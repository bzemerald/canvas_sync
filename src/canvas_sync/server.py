"""Local HTTP API for the desktop app (`canvas serve`).

Listens on 127.0.0.1 only, and every request must carry `Authorization: Bearer <token>`:
other programs on the machine, and web pages in a browser, can reach localhost too.
The app starts this process, reads `{"port": ..., "token": ...}` from its first line
of stdout, and talks to it from then on.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import secrets
import socket
import sys
import threading
import webbrowser
from collections.abc import AsyncIterator, Iterator
from contextlib import asynccontextmanager, contextmanager
from dataclasses import asdict, dataclass, field, replace
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from urllib.parse import urlencode, urljoin, urlsplit

import httpx

from fastapi import Depends, FastAPI, Header, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, Response
from pydantic import BaseModel

from . import __version__, content
from .content import news, news_counts
from .api import CanvasClient, CanvasError
from .discover import FILE_REF
from .config import (
    PREFS_FILE, Account, AppPrefs, ConfigError, PinnedCourse, PinnedFolder, SmartFolder, delete_smart_folder,
    move_pinned, pin, save_pinned, save_smart_folder, set_course_select, unpin,
)
from .search import course_label
from .engine import Engine
from .local import open_path
from .plan import Kind, Scope
from .state import META_DIR, NEWS_KINDS
from .thumbs import thumbnail

# Where the Tauri webview loads the UI from (production on macOS/Linux, Windows, dev server).
APP_ORIGINS = ["tauri://localhost", "http://tauri.localhost", "https://tauri.localhost", "http://localhost:1420"]

TRANSFERS = (Kind.DOWNLOAD, Kind.UPDATE, Kind.CONFLICT)
MEDIA_MAX_BYTES = 25 * 1024 * 1024
DEFAULT_ROOT = Path("~/Canvas")
# What works before an account is set up: enough to set one up.
SETUP_PATHS = {"/health", "/prefs", "/account", "/account/setup", "/open"}
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
    errors: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)

    @property
    def running(self) -> bool:
        return self.phase in ("checking", "downloading", "indexing")


class OpenRequest(BaseModel):
    path: str | None = None    # relative to the sync folder
    url: str | None = None     # Canvas URL, relative to the Canvas base URL
    external: str | None = None  # any http(s) link, in the browser
    reveal: bool = False       # show in the file manager instead of opening
    preview: bool = False      # Quick Look (macOS)


class LaunchRequest(BaseModel):
    """An external tool to open: from the course menu, a module item, an assignment, or a link."""
    course_id: int
    tool_id: int | None = None
    module_item_id: int | None = None
    assignment_id: int | None = None
    url: str | None = None  # the tool's launch URL (links like /external_tools/retrieve?url=...)


class SeenRequest(BaseModel):
    kinds: list[str] | None = None  # announcement / assignment / page / file; None: all


class ScopeRequest(BaseModel):
    """A term, course, folder or file: paths relative to the sync folder, and/or file ids."""

    paths: list[str] = []
    file_ids: list[int] = []

    def scope(self) -> Scope | None:
        return Scope(self.paths, set(self.file_ids)) if self.paths or self.file_ids else None


class PrefsRequest(BaseModel):
    """What to change; what's left out stays."""
    language: str | None = None
    auto_sync: int | None = None
    sync_on_launch: bool | None = None
    select: str | None = None  # which courses to sync: active | favorites (in the folder's config.toml)


class SetupRequest(BaseModel):
    url: str                 # the Canvas site, e.g. bcourses.berkeley.edu
    token: str
    root: str | None = None  # the sync folder; default: the current one, or ~/Canvas


class TokenRequest(BaseModel):
    token: str


class SyncRequest(ScopeRequest):
    courses: list[int] | None = None  # default: every course `pull` would sync


class RestoreRequest(ScopeRequest):
    dry_run: bool = False


class PathRequest(BaseModel):
    path: str


class PinRequest(BaseModel):
    path: str | None = None    # a folder
    course: int | None = None  # or a course


class PathsRequest(BaseModel):
    paths: list[str]


