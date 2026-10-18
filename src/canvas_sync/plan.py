"""Compare remote, base (last pulled) and local, and produce a concrete list of actions.

Planning only reads (Canvas snapshot, state db, filesystem); nothing changes until the
plan is handed to the executor. Every path in a plan is final, so a UI can show
exactly what will happen and drop actions it doesn't want before applying.
"""

from __future__ import annotations

import os
import stat
from dataclasses import asdict, dataclass, field
from datetime import date
from enum import StrEnum
from pathlib import Path, PurePosixPath
from typing import Any

from .config import Settings
from .discover import CourseSnapshot
from .layout import Layout, Placement
from .local import inode_index, is_regular, occupied, sha256_file, sibling
from .models import RemoteFile
from .state import FileRecord, State


class Kind(StrEnum):
    DOWNLOAD = "download"  # new file
    UPDATE = "update"  # changed on Canvas, untouched locally
    CONFLICT = "conflict"  # changed on both sides
    MOVE = "move"  # layout now puts it somewhere else
    PIN = "pin"  # you moved it; remember the new location
    IGNORE = "ignore"  # you deleted it; stop syncing it
    REMOTE_DELETED = "remote_deleted"  # gone from Canvas; local copy kept
    DELETE = "delete"  # gone from Canvas; local copy sent to Trash
    LINK = "link"  # symlink in a secondary view
    UNLINK = "unlink"
    SKIP = "skip"  # informational: can't or won't sync this


@dataclass
class Action:
    kind: Kind
    course_id: int
    file_id: int | None
    name: str
    path: str | None = None  # destination, or the file concerned (relative to root)
    src: str | None = None  # current location (move / update / conflict / pin)
    backup: str | None = None  # conflict + rename_local: where your edited copy goes
    target: str | None = None  # link: the real file it points at
    resolution: str | None = None  # conflict: rename_local | rename_remote | skip
    replaces: int | None = None  # Canvas replaced file `replaces` with this one
    reason: str | None = None


@dataclass
class Plan:
    actions: list[Action]
    warnings: list[str]
    snapshots: list[CourseSnapshot] = field(default_factory=list, repr=False)

    def to_dict(self) -> dict[str, Any]:
        return {"actions": [asdict(a) for a in self.actions], "warnings": self.warnings}


@dataclass
class Scope:
    """Part of the sync folder: files or folders (paths relative to root) and/or file ids."""

    paths: list[str] = field(default_factory=list)
    file_ids: set[int] = field(default_factory=set)

    def __post_init__(self) -> None:
        self.paths = [p.strip("/") for p in self.paths]

    def contains(self, path: str | None) -> bool:
        if path is None:
            return False
        return any(p == "" or path == p or path.startswith(p + "/") for p in self.paths)

    def overlaps(self, folder: str) -> bool:
        """`folder` is inside the scope, or the scope is inside `folder`."""
        return self.contains(folder) or any(p.startswith(folder.strip("/") + "/") for p in self.paths)

    def touches(self, a: Action) -> bool:
        return a.file_id in self.file_ids or any(map(self.contains, (a.path, a.src, a.backup, a.target)))


def narrow(actions: list[Action], scope: Scope) -> list[Action]:
    """The part of a plan that concerns `scope`, kept whole per file: a file in scope gets
    all its actions (its download *and* its links in other views), so syncing just the
    Files/ view still fetches a file whose real copy lives under Modules/. Files whose
    actions free up or occupy the same paths are pulled in too, so nothing collides."""
    by_file: dict[int | None, list[Action]] = {}
    for a in actions:
        by_file.setdefault(a.file_id, []).append(a)
    chosen = {a.file_id for a in actions if scope.touches(a)}
    while True:
        paths = {p for f in chosen for a in by_file[f] for p in (a.path, a.src) if p}
        more = {a.file_id for a in actions if a.file_id not in chosen and ({a.path, a.src} & paths)}
        if not more:
            return [a for a in actions if a.file_id in chosen]
        chosen |= more


@dataclass
class LocalInfo:
    path: str | None  # where the file is now; None if it's gone
    moved: bool = False
    modified: bool = False


