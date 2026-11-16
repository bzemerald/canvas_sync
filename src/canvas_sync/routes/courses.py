"""The courses: which sync, what each has (content.py), how they're called and arranged
(places.py), Pinned, the sidebar."""

from __future__ import annotations

import re
from typing import Any

import httpx
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from .. import content, ed, notes
from ..api import CanvasError
from ..backend import Backend, SyncRequest
from ..config import save_course_place, save_pinned, save_sidebar_order, set_course_icon, set_courses_syncing
from ..content import news, news_counts
from ..courses import course_label, rename_course, rename_term
from ..engine import Engine
from ..models import Course
from ..places import as_course, course_layout, course_place, describe, hide_courses
from ..things import NOTE_ID, PLACES, Entry, once, parse_entry


class ChoiceRequest(BaseModel):
    sync: list[int]  # the courses chosen
    skip: list[int]  # the rest


class SeenRequest(BaseModel):
    views: list[str] | None = None  # the ones that count what's new (content.NEWS_VIEWS); None: all


class PlaceRequest(BaseModel):
    """What a place holds, in order (things as written down, with `title` and `hidden`)."""
    entries: list[dict[str, Any]]


class NoteRequest(BaseModel):
    text: str


class IconRequest(BaseModel):
    """One of: an icon from the app's set (with a color), an emoji, "none", or nothing (the app picks)."""
    icon: str | None = None
    color: str | None = None
    emoji: str | None = None


class TitleRequest(BaseModel):
    title: str = ""  # "": its own name again
    term: str = ""   # /terms/title: which, by its name on Canvas


class HideRequest(BaseModel):
    hidden: bool
    syncing: bool | None = None  # False: also stop syncing it; True: sync it again; None: leave as is
    courses: list[int] = []      # /courses/hide: which (a whole term)


class SidebarRequest(BaseModel):
    terms: list[str] | None = None    # the terms in order (Canvas's names for them)
    courses: list[int] | None = None  # course ids in order


