"""What the app's HTTP API (server.py, routes/) keeps between requests: the account, the sync
running, search by meaning getting ready, the sync folder on its way elsewhere; and what every
route asks of it (an Engine, a path inside the folder, the preferences)."""

from __future__ import annotations

import asyncio
import secrets
import sys
import threading
from collections.abc import Coroutine, Iterator
from contextlib import contextmanager
from dataclasses import asdict, dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from fastapi import Header, HTTPException, Request
from pydantic import BaseModel

from . import migrations
from .api import Auth, CanvasClient, CanvasError
from .config import PREFS_FILE, Account, AppPrefs
from .engine import Engine
from .local import inside as in_folder
from .paths import config_file
from .plan import TRANSFERS, Kind, Scope
from .sync import keep_sign_in, other_sources, reindex

# What works before an account is set up: enough to set one up.
SETUP_PATHS = {"/health", "/prefs", "/account", "/account/setup", "/open"}
# What can be asked while the sync folder moves: none of it opens the folder's databases.
WHILE_MOVING = {"/health", "/sync", "/account", "/account/move"}
# Opening the app syncs, unless it synced this recently.
LAUNCH_GRACE = timedelta(minutes=10)
STARTUP_DELAY = 3.0  # seconds before that first sync, so the app comes up first
TICK = 60.0          # how often to see whether an automatic sync is due


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


@dataclass
class SyncJob:
    phase: str = "idle"  # idle | checking | downloading | indexing | done | failed
    scope: list[str] = field(default_factory=list)  # paths synced; empty = everything
    started_at: str | None = None
    finished_at: str | None = None
    total: int = 0       # files to transfer
    done: int = 0
    current: str = ""
    changes: dict[str, int] = field(default_factory=dict)
    errors: list[str] = field(default_factory=list)  # why it failed (phase "failed")
    failed: list[dict[str, str]] = field(default_factory=list)  # files that didn't sync: path, error
    warnings: list[str] = field(default_factory=list)  # what couldn't be read this time (tried again next)
    ed_error: str | None = None  # Ed went wrong (see ed.py); the rest synced anyway
    expired: bool = False  # Canvas no longer takes the token or the browser sign-in

    @property
    def running(self) -> bool:
        return self.phase in ("checking", "downloading", "indexing")


@dataclass
class MeaningJob:
    """Getting search by meaning ready: its model downloaded, the index's text cut into passages."""
    phase: str = "idle"  # idle | downloading | indexing | failed
    done: int = 0        # bytes downloaded, or items cut
    total: int = 0
    error: str = ""


class ScopeRequest(BaseModel):
    """A term, course, folder or file: paths relative to the sync folder, and/or file ids."""

    paths: list[str] = []
    file_ids: list[int] = []

    def scope(self) -> Scope | None:
        return Scope(self.paths, set(self.file_ids)) if self.paths or self.file_ids else None


class SyncRequest(ScopeRequest):
    courses: list[int] | None = None  # default: every course `pull` would sync


