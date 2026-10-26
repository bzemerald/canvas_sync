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
import re
import secrets
import socket
import sys
import threading
import webbrowser
from collections.abc import AsyncIterator, Callable, Iterator
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
from . import ed, meaning
from .catalog import abbreviations, catalog
from .meaning import Meaning
from .models import Course
from .content import news, news_counts
from .api import CanvasClient, CanvasError
from .discover import FILE_REF
from .config import (
    PREFS_FILE, Account, AppPrefs, ConfigError, CourseLayout, migrate, needs_migration, save_course_place, save_pinned,
    save_sidebar_order, set_course_icon, set_course_select, set_courses_hidden, set_courses_syncing, set_ed_courses,
)
from .engine import Engine
from .local import open_path
from .places import PLACES, Place, as_course, describe, usual
from .plan import Kind, Scope
from .search import course_label
from .state import META_DIR, NEWS_KINDS
from .things import Entry, parse_entry
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
    ed_error: str | None = None  # Ed went wrong (see ed.py); the rest synced anyway

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


@dataclass
class MeaningJob:
    """Getting search by meaning ready: its model downloaded, the index's text cut into passages."""
    phase: str = "idle"  # idle | downloading | indexing | failed
    done: int = 0        # bytes downloaded, or items cut
    total: int = 0
    error: str = ""


class MeaningRequest(BaseModel):
    on: bool


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


class EdLinkRequest(BaseModel):
    ed: int  # an Ed course
    course: int | None  # the course it is (None: none)


class PlaceRequest(BaseModel):
    """What a place holds, in order (things as written down, with `title` and `hidden`)."""
    entries: list[dict[str, Any]]


class NoteRequest(BaseModel):
    text: str


class OpenedRequest(BaseModel):
    """Something was opened: the app's key for it, and what had been typed in search (if anything)."""
    key: str
    query: str = ""


class IconRequest(BaseModel):
    """One of: an icon from the app's set (with a color), an emoji, "none", or nothing (the app picks)."""
    icon: str | None = None
    color: str | None = None
    emoji: str | None = None


class HideRequest(BaseModel):
    hidden: bool
    syncing: bool | None = None  # False: also stop syncing it; True: sync it again; None: leave as is
    courses: list[int] = []      # /courses/hide: which (a whole term)


class FolderRequest(BaseModel):
    root: str
    new: bool  # True: an empty folder, to sync into anew; False: the old one, moved


class ChoiceRequest(BaseModel):
    sync: list[int]  # the courses chosen
    skip: list[int]  # the rest


class SidebarRequest(BaseModel):
    terms: list[str] | None = None    # the terms in order (Canvas's names for them)
    courses: list[int] | None = None  # course ids in order


class SyncRequest(ScopeRequest):
    courses: list[int] | None = None  # default: every course `pull` would sync


class RestoreRequest(ScopeRequest):
    dry_run: bool = False


class PathRequest(BaseModel):
    path: str


class PathsRequest(BaseModel):
    paths: list[str]


class DeleteRequest(PathsRequest):
    dry_run: bool = False
    stop_syncing_folders: bool = True  # also don't download what Canvas adds to the folders later


class RenameRequest(BaseModel):
    path: str
    name: str


