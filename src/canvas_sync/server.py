"""Local HTTP API for the desktop app (`canvas serve`).

Listens on 127.0.0.1 only, and every request must carry `Authorization: Bearer <token>`:
other programs on the machine, and web pages in a browser, can reach localhost too.
The app starts this process, reads `{"port": ..., "token": ...}` from its first line
of stdout, and talks to it from then on.
"""

from __future__ import annotations

import asyncio
import json
import os
import secrets
import socket
import sys
import threading
import webbrowser
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from fastapi import Depends, FastAPI, Header, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from pydantic import BaseModel

from . import __version__
from .api import CanvasClient, CanvasError
from .config import Account, ConfigError, SmartFolder, delete_smart_folder, save_smart_folder
from .engine import Engine
from .local import open_path
from .plan import Kind, Scope
from .state import META_DIR
from .thumbs import thumbnail

# Where the Tauri webview loads the UI from (production on macOS/Linux, Windows, dev server).
APP_ORIGINS = ["tauri://localhost", "http://tauri.localhost", "https://tauri.localhost", "http://localhost:1420"]

TRANSFERS = (Kind.DOWNLOAD, Kind.UPDATE, Kind.CONFLICT)


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
    errors: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)

    @property
    def running(self) -> bool:
        return self.phase in ("checking", "downloading", "indexing")


class OpenRequest(BaseModel):
    path: str | None = None    # relative to the sync folder
    url: str | None = None     # Canvas URL, relative to the Canvas base URL
    reveal: bool = False       # show in the file manager instead of opening
    preview: bool = False      # Quick Look (macOS)


class ScopeRequest(BaseModel):
    """A term, course, folder or file: paths relative to the sync folder, and/or file ids."""

    paths: list[str] = []
    file_ids: list[int] = []

    def scope(self) -> Scope | None:
        return Scope(self.paths, set(self.file_ids)) if self.paths or self.file_ids else None


class SyncRequest(ScopeRequest):
    courses: list[int] | None = None  # default: every course `pull` would sync


class RestoreRequest(ScopeRequest):
    dry_run: bool = False


class SmartFolderRequest(BaseModel):
    name: str
    query: str = ""
    courses: list[int] = []
    kinds: list[str] = []
    content: bool = False
    replaces: str | None = None  # renaming: the old name


