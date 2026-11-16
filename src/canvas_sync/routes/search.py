"""Searching: the index (search.py), the app's search as you type (finding.py), what search
can go to by name (catalog.py), and search by meaning (meaning.py)."""

from __future__ import annotations

import asyncio
from dataclasses import asdict, replace
from typing import Any

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel

from .. import finding, meaning
from ..backend import Backend
from ..catalog import abbreviations, catalog
from ..engine import Engine
from ..meaning import Meaning


class OpenedRequest(BaseModel):
    """Something was opened: the app's key for it, and what had been typed in search (if anything)."""
    key: str
    query: str = ""


class MeaningRequest(BaseModel):
    on: bool


def routes(b: Backend) -> APIRouter:
    r = APIRouter()

    @r.get("/search")
    def search(q: str = "", limit: int = 50, course: list[int] = Query(default=[]),
               kind: list[str] = Query(default=[]), names_only: bool = False, under: str = "") -> list[dict[str, Any]]:
        """`under`: only files in that folder (the app's search box, on a course's Files tab)."""
        if under:
            b.inside(under)
        with b.engine() as e:
            if (courses := e.visible(course)) == []:
                return []
            return [h.to_dict() for h in e.search(q, min(limit, 500), courses, kind or None, names_only, under or None)]

    @r.get("/find")
    def find(q: str = "", limit: int = 40, course: list[int] = Query(default=[]), kind: list[str] = Query(default=[]),
             since: str = "", until: str = "", source: str = "", under: str | None = None) -> dict[str, Any]:
        """The app's search as you type (its find.ts), in the index: `q` is only words to find
        (what was typed, read: no courses in it; "quoted" ones as they are); `course`, `kind`,
        `since`/`until` and `source` (ed): what the app read as narrowing it down; `under`: only
        files in that folder ("": any folder; searching from a course's Files or All files). `corrected`: words taken for
        others, misspelled ("midtrem": midterm)."""
        if under:
            b.inside(under)
        with b.engine() as e:
            hits, corrected = finding.find(e, q, min(limit, 500), course, kind or None, since or None, until or None,
                                           source or None, under, prefs_path=b.prefs_path)
            return {"hits": [h.to_dict() for h in hits], "corrected": corrected}

    @r.get("/catalog")
    def catalog_() -> dict[str, Any]:
        """Everything search can go to by name (see catalog.py), what words stand for, and what
        you open: how often and lately, and what you'd typed for what."""
        with b.engine() as e:
            return {"things": catalog(e), "abbreviations": abbreviations(e), "folder_titles": e.settings.folder_titles,
                    **e.state.usage()}

    @r.post("/opened")
    def opened(req: OpenedRequest) -> dict[str, bool]:
        if not req.key.strip() or len(req.key) > 1000:
            raise HTTPException(400, "say what was opened")
        with b.engine() as e:
            e.state.record_opened(req.key, " ".join(req.query.lower().split())[:80])
        return {"recorded": True}

    # -- searching by meaning (meaning.py) --------------------------------------------------------

    def get_meaning() -> dict[str, Any]:
        out: dict[str, Any] = {"on": b.prefs().meaning, "model": meaning.downloaded(b.home), **asdict(b.meaning_job)}
        if b.account is not None:
            with b.engine() as e:
                out["items"], out["covered"] = Meaning(e.index).counts()
        return out

    @r.get("/meaning")
    def meaning_state() -> dict[str, Any]:
        """Searching by meaning: on or not, its model downloaded or not, what's being done to get
        it ready (downloading the model, cutting the index's text into passages), and how much of
        the index has passages (items, covered)."""
        return get_meaning()

    def prepare_meaning() -> None:
        """The model downloaded if it isn't, then passages for what has none (in the background)."""
        mj, home = b.meaning_job, b.home
        try:
            if not meaning.downloaded(home):
                mj.phase, mj.done, mj.total, mj.error = "downloading", 0, 0, ""
                meaning.download(home, lambda done, total: (setattr(mj, "done", done), setattr(mj, "total", total)))
            if b.account is not None and b.prefs().meaning:
                with Engine(b.account.root) as e:
                    m = Meaning(e.index)
                    items, covered = m.counts()
                    if covered < items:  # (turned off and on again: nothing to do)
                        mj.phase, mj.done, mj.total = "indexing", 0, items - covered
                        m.sync(meaning.embedder(home), lambda done, total: (setattr(mj, "done", done), setattr(mj, "total", total)))
            mj.phase, mj.error = "idle", ""
        except Exception as err:  # (offline, say: shown in Settings)
            mj.phase, mj.error = "failed", f"{type(err).__name__}: {err}"

    @r.post("/meaning")
    async def set_meaning(req: MeaningRequest) -> dict[str, Any]:
        """Turn searching by meaning on (getting it ready, if it isn't) or off."""
        replace(b.prefs(), meaning=req.on).save(b.prefs_path)
        if not req.on:
            meaning.forget(b.home)
        elif b.meaning_job.phase not in ("downloading", "indexing"):
            # Said before it starts: the answer says it's being done (the app polls while it is).
            mj = b.meaning_job
            mj.phase, mj.done, mj.total, mj.error = "indexing" if meaning.downloaded(b.home) else "downloading", 0, 0, ""
            b.spawn(asyncio.to_thread(prepare_meaning))
        return get_meaning()

    return r