class Backend:
    """The app's backend as it is now. `account` None: not set up yet."""

    def __init__(self, account: Account | None, token: str, prefs_path: Path = PREFS_FILE) -> None:
        self.account = account
        self.token = token
        self.prefs_path = prefs_path
        self.home = prefs_path.parent  # the app's own folder (models/ is in it)
        self.job = SyncJob()
        self.meaning_job = MeaningJob()
        self.moving = False  # the sync folder is on its way elsewhere (POST /account/move)
        self.busy = 0  # requests being answered that use the sync folder: a move waits for them
        self.counting = threading.Lock()
        self.tasks: set[asyncio.Task[Any]] = set()

    # -- every request ------------------------------------------------------------------------

    def authorized(self, authorization: str = Header(default="")) -> None:
        if not secrets.compare_digest(authorization, f"Bearer {self.token}"):
            raise HTTPException(401, "bad token")

    def ready(self, request: Request) -> Iterator[None]:
        path = request.url.path
        path = path[path.find("/api") + 4:]
        if self.account is None and path not in SETUP_PATHS:
            raise HTTPException(409, "not set up")
        counted = path not in WHILE_MOVING
        with self.counting:
            if self.moving and counted:
                raise HTTPException(409, "moving the sync folder")  # (its databases are on their way)
            self.busy += counted
        try:
            if self.missing() and path not in SETUP_PATHS | {"/account/folder"}:
                raise HTTPException(409, "sync folder missing")
            yield
        finally:
            with self.counting:
                self.busy -= counted

    # -- what routes ask for ------------------------------------------------------------------

    @property
    def root(self) -> Path:
        assert self.account is not None  # (see `ready`)
        return self.account.root

    def missing(self) -> bool:
        """The sync folder isn't where it was (moved, renamed or deleted)."""
        return self.account is not None and not self.moving and not config_file(self.account.root).exists()

    def prefs(self) -> AppPrefs:
        return AppPrefs.load(self.prefs_path)

    @contextmanager
    def engine(self) -> Iterator[Engine]:
        # One Engine per request: SQLite connections belong to the thread that made them.
        with Engine(self.root) as e:
            yield e

    def config(self) -> Path:
        """The sync folder's config.toml."""
        return config_file(self.root)

    def inside(self, rel: str) -> Path:
        try:
            return in_folder(self.root, rel)
        except ValueError as err:
            raise HTTPException(400, str(err))

    def scope_paths(self, req: ScopeRequest) -> None:
        for p in req.paths:
            self.inside(p)

    def canvas(self, auth: Auth) -> CanvasClient:
        """A client of the account's Canvas, signed in with `auth`."""
        assert self.account is not None
        return CanvasClient(self.account.base_url, auth)

    def spawn(self, work: Coroutine[Any, Any, Any]) -> None:
        """Run in the background, kept until done."""
        task = asyncio.create_task(work)
        self.tasks.add(task)
        task.add_done_callback(self.tasks.discard)

    def update_files(self) -> None:
        """The sync folder and app.toml as an older version left them, the way this one keeps them."""
        migrations.update(self.account.root if self.account is not None else None, self.prefs_path)

    def choosing(self) -> bool:
        """Signed in to a folder that has never synced: which courses to sync is chosen first
        (Canvas leaves most past courses "active", so syncing them all would bring every term)."""
        if self.account is None or self.moving or self.missing():
            return False
        with Engine(self.account.root) as e:
            return e.state.last_synced() is None

    # -- syncing ------------------------------------------------------------------------------

    def start_sync(self, req: SyncRequest) -> None:
        assert self.account is not None
        if self.job.running:
            raise HTTPException(409, "a sync is already running")
        if self.moving:
            raise HTTPException(409, "moving the sync folder")
        auth = self.account.auth()
        if not auth:
            raise HTTPException(400, "not signed in to Canvas")
        self.scope_paths(req)
        self.job = SyncJob(phase="checking", started_at=_now(), scope=req.paths)
        self.spawn(_run_sync(self, auth, req.courses, req.scope(), self.job))

    def try_sync(self) -> None:
        """Sync everything, unless signed out or one's running (the next brings it)."""
        try:
            self.start_sync(SyncRequest())
        except HTTPException:
            pass

    def unless_syncing(self) -> None:
        if self.job.running:
            raise HTTPException(409, "wait for the sync to finish")

    def sync_state(self) -> dict[str, Any]:
        last = None if self.job.running or self.moving else self.last_synced()
        return {**asdict(self.job), "running": self.job.running, "last_synced": last.isoformat() if last else None}

    def last_synced(self) -> datetime | None:
        """When a sync last finished (any sync; including one before the app started)."""
        times = [datetime.fromisoformat(self.job.finished_at)] if self.job.finished_at else []
        if self.account is not None:
            with self.engine() as e:
                if stored := e.state.last_synced():
                    times.append(stored)
        return max(times, default=None)

    def sync_if_due(self, within: timedelta) -> None:
        if self.account is None or self.moving or self.missing() or self.choosing() \
                or not _due(self.last_synced(), within, datetime.now(timezone.utc)):
            return
        self.try_sync()

    async def scheduler(self) -> None:
        """Sync when the app opens (unless it just did), then as often as the preferences say."""
        await asyncio.sleep(STARTUP_DELAY)
        if self.prefs().sync_on_launch:
            self.sync_if_due(LAUNCH_GRACE)
        while True:
            await asyncio.sleep(TICK)
            try:
                p = self.prefs()
                if p.auto_sync:
                    self.sync_if_due(timedelta(minutes=p.auto_sync))
            except Exception:  # keep the timer alive whatever one round runs into
                pass


