"""The sync folder's files: browsing, thumbnails, images in pages, what's new, and changing
what syncs (restore, delete, untrack, track, rename)."""

from __future__ import annotations

import hashlib
from dataclasses import asdict
from typing import Any
from urllib.parse import urljoin, urlsplit

import httpx
from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse, Response
from pydantic import BaseModel

from .. import content
from ..api import CanvasError
from ..backend import Backend, ScopeRequest
from ..discover import FILE_REF
from ..paths import META_DIR
from ..thumbs import thumbnail

MEDIA_MAX_BYTES = 25 * 1024 * 1024


class PathsSeenRequest(BaseModel):
    files: list[str] = []    # in the sync folder
    folders: list[str] = []  # in the sync folder ("": all of it)


class RestoreRequest(ScopeRequest):
    dry_run: bool = False


class PathsRequest(BaseModel):
    paths: list[str]


class DeleteRequest(PathsRequest):
    dry_run: bool = False
    stop_syncing_folders: bool = True  # also don't download what Canvas adds to the folders later


class RenameRequest(BaseModel):
    path: str
    name: str


def routes(b: Backend) -> APIRouter:
    r = APIRouter()

    @r.post("/seen/paths")
    def paths_seen(req: PathsSeenRequest) -> dict[str, list[str]]:
        """Mark new files seen: these, and those in these folders."""
        for folder in req.folders:
            if folder.strip("/") and not b.inside(folder).is_dir():
                raise HTTPException(404, f"{folder} is not a folder")
        with b.engine() as e:
            e.state.mark_paths_seen(req.files, req.folders)
        return {"seen": [*req.files, *req.folders]}

    @r.get("/new/files")
    def new_files() -> list[str]:
        """Where the files not opened yet are: what can be marked read."""
        with b.engine() as e:
            return content.new_files(e.state, e.root)

    @r.get("/media")
    async def media(url: str) -> Response:
        """An image in a page. Canvas files we have come from disk; anything else is
        fetched (with the Canvas token only for Canvas itself) and cached."""
        account = b.account
        assert account is not None
        target = urljoin(account.base_url + "/", url)
        parts = urlsplit(target)
        if parts.scheme not in ("http", "https"):
            raise HTTPException(400, "only web images")
        on_canvas = parts.netloc == urlsplit(account.base_url).netloc
        if on_canvas and (m := FILE_REF.search(parts.path)) and m[1] in ("", "courses"):
            with b.engine() as e:
                rec = e.state.get(int(m[3]))
            if rec and rec.path and not rec.ignored and (account.root / rec.path).is_file():
                return FileResponse(account.root / rec.path)
        cache = account.root / META_DIR / "cache" / "media" / hashlib.sha1(target.encode()).hexdigest()
        if cache.exists() and cache.with_suffix(".type").exists():
            return FileResponse(cache, media_type=cache.with_suffix(".type").read_text(encoding="utf-8"))
        try:
            if on_canvas:
                auth = account.auth()
                if not auth:
                    raise HTTPException(400, "no Canvas token")
                async with b.canvas(auth) as client:
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

    @r.get("/tree")
    def tree(path: str = "") -> list[dict[str, Any]]:
        if path:
            b.inside(path)
        with b.engine() as e:
            try:
                return [asdict(x) for x in e.list_dir(path)]
            except LookupError as err:
                raise HTTPException(404, str(err))

    @r.get("/thumb")
    def thumb(path: str, size: int = 256) -> FileResponse:
        b.inside(path)
        out = thumbnail(b.root, path, size)
        if out is None:
            raise HTTPException(404, "no thumbnail for this file")
        return FileResponse(out, media_type="image/jpeg", headers={"Cache-Control": "max-age=3600"})

    @r.get("/folder-titles")
    def folder_titles() -> dict[str, str]:
        with b.engine() as e:
            return e.settings.folder_titles

    @r.get("/status")
    def status() -> list[dict[str, Any]]:
        with b.engine() as e:
            return [asdict(s) for s in e.status()]

    # -- changing what syncs ------------------------------------------------------------------

    @r.post("/restore")
    def restore(req: RestoreRequest) -> dict[str, Any]:
        b.scope_paths(req)
        scope = req.scope()
        if scope is None:
            raise HTTPException(400, "say what to restore")
        with b.engine() as e:
            todo = e.restorable(scope)
            if req.dry_run:
                return {"files": [asdict(s) for s in todo]}
            b.unless_syncing()
            try:
                restored = e.restore_in(scope)
            except LookupError as err:
                raise HTTPException(409, str(err))
            e.reindex()
            return {"restored": restored}

    def changing(paths: list[str]) -> None:
        b.unless_syncing()
        if not paths:
            raise HTTPException(400, "say which files")
        for p in paths:
            b.inside(p)

    @r.post("/delete")
    def delete(req: DeleteRequest) -> dict[str, Any]:
        changing(req.paths)
        with b.engine() as e:
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

    @r.post("/untrack")
    def untrack(req: PathsRequest) -> dict[str, int]:
        changing(req.paths)
        with b.engine() as e:
            try:
                n = e.untrack(req.paths)
            except ValueError as err:
                raise HTTPException(400, str(err))
            except LookupError as err:
                raise HTTPException(404, str(err))
            e.reindex()
            return {"files": n}

    @r.post("/track")
    def track(req: PathsRequest) -> dict[str, int]:
        changing(req.paths)
        with b.engine() as e:
            try:
                n = e.track(req.paths)
            except (ValueError, LookupError) as err:
                raise HTTPException(400, str(err))
            e.reindex()
            return {"files": n}

    @r.post("/rename")
    def rename(req: RenameRequest) -> dict[str, bool]:
        b.inside(req.path)
        with b.engine() as e:
            try:
                e.rename_folder(req.path, req.name)
                return {"ok": True}
            except ValueError as err:
                raise HTTPException(400, str(err))
            except LookupError as err:
                raise HTTPException(404, str(err))

    return r