def create_app(account: Account | None, token: str, prefs_path: Path = PREFS_FILE, background: bool = False) -> FastAPI:
    """The API. `account` None: not set up yet (the app shows its sign-in). `background`:
    also sync automatically, as the preferences say."""

    @asynccontextmanager
    async def lifespan(_: FastAPI) -> AsyncIterator[None]:
        timer = asyncio.create_task(scheduler()) if background else None
        yield
        if timer:
            timer.cancel()

    def update_files() -> None:
        """config.toml and app.toml written as an older version did, the way this one does."""
        try:
            if account is not None and needs_migration(cfg := account.root / META_DIR / "config.toml"):
                with Engine(account.root) as e:
                    migrate(cfg, lambda course: [t["id"] for t in content.tools(e.state, course)])
            AppPrefs.migrate(prefs_path)
        except Exception:  # (a broken config.toml: every request says so)
            pass

    update_files()
    app = FastAPI(title="canvas-sync", version=__version__, lifespan=lifespan)
    app.add_middleware(
        CORSMiddleware, allow_origins=APP_ORIGINS, allow_methods=["*"], allow_headers=["*"],
    )
    job = SyncJob()
    meaning_job = MeaningJob()
    home = prefs_path.parent  # the app's own folder (models/ is in it)
    tasks: set[asyncio.Task[None]] = set()

    def authorized(authorization: str = Header(default="")) -> None:
        if not secrets.compare_digest(authorization, f"Bearer {token}"):
            raise HTTPException(401, "bad token")

    def ready(request: Request) -> None:
        path = request.url.path
        path = path[path.find("/api") + 4:]
        if account is None and path not in SETUP_PATHS:
            raise HTTPException(409, "not set up")
        if missing() and path not in SETUP_PATHS | {"/account/folder"}:
            raise HTTPException(409, "sync folder missing")

    def missing() -> bool:
        """The sync folder isn't where it was (moved, renamed or deleted)."""
        return account is not None and not (account.root / META_DIR / "config.toml").exists()

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

    def choosing() -> bool:
        """Signed in to a folder that has never synced: which courses to sync is chosen first
        (Canvas leaves most past courses "active", so syncing them all would bring every term)."""
        if account is None or missing():
            return False
        with Engine(account.root) as e:
            return e.state.last_synced() is None

    @api.get("/health")
    def health() -> dict[str, Any]:
        return {"ok": True, "version": __version__, "set_up": account is not None, "choosing": choosing(),
                "folder_missing": missing(),
                "root": str(account.root) if account else None, "canvas": account.base_url if account else None}

    # -- preferences and the account --------------------------------------------------------

    @api.get("/prefs")
    def get_prefs() -> dict[str, Any]:
        p = prefs()
        out: dict[str, Any] = {"language": p.language, "auto_sync": p.auto_sync, "sync_on_launch": p.sync_on_launch}
        if account is not None and not missing():
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
        new = Account(url, sync_folder(root, url), me.get("name") or None)
        if account and account.base_url != url:
            account.clear_token()  # signed out of the old site
        new.save()
        new.set_token(new_token)
        account = new
        update_files()
        if not choosing():  # (else the first sync starts once the courses are chosen)
            try:
                start_sync(SyncRequest())  # what you signed in for
            except HTTPException:
                pass
        return account_info()

    def sync_folder(root: Path, url: str, new: bool = True) -> Path:
        """A folder to sync into, set up: an empty one (or not there yet), or one that has synced
        before (only that, unless `new`)."""
        if root.exists() and not root.is_dir():
            raise HTTPException(400, "not a folder")
        ours = (root / META_DIR / "config.toml").is_file()
        if not new and not ours:
            raise HTTPException(400, "not a sync folder")
        if root.exists() and not ours and any(not p.name.startswith(".") for p in root.iterdir()):
            raise HTTPException(400, "folder not empty")
        if ours and account and account.root.resolve() == root.resolve() and account.base_url != url:
            raise HTTPException(400, "folder belongs to another Canvas site")
        return Engine.init_root(root)

    @api.post("/account/folder")
    async def move_folder(req: FolderRequest) -> dict[str, Any]:
        """The sync folder went missing: where it is now, or a new one to sync into anew. The
        account stays signed in; the first sync of a new one waits for the courses to be chosen."""
        assert account is not None
        if job.running:
            raise HTTPException(409, "wait for the sync to finish")
        account.root = sync_folder(Path(req.root).expanduser(), account.base_url, req.new)
        account.save()
        update_files()
        if not choosing():
            try:
                start_sync(SyncRequest())
            except HTTPException:
                pass  # signed out
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

    # -- Ed (ed.py) ---------------------------------------------------------------------------

    def ed_info() -> dict[str, Any]:
        assert account is not None
        with engine() as e:
            links = {eid: cid for cid, eid in e.settings.ed_courses.items() if eid}
            return {
                "connected": bool(account.ed_token()), "user": account.ed_user,
                "token_page": ed.TOKEN_PAGE.format(region=account.ed_region or "us"),
                **e.state.source(ed.SOURCE),  # ok_at, error: how it went last
                "courses": [{**x, "course": links.get(x["id"])} for x in e.state.ed_courses()],
                "canvas": [{"id": c.id, "label": course_label(c, e.settings), "term": c.term} for c in e.state.courses()],
            }

    @api.get("/ed")
    def get_ed() -> dict[str, Any]:
        return ed_info()

    @api.post("/ed/connect")
    async def connect_ed(req: TokenRequest) -> dict[str, Any]:
        """Connect Ed with a token made in its settings (or a new one): which region's it is, who
        you are there, your courses there, each linked to its Canvas course. Then a sync brings
        what's on them."""
        assert account is not None
        new_token = req.token.strip()
        try:
            region, me = await ed.find(new_token)
        except ed.EdError as err:
            raise HTTPException(400, err.reason)
        account.set_ed_token(region, new_token)
        account.ed_region, account.ed_user = region, me["user"].get("name") or None
        account.save()
        with engine() as e:
            try:
                async with ed.EdClient(new_token, region) as client:
                    await ed.refresh(e, client)
                e.state.record_source(ed.SOURCE)
            except ed.EdError as err:
                e.state.record_source(ed.SOURCE, err.reason)
            e.state.commit()
        try:
            start_sync(SyncRequest())
        except HTTPException:
            pass  # one's running (the next brings Ed), or signed out of Canvas
        return ed_info()

    @api.post("/ed/disconnect")
    def disconnect_ed() -> dict[str, Any]:
        """Forget the Ed token. What came from Ed stays, and which course each Ed course is."""
        assert account is not None
        account.clear_ed_token()
        account.ed_region = account.ed_user = None
        account.save()
        return ed_info()

    @api.put("/ed/link")
    def link_ed(req: EdLinkRequest) -> dict[str, Any]:
        """Which course an Ed course is; None: none (and it isn't matched again)."""
        with engine() as e:
            changes = {cid: 0 for cid, eid in e.settings.ed_courses.items() if eid == req.ed}
            if req.course is not None:
                if all(c.id != req.course for c in e.state.courses()):
                    raise HTTPException(404, "no such course")
                changes[req.course] = req.ed
            else:
                for cid in ed.match([x for x in e.state.ed_courses() if x["id"] == req.ed], e.state.courses()):
                    if cid not in e.settings.ed_courses:  # (its match, which isn't linked yet: not later either)
                        changes[cid] = 0
            set_ed_courses(e.root / META_DIR / "config.toml", changes)
        return ed_info()

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
                    # Where what's from each part of Canvas goes (files, modules, attachments).
                    "source_dirs": {k: e.layout.renamed(canonical / v).as_posix() for k, v in e.settings.view_dirs.items()},
                    "new": sum(news_counts(news(e.state, e.root, c.id)).values()),  # things you haven't opened
                    "icon": e.settings.course_icons.get(c.id),  # chosen; None: the app picks one
                    "hidden": c.id in e.settings.hidden,      # not shown in the sidebar or search
                    "excluded": c.id in e.settings.exclude,   # not synced
                })
            return out

    @api.get("/courses/choice")
    async def course_choice() -> dict[str, Any]:
        """Your courses on Canvas, to choose which sync: each with its term's dates and its own,
        and whether it syncs now. `chosen`: the config already says which (not just `select`)."""
        assert account is not None
        if not (token := account.token()):
            raise HTTPException(400, "not signed in to Canvas")
        try:
            async with CanvasClient(account.base_url, token) as client:
                with Engine(account.root, client) as e:
                    out = []
                    for d in await e.course_data():
                        c, term = Course.from_api(d), d.get("term") or {}
                        out.append({
                            "id": c.id, "code": c.code, "name": c.name, "label": course_label(c, e.settings),
                            "term": c.term, "term_start": term.get("start_at"), "term_end": term.get("end_at"),
                            "start_at": d.get("start_at"), "end_at": d.get("end_at"),
                            "favorite": c.is_favorite, "syncing": e.is_selected(c),
                        })
                    s = e.settings
                    return {"select": s.select, "chosen": bool(s.include or s.exclude), "courses": out}
        except (CanvasError, httpx.HTTPError) as err:
            raise HTTPException(502, f"could not list the courses: {err}")

    @api.put("/courses/choice")
    async def choose_courses(req: ChoiceRequest) -> dict[str, Any]:
        """Which courses sync, as chosen; the first sync starts when this is the first choice."""
        first = choosing()
        with engine() as e:
            set_courses_syncing(config(), req.sync, req.skip, include=e.settings.select != "active")
        if first:
            start_sync(SyncRequest())
        return sync_state()

    @api.get("/search")
    def search(q: str = "", limit: int = 50, course: list[int] = Query(default=[]),
               kind: list[str] = Query(default=[]), names_only: bool = False, under: str = "") -> list[dict[str, Any]]:
        """`under`: only files in that folder (the app's search box, on a course's 文件 tab)."""
        if under:
            inside(under)
        with engine() as e:
            if not course and e.settings.hidden:  # hidden courses only turn up when asked for by name
                course = [c.id for c in e.state.courses() if c.id not in e.settings.hidden]
                if not course:
                    return []
            return [h.to_dict() for h in e.search(q, min(limit, 500), course or None, kind or None, names_only, under or None)]

    @api.get("/find")
    def find(q: str = "", limit: int = 40, course: list[int] = Query(default=[]), kind: list[str] = Query(default=[]),
             since: str = "", until: str = "", source: str = "", under: str = "") -> dict[str, Any]:
        """The app's search as you type (its find.ts), in the index: `q` is only words to find
        (what was typed, read: no courses in it; "quoted" ones as they are); `course`, `kind`,
        `since`/`until` and `source` (ed): what the app read as narrowing it down; `under`: only
        files in that folder (searching from a course's 文件). `corrected`: words taken for
        others, misspelled ("midtrem": midterm)."""
        if under:
            inside(under)
        with engine() as e:
            folder, also = e.folder_scope(under or None)
            if not course and e.settings.hidden:  # (as /search)
                course = [c.id for c in e.state.courses() if c.id not in e.settings.hidden]
                if not course:
                    return {"hits": [], "corrected": {}}
            # Words nothing has (misspelled, likely) are taken for the nearest words there are.
            corrected = e.index.corrections(q, abbreviations(e))
            q = e.index.corrected(q, corrected)
            hits = e.index.search(q, e.state.courses(), e.settings, min(limit, 500), course or None, kind or None,
                                  under=folder, also=also, literal=True, since=since or None, until=until or None,
                                  source=source or None)
            # By meaning too (when it's on), for what's said in a few words: what the words alone
            # didn't find.
            if len(q.split()) >= 2 and not under and prefs().meaning and meaning.downloaded(home):
                codes = {c.id: course_label(c, e.settings) for c in e.state.courses()}
                had = {(h.kind, h.course_id, h.path or h.url or h.title) for h in hits}
                hits += [h for h in Meaning(e.index).search(q, meaning.embedder(home), codes, course or None, kind or None,
                                                            since or None, until or None, source=source or None)
                         if (h.kind, h.course_id, h.path or h.url or h.title) not in had]
            return {"hits": [h.to_dict() for h in hits], "corrected": corrected}

    @api.get("/catalog")
    def catalog_() -> dict[str, Any]:
        """Everything search can go to by name (see catalog.py), what words stand for, and what
        you open: how often and lately, and what you'd typed for what."""
        with engine() as e:
            return {"things": catalog(e), "abbreviations": abbreviations(e), **e.state.usage()}

    @api.post("/opened")
    def opened(req: OpenedRequest) -> dict[str, bool]:
        if not req.key.strip() or len(req.key) > 1000:
            raise HTTPException(400, "say what was opened")
        with engine() as e:
            e.state.record_opened(req.key, " ".join(req.query.lower().split())[:80])
        return {"recorded": True}

    # -- a course's page ------------------------------------------------------------------

    @api.get("/courses/{course_id}/overview")
    def course_overview(course_id: int) -> dict[str, Any]:
        with engine() as e:
            out = content.overview(e.state, e.root, course_id)
            # This week's modules, for the overview's 当前模块 card.
            out["current_modules"] = [m for m in content.modules(e.state, e.root, e.layout, course_id) if m["current"]][:2]
            return out

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
    async def course_item(course_id: int, kind: str, doc_id: str) -> dict[str, Any]:
        """One item in full. Opening it is reading it: it's no longer new. One from Ed comes
        with its replies as they are now (fetched, when there are new ones)."""
        with engine() as e:
            if doc_id.startswith("ed-") and account.ed_region and (ed_token := account.ed_token()):
                await ed.fetch_replies(e, ed_token, account.ed_region, course_id, kind, doc_id)
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
            return FileResponse(cache, media_type=cache.with_suffix(".type").read_text(encoding="utf-8"))
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
        cache.with_suffix(".type").write_text(ctype.split(";")[0], encoding="utf-8")
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

    def course_dirs(e: Engine) -> dict[str, int]:
        return {e.layout.course_dir(c).as_posix(): c.id for c in e.state.courses()}

    def place_entries(req: PlaceRequest, home: int | None = None) -> list[Entry]:
        out: list[Entry] = []
        for d in req.entries:
            entry = parse_entry(d, home)
            if entry is None:
                raise HTTPException(400, f"that doesn't make sense: {d}")
            if all(x.thing != entry.thing for x in out):
                out.append(entry)
        return out

    @api.get("/pinned")
    def pinned() -> list[dict[str, Any]]:
        """置顶: what's pinned, in order, each as it's called now."""
        with engine() as e:
            items = as_course(e.settings.pinned, course_dirs(e))
            if items != e.settings.pinned:
                save_pinned(config(), items)
            return describe(items, e)

    @api.put("/pinned")
    def arrange_pinned(req: PlaceRequest) -> list[dict[str, Any]]:
        """置顶 as it should be: anything, in this order."""
        items = place_entries(req)
        with engine() as e:
            save_pinned(config(), as_course(items, course_dirs(e)))
        return pinned()

    @api.post("/courses/{course_id}/icon")
    def course_icon(course_id: int, req: IconRequest) -> dict[str, Any]:
        if req.emoji is not None and not 0 < len(req.emoji) <= 16:
            raise HTTPException(400, "one emoji")
        if req.icon is not None and not re.fullmatch(r"[a-z0-9-]{1,40}", req.icon):
            raise HTTPException(400, "not an icon name")
        if req.color is not None and not re.fullmatch(r"[a-z]{1,20}", req.color):
            raise HTTPException(400, "not a color name")
        icon = {"emoji": req.emoji} if req.emoji else {"icon": req.icon, "color": req.color or ""} if req.icon else None
        set_course_icon(config(), course_id, icon)
        with engine() as e:
            return {"icon": e.settings.course_icons.get(course_id)}

    def hide(course_ids: list[int], req: HideRequest) -> None:
        if req.hidden:
            # A hidden course isn't on show anywhere: it's unpinned, and so is what's pinned from it.
            with engine() as e:
                items = e.settings.pinned
                shown = [x for x, d in zip(items, describe(items, e)) if d["in_course"] not in course_ids]
            if shown != items:
                save_pinned(config(), shown)
        set_courses_hidden(config(), course_ids, req.hidden, syncing=req.syncing)

    # -- a course's page, arranged ------------------------------------------------------------

    def place(e: Engine, course_id: int, name: str) -> Place:
        tools = [t["id"] for t in content.tools(e.state, course_id)] if name == "links" else []
        default = (prefs().tabs or usual("tabs")) if name == "tabs" else (prefs().overview or usual("overview")) if name == "overview" else []
        course = next((c for c in e.state.courses() if c.id == course_id), None)
        return Place(name, course_id, tools, default, e.layout.course_dir(course).as_posix() if course else None)

    def own_layout(e: Engine, course_id: int) -> CourseLayout:
        return e.settings.course_layouts.get(course_id) or CourseLayout()

    def layout_of(course_id: int) -> dict[str, Any]:
        """The course's page: its tabs, overview and 工具与链接, each with all it holds, in order."""
        with engine() as e:
            own = own_layout(e, course_id)
            out: dict[str, Any] = {"own": {}}
            for name in PLACES:
                p, stored = place(e, course_id, name), getattr(own, name)
                out[name] = describe(p.arranged(stored), e)
                out["own"][name] = p.is_arranged(stored)  # (else it follows the default)
            return out

    def known(name: str) -> None:
        if name not in PLACES:
            raise HTTPException(404, f"places are {PLACES}")

    @api.get("/courses/{course_id}/layout")
    def course_layout(course_id: int) -> dict[str, Any]:
        return layout_of(course_id)

    @api.put("/courses/{course_id}/layout/{name}")
    def arrange_course(course_id: int, name: str, req: PlaceRequest) -> dict[str, Any]:
        """One of the course's places as it should be. Its own things it leaves out are put back
        where the default has them: they're hidden, not taken away."""
        known(name)
        items = place_entries(req, course_id)
        with engine() as e:
            p = place(e, course_id, name)
            if other := [x.thing.to_dict() for x in items if not p.holds(x.thing)]:
                raise HTTPException(400, f"not this course's: {other}")  # (its places hold only its things)
            save_course_place(config(), course_id, name, p.settle(items))
        return layout_of(course_id)

    @api.post("/courses/{course_id}/layout/{name}/reset")
    def reset_course_layout(course_id: int, name: str) -> dict[str, Any]:
        """Back to the default (as other courses are). What was added stays, after the rest."""
        known(name)
        with engine() as e:
            save_course_place(config(), course_id, name, place(e, course_id, name).added(getattr(own_layout(e, course_id), name)))
        return layout_of(course_id)

    @api.post("/courses/{course_id}/layout/{name}/default")
    def make_default_layout(course_id: int, name: str) -> dict[str, Any]:
        """The course's own things here (its views), as it has them, become the default: for every
        course that isn't arranged for itself. (What it added is its own.)"""
        if name not in ("tabs", "overview"):
            raise HTTPException(404, "tabs or overview")
        with engine() as e:
            p, stored = place(e, course_id, name), getattr(own_layout(e, course_id), name)
            mine = [Entry(replace(x.thing, course=None), x.title, x.hidden) for x in p.arranged(stored) if p.own(x.thing)]
            replace(prefs(), **{name: mine}).save(prefs_path)
            save_course_place(config(), course_id, name, place(e, course_id, name).settle(stored))
        return layout_of(course_id)

    def note_file(course_id: int, note: str) -> Path:
        if not re.fullmatch(r"[a-z0-9-]{1,40}", note):
            raise HTTPException(400, "not a note id")
        assert account is not None
        return account.root / META_DIR / "notes" / str(course_id) / f"{note}.md"

    @api.get("/courses/{course_id}/notes/{note}")
    def read_note(course_id: int, note: str) -> dict[str, str]:
        f = note_file(course_id, note)
        return {"text": f.read_text(encoding="utf-8") if f.exists() else ""}

    @api.put("/courses/{course_id}/notes/{note}")
    def write_note(course_id: int, note: str, req: NoteRequest) -> dict[str, str]:
        """A note card's text, as typed (kept in the sync folder, under .canvas/notes)."""
        if len(req.text) > 1_000_000:
            raise HTTPException(413, "too long")
        f = note_file(course_id, note)
        f.parent.mkdir(parents=True, exist_ok=True)
        tmp = f.with_suffix(".tmp")
        tmp.write_text(req.text, encoding="utf-8")
        tmp.replace(f)
        return {"text": req.text}

    @api.post("/courses/{course_id}/hide")
    def hide_course(course_id: int, req: HideRequest) -> dict[str, Any]:
        """Hide a course from the app (and maybe stop syncing it), or bring it back."""
        hide([course_id], req)
        with engine() as e:
            return {"hidden": course_id in e.settings.hidden, "excluded": course_id in e.settings.exclude}

    @api.post("/courses/hide")
    def hide_courses(req: HideRequest) -> dict[str, Any]:
        """The same for several courses (a whole term)."""
        hide(req.courses, req)
        with engine() as e:
            return {"hidden": [c for c in req.courses if c in e.settings.hidden],
                    "excluded": [c for c in req.courses if c in e.settings.exclude]}

    @api.get("/sidebar")
    def sidebar() -> dict[str, Any]:
        """How you arranged the sidebar: the order of terms, and of courses in them."""
        with engine() as e:
            return {"terms": e.settings.term_order, "courses": e.settings.course_order}

    @api.post("/sidebar")
    def arrange_sidebar(req: SidebarRequest) -> dict[str, Any]:
        save_sidebar_order(config(), req.terms, req.courses)
        return sidebar()

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
        task = asyncio.create_task(_run_sync(account, canvas_token, req.courses, req.scope(), job, after_index))
        tasks.add(task)
        task.add_done_callback(tasks.discard)

    def after_index(e: Engine, progress: meaning.ProgressHandler) -> None:
        """After a sync's indexing: passages for what changed, when searching by meaning is on."""
        if prefs().meaning and meaning.downloaded(home):
            Meaning(e.index).sync(meaning.embedder(home), progress)

    # -- searching by meaning (meaning.py) --------------------------------------------------------

    def get_meaning() -> dict[str, Any]:
        out: dict[str, Any] = {"on": prefs().meaning, "model": meaning.downloaded(home), **asdict(meaning_job)}
        if account is not None:
            with engine() as e:
                out["items"], out["covered"] = Meaning(e.index).counts()
        return out

    @api.get("/meaning")
    def meaning_state() -> dict[str, Any]:
        """Searching by meaning: on or not, its model downloaded or not, what's being done to get
        it ready (downloading the model, cutting the index's text into passages), and how much of
        the index has passages (items, covered)."""
        return get_meaning()

    def prepare_meaning() -> None:
        """The model downloaded if it isn't, then passages for what has none (in the background)."""
        mj = meaning_job
        try:
            if not meaning.downloaded(home):
                mj.phase, mj.done, mj.total, mj.error = "downloading", 0, 0, ""
                meaning.download(home, lambda done, total: (setattr(mj, "done", done), setattr(mj, "total", total)))
            if account is not None and prefs().meaning:
                with Engine(account.root) as e:
                    m = Meaning(e.index)
                    items, covered = m.counts()
                    if covered < items:  # (turned off and on again: nothing to do)
                        mj.phase, mj.done, mj.total = "indexing", 0, items - covered
                        m.sync(meaning.embedder(home), lambda done, total: (setattr(mj, "done", done), setattr(mj, "total", total)))
            mj.phase, mj.error = "idle", ""
        except Exception as err:  # (offline, say: shown in 设置)
            mj.phase, mj.error = "failed", f"{type(err).__name__}: {err}"

    @api.post("/meaning")
    async def set_meaning(req: MeaningRequest) -> dict[str, Any]:
        """Turn searching by meaning on (getting it ready, if it isn't) or off."""
        replace(prefs(), meaning=req.on).save(prefs_path)
        if not req.on:
            meaning.forget(home)
        elif meaning_job.phase not in ("downloading", "indexing"):
            # Said before it starts: the answer says it's being done (the app polls while it is).
            mj = meaning_job
            mj.phase, mj.done, mj.total, mj.error = "indexing" if meaning.downloaded(home) else "downloading", 0, 0, ""
            task = asyncio.create_task(asyncio.to_thread(prepare_meaning))
            tasks.add(task)
            task.add_done_callback(tasks.discard)
        return get_meaning()

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
        if account is None or missing() or choosing() or not _due(last_synced(), within, datetime.now(timezone.utc)):
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
                    job: SyncJob, after_index: Callable[[Engine, meaning.ProgressHandler], None] | None = None) -> None:
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
                if scope is None and account.ed_region and (ed_token := account.ed_token()):
                    job.current = "Ed"
                    job.ed_error = await ed.sync(e, ed_token, account.ed_region, [x.course.id for x in plan.snapshots])

        job.phase, job.done, job.total, job.current = "indexing", 0, 0, ""

        def index() -> None:
            def progress(done: int, total: int, title: str) -> None:
                job.done, job.total, job.current = done, total, title

            with Engine(account.root) as e:
                e.reindex(progress)
                if after_index:
                    after_index(e, lambda done, total: progress(done, total, ""))

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
    sock.listen(128)  # connections made before uvicorn is up wait instead of being refused
    print(json.dumps({"port": sock.getsockname()[1], "token": token}), flush=True)
    config = uvicorn.Config(create_app(account, token, background=True), log_level="warning")
    uvicorn.Server(config).run(sockets=[sock])