class DeleteRequest(PathsRequest):
    dry_run: bool = False
    stop_syncing_folders: bool = True  # also don't download what Canvas adds to the folders later


class RenameRequest(BaseModel):
    path: str
    name: str


class MoveRequest(BaseModel):
    index: int
    to: int


class SmartFolderRequest(BaseModel):
    name: str
    query: str = ""
    courses: list[int] = []
    kinds: list[str] = []
    content: bool = False
    replaces: str | None = None  # renaming: the old name


def create_app(account: Account | None, token: str, prefs_path: Path = PREFS_FILE, background: bool = False) -> FastAPI:
    """The API. `account` None: not set up yet (the app shows its sign-in). `background`:
    also sync automatically, as the preferences say."""

    @asynccontextmanager
    async def lifespan(_: FastAPI) -> AsyncIterator[None]:
        timer = asyncio.create_task(scheduler()) if background else None
        yield
        if timer:
            timer.cancel()

    app = FastAPI(title="canvas-sync", version=__version__, lifespan=lifespan)
    app.add_middleware(
        CORSMiddleware, allow_origins=APP_ORIGINS, allow_methods=["*"], allow_headers=["*"],
    )
    job = SyncJob()
    tasks: set[asyncio.Task[None]] = set()

    def authorized(authorization: str = Header(default="")) -> None:
        if not secrets.compare_digest(authorization, f"Bearer {token}"):
            raise HTTPException(401, "bad token")

    def ready(request: Request) -> None:
        if account is None:
            path = request.url.path
            if path[path.find("/api") + 4:] not in SETUP_PATHS:
                raise HTTPException(409, "not set up")

    def prefs() -> AppPrefs:
        return AppPrefs.load(prefs_path)

    @contextmanager
    def engine() -> Iterator[Engine]:
        # One Engine per request: SQLite connections belong to the thread that made them.
        assert account is not None  # (see `ready`)
        with Engine(account.root) as e:
            yield e

    api = FastAPI(dependencies=[Depends(authorized), Depends(ready)])

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
        return {"ok": True, "version": __version__, "set_up": account is not None,
                "root": str(account.root) if account else None, "canvas": account.base_url if account else None}

    # -- preferences and the account --------------------------------------------------------

    @api.get("/prefs")
    def get_prefs() -> dict[str, Any]:
        out: dict[str, Any] = asdict(prefs())
        if account is not None:
            with engine() as e:
                out["select"] = e.settings.select
        return out

    @api.post("/prefs")
    def set_prefs(req: PrefsRequest) -> dict[str, Any]:
        changes = {k: v for k, v in req.model_dump().items() if v is not None and k != "select"}
        try:
            replace(prefs(), **changes).save(prefs_path)
            if req.select is not None:
                if account is None:
                    raise HTTPException(409, "not set up")
                set_course_select(account.root / META_DIR / "config.toml", req.select)
        except ConfigError as err:
            raise HTTPException(400, str(err))
        return get_prefs()

    def account_info() -> dict[str, Any]:
        if account is None:
            return {"set_up": False, "signed_in": False, "base_url": None, "root": None, "user": None}
        return {"set_up": True, "signed_in": bool(account.token()), "base_url": account.base_url,
                "root": str(account.root), "user": account.user}

    @api.get("/account")
    def get_account() -> dict[str, Any]:
        return account_info()

    @api.get("/account/check")
    async def check_account() -> dict[str, Any]:
        """Whether the saved token still works (it expires, or can be revoked on Canvas)."""
        assert account is not None
        if not (saved := account.token()):
            return {"ok": False, "error": "not signed in"}
        try:
            me = await _who(account.base_url, saved)
        except HTTPException as err:
            return {"ok": False, "error": err.detail}
        if me.get("name") and me["name"] != account.user:
            account.user = me["name"]
            account.save()
        return {"ok": True, "user": account.user}

    @api.post("/account/setup")
    async def set_up(req: SetupRequest) -> dict[str, Any]:
        """Sign in, or switch to another account or school: check the token, settle on the
        sync folder, save both. The folder's files and settings are left as they are."""
        nonlocal account
        if job.running:
            raise HTTPException(409, "wait for the sync to finish")
        url, new_token = _canvas_site(req.url), req.token.strip()
        if not new_token:
            raise HTTPException(400, "token rejected")
        me = await _who(url, new_token)
        root = Path(req.root).expanduser() if req.root else (account.root if account else DEFAULT_ROOT.expanduser())
        if root.exists() and not root.is_dir():
            raise HTTPException(400, "not a folder")
        ours = (root / META_DIR).is_dir()
        if root.exists() and not ours and any(not p.name.startswith(".") for p in root.iterdir()):
            raise HTTPException(400, "folder not empty")
        if ours and account and account.root.resolve() == root.resolve() and account.base_url != url:
            raise HTTPException(400, "folder belongs to another Canvas site")
        new = Account(url, Engine.init_root(root), me.get("name") or None)
        if account and account.base_url != url:
            account.clear_token()  # signed out of the old site
        new.save()
        new.set_token(new_token)
        account = new
        try:
            start_sync(SyncRequest())  # what you signed in for
        except HTTPException:
            pass
        return account_info()

    @api.post("/account/token")
    async def replace_token(req: TokenRequest) -> dict[str, Any]:
        """A new token for the same account (the old one expired, or was revoked)."""
        assert account is not None
        new_token = req.token.strip()
        me = await _who(account.base_url, new_token)
        account.user = me.get("name") or account.user
        account.save()
        account.set_token(new_token)
        return account_info()

    @api.post("/account/signout")
    def sign_out() -> dict[str, Any]:
        """Forget the token. Files, settings and what's been synced stay; signing in again resumes."""
        assert account is not None
        if job.running:
            raise HTTPException(409, "wait for the sync to finish")
        account.clear_token()
        return account_info()

    @api.post("/open/config")
    def open_config() -> dict[str, str]:
        """The sync folder's config.toml, in your text editor: the settings the app doesn't show."""
        assert account is not None
        target = account.root / META_DIR / "config.toml"
        open_path(target)
        return {"opened": str(target)}

    @api.get("/courses")
    def courses() -> list[dict[str, Any]]:
        with engine() as e:
            out = []
            for c in e.state.courses():
                d, canonical = e.layout.course_dir(c), e.layout.canonical_course_dir(c)
                term_renamed = len(d.parts) > 1 and d.parent.name != canonical.parent.name
                out.append({
                    **asdict(c), "dir": d.as_posix(),
                    "display_code": e.settings.course_names.get(c.id) or c.code,
                    "label": course_label(c, e.settings),       # what the app calls it
                    "renamed": d.name != canonical.name,         # you gave it a name
                    "default_name": canonical.name,              # renaming to this undoes that
                    "term_label": d.parent.name if term_renamed else c.term,
                    "new": sum(news_counts(news(e.state, e.root, c.id)).values()),  # things you haven't opened
                })
            return out

    @api.get("/search")
    def search(q: str = "", limit: int = 50, course: list[int] = Query(default=[]),
               kind: list[str] = Query(default=[]), names_only: bool = False) -> list[dict[str, Any]]:
        with engine() as e:
            return [h.to_dict() for h in e.search(q, min(limit, 500), course or None, kind or None, names_only)]

    # -- a course's page ------------------------------------------------------------------

    @api.get("/courses/{course_id}/overview")
    def course_overview(course_id: int) -> dict[str, Any]:
        with engine() as e:
            return content.overview(e.state, e.root, course_id)

    @api.get("/courses/{course_id}/modules")
    def course_modules(course_id: int) -> list[dict[str, Any]]:
        with engine() as e:
            return content.modules(e.state, e.root, e.layout, course_id)

    @api.get("/courses/{course_id}/items")
    def course_items(course_id: int, kind: str) -> list[dict[str, Any]]:
        if kind not in content.KINDS:
            raise HTTPException(400, f"kind must be one of {content.KINDS}")
        with engine() as e:
            return content.items(e.state, e.root, course_id, kind)

    @api.get("/courses/{course_id}/items/{kind}/{doc_id}")
    def course_item(course_id: int, kind: str, doc_id: str) -> dict[str, Any]:
        """One item in full. Opening it is reading it: it's no longer new."""
        with engine() as e:
            found = content.item(e.state, e.root, course_id, kind, doc_id)
            if found is not None:
                e.state.mark_seen(course_id, [(kind, doc_id)])
        if found is None:
            raise HTTPException(404, "not found (pull to fetch what's new)")
        return found

    @api.get("/courses/{course_id}/grades")
    def course_grades(course_id: int) -> dict[str, Any]:
        with engine() as e:
            return content.grades(e.state, e.root, course_id)

    @api.post("/courses/{course_id}/seen")
    def course_seen(course_id: int, req: SeenRequest | None = None) -> dict[str, int]:
        """Mark everything new in a course (or just some kinds of things) as seen."""
        kinds = (req.kinds if req else None) or None
        if kinds and set(kinds) - set(NEWS_KINDS):
            raise HTTPException(400, f"kinds must be among {NEWS_KINDS}")
        with engine() as e:
            e.state.mark_seen(course_id, kinds=kinds)
            return news_counts(news(e.state, e.root, course_id))

    @api.get("/media")
    async def media(url: str) -> Response:
        """An image in a page. Canvas files we have come from disk; anything else is
        fetched (with the Canvas token only for Canvas itself) and cached."""
        target = urljoin(account.base_url + "/", url)
        parts = urlsplit(target)
        if parts.scheme not in ("http", "https"):
            raise HTTPException(400, "only web images")
        on_canvas = parts.netloc == urlsplit(account.base_url).netloc
        if on_canvas and (m := FILE_REF.search(parts.path)) and m[1] in ("", "courses"):
            with engine() as e:
                rec = e.state.get(int(m[3]))
            if rec and rec.path and not rec.ignored and (account.root / rec.path).is_file():
                return FileResponse(account.root / rec.path)
        cache = account.root / META_DIR / "cache" / "media" / hashlib.sha1(target.encode()).hexdigest()
        if cache.exists() and cache.with_suffix(".type").exists():
            return FileResponse(cache, media_type=cache.with_suffix(".type").read_text())
        try:
            if on_canvas:
                token = account.token()
                if not token:
                    raise HTTPException(400, "no Canvas token")
                async with CanvasClient(account.base_url, token) as client:
                    body, ctype = await client.fetch(target, MEDIA_MAX_BYTES)
            else:
                async with httpx.AsyncClient(follow_redirects=True, timeout=20) as plain:
                    resp = await plain.get(target)
                    resp.raise_for_status()
                    if len(resp.content) > MEDIA_MAX_BYTES:
                        raise HTTPException(413, "too large")
                    body, ctype = resp.content, resp.headers.get("content-type", "")
        except (CanvasError, httpx.HTTPError) as err:
            raise HTTPException(502, f"could not fetch the image: {err}")
        if not ctype.startswith("image/"):
            raise HTTPException(415, "not an image")
        cache.parent.mkdir(parents=True, exist_ok=True)
        cache.write_bytes(body)
        cache.with_suffix(".type").write_text(ctype.split(";")[0])
        return Response(body, media_type=ctype, headers={"Cache-Control": "max-age=86400"})

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
            if job.running:
                raise HTTPException(409, "wait for the sync to finish")
            try:
                restored = e.restore_in(scope)
            except LookupError as err:
                raise HTTPException(409, str(err))
            e.reindex()
            return {"restored": restored}

    def changing(paths: list[str]) -> None:
        if job.running:
            raise HTTPException(409, "wait for the sync to finish")
        if not paths:
            raise HTTPException(400, "say which files")
        for p in paths:
            inside(p)

    @api.post("/delete")
    def delete(req: DeleteRequest) -> dict[str, Any]:
        changing(req.paths)
        with engine() as e:
            try:
                if req.dry_run:
                    return e.delete_preview(req.paths)
                deleted = e.delete(req.paths, req.stop_syncing_folders)
            except ValueError as err:
                raise HTTPException(400, str(err))
            except LookupError as err:
                raise HTTPException(404, str(err))
            e.reindex()
            return {"deleted": deleted}

    @api.post("/untrack")
    def untrack(req: PathsRequest) -> dict[str, int]:
        changing(req.paths)
        with engine() as e:
            try:
                n = e.untrack(req.paths)
            except ValueError as err:
                raise HTTPException(400, str(err))
            except LookupError as err:
                raise HTTPException(404, str(err))
            e.reindex()
            return {"files": n}

    @api.post("/track")
    def track(req: PathsRequest) -> dict[str, int]:
        changing(req.paths)
        with engine() as e:
            try:
                n = e.track(req.paths)
            except (ValueError, LookupError) as err:
                raise HTTPException(400, str(err))
            e.reindex()
            return {"files": n}

    def config() -> Path:
        """The sync folder's config.toml (pinned items live there)."""
        assert account is not None
        return account.root / META_DIR / "config.toml"

    @api.get("/pinned")
    def pinned() -> list[dict[str, Any]]:
        """The sidebar's pinned list: courses, folders and smart folders, in order."""
        with engine() as e:
            dirs = {e.layout.course_dir(c).as_posix(): c.id for c in e.state.courses()}
            items = list(e.settings.pinned)
            # A course's folder pinned before courses could be: it's the course that was meant.
            if any(isinstance(i, PinnedFolder) and i.path in dirs for i in items):
                converted = [PinnedCourse(dirs[i.path]) if isinstance(i, PinnedFolder) and i.path in dirs else i for i in items]
                items = [i for n, i in enumerate(converted) if i not in converted[:n]]  # (pinned twice: once)
                save_pinned(config(), items)
            out: list[dict[str, Any]] = []
            for item in items:
                if isinstance(item, PinnedCourse):
                    out.append({"type": "course", "id": item.course, "exists": item.course in dirs.values()})
                elif isinstance(item, PinnedFolder):
                    course = next((cid for d, cid in dirs.items() if item.path == d or item.path.startswith(d + "/")), None)
                    out.append({"type": "folder", "path": item.path, "course_id": course,
                                "exists": (account.root / item.path).is_dir()})
                else:
                    out.append({"type": "smart", **asdict(item)})
            return out

    def pin_item(req: PinRequest) -> PinnedFolder | PinnedCourse:
        if req.course is not None:
            return PinnedCourse(req.course)
        if req.path is None:
            raise HTTPException(400, "say what to pin")
        if not inside(req.path).is_dir():
            raise HTTPException(404, f"{req.path} is not a folder")
        return PinnedFolder(req.path.strip("/"))

    @api.post("/pinned")
    def add_pin(req: PinRequest) -> list[dict[str, Any]]:
        item = pin_item(req)
        with engine() as e:
            dirs = {e.layout.course_dir(c).as_posix(): c.id for c in e.state.courses()}
        if isinstance(item, PinnedFolder) and item.path in dirs:
            item = PinnedCourse(dirs[item.path])  # a course's own folder: pin the course
        pin(config(), item)
        return pinned()

    @api.post("/pinned/remove")
    def remove_pin(req: PinRequest) -> list[dict[str, Any]]:
        try:
            unpin(config(), PinnedCourse(req.course) if req.course is not None else PinnedFolder((req.path or "").strip("/")))
        except LookupError as err:
            raise HTTPException(404, str(err))
        return pinned()

    @api.post("/pinned/move")
    def move(req: MoveRequest) -> list[dict[str, Any]]:
        try:
            move_pinned(config(), req.index, req.to)
        except LookupError as err:
            raise HTTPException(400, str(err))
        return pinned()

    @api.post("/rename")
    def rename(req: RenameRequest) -> dict[str, str]:
        if job.running:
            raise HTTPException(409, "wait for the sync to finish")
        inside(req.path)
        with engine() as e:
            try:
                new = e.rename_folder(req.path, req.name)
            except (ValueError, FileExistsError) as err:
                raise HTTPException(400, str(err))
            except LookupError as err:
                raise HTTPException(404, str(err))
            e.reindex()  # paths changed; the text is reused, so this is quick
        return {"path": new}

    @api.post("/smart-folders")
    def save_folder(req: SmartFolderRequest) -> list[dict[str, Any]]:
        if not req.name.strip():
            raise HTTPException(400, "a smart folder needs a name")
        folder = SmartFolder(req.name.strip(), req.query.strip(), req.courses, req.kinds, req.content)
        try:
            save_smart_folder(config(), folder, req.replaces)
        except ConfigError as err:
            raise HTTPException(400, str(err))
        return pinned()

    @api.delete("/smart-folders/{name}")
    def delete_folder(name: str) -> list[dict[str, Any]]:
        try:
            delete_smart_folder(config(), name)
        except LookupError as err:
            raise HTTPException(404, str(err))
        return pinned()

    @api.get("/status")
    def status() -> list[dict[str, Any]]:
        with engine() as e:
            return [asdict(s) for s in e.status()]

    @api.post("/open")
    def open_(req: OpenRequest) -> dict[str, str]:
        if account is None and not req.external:
            raise HTTPException(409, "not set up")
        assert account is not None or req.external
        if req.path is not None and account is not None:
            target = inside(req.path)
            if not target.exists():
                raise HTTPException(404, f"{req.path} does not exist")
            open_path(target, reveal=req.reveal, preview=req.preview)
            if not req.reveal:  # opening (or previewing) a file is seeing it
                with engine() as e:
                    if rec := e.state.by_path(req.path.strip("/")):
                        e.state.mark_seen(rec.course_id, [("file", str(rec.id))])
            return {"opened": str(target)}
        if req.external:
            if urlsplit(req.external).scheme not in ("http", "https", "mailto"):
                raise HTTPException(400, "only web links")
            webbrowser.open(req.external)
            return {"opened": req.external}
        if req.url and account is not None:
            if not req.url.startswith("/"):
                raise HTTPException(400, "url must be relative to the Canvas site")
            webbrowser.open(account.base_url + req.url)
            return {"opened": account.base_url + req.url}
        raise HTTPException(400, "give a path or a url")

    @api.post("/launch")
    async def launch(req: LaunchRequest) -> dict[str, Any]:
        """Open an external tool in the browser, signed in: Canvas makes a one-time launch
        link. Where Canvas won't (some schools and tools turn it off), the tool's page on Canvas."""
        cid = req.course_id
        if req.module_item_id is not None:
            params = {"launch_type": "module_item", "module_item_id": req.module_item_id}
            fallback = f"/courses/{cid}/modules/items/{req.module_item_id}"
        elif req.assignment_id is not None:
            params = {"launch_type": "assessment", "assignment_id": req.assignment_id}
            fallback = f"/courses/{cid}/assignments/{req.assignment_id}"
        elif req.tool_id is not None:
            params = {"id": req.tool_id, "launch_type": "course_navigation"}  # as its tab in the menu does
            fallback = f"/courses/{cid}/external_tools/{req.tool_id}"
        elif req.url:
            if urlsplit(req.url).scheme not in ("http", "https"):
                raise HTTPException(400, "only web links")
            params = {"url": req.url}
            fallback = f"/courses/{cid}/external_tools/retrieve?{urlencode({'url': req.url})}"
        else:
            raise HTTPException(400, "say which tool")
        target, signed_in = account.base_url + fallback, False
        if token := account.token():
            try:
                async with CanvasClient(account.base_url, token) as client:
                    got = await client.sessionless_launch(cid, params)
                url = got.get("url") if isinstance(got, dict) else None
                # Only ever a link on Canvas itself: it carries the sign-in.
                if isinstance(url, str) and urlsplit(url).netloc == urlsplit(account.base_url).netloc \
                        and urlsplit(url).scheme in ("http", "https"):
                    target, signed_in = url, True
            except (CanvasError, httpx.HTTPError):
                pass
        webbrowser.open(target)
        return {"opened": target, "signed_in": signed_in}

    @api.post("/reindex")
    def reindex() -> dict[str, Any]:
        with engine() as e:
            return asdict(e.reindex())

    @api.get("/sync")
    def sync_state() -> dict[str, Any]:
        last = None if job.running else last_synced()
        return {**asdict(job), "running": job.running, "last_synced": last.isoformat() if last else None}

    def start_sync(req: SyncRequest) -> None:
        nonlocal job
        assert account is not None
        if job.running:
            raise HTTPException(409, "a sync is already running")
        canvas_token = account.token()
        if not canvas_token:
            raise HTTPException(400, "not signed in to Canvas")
        scope_paths(req)
        job = SyncJob(phase="checking", started_at=_now(), scope=req.paths)
        task = asyncio.create_task(_run_sync(account, canvas_token, req.courses, req.scope(), job))
        tasks.add(task)
        task.add_done_callback(tasks.discard)

    @api.post("/sync", status_code=202)
    async def sync(req: SyncRequest | None = None) -> dict[str, Any]:
        start_sync(req or SyncRequest())
        return sync_state()

    # -- syncing by itself ----------------------------------------------------------------------

    def last_synced() -> datetime | None:
        """When a sync last finished (any sync; including one before the app started)."""
        times = [datetime.fromisoformat(job.finished_at)] if job.finished_at else []
        if account is not None:
            with engine() as e:
                if stored := e.state.last_synced():
                    times.append(stored)
        return max(times, default=None)

    def sync_if_due(within: timedelta) -> None:
        if account is None or not _due(last_synced(), within, datetime.now(timezone.utc)):
            return
        try:
            start_sync(SyncRequest())
        except HTTPException:
            pass  # signed out, or already syncing

    async def scheduler() -> None:
        """Sync when the app opens (unless it just did), then as often as the preferences say."""
        await asyncio.sleep(STARTUP_DELAY)
        if prefs().sync_on_launch:
            sync_if_due(LAUNCH_GRACE)
        while True:
            await asyncio.sleep(TICK)
            try:
                p = prefs()
                if p.auto_sync:
                    sync_if_due(timedelta(minutes=p.auto_sync))
            except Exception:  # keep the timer alive whatever one round runs into
                pass

    app.mount("/api", api)
    return app


