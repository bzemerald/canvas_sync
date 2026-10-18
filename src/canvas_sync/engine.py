"""Library entry point. The CLI is a thin shell over this; a GUI would be another."""

from __future__ import annotations

import asyncio
import os
import posixpath
from dataclasses import dataclass
from pathlib import Path, PurePosixPath

from send2trash import send2trash

from .api import CanvasClient
from .browse import RESTORABLE, Entry, list_dir
from .config import SETTINGS_TEMPLATE, Settings, record_folder_rename, update_skip_folders
from .discover import discover_course
from .execute import EventHandler, Executor
from .layout import Layout, sanitize
from .local import clone_file, is_regular, sha256_file
from .models import Course
from .plan import Action, Inspector, Plan, Planner, Scope, narrow
from .search import Hit, Index, IndexStats, ProgressHandler
from .state import META_DIR, State


class NotInitialized(Exception):
    pass


@dataclass
class FileStatus:
    path: str | None  # where the file is now (or was, if you deleted it)
    file_id: int
    course_id: int
    states: list[str]  # modified | missing | moved | ignored | remote_deleted


class Engine:
    def __init__(self, root: Path, client: CanvasClient | None = None):
        self.root = root.expanduser().resolve()
        self.meta = self.root / META_DIR
        if not (self.meta / "config.toml").exists():
            raise NotInitialized(f"{self.root} is not set up yet (run `canvas init`)")
        self.settings = Settings.load(self.meta / "config.toml")
        self.layout = Layout(self.settings)
        self.state = State(self.meta / "state.db")
        self.client = client
        self._index: Index | None = None

    @staticmethod
    def init_root(root: Path) -> Path:
        root = root.expanduser().resolve()
        meta = root / META_DIR
        meta.mkdir(parents=True, exist_ok=True)
        if not (meta / "config.toml").exists():
            (meta / "config.toml").write_text(SETTINGS_TEMPLATE)
        State(meta / "state.db").close()
        return root

    def __enter__(self) -> Engine:
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()

    def close(self) -> None:
        if self._index is not None:
            self._index.close()
        self.state.close()

    @property
    def index(self) -> Index:
        if self._index is None:
            self._index = Index(self.meta / "index.db")
        return self._index

    def _api(self) -> CanvasClient:
        if self.client is None:
            raise RuntimeError("this operation needs a Canvas connection")
        return self.client

    # -- online -------------------------------------------------------------------

    async def courses(self) -> list[Course]:
        """Current courses, plus any ids listed under `include` in the config."""
        api = self._api()
        listed = [
            Course.from_api(d) for d in await api.courses() if not d.get("access_restricted_by_date")
        ]
        known = {c.id for c in listed}
        extra = [i for i in self.settings.include if i not in known]
        for d in await asyncio.gather(*(api.course(i, ["term"]) for i in extra), return_exceptions=True):
            if isinstance(d, dict):
                listed.append(Course.from_api(d))
        return listed

    def is_selected(self, course: Course) -> bool:
        s = self.settings
        if course.id in s.exclude:
            return False
        return course.id in s.include or s.select == "active" or course.is_favorite

    async def plan(self, courses: list[Course] | None = None, scope: Scope | None = None) -> Plan:
        """Look at Canvas and the disk and work out what a pull would do. Changes nothing.

        With a `scope` (a term, course, folder or file), only courses under it are checked
        and only actions for files in it are kept. An explicit scope also covers courses
        `pull` would normally skip, since you asked for them."""
        if courses is None:
            courses = self.courses_in(scope) if scope else [c for c in await self.courses() if self.is_selected(c)]
        snaps = await asyncio.gather(*(discover_course(self._api(), c) for c in courses))
        planner = Planner(self.root, self.state, self.layout, self.settings)
        plan = Plan([], [], list(snaps))
        for snap in snaps:
            plan.actions += planner.plan_course(snap)
            plan.warnings += [f"{snap.course.code}: {w}" for w in snap.warnings]
        if scope:
            plan.actions = narrow(plan.actions, scope)
        return plan

    def courses_in(self, scope: Scope) -> list[Course]:
        """Courses we've synced before that the scope reaches into."""
        ids = {r.course_id for r in map(self.state.get, scope.file_ids) if r}
        return [
            c for c in self.state.courses()
            if c.id in ids or scope.overlaps(self.layout.course_dir(c).as_posix())
        ]

    async def apply(self, plan: Plan, on_event: EventHandler | None = None) -> list[tuple[Action, str]]:
        return await Executor(self.root, self.state, self._api(), on_event).apply(plan)

    # -- offline ------------------------------------------------------------------

    def status(self) -> list[FileStatus]:
        """How tracked files differ from the copies last pulled. No network."""
        inspector = Inspector(self.root)
        out = []
        for r in self.state.all_files():
            states, path = [], r.path
            if r.ignored:
                # Not synced any more: deleted by you, or kept as your own file.
                states.append("untracked" if r.path and is_regular(self.root / r.path) else "ignored")
            elif r.path:
                info = inspector.inspect(r)
                if info.path is None:
                    states.append("missing")
                else:
                    path = info.path
                    states += ["moved"] * info.moved + ["modified"] * info.modified
            if r.remote_deleted and r.path:
                states.append("remote_deleted")
            if states:
                out.append(FileStatus(path, r.id, r.course_id, states))
        return out

    def reindex(self, on_progress: ProgressHandler | None = None) -> IndexStats:
        """Update the search index from what was last pulled. Only changed files are re-read."""
        return self.index.sync(self.state, self.root, on_progress)

    def search(self, query: str, limit: int = 50, course_ids: list[int] | None = None,
               kinds: list[str] | None = None, names_only: bool = False, under: str | None = None) -> list[Hit]:
        """`under`: only files in that folder, counting the ones its view links point to."""
        under, also = self.folder_scope(under)
        return self.index.search(query, self.state.courses(), self.settings, limit, course_ids, kinds, names_only,
                                 under, also)

    def folder_scope(self, under: str | None) -> tuple[str | None, list[str]]:
        """A folder searched in, and the files its view links point to (elsewhere)."""
        if under is None:
            return None, []
        under = under.strip("/")
        also = [
            r[0] for r in self.state.db.execute(
                "SELECT f.path FROM links l JOIN files f ON f.id = l.file_id WHERE f.path IS NOT NULL"
                " AND (l.path = ? OR substr(l.path, 1, ?) = ?)", (under, len(under) + 1, under + "/"))
        ]
        return under, also

    def relative(self, path: Path) -> str:
        """A user-supplied path (absolute, or relative to cwd) as a path relative to root.
        Symlinks are deliberately not resolved: a view link maps to its file."""
        p = Path(os.path.abspath(path.expanduser()))
        try:
            return p.relative_to(self.root).as_posix()
        except ValueError:
            raise LookupError(f"{path} is not inside {self.root}") from None

    # -- deleting, and stopping / resuming sync ------------------------------------------

    def _checked(self, rel: str, gone_ok: bool = False) -> str:
        """`gone_ok`: also a folder you deleted, that files from Canvas were in."""
        rel = rel.strip("/")
        if not rel or rel.split("/")[0] == META_DIR:
            raise ValueError("that can't be changed")
        if not os.path.lexists(self.root / rel) and not (gone_ok and self._has_canvas_content(rel)):
            raise LookupError(f"{rel} does not exist")
        return rel

    def _where(self) -> dict[int, str]:
        """Where each synced file is now, following moves you haven't pulled yet."""
        moved = {s.file_id: s.path for s in self.status() if "moved" in s.states and s.path}
        return {r.id: moved.get(r.id, r.path) for r in self.state.all_files() if r.path and not r.ignored}

    def _affected(self, rels: list[str]) -> tuple[dict[int, str], list[str]]:
        """Synced files at or under these paths (a view link stands for its file), with
        where they are; and which of the paths are folders."""
        where = self._where()
        links = {row[0]: row[1] for row in self.state.db.execute("SELECT path, file_id FROM links")}
        ids: set[int] = set()
        folders = []
        for rel in rels:
            if (self.root / rel).is_dir() and not (self.root / rel).is_symlink():
                folders.append(rel)
                ids |= {fid for fid, p in where.items() if _under(p, rel)}
            elif rel in links:
                ids.add(links[rel])
            else:
                ids |= {fid for fid, p in where.items() if p == rel}
        return {fid: where[fid] for fid in ids if fid in where}, folders

    def _has_canvas_content(self, folder: str) -> bool:
        if any(r.path and _under(r.path, folder) for r in self.state.all_files()):
            return True
        return any(_under(row[0], folder) for row in self.state.db.execute("SELECT path FROM links"))

    def _stop_syncing(self, files: dict[int, str], keep_links_in: list[str] = ()) -> None:  # type: ignore[assignment]
        """Mark files as not synced. Their view links go: sync won't put them there any more.
        But not those in folders you keep without syncing (`keep_links_in`, and folders
        already not synced): they stay, pointing at the file. A file you moved is recorded
        where it is now."""
        for fid, now in files.items():
            for path, linked in list(self.state.db.execute("SELECT path, file_id FROM links")):
                kept = any(_under(path, k) for k in keep_links_in)
                if linked == fid and not kept and not self.layout.skipped(PurePosixPath(self.layout.canonical(path))):
                    if (self.root / path).is_symlink():
                        (self.root / path).unlink()
                    self.state.remove_link(path)
            rec = self.state.get(fid)
            moved = rec is not None and rec.path != now
            self.state.update(fid, ignored=1, **({"path": now, "pinned_path": now} if moved else {}))

    def delete_preview(self, rels: list[str]) -> dict[str, object]:
        """What `delete` would do, for the confirmation."""
        rels = [self._checked(r) for r in rels]
        files, folders = self._affected(rels)
        own = 0
        for rel in rels:
            p = self.root / rel
            if p.is_dir() and not p.is_symlink():
                tracked = {v for v in files.values()}
                for dirpath, _, names in os.walk(p):
                    for n in names:
                        full = Path(dirpath) / n
                        rel_n = full.relative_to(self.root).as_posix()
                        if is_regular(full) and rel_n not in tracked:
                            own += 1
            elif not self.state.is_link(rel) and rel not in files.values():
                own += 1
        return {
            "canvas_files": len(files),
            "own_files": own,
            "folders": folders,
            "canvas_folders": [f for f in folders if self._has_canvas_content(f)],
        }

    def delete(self, rels: list[str], stop_syncing_folders: bool = True) -> list[str]:
        """Move files and folders to the Trash. Files from Canvas aren't downloaded again
        (they can be restored); deleting a view link deletes the file it shows. With
        `stop_syncing_folders`, files Canvas adds to the deleted folders later aren't
        downloaded either."""
        rels = [self._checked(r) for r in rels]
        files, folders = self._affected(rels)
        skip = [self.layout.canonical(f) for f in folders if self._has_canvas_content(f)] if stop_syncing_folders else []
        for path, _ in list(self.state.db.execute("SELECT path, file_id FROM links")):
            if any(_under(path, f) for f in folders):
                self.state.remove_link(path)  # goes to the Trash with its folder
        self._stop_syncing(files)
        self.state.commit()
        trash = sorted({*rels, *files.values()}, key=len)
        done = []
        for rel in trash:
            p = self.root / rel
            if os.path.lexists(p) and not any(_under(rel, d) for d in done):
                send2trash(p)
                done.append(rel)
        if skip:
            update_skip_folders(self.meta / "config.toml", add=skip)
            self._reload()
        return done

    def untrack(self, rels: list[str]) -> int:
        """Stop syncing these files and folders but keep them, as your own files. Files
        Canvas adds to the folders later aren't downloaded (a folder you deleted, too).
        View links in the folders stay. Returns how many files."""
        rels = [self._checked(r, gone_ok=True) for r in rels]
        files, folders = self._affected(rels)
        folders += [r for r in rels if not os.path.lexists(self.root / r)]
        skip = [self.layout.canonical(f) for f in folders if self._has_canvas_content(f)]
        self._stop_syncing(files, keep_links_in=folders)
        self.state.commit()
        if skip:
            update_skip_folders(self.meta / "config.toml", add=skip)
            self._reload()
        return len(files)

    def track(self, rels: list[str]) -> int:
        """Undo `untrack`: sync these files and folders again (a folder you deleted: what
        Canvas adds to it). Returns how many files."""
        rels = [self._checked(r, gone_ok=True) for r in rels]
        n = 0
        for r in self.state.all_files():
            if r.ignored and r.path and is_regular(self.root / r.path) and any(_under(r.path, rel) for rel in rels):
                self.state.update(r.id, ignored=0)
                n += 1
        self.state.commit()
        self._resume(rels)
        return n

    def restore_in(self, scope: Scope) -> list[str]:
        """Restore everything you changed or deleted in `scope`, and sync its folders again."""
        restored = self.restore_files([s.file_id for s in self.restorable(scope)])
        if scope.paths:
            self._resume(scope.paths)
        return restored

    def _resume(self, rels: list[str]) -> None:
        """Sync these paths' folders again: what's at or under them, and the folders above
        them that weren't synced (else nothing in them could be). The other folders in
        those stay as they were: not synced."""
        canon = [self.layout.canonical(r) for r in rels]
        above = [s for s in self.settings.skip_folders if any(c.startswith(s + "/") for c in canon)]
        keep: list[str] = []
        for s in above:
            for c in (c for c in canon if c.startswith(s + "/")):
                here = s
                for part in c[len(s) + 1:].split("/"):
                    keep += [d for d in self._subfolders(here) if d != f"{here}/{part}"]
                    here = f"{here}/{part}"
        keep = [k for k in keep if not any(_under(k, c) or _under(c, k) for c in canon)]
        update_skip_folders(self.meta / "config.toml", remove_under=canon, remove=above, add=keep)
        self._reload()

    def _subfolders(self, canonical: str) -> list[str]:
        """The folders in a folder (Canvas-derived paths): on disk, and those you deleted
        that files from Canvas were in."""
        rel = self.layout.renamed(PurePosixPath(canonical)).as_posix()
        names = set()
        if (self.root / rel).is_dir():
            names |= {d.name for d in os.scandir(self.root / rel) if d.is_dir(follow_symlinks=False)}
        paths = [r.path for r in self.state.all_files() if r.path]
        paths += [row[0] for row in self.state.db.execute("SELECT path FROM links")]
        names |= {p[len(rel) + 1:].split("/")[0] for p in paths if p.startswith(rel + "/") and "/" in p[len(rel) + 1:]}
        return sorted(self.layout.canonical(f"{rel}/{n}") for n in names)

    def _reload(self) -> None:
        self.settings = Settings.load(self.meta / "config.toml")
        self.layout = Layout(self.settings)

    def restorable(self, scope: Scope) -> list[FileStatus]:
        """Files in `scope` that `restore_files` would put back: edited or deleted by you."""
        return [
            s for s in self.status()
            if RESTORABLE & set(s.states) and (s.file_id in scope.file_ids or scope.contains(s.path))
        ]

    def restore(self, path: Path) -> list[str]:
        """Put back the copies last pulled from Canvas, for a file or everything changed in
        a folder. Your edited versions go to the Trash."""
        rel = self.relative(path)
        if (self.root / rel).is_dir() and not (self.root / rel).is_symlink():
            return self.restore_in(Scope([rel]))
        rec = self.state.by_path(rel)
        if rec is None:  # maybe a file you moved here
            moved = {s.path: s.file_id for s in self.status() if "moved" in s.states}
            rec = self.state.get(moved[rel]) if rel in moved else None
        if rec is None and not os.path.lexists(self.root / rel) and self.restorable(Scope([rel])):
            return self.restore_in(Scope([rel]))  # a folder you deleted
        if rec is None or rec.path is None:
            raise LookupError(f"{rel} is not a file canvas-sync tracks")
        return self.restore_files([rec.id])

    def restore_files(self, file_ids: list[int]) -> list[str]:
        """Restore each file where it is now (a file you moved stays moved, but gets its
        original content back) or, if you deleted it, where it was."""
        inspector = Inspector(self.root)
        done = []
        for fid in file_ids:
            rec = self.state.get(fid)
            if rec is None or rec.path is None:
                raise LookupError(f"file {fid} is not tracked")
            original = self.meta / "originals" / str(rec.id)
            if not original.exists():
                raise LookupError(f"no original kept for {rec.path}; run `canvas pull`")
            rel = rec.path
            if not rec.ignored:
                rel = inspector.inspect(rec).path or rec.path
            dest = self.root / rel
            if is_regular(dest) and sha256_file(dest) != rec.base_hash:
                send2trash(dest)
            dest.parent.mkdir(parents=True, exist_ok=True)
            clone_file(original, dest)
            st = dest.stat()
            self.state.update(rec.id, ignored=0, snap_mtime=st.st_mtime, snap_size=st.st_size, snap_inode=st.st_ino)
            self.state.commit()
            done.append(rel)
        if done:  # synced again: so are the folders they're in
            self._resume(done)
        return done

    def rename_folder(self, rel: str, name: str) -> str:
        """Rename a folder without changing what syncing does: files Canvas adds to it
        later still land in it, links into it keep working, nothing is re-downloaded.
        Returns the new path."""
        rel = rel.strip("/")
        src = self.root / rel
        if not rel or rel.split("/")[0] == META_DIR:
            raise ValueError("that folder can't be renamed")
        if not src.is_dir() or src.is_symlink():
            raise LookupError(f"{rel} is not a folder")
        new_name = sanitize(name.strip())
        if not name.strip() or new_name.startswith("."):
            raise ValueError("folder names can't be empty or start with a dot")
        parent = posixpath.dirname(rel)
        new = posixpath.join(parent, new_name) if parent else new_name
        if new == rel:
            return rel
        dest = self.root / new
        if os.path.lexists(dest) and not dest.samefile(src):  # (a case-only rename is the same folder)
            raise FileExistsError(f"{new} already exists")

        canonical = self.layout.canonical(rel)
        own_name = posixpath.basename(canonical)
        os.rename(src, dest)
        try:
            self._repath(rel, new)
            record_folder_rename(self.meta / "config.toml", canonical, None if new_name == own_name else new_name, rel, new)
            self.state.commit()
        except BaseException:
            self.state.db.rollback()
            os.rename(dest, src)
            raise
        self._reload()
        self._relink()
        return new

    def _repath(self, old: str, new: str) -> None:
        """Every path we've recorded at or under `old` now starts with `new`."""
        def moved(p: str | None) -> str | None:
            if p is not None and (p == old or p.startswith(old + "/")):
                return new + p[len(old):]
            return None

        for r in self.state.all_files():
            changes = {k: v for k in ("path", "pinned_path") if (v := moved(getattr(r, k))) is not None}
            if changes:
                self.state.update(r.id, **changes)
        for path, fid in list(self.state.db.execute("SELECT path, file_id FROM links")):
            if (to := moved(path)) is not None:
                self.state.remove_link(path)
                self.state.add_link(to, fid)

    def _relink(self) -> None:
        """Point every view link at its file again (links from outside a renamed folder
        into it are relative paths that went stale)."""
        for path, fid in list(self.state.db.execute("SELECT path, file_id FROM links")):
            rec = self.state.get(fid)
            link = self.root / path
            if rec is None or rec.path is None or not link.is_symlink():
                continue
            want = os.path.relpath(self.root / rec.path, link.parent)
            if os.readlink(link) != want:
                link.unlink()
                os.symlink(want, link)

    def list_dir(self, rel: str = "") -> list[Entry]:
        """A folder's contents as the app shows them; see `browse.list_dir`."""
        return list_dir(self.root, self.state, self.layout, self.status(), rel.strip("/"))


def _under(path: str, folder: str) -> bool:
    return path == folder or path.startswith(folder + "/")