def create_app(account: Account, token: str) -> FastAPI:
    app = FastAPI(title="canvas-sync", version=__version__)
    app.add_middleware(
        CORSMiddleware, allow_origins=APP_ORIGINS, allow_methods=["*"], allow_headers=["*"],
    )
    job = SyncJob()
    tasks: set[asyncio.Task[None]] = set()

    def authorized(authorization: str = Header(default="")) -> None:
        if not secrets.compare_digest(authorization, f"Bearer {token}"):
            raise HTTPException(401, "bad token")

    @contextmanager
    def engine() -> Iterator[Engine]:
        # One Engine per request: SQLite connections belong to the thread that made them.
        with Engine(account.root) as e:
            yield e

    api = FastAPI(dependencies=[Depends(authorized)])

    def inside(rel: str) -> Path:
        """root/rel, refusing anything that resolves outside the sync folder or into .canvas."""
        root = account.root.resolve()
        target = (account.root / rel).resolve()
        if target != root and root not in target.parents:
            raise HTTPException(400, "path is outside the sync folder")
        if (root / META_DIR) in [target, *target.parents]:
            raise HTTPException(400, "that's canvas-sync's own folder")
        return account.root / rel

    def scope_paths(req: ScopeRequest) -> None:
        for p in req.paths:
            inside(p)

    @api.get("/health")
    def health() -> dict[str, Any]:
        return {"ok": True, "version": __version__, "root": str(account.root), "canvas": account.base_url}

    @api.get("/courses")
    def courses() -> list[dict[str, Any]]:
        with engine() as e:
            return [
                {**asdict(c), "dir": str(e.layout.course_dir(c)),
                 "display_code": e.settings.course_names.get(c.id) or c.code}
                for c in e.state.courses()
            ]

    @api.get("/search")
    def search(q: str = "", limit: int = 50, course: list[int] = Query(default=[]),
               kind: list[str] = Query(default=[]), names_only: bool = False) -> list[dict[str, Any]]:
        with engine() as e:
            return [h.to_dict() for h in e.search(q, min(limit, 500), course or None, kind or None, names_only)]

    @api.get("/tree")
    def tree(path: str = "") -> list[dict[str, Any]]:
        if path:
            inside(path)
        with engine() as e:
            try:
                return [asdict(x) for x in e.list_dir(path)]
            except LookupError as err:
                raise HTTPException(404, str(err))

    @api.get("/thumb")
    def thumb(path: str, size: int = 256) -> FileResponse:
        inside(path)
        out = thumbnail(account.root, path, size)
        if out is None:
            raise HTTPException(404, "no thumbnail for this file")
        return FileResponse(out, media_type="image/jpeg", headers={"Cache-Control": "max-age=3600"})

    @api.post("/restore")
    def restore(req: RestoreRequest) -> dict[str, Any]:
        scope_paths(req)
        scope = req.scope()
        if scope is None:
            raise HTTPException(400, "say what to restore")
        with engine() as e:
            todo = e.restorable(scope)
            if req.dry_run:
                return {"files": [asdict(s) for s in todo]}
            try:
                return {"restored": e.restore_files([s.file_id for s in todo])}
            except LookupError as err:
                raise HTTPException(409, str(err))

    @api.get("/smart-folders")
    def smart_folders() -> list[dict[str, Any]]:
        with engine() as e:
            return [asdict(f) for f in e.settings.smart_folders]

    @api.post("/smart-folders")
    def save_folder(req: SmartFolderRequest) -> list[dict[str, Any]]:
        if not req.name.strip():
            raise HTTPException(400, "a smart folder needs a name")
        folder = SmartFolder(req.name.strip(), req.query.strip(), req.courses, req.kinds, req.content)
        try:
            save_smart_folder(account.root / META_DIR / "config.toml", folder, req.replaces)
        except ConfigError as err:
            raise HTTPException(400, str(err))
        return smart_folders()

    @api.delete("/smart-folders/{name}")
    def delete_folder(name: str) -> list[dict[str, Any]]:
        try:
            delete_smart_folder(account.root / META_DIR / "config.toml", name)
        except LookupError as err:
            raise HTTPException(404, str(err))
        return smart_folders()

    @api.get("/status")
    def status() -> list[dict[str, Any]]:
        with engine() as e:
            return [asdict(s) for s in e.status()]

    @api.post("/open")
    def open_(req: OpenRequest) -> dict[str, str]:
        if req.path is not None:
            target = inside(req.path)
            if not target.exists():
                raise HTTPException(404, f"{req.path} does not exist")
            open_path(target, reveal=req.reveal, preview=req.preview)
            return {"opened": str(target)}
        if req.url:
            if not req.url.startswith("/"):
                raise HTTPException(400, "url must be relative to the Canvas site")
            webbrowser.open(account.base_url + req.url)
            return {"opened": account.base_url + req.url}
        raise HTTPException(400, "give a path or a url")

    @api.post("/reindex")
    def reindex() -> dict[str, Any]:
        with engine() as e:
            return asdict(e.reindex())

    @api.get("/sync")
    def sync_state() -> dict[str, Any]:
        return {**asdict(job), "running": job.running}

    @api.post("/sync", status_code=202)
    async def sync(req: SyncRequest | None = None) -> dict[str, Any]:
        nonlocal job
        if job.running:
            raise HTTPException(409, "a sync is already running")
        canvas_token = account.token()
        if not canvas_token:
            raise HTTPException(400, "no Canvas token; run `canvas init`")
        req = req or SyncRequest()
        scope_paths(req)
        job = SyncJob(phase="checking", started_at=_now(), scope=req.paths)
        task = asyncio.create_task(_run_sync(account, canvas_token, req.courses, req.scope(), job))
        tasks.add(task)
        task.add_done_callback(tasks.discard)
        return sync_state()

    app.mount("/api", api)
    return app


async def _run_sync(account: Account, canvas_token: str, course_ids: list[int] | None, scope: Scope | None,
                    job: SyncJob) -> None:
    try:
        async with CanvasClient(account.base_url, canvas_token) as client:
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
                        job.errors.append(f"{a.path or a.name}: {error}")

                if work:
                    await e.apply(plan, on_event)

        job.phase, job.done, job.total, job.current = "indexing", 0, 0, ""

        def index() -> None:
            def progress(done: int, total: int, title: str) -> None:
                job.done, job.total, job.current = done, total, title

            with Engine(account.root) as e:
                e.reindex(progress)

        await asyncio.to_thread(index)
        job.phase = "done"
    except CanvasError as err:
        job.phase = "failed"
        job.errors.append(str(err) + (" (Canvas token expired or revoked?)" if err.status == 401 else ""))
    except Exception as err:  # surfaced to the UI rather than lost in a background task
        job.phase = "failed"
        job.errors.append(f"{type(err).__name__}: {err}")
    finally:
        job.finished_at, job.current = _now(), ""


def _exit_when_stdin_closes() -> None:
    """The app keeps our stdin open. When it goes away, however it went (quit, crash,
    killed by a dev-mode rebuild), the pipe closes and we go too."""
    def watch() -> None:
        try:
            while sys.stdin.buffer.read(4096):
                pass
        finally:
            os._exit(0)

    threading.Thread(target=watch, name="parent-watch", daemon=True).start()


def serve(account: Account, port: int = 0, token: str | None = None, exit_with_stdin: bool = False) -> None:
    import uvicorn

    if exit_with_stdin:
        _exit_when_stdin_closes()

    token = token or os.environ.get("CANVAS_SERVER_TOKEN") or secrets.token_urlsafe(32)
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    sock.bind(("127.0.0.1", port))
    print(json.dumps({"port": sock.getsockname()[1], "token": token}), flush=True)
    config = uvicorn.Config(create_app(account, token), log_level="warning")
    uvicorn.Server(config).run(sockets=[sock])
