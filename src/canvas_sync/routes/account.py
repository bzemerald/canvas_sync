"""Settings: the preferences, the account and its sync folder, Ed, AI apps."""

from __future__ import annotations

import asyncio
from dataclasses import replace
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

import httpx
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from .. import assistants, ed
from ..api import Auth, parse_json, signed_out
from ..backend import Backend, canvas_command, mcp_args
from ..config import Account, ConfigError, set_course_select, set_ed_courses
from ..courses import course_label
from ..engine import Engine
from ..local import MoveError, move_sync_folder
from ..paths import config_file

DEFAULT_ROOT = Path("~/Canvas")
MOVE_WAIT = 30.0  # seconds a move waits for what's being answered (a slow thumbnail) to finish


class PrefsRequest(BaseModel):
    """What to change; what's left out stays."""
    language: str | None = None
    auto_sync: int | None = None
    sync_on_launch: bool | None = None
    launcher_key: str | None = None  # "": the usual
    select: str | None = None  # which courses to sync: active | favorites (in the folder's config.toml)


class CredentialsRequest(BaseModel):
    """One of: an access token, or the cookies of a sign-in in the app's Canvas window."""
    token: str | None = None
    cookies: dict[str, str] | None = None

    def auth(self) -> Auth:
        if self.cookies:
            return Auth(cookies=self.cookies)
        if self.token and self.token.strip():
            return Auth(token=self.token.strip())
        raise HTTPException(400, "token rejected")


class SetupRequest(CredentialsRequest):
    url: str                 # the Canvas site, e.g. bcourses.berkeley.edu
    root: str | None = None  # the sync folder; default: the current one, or ~/Canvas


class FolderRequest(BaseModel):
    root: str
    new: bool  # True: an empty folder, to sync into anew; False: the old one, moved


class MoveRequest(BaseModel):
    root: str


class TokenRequest(BaseModel):
    token: str


class EdLinkRequest(BaseModel):
    ed: int  # an Ed course
    course: int | None  # the course it is (None: none)