def routes(b: Backend) -> APIRouter:
    r = APIRouter()

    @r.get("/courses")
    def courses() -> list[dict[str, Any]]:
        with b.engine() as e:
            return content.courses(e)

    @r.get("/courses/choice")
    async def course_choice() -> dict[str, Any]:
        """Your courses on Canvas, to choose which sync: each with its term's dates and its own,
        and whether it syncs now. `chosen`: the config already says which (not just `select`)."""
        assert b.account is not None
        if not (auth := b.account.auth()):
            raise HTTPException(400, "not signed in to Canvas")
        try:
            async with b.canvas(auth) as client:
                with Engine(b.root, client) as e:
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

    @r.put("/courses/choice")
    async def choose_courses(req: ChoiceRequest) -> dict[str, Any]:
        """Which courses sync, as chosen; the first sync starts when this is the first choice."""
        first = b.choosing()
        with b.engine() as e:
            set_courses_syncing(b.config(), req.sync, req.skip, include=e.settings.select != "active")
        if first:
            b.start_sync(SyncRequest())
        return b.sync_state()

    # -- a course's page ------------------------------------------------------------------

    @r.get("/courses/{course_id}/overview")
    def course_overview(course_id: int) -> dict[str, Any]:
        with b.engine() as e:
            return content.CourseContent.of(e, course_id).overview()

    @r.get("/courses/{course_id}/modules")
    def course_modules(course_id: int) -> list[dict[str, Any]]:
        with b.engine() as e:
            return content.CourseContent.of(e, course_id).modules()

    @r.get("/courses/{course_id}/items")
    def course_items(course_id: int, kind: str) -> list[dict[str, Any]]:
        if kind not in content.KINDS:
            raise HTTPException(400, f"kind must be one of {content.KINDS}")
        with b.engine() as e:
            return content.CourseContent.of(e, course_id).items(kind)

    @r.get("/courses/{course_id}/ed")
    def course_ed(course_id: int) -> list[dict[str, Any]]:
        """Everything the course has on Ed (the `ed` view's list), each the kind it is."""
        with b.engine() as e:
            return content.CourseContent.of(e, course_id).ed_items()

    @r.get("/courses/{course_id}/items/{kind}/{doc_id}")
    async def course_item(course_id: int, kind: str, doc_id: str) -> dict[str, Any]:
        """One item in full. Opening it is reading it: it's no longer new. One from Ed comes
        with its replies as they are now (fetched, when there are new ones)."""
        account = b.account
        assert account is not None
        with b.engine() as e:
            if content.on_ed(kind, doc_id) and account.ed_region and (ed_token := account.ed_token()):
                await ed.fetch_replies(e, ed_token, account.ed_region, course_id, kind, doc_id)
            found = content.CourseContent.of(e, course_id).item(kind, doc_id)
            if found is not None:
                e.state.mark_seen(course_id, [(kind, doc_id)])
        if found is None:
            raise HTTPException(404, "not found (pull to fetch what's new)")
        return found

    @r.get("/courses/{course_id}/grades")
    def course_grades(course_id: int) -> dict[str, Any]:
        with b.engine() as e:
            return content.CourseContent.of(e, course_id).grades()

    @r.post("/courses/{course_id}/seen")
    def course_seen(course_id: int, req: SeenRequest | None = None) -> dict[str, int]:
        """Mark everything new in a course (or in some of its views) as seen."""
        views = (req.views if req else None) or None
        if views and set(views) - set(content.NEWS_VIEWS):
            raise HTTPException(400, f"views must be among {list(content.NEWS_VIEWS)}")
        with b.engine() as e:
            content.mark_seen(e.state, course_id, views)
            return news_counts(news(e.state, e.root, course_id))

    # -- how courses are called, and shown ----------------------------------------------------

    @r.post("/courses/{course_id}/icon")
    def course_icon(course_id: int, req: IconRequest) -> dict[str, Any]:
        if req.emoji is not None and not 0 < len(req.emoji) <= 16:
            raise HTTPException(400, "one emoji")
        if req.icon is not None and not re.fullmatch(r"[a-z0-9-]{1,40}", req.icon):
            raise HTTPException(400, "not an icon name")
        if req.color is not None and not re.fullmatch(r"[a-z]{1,20}", req.color):
            raise HTTPException(400, "not a color name")
        icon = {"emoji": req.emoji} if req.emoji else {"icon": req.icon, "color": req.color or ""} if req.icon else None
        set_course_icon(b.config(), course_id, icon)
        with b.engine() as e:
            return {"icon": e.settings.course_icons.get(course_id)}

    @r.put("/courses/{course_id}/title")
    def course_title(course_id: int, req: TitleRequest) -> None:
        with b.engine() as e:
            try:
                rename_course(e, course_id, req.title)
            except LookupError as err:
                raise HTTPException(404, str(err))

    @r.put("/terms/title")
    def term_title(req: TitleRequest) -> None:
        with b.engine() as e:
            try:
                rename_term(e, req.term, req.title)
            except LookupError as err:
                raise HTTPException(404, str(err))

    def hide(course_ids: list[int], req: HideRequest) -> None:
        with b.engine() as e:
            hide_courses(e, course_ids, req.hidden, req.syncing)

    @r.post("/courses/{course_id}/hide")
    def hide_course(course_id: int, req: HideRequest) -> dict[str, Any]:
        """Hide a course from the app (and maybe stop syncing it), or bring it back."""
        hide([course_id], req)
        with b.engine() as e:
            return {"hidden": course_id in e.settings.hidden, "excluded": course_id in e.settings.exclude}

    @r.post("/courses/hide")
    def hide_several(req: HideRequest) -> dict[str, Any]:
        """The same for several courses (a whole term)."""
        hide(req.courses, req)
        with b.engine() as e:
            return {"hidden": [c for c in req.courses if c in e.settings.hidden],
                    "excluded": [c for c in req.courses if c in e.settings.exclude]}

    @r.get("/sidebar")
    def sidebar() -> dict[str, Any]:
        """How you arranged the sidebar: the order of terms, and of courses in them."""
        with b.engine() as e:
            return {"terms": e.settings.term_order, "courses": e.settings.course_order}

    @r.post("/sidebar")
    def arrange_sidebar(req: SidebarRequest) -> dict[str, Any]:
        save_sidebar_order(b.config(), req.terms, req.courses)
        return sidebar()

    # -- places (places.py) ---------------------------------------------------------------------

    def place_entries(req: PlaceRequest, home: int | None = None) -> list[Entry]:
        out: list[Entry] = []
        for d in req.entries:
            entry = parse_entry(d, home)
            if entry is None:
                raise HTTPException(400, f"that doesn't make sense: {d}")
            out.append(entry)
        return once(out)

    @r.get("/pinned")
    def pinned() -> list[dict[str, Any]]:
        """Pinned: what's pinned, in order, each as it's called now."""
        with b.engine() as e:
            items = as_course(e.settings.pinned, e.layout.course_dirs(e.state.courses()))
            if items != e.settings.pinned:
                save_pinned(b.config(), items)
            return describe(items, e)

    @r.put("/pinned")
    def arrange_pinned(req: PlaceRequest) -> list[dict[str, Any]]:
        """Pinned as it should be: anything, in this order."""
        items = place_entries(req)
        with b.engine() as e:
            save_pinned(b.config(), as_course(items, e.layout.course_dirs(e.state.courses())))
        return pinned()

    def known(name: str) -> None:
        if name not in PLACES:
            raise HTTPException(404, f"places are {PLACES}")

    @r.get("/courses/{course_id}/layout")
    def layout_of(course_id: int) -> dict[str, Any]:
        """The course's page: its tabs, overview and Tools and links, each with all it holds, in order."""
        with b.engine() as e:
            return course_layout(e, b.prefs(), course_id)

    @r.put("/courses/{course_id}/layout/{name}")
    def arrange_course(course_id: int, name: str, req: PlaceRequest) -> dict[str, Any]:
        """One of the course's places as it should be. Its own things it leaves out are put back
        where the default has them: they're hidden, not taken away."""
        known(name)
        items = place_entries(req, course_id)
        with b.engine() as e:
            p = course_place(e, b.prefs(), course_id, name)
            if other := [x.thing.to_dict() for x in items if not p.holds(x.thing)]:
                raise HTTPException(400, f"not this course's: {other}")  # (its places hold only its things)
            save_course_place(b.config(), course_id, name, p.settle(items))
        return layout_of(course_id)

    def note_id(note: str) -> str:
        if not NOTE_ID.fullmatch(note):
            raise HTTPException(400, "not a note id")
        return note

    @r.get("/courses/{course_id}/notes/{note}")
    def read_note(course_id: int, note: str) -> dict[str, str]:
        return {"text": notes.read(b.root, course_id, note_id(note))}

    @r.put("/courses/{course_id}/notes/{note}")
    def write_note(course_id: int, note: str, req: NoteRequest) -> dict[str, str]:
        """A note card's text, as typed (kept in the sync folder, under .canvas/notes)."""
        if len(req.text) > 1_000_000:
            raise HTTPException(413, "too long")
        notes.write(b.root, course_id, note_id(note), req.text)
        return {"text": req.text}

    return r
