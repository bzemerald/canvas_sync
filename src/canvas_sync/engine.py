"""Library entry point. The CLI is a thin shell over this; a GUI would be another."""

from __future__ import annotations

import asyncio
import os
from dataclasses import dataclass
from pathlib import Path

from send2trash import send2trash

from .api import CanvasClient
from .browse import RESTORABLE, Entry, list_dir
from .config import SETTINGS_TEMPLATE, Settings
from .discover import discover_course
from .execute import EventHandler, Executor
from .layout import Layout
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
                states.append("ignored")
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
               kinds: list[str] | None = None, names_only: bool = False) -> list[Hit]:
        return self.index.search(query, self.state.courses(), self.settings, limit, course_ids, kinds, names_only)

    def relative(self, path: Path) -> str:
        """A user-supplied path (absolute, or relative to cwd) as a path relative to root.
        Symlinks are deliberately not resolved: a view link maps to its file."""
        p = Path(os.path.abspath(path.expanduser()))
        try:
            return p.relative_to(self.root).as_posix()
        except ValueError:
            raise LookupError(f"{path} is not inside {self.root}") from None

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
            return self.restore_files([s.file_id for s in self.restorable(Scope([rel]))])
        rec = self.state.by_path(rel)
        if rec is None:  # maybe a file you moved here
            moved = {s.path: s.file_id for s in self.status() if "moved" in s.states}
            rec = self.state.get(moved[rel]) if rel in moved else None
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
        return done

    def list_dir(self, rel: str = "") -> list[Entry]:
        """A folder's contents as the app shows them; see `browse.list_dir`."""
        return list_dir(self.root, self.state, self.layout, self.status(), rel.strip("/"))