def canvas_command() -> str:
    """The `canvas` program this is: the app's packed backend, or the one beside this Python (.venv)."""
    if getattr(sys, "frozen", False) or sys.platform == "win32":  # (PyInstaller; Windows: see mcp_args)
        return sys.executable
    return str(Path(sys.executable).parent / "canvas")


def mcp_args() -> list[str]:
    """What to give canvas_command for `canvas mcp`. On Windows, a .venv's canvas.exe is unsigned, and
    Smart App Control may block it: there it's the signed Python, running the package."""
    return ["-m", "canvas_sync", "mcp"] if sys.platform == "win32" and not getattr(sys, "frozen", False) else ["mcp"]


def _due(last: datetime | None, every: timedelta, now: datetime) -> bool:
    return last is None or now - last >= every


async def _sync_canvas(account: Account, client: CanvasClient, course_ids: list[int] | None, scope: Scope | None,
                       job: SyncJob) -> None:
    with Engine(account.root, client) as e:
        courses = None
        if course_ids is not None:
            courses = [c for c in await e.courses() if c.id in course_ids]
        plan = await e.plan(courses, scope)
        job.warnings = plan.warnings
        work = [a for a in plan.actions if a.kind != Kind.SKIP]
        for a in work:
            if a.kind not in (Kind.LINK, Kind.UNLINK):
                job.changes[a.kind.value] = job.changes.get(a.kind.value, 0) + 1
        job.total = sum(a.kind in TRANSFERS for a in work)
        job.phase = "downloading"

        def on_event(a: Any, error: str | None) -> None:
            if a.kind in TRANSFERS:
                job.done += 1
                job.current = a.path or a.name or ""
            if error:
                job.failed.append({"path": a.path or a.name or "", "error": error})

        # Even with nothing to download: this is what stores new announcements,
        # assignments, pages and modules.
        await e.apply(plan, on_event)
        if scope is None:
            job.current = "Ed"
            job.ed_error = await other_sources(e, account, [x.course.id for x in plan.snapshots])


async def _run_sync(b: Backend, auth: Auth, course_ids: list[int] | None, scope: Scope | None, job: SyncJob) -> None:
    account = b.account
    assert account is not None
    try:
        async with b.canvas(auth) as client:
            await _sync_canvas(account, client, course_ids, scope, job)
            keep_sign_in(account, client, auth)

        job.phase, job.done, job.total, job.current = "indexing", 0, 0, ""

        def index() -> None:
            def progress(done: int, total: int, title: str) -> None:
                job.done, job.total, job.current = done, total, title

            with Engine(account.root) as e:
                reindex(e, b.prefs_path, progress, lambda done, total: progress(done, total, ""))

        await asyncio.to_thread(index)
        job.phase = "done"
    except CanvasError as err:
        job.phase, job.expired = "failed", err.signed_out
        hint = " (Canvas token expired or revoked?)" if auth.kind == "token" else " (signed out of Canvas)"
        job.errors.append(str(err) + (hint if job.expired else ""))
    except Exception as err:  # surfaced to the UI rather than lost in a background task
        job.phase = "failed"
        job.errors.append(f"{type(err).__name__}: {err}")
    finally:
        job.finished_at, job.current = _now(), ""