class Inspector:
    """Works out what happened on disk to a tracked file since we last wrote it."""

    def __init__(self, root: Path):
        self.root = root
        self._inodes: dict[int, str] | None = None

    def inspect(self, rec: FileRecord) -> LocalInfo:
        assert rec.path is not None
        # One call, on a plain string: status() asks this of every tracked file.
        here = os.path.join(self.root, rec.path)
        try:
            st = os.lstat(here)
        except OSError:
            st = None
        if st is not None and stat.S_ISREG(st.st_mode):
            return LocalInfo(rec.path, modified=self._modified(rec, here, st))
        # Not where we left it. Moves within the volume keep the inode, so look for it.
        if rec.snap_inode is not None:
            if self._inodes is None:
                self._inodes = inode_index(self.root)
            moved = self._inodes.get(rec.snap_inode)
            if moved and moved != rec.path:
                return LocalInfo(moved, moved=True, modified=self._modified(rec, self.root / moved))
        return LocalInfo(None)

    @staticmethod
    def _modified(rec: FileRecord, path: Path | str, st: os.stat_result | None = None) -> bool:
        st = st or os.stat(path)
        if st.st_mtime == rec.snap_mtime and st.st_size == rec.snap_size:
            return False
        return sha256_file(Path(path)) != rec.base_hash


