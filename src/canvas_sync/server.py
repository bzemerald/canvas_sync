"""Local HTTP API for the desktop app (`canvas serve`).

Listens on 127.0.0.1 only, and every request must carry `Authorization: Bearer <token>`:
other programs on the machine, and web pages in a browser, can reach localhost too.
The app starts this process, reads `{"port": ..., "token": ...}` from its first line
of stdout, and talks to it from then on.

What it keeps between requests is in backend.py; the routes are in routes/, by what they're for.
"""

from __future__ import annotations

import asyncio
import json
import os
import secrets
import socket
import sys
import threading
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from dataclasses import asdict
from pathlib import Path
from typing import Any

from fastapi import Depends, FastAPI
from fastapi.middleware.cors import CORSMiddleware

from . import __version__, assistants
from .backend import Backend, SyncRequest, canvas_command, mcp_args
from .config import PREFS_FILE, Account
from .routes import account as account_routes, courses, files, opening, search

# Where the Tauri webview loads the UI from (production on macOS/Linux, Windows, dev server).
APP_ORIGINS = ["tauri://localhost", "http://tauri.localhost", "https://tauri.localhost", "http://localhost:1420"]


def create_app(account: Account | None, token: str, prefs_path: Path = PREFS_FILE, background: bool = False) -> FastAPI:
    """The API. `account` None: not set up yet (the app shows its sign-in). `background`:
    also sync automatically, as the preferences say."""
    b = Backend(account, token, prefs_path)

    @asynccontextmanager
    async def lifespan(_: FastAPI) -> AsyncIterator[None]:
        timer = asyncio.create_task(b.scheduler()) if background else None
        if background:  # AI apps still pointing at where this app was (moved, reinstalled)
            b.spawn(asyncio.to_thread(assistants.repair, canvas_command(), mcp_args(), b.home / "backups"))
        yield
        if timer:
            timer.cancel()

    b.update_files()
    app = FastAPI(title="canvas-sync", version=__version__, lifespan=lifespan)
    app.add_middleware(
        CORSMiddleware, allow_origins=APP_ORIGINS, allow_methods=["*"], allow_headers=["*"],
    )
    api = FastAPI(dependencies=[Depends(b.authorized), Depends(b.ready)])

    @api.get("/health")
    def health() -> dict[str, Any]:
        a = b.account
        return {"ok": True, "version": __version__, "set_up": a is not None, "choosing": b.choosing(),
                "folder_missing": b.missing(),
                "root": str(a.root) if a else None, "canvas": a.base_url if a else None}

    @api.get("/sync")
    def sync_state() -> dict[str, Any]:
        return b.sync_state()

    @api.post("/sync", status_code=202)
    async def sync(req: SyncRequest | None = None) -> dict[str, Any]:
        b.start_sync(req or SyncRequest())
        return b.sync_state()

    @api.post("/reindex")
    def reindex() -> dict[str, Any]:
        with b.engine() as e:
            return asdict(e.reindex())

    for part in (account_routes, courses, files, search, opening):
        api.include_router(part.routes(b))
    app.mount("/api", api)
    return app


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


def serve(account: Account | None, port: int = 0, token: str | None = None, exit_with_stdin: bool = False) -> None:
    import uvicorn

    if exit_with_stdin:
        _exit_when_stdin_closes()

    token = token or os.environ.get("CANVAS_SERVER_TOKEN") or secrets.token_urlsafe(32)
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    sock.bind(("127.0.0.1", port))
    sock.listen(128)  # connections made before uvicorn is up wait instead of being refused
    print(json.dumps({"port": sock.getsockname()[1], "token": token}), flush=True)
    config = uvicorn.Config(create_app(account, token, background=True), log_level="warning")
    uvicorn.Server(config).run(sockets=[sock])
