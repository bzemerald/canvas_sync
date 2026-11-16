"""Opening things outside the app: a file (or its folder), a web link, a page on Canvas, an
external tool signed in, the sync folder's config.toml."""

from __future__ import annotations

import webbrowser
from typing import Any
from urllib.parse import urlencode, urlsplit

import httpx
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from ..api import CanvasError
from ..backend import Backend
from ..local import open_path


class OpenRequest(BaseModel):
    path: str | None = None    # relative to the sync folder
    url: str | None = None     # Canvas URL, relative to the Canvas base URL
    external: str | None = None  # any http(s) link, in the browser
    reveal: bool = False       # show in the file manager instead of opening
    preview: bool = False      # Quick Look (macOS)
    seen: bool = False         # only mark it seen (the app showed it itself)


class LaunchRequest(BaseModel):
    """An external tool to open: from the course menu, a module item, an assignment, or a link."""
    course_id: int
    tool_id: int | None = None
    module_item_id: int | None = None
    assignment_id: int | None = None
    url: str | None = None  # the tool's launch URL (links like /external_tools/retrieve?url=...)


def routes(b: Backend) -> APIRouter:
    r = APIRouter()

    @r.post("/open")
    def open_(req: OpenRequest) -> dict[str, str]:
        account = b.account
        if account is None and not req.external:
            raise HTTPException(409, "not set up")
        if req.path is not None and account is not None:
            target = b.inside(req.path)
            if not target.exists():
                raise HTTPException(404, f"{req.path} does not exist")
            if not req.seen:
                open_path(target, reveal=req.reveal, preview=req.preview)
            if not req.reveal:  # opening (or previewing) a file is seeing it
                with b.engine() as e:
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

    @r.post("/open/config")
    def open_config() -> dict[str, str]:
        """The sync folder's config.toml, in your text editor: the settings the app doesn't show."""
        target = b.config()
        open_path(target)
        return {"opened": str(target)}

    @r.post("/launch")
    async def launch(req: LaunchRequest) -> dict[str, Any]:
        """Open an external tool in the browser, signed in: Canvas makes a one-time launch
        link. Where Canvas won't (some schools and tools turn it off), the tool's page on Canvas."""
        account = b.account
        assert account is not None
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
        if auth := account.auth():
            try:
                async with b.canvas(auth) as client:
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

    return r