class Planner:
    def __init__(self, root: Path, state: State, layout: Layout, settings: Settings):
        self.root = root
        self.state = state
        self.layout = layout
        self.settings = settings
        self.inspector = Inspector(root)

    def plan_course(self, snap: CourseSnapshot) -> list[Action]:
        s, course = self.settings, snap.course
        cid = course.id
        recs = {r.id: r for r in self.state.files_for_course(cid)}
        local = {r.id: self.inspector.inspect(r) for r in recs.values() if r.path and not r.ignored}
        out: list[Action] = []

        # Files you moved in Finder: remember where you put them (or move them back).
        pins = {r.id: r.pinned_path for r in recs.values() if r.pinned_path}
        for rid, info in local.items():
            if info.moved and s.on_local_move == "follow":
                pins[rid] = info.path
                out.append(Action(Kind.PIN, cid, rid, recs[rid].name, path=info.path, src=recs[rid].path))

        placements = self.layout.place_course(
            course, snap.files.values(), {k: v for k, v in pins.items() if k in snap.files}
        )

        # When a file disappears from Canvas and a new one shows up at the same spot,
        # the instructor almost certainly re-uploaded it: treat that as an update.
        vanished = {
            r.path.casefold(): r
            for r in recs.values()
            if r.id not in snap.files and r.path and not r.ignored
        }
        final: dict[int, str] = {}  # where each file's real copy will be after this plan
        max_bytes = s.max_file_mb * 1024 * 1024

        for f in sorted(snap.files.values(), key=lambda f: f.id):
            placement, rec, info = placements.get(f.id), recs.get(f.id), local.get(f.id)
            if placement is None:  # excluded by a rule; leave any existing copy alone
                if info and info.path:
                    final[f.id] = info.path
                continue
            if rec is not None and rec.ignored:
                continue
            desired = placement.primary.as_posix()
            replaces = None
            if (rec is None or rec.path is None) and desired.casefold() in vanished:
                rec = vanished.pop(desired.casefold())
                replaces, info = rec.id, local.get(rec.id)

            def add(kind: Kind, **kw: Any) -> None:
                out.append(Action(kind, cid, f.id, f.name, replaces=replaces, **kw))

            gone_locally = info is not None and info.path is None
            if rec is None or rec.path is None or (gone_locally and s.on_local_delete == "restore"):
                if why := self._unfetchable(f, max_bytes):
                    add(Kind.SKIP, path=desired, reason=why)
                elif self._occupied(desired):
                    add(Kind.SKIP, path=desired, reason="path is taken by a file canvas-sync doesn't manage")
                else:
                    add(Kind.DOWNLOAD, path=desired)
                    final[f.id] = desired
                continue
            if gone_locally:
                add(Kind.IGNORE, path=rec.path, reason="deleted locally")
                continue

            assert info is not None and info.path is not None
            cur = info.path
            remote_changed = (
                replaces is not None or f.version != rec.base_version or f.size != rec.base_size
            )
            if remote_changed:
                if why := self._unfetchable(f, max_bytes):
                    add(Kind.SKIP, path=cur, reason=f"update not downloaded: {why}")
                    final[f.id] = cur
                    continue
                dest = desired if desired == cur or not self._occupied(desired) else cur
                if not info.modified:
                    add(Kind.UPDATE, path=dest, src=cur)
                    final[f.id] = dest
                else:
                    final[f.id] = self._conflict(add, cur, dest)
            elif cur != desired:
                if self._occupied(desired):
                    add(Kind.SKIP, path=cur, reason=f"can't move to {desired}: path is taken")
                    final[f.id] = cur
                else:
                    add(Kind.MOVE, path=desired, src=cur)
                    final[f.id] = desired
            else:
                final[f.id] = cur

        # Gone from Canvas. Skipped if discovery was incomplete: absence proves nothing then.
        replaced = {a.replaces for a in out if a.replaces is not None}
        if snap.complete:
            for r in recs.values():
                if r.id in snap.files or r.id in replaced or r.remote_deleted:
                    continue
                info = local.get(r.id)
                if s.on_remote_delete == "delete_if_unmodified" and info and info.path and not info.modified:
                    out.append(Action(Kind.DELETE, cid, r.id, r.name, path=info.path, reason="removed from Canvas"))
                else:
                    out.append(Action(Kind.REMOTE_DELETED, cid, r.id, r.name, path=r.path))

        vacated = {a.src for a in out if a.kind in (Kind.MOVE, Kind.PIN, Kind.UPDATE) and a.src != a.path}
        out += self._plan_links(cid, snap, placements, final, vacated)
        return out

    def _plan_links(self, cid: int, snap: CourseSnapshot, placements: dict[int, Placement | None], final: dict[int, str],
                    vacated: set[str | None]) -> list[Action]:
        out: list[Action] = []
        want: dict[str, tuple[int, str]] = {}
        for fid, placement in placements.items():
            if placement is not None and fid in final:
                for link in placement.links:
                    want[link.as_posix()] = (fid, final[fid])
        # A link in a folder you stopped syncing stays (it's in what you kept), still
        # pointing at its file: where sync puts it, or where you kept it if it isn't synced.
        for path, fid in self.state.links_for_course(cid).items():
            if path in want or fid not in snap.files or not self.layout.skipped(PurePosixPath(self.layout.canonical(path))):
                continue
            rec = self.state.get(fid)
            kept = rec.path if rec and rec.ignored and rec.path and is_regular(self.root / rec.path) else None
            if target := final.get(fid, kept):
                want[path] = (fid, target)
        for path, (fid, target) in want.items():
            name = snap.files[fid].name
            if self._link_ok(path, target):
                continue
            p = self.root / path
            if occupied(p) and not p.is_symlink() and path not in vacated:
                out.append(Action(Kind.SKIP, cid, fid, name, path=path, reason="can't link: a real file is there"))
                continue
            out.append(Action(Kind.LINK, cid, fid, name, path=path, target=target))
        for path, fid in self.state.links_for_course(cid).items():
            if path not in want and fid in snap.files:
                out.append(Action(Kind.UNLINK, cid, fid, snap.files[fid].name, path=path))
        return out

    def _conflict(self, add: Any, cur: str, dest: str) -> str:
        how = self.settings.on_conflict
        if how == "skip":
            add(Kind.CONFLICT, path=cur, src=cur, resolution=how,
                reason="changed on both sides; kept your copy, update not applied")
            return cur
        if how == "rename_local":
            add(Kind.CONFLICT, path=dest, src=cur, backup=sibling(cur, "mine", self.root), resolution=how)
            return dest
        new = sibling(dest, f"updated {date.today().isoformat()}", self.root)
        add(Kind.CONFLICT, path=new, src=cur, resolution=how)
        return new

    def _unfetchable(self, f: RemoteFile, max_bytes: float) -> str | None:
        if f.locked or not f.url:
            return "locked on Canvas"
        if f.size > max_bytes:
            return f"larger than {self.settings.max_file_mb:g} MB (sync.max_file_mb)"
        return None

    def _occupied(self, rel: str) -> bool:
        """Something we don't manage is at `rel` (our own symlinks can be replaced)."""
        return occupied(self.root / rel) and not self.state.is_link(rel)

    def _link_ok(self, rel: str, target: str) -> bool:
        p = self.root / rel
        if not p.is_symlink():
            return False
        return os.readlink(p) == os.path.relpath(self.root / target, p.parent)