def _due(last: datetime | None, every: timedelta, now: datetime) -> bool:
    return last is None or now - last >= every


def _canvas_site(url: str) -> str:
    """"bcourses.berkeley.edu" or a link to any page there -> "https://bcourses.berkeley.edu"."""
    url = url.strip()
    if "://" not in url:
        url = "https://" + url
    parts = urlsplit(url)
    host = parts.hostname or ""
    if parts.scheme not in ("http", "https") or parts.username or not ("." in host or host == "localhost"):
        raise HTTPException(400, "not a web address")
    if parts.scheme == "http" and parts.hostname not in ("localhost", "127.0.0.1"):
        raise HTTPException(400, "https only")  # the token would travel unencrypted
    return f"{parts.scheme}://{parts.netloc}"


async def _who(url: str, token: str) -> dict[str, Any]:
    """Your profile on that Canvas, if the token works there; else a 400 saying why. One try,
    no retries: this is someone waiting on a sign-in form."""
    try:
        async with httpx.AsyncClient(timeout=15, follow_redirects=True) as http:
            resp = await http.get(f"{url}/api/v1/users/self", headers={"Authorization": f"Bearer {token}"})
    except httpx.HTTPError:
        raise HTTPException(400, "can't reach the site")
    if resp.status_code == 401:
        raise HTTPException(400, "token rejected")
    try:
        me = resp.json()
    except ValueError:
        me = None
    if not resp.is_success or not isinstance(me, dict) or "id" not in me:
        raise HTTPException(400, "not a Canvas site")
    return me


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

                # Even with nothing to download: this is what stores new announcements,
                # assignments, pages and modules.
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


def serve(account: Account | None, port: int = 0, token: str | None = None, exit_with_stdin: bool = False) -> None:
    import uvicorn

    if exit_with_stdin:
        _exit_when_stdin_closes()

    token = token or os.environ.get("CANVAS_SERVER_TOKEN") or secrets.token_urlsafe(32)
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    sock.bind(("127.0.0.1", port))
    print(json.dumps({"port": sock.getsockname()[1], "token": token}), flush=True)
    config = uvicorn.Config(create_app(account, token, background=True), log_level="warning")
    uvicorn.Server(config).run(sockets=[sock])
