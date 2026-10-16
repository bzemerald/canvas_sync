"""Carry out a plan. Deliberately dumb: every decision was already made by the planner."""

from __future__ import annotations

import asyncio
import os
import shutil
from collections.abc import Callable
from datetime import datetime
from pathlib import Path

from send2trash import send2trash

from .api import CanvasClient
from .local import clone_file, is_regular, prune_empty_dirs
from .models import RemoteFile
from .plan import Action, Kind, Plan
from .state import META_DIR, State

# Called after each action with (action, error message or None).
EventHandler = Callable[[Action, str | None], None]


class Executor:
    def __init__(self, root: Path, state: State, client: CanvasClient, on_event: EventHandler | None = None):
        self.root = root
        self.state = state
        self.client = client
        self.originals = root / META_DIR / "originals"
        self.tmp = root / META_DIR / "tmp"
        self.on_event = on_event or (lambda action, error: None)

    async def apply(self, plan: Plan) -> list[tuple[Action, str]]:
        """Run every action; one failure doesn't stop the rest. Returns the failures."""
        self.originals.mkdir(parents=True, exist_ok=True)
        shutil.rmtree(self.tmp, ignore_errors=True)  # leftovers from an interrupted run
        self.tmp.mkdir(parents=True)

        remote: dict[int, RemoteFile] = {}
        for snap in plan.snapshots:
            self.state.save_course(snap.course)
            for f in snap.files.values():
                self.state.upsert_remote(f)
                remote[f.id] = f
            self.state.save_documents(snap.course.id, snap.documents)
            if snap.modules is not None:
                self.state.save_modules(snap.course.id, snap.modules)
        self.state.commit()

        errors: list[tuple[Action, str]] = []

        async def run(a: Action) -> None:
            try:
                await self._do(a, remote.get(a.file_id) if a.file_id is not None else None)
                self.state.commit()
                self.on_event(a, None)
            except Exception as e:
                errors.append((a, str(e)))
                self.on_event(a, str(e))

        def of(*kinds: Kind) -> list[Action]:
            return [a for a in plan.actions if a.kind in kinds]

        # Clear the way first, download in parallel, then the bookkeeping and links.
        for a in of(Kind.PIN, Kind.UNLINK, Kind.MOVE):
            await run(a)
        await asyncio.gather(*(run(a) for a in of(Kind.DOWNLOAD, Kind.UPDATE, Kind.CONFLICT)))
        for a in of(Kind.IGNORE, Kind.REMOTE_DELETED, Kind.DELETE, Kind.LINK):
            await run(a)

        self._refresh_inodes([s.course.id for s in plan.snapshots])
        self.state.commit()
        return errors

    async def _do(self, a: Action, f: RemoteFile | None) -> None:
        root, fid = self.root, a.file_id
        assert fid is not None
        match a.kind:
            case Kind.PIN:
                self.state.update(fid, path=a.path, pinned_path=a.path)
            case Kind.UNLINK:
                p = root / a.path
                if p.is_symlink():
                    p.unlink()
                    prune_empty_dirs(p.parent, root)
                self.state.remove_link(a.path)
            case Kind.MOVE:
                self._move(root / a.src, a.path)
                self.state.update(fid, path=a.path)
            case Kind.DOWNLOAD:
                tmp, digest = await self._fetch(f)
                self._install(f, tmp, digest, a.path)
            case Kind.UPDATE:
                tmp, digest = await self._fetch(f)
                if a.replaces is not None:
                    self._adopt(a.replaces, fid)
                self._install(f, tmp, digest, a.path)
                if a.src != a.path:
                    self._remove(root / a.src)
            case Kind.CONFLICT:
                if a.resolution == "skip":
                    return
                tmp, digest = await self._fetch(f)
                if a.replaces is not None:
                    self._adopt(a.replaces, fid)
                if a.backup:  # rename_local: your edited copy steps aside, untracked from now on
                    os.rename(root / a.src, root / a.backup)
                self._install(f, tmp, digest, a.path)
                if a.resolution == "rename_remote":
                    self.state.update(fid, pinned_path=a.path)
            case Kind.IGNORE:
                self.state.update(fid, ignored=1)
            case Kind.REMOTE_DELETED:
                self.state.update(fid, remote_deleted=1)
            case Kind.DELETE:
                p = root / a.path
                if is_regular(p):
                    send2trash(p)
                    prune_empty_dirs(p.parent, root)
                self.state.update(fid, path=None, remote_deleted=1)
            case Kind.LINK:
                p = root / a.path
                if p.is_symlink():
                    p.unlink()
                elif p.exists():
                    raise FileExistsError(f"{a.path} exists and is not a symlink")
                p.parent.mkdir(parents=True, exist_ok=True)
                os.symlink(os.path.relpath(root / a.target, p.parent), p)
                self.state.add_link(a.path, fid)
            case Kind.SKIP:
                pass

    async def _fetch(self, f: RemoteFile | None) -> tuple[Path, str]:
        if f is None or not f.url:
            raise RuntimeError("no download URL")
        tmp = self.tmp / f"{f.id}.part"
        digest = await self.client.download(f.url, tmp)
        if ts := _timestamp(f.version):
            os.utime(tmp, (ts, ts))  # so Finder's "Date Modified" means something
        return tmp, digest

    def _install(self, f: RemoteFile, tmp: Path, digest: str, rel: str) -> None:
        dest = self.root / rel
        self._clear_link(dest, rel)
        dest.parent.mkdir(parents=True, exist_ok=True)
        clone_file(tmp, self.originals / str(f.id))
        os.replace(tmp, dest)
        st = dest.stat()
        self.state.update(
            f.id, path=rel, ignored=0,
            base_hash=digest, base_version=f.version, base_size=f.size,
            snap_mtime=st.st_mtime, snap_size=st.st_size, snap_inode=st.st_ino,
        )

    def _move(self, src: Path, rel: str) -> None:
        dest = self.root / rel
        self._clear_link(dest, rel)
        dest.parent.mkdir(parents=True, exist_ok=True)
        os.rename(src, dest)
        prune_empty_dirs(src.parent, self.root)

    def _remove(self, p: Path) -> None:
        if is_regular(p):
            p.unlink()
            prune_empty_dirs(p.parent, self.root)

    def _clear_link(self, p: Path, rel: str) -> None:
        if p.is_symlink():  # one of our view links is in the way; the planner checked
            p.unlink()
            self.state.remove_link(rel)

    def _adopt(self, old_id: int, new_id: int) -> None:
        self.state.rekey(old_id, new_id)
        (self.originals / str(old_id)).unlink(missing_ok=True)

    def _refresh_inodes(self, course_ids: list[int]) -> None:
        # Apps that "safe save" swap in a new inode; keep ours current so moves stay detectable.
        for cid in course_ids:
            for r in self.state.files_for_course(cid):
                if r.path and not r.ignored:
                    p = self.root / r.path
                    if is_regular(p) and (ino := p.stat().st_ino) != r.snap_inode:
                        self.state.update(r.id, snap_inode=ino)


def _timestamp(iso: str) -> float | None:
    try:
        return datetime.fromisoformat(iso.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None