def routes(b: Backend) -> APIRouter:
    r = APIRouter()

    @r.get("/prefs")
    def get_prefs() -> dict[str, Any]:
        p = b.prefs()
        out: dict[str, Any] = {"language": p.language, "auto_sync": p.auto_sync, "sync_on_launch": p.sync_on_launch,
                               "launcher_key": p.launcher_key}
        if b.account is not None and not b.missing():
            with b.engine() as e:
                out["select"] = e.settings.select
        return out

    @r.post("/prefs")
    def set_prefs(req: PrefsRequest) -> dict[str, Any]:
        changes = {k: v for k, v in req.model_dump().items() if v is not None and k != "select"}
        try:
            replace(b.prefs(), **changes).save(b.prefs_path)
            if req.select is not None:
                if b.account is None:
                    raise HTTPException(409, "not set up")
                set_course_select(b.config(), req.select)
        except ConfigError as err:
            raise HTTPException(400, str(err))
        return get_prefs()

    # -- the account --------------------------------------------------------------------------

    def account_info() -> dict[str, Any]:
        account = b.account
        if account is None:
            return {"set_up": False, "signed_in": False, "auth": None, "base_url": None, "root": None, "user": None}
        auth = account.auth()
        return {"set_up": True, "signed_in": auth is not None, "auth": auth.kind if auth else None,
                "base_url": account.base_url, "root": str(account.root), "user": account.user}

    @r.get("/account")
    def get_account() -> dict[str, Any]:
        return account_info()

    @r.get("/account/check")
    async def check_account() -> dict[str, Any]:
        """Whether the saved token or browser sign-in still works (both expire; a token can be revoked)."""
        account = b.account
        assert account is not None
        if not (saved := account.auth()):
            return {"ok": False, "error": "not signed in"}
        try:
            me = await _who(account.base_url, saved)
        except HTTPException as err:
            return {"ok": False, "error": err.detail}
        if me.get("name") and me["name"] != account.user:
            account.user = me["name"]
            account.save()
        return {"ok": True, "user": account.user}

    @r.post("/account/setup")
    async def set_up(req: SetupRequest) -> dict[str, Any]:
        """Sign in, or switch to another account or school: check the token, settle on the
        sync folder, save both. The folder's files and settings are left as they are."""
        b.unless_syncing()
        url, new_auth = _canvas_site(req.url), req.auth()
        me = await _who(url, new_auth)
        account = b.account
        root = Path(req.root).expanduser() if req.root else (account.root if account else DEFAULT_ROOT.expanduser())
        new = Account(url, sync_folder(root, url), me.get("name") or None)
        if account and account.base_url != url:
            account.clear_token()  # signed out of the old site
        new.save()
        new.set_auth(new_auth)
        b.account = new
        b.update_files()
        if not b.choosing():  # (else the first sync starts once the courses are chosen)
            b.try_sync()  # what you signed in for
        return account_info()

    def sync_folder(root: Path, url: str, new: bool = True) -> Path:
        """A folder to sync into, set up: an empty one (or not there yet), or one that has synced
        before (only that, unless `new`)."""
        account = b.account
        if root.exists() and not root.is_dir():
            raise HTTPException(400, "not a folder")
        ours = config_file(root).is_file()
        if not new and not ours:
            raise HTTPException(400, "not a sync folder")
        if root.exists() and not ours and any(not p.name.startswith(".") for p in root.iterdir()):
            raise HTTPException(400, "folder not empty")
        if ours and account and account.root.resolve() == root.resolve() and account.base_url != url and not b.choosing():
            raise HTTPException(400, "folder belongs to another Canvas site")  # (one that never synced is still free)
        return Engine.init_root(root)

    @r.post("/account/folder")
    async def move_folder(req: FolderRequest) -> dict[str, Any]:
        """The sync folder went missing: where it is now, or a new one to sync into anew. The
        account stays signed in; the first sync of a new one waits for the courses to be chosen."""
        account = b.account
        assert account is not None
        b.unless_syncing()
        account.root = sync_folder(Path(req.root).expanduser(), account.base_url, req.new)
        account.save()
        b.update_files()
        if not b.choosing():
            b.try_sync()
        return account_info()

    @r.post("/account/move")
    async def move_workspace(req: MoveRequest) -> dict[str, Any]:
        """Everything in the sync folder, moved to an empty folder, and used from there."""
        account = b.account
        assert account is not None
        with b.counting:
            if b.moving:
                raise HTTPException(409, "moving the sync folder")
            if b.job.running or b.meaning_job.phase in ("downloading", "indexing"):
                raise HTTPException(409, "wait for the sync to finish")
            b.moving = True  # (from now on nothing else opens the folder)
        try:
            for _ in range(int(MOVE_WAIT / 0.05)):  # what's being answered finishes first
                if b.busy == 0:
                    break
                await asyncio.sleep(0.05)
            else:
                raise HTTPException(409, "the app is busy")
            old, new = account.root.resolve(), Path(req.root).expanduser().resolve()

            def use() -> None:  # (only now is the old one gone: a crash before it leaves a whole copy)
                replace(account, root=new).save()
                account.root = new
            try:
                left_behind = await asyncio.to_thread(move_sync_folder, old, new, use)
            except MoveError as err:
                raise HTTPException(400, str(err))
        finally:
            b.moving = False
        b.update_files()
        return {**account_info(), "left_behind": left_behind}

    @r.post("/account/credentials")
    async def replace_credentials(req: CredentialsRequest) -> dict[str, Any]:
        """A new token or browser sign-in for the same account (the old one expired, or was revoked)."""
        account = b.account
        assert account is not None
        new_auth = req.auth()
        me = await _who(account.base_url, new_auth)
        account.user = me.get("name") or account.user
        account.save()
        account.set_auth(new_auth)
        return account_info()

    @r.post("/account/signout")
    def sign_out() -> dict[str, Any]:
        """Forget the token or sign-in. Files, settings and what's been synced stay; signing in again resumes."""
        assert b.account is not None
        b.unless_syncing()
        b.account.clear_token()
        return account_info()

    # -- Ed (ed.py) ---------------------------------------------------------------------------

    def ed_info() -> dict[str, Any]:
        account = b.account
        assert account is not None
        with b.engine() as e:
            links = {eid: cid for cid, eid in e.settings.ed_courses.items() if eid}
            return {
                "connected": bool(account.ed_token()), "user": account.ed_user,
                "token_page": ed.TOKEN_PAGE.format(region=account.ed_region or "us"),
                **e.state.source(ed.SOURCE),  # ok_at, error: how it went last
                "courses": [{**x, "course": links.get(x["id"])} for x in e.state.ed_courses()],
                "canvas": [{"id": c.id, "label": course_label(c, e.settings), "term": c.term} for c in e.state.courses()],
            }

    @r.get("/ed")
    def get_ed() -> dict[str, Any]:
        return ed_info()

    @r.post("/ed/connect")
    async def connect_ed(req: TokenRequest) -> dict[str, Any]:
        """Connect Ed with a token made in its settings (or a new one): which region's it is, who
        you are there, your courses there, each linked to its Canvas course. Then a sync brings
        what's on them."""
        account = b.account
        assert account is not None
        new_token = req.token.strip()
        try:
            region, me = await ed.find(new_token)
        except ed.EdError as err:
            raise HTTPException(400, err.reason)
        account.set_ed_token(region, new_token)
        account.ed_region, account.ed_user = region, me["user"].get("name") or None
        account.save()
        with b.engine() as e:
            try:
                async with ed.EdClient(new_token, region) as client:
                    await ed.refresh(e, client)
                e.state.record_source(ed.SOURCE)
            except ed.EdError as err:
                e.state.record_source(ed.SOURCE, err.reason)
            e.state.commit()
        b.try_sync()  # (one's running: the next brings Ed)
        return ed_info()

    @r.post("/ed/disconnect")
    def disconnect_ed() -> dict[str, Any]:
        """Forget the Ed token. What came from Ed stays, and which course each Ed course is."""
        account = b.account
        assert account is not None
        account.clear_ed_token()
        account.ed_region = account.ed_user = None
        account.save()
        return ed_info()

    @r.put("/ed/link")
    def link_ed(req: EdLinkRequest) -> dict[str, Any]:
        """Which course an Ed course is; None: none (and it isn't matched again)."""
        with b.engine() as e:
            changes = {cid: 0 for cid, eid in e.settings.ed_courses.items() if eid == req.ed}
            if req.course is not None:
                if e.state.course(req.course) is None:
                    raise HTTPException(404, "no such course")
                changes[req.course] = req.ed
            else:
                for cid in ed.match([x for x in e.state.ed_courses() if x["id"] == req.ed], e.state.courses()):
                    if cid not in e.settings.ed_courses:  # (its match, which isn't linked yet: not later either)
                        changes[cid] = 0
            set_ed_courses(e.config_file, changes)
        return ed_info()

    # -- AI apps (assistants.py) ----------------------------------------------------------------

    @r.get("/mcp")
    def mcp_command() -> dict[str, Any]:
        """How an AI assistant starts `canvas mcp` (agent.py): this program, packed in the app or not."""
        return {"command": canvas_command(), "args": mcp_args()}

    @r.get("/assistants")
    def assistants_state() -> list[dict[str, Any]]:
        """The AI apps `canvas mcp` can be added to: installed or not, added or not."""
        return assistants.state(canvas_command())

    def assistant(app_id: str) -> assistants.App:
        if (app := next((a for a in assistants.apps() if a.id == app_id), None)) is None:
            raise HTTPException(404, "no such app")
        return app

    @r.get("/assistants/{app_id}/preview")
    def preview_assistant(app_id: str, remove: bool = False) -> dict[str, Any]:
        """What adding or removing would change in the app's config file. Nothing is written."""
        try:
            return assistants.preview(assistant(app_id), canvas_command(), mcp_args(), b.home / "backups", remove)
        except (assistants.AssistantError, OSError) as err:
            raise HTTPException(400, str(err))

    @r.post("/assistants/{app_id}")
    def add_assistant(app_id: str) -> list[dict[str, Any]]:
        try:
            assistants.add(assistant(app_id), canvas_command(), mcp_args(), b.home / "backups")
        except (assistants.AssistantError, OSError) as err:
            raise HTTPException(400, str(err))
        return assistants.state(canvas_command())

    @r.delete("/assistants/{app_id}")
    def remove_assistant(app_id: str) -> list[dict[str, Any]]:
        try:
            assistants.remove(assistant(app_id), b.home / "backups")
        except (assistants.AssistantError, OSError) as err:
            raise HTTPException(400, str(err))
        return assistants.state(canvas_command())

    return r


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


async def _who(url: str, auth: Auth) -> dict[str, Any]:
    """Your profile on that Canvas, if the token or sign-in works there; else a 400 saying why.
    One try, no retries: this is someone waiting on a sign-in form."""
    try:
        async with httpx.AsyncClient(timeout=15, follow_redirects=True, **auth.client_args(url)) as http:
            resp = await http.get(f"{url}/api/v1/users/self")
    except httpx.HTTPError:
        raise HTTPException(400, "can't reach the site")
    if resp.status_code == 401 or signed_out(resp):
        raise HTTPException(400, "token rejected" if auth.kind == "token" else "sign-in rejected")
    try:
        me = parse_json(resp)
    except ValueError:
        me = None
    if not resp.is_success or not isinstance(me, dict) or "id" not in me:
        raise HTTPException(400, "not a Canvas site")
    return me
