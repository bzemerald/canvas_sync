"""Ed (edstem.org), where many courses talk: announcements, a thread per assignment, questions.

Ed has no documented API. What it serves its own pages is used, as smartspot2/edapi found it,
read-only, with a token you make in Ed's settings. Each Ed course belongs to one Canvas course
(matched by its code and term; changeable in 设置): what's on it is that course's.
"""

from __future__ import annotations

import asyncio
import html
import json
import re
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta, timezone
from typing import TYPE_CHECKING, Any

import httpx

from . import __version__
from .config import set_ed_courses
from .models import Course, Document
from .search import code_keys
from .state import META_DIR

if TYPE_CHECKING:
    from .engine import Engine

# Ed keeps each region's accounts apart, each with its API at its own address.
API = {"us": "https://us.edstem.org/api/", "eu": "https://eu.edstem.org/api/", "au": "https://edstem.org/api/"}
USER_AGENT = f"canvas-sync/{__version__}"  # Ed's firewall turns away requests without one
TOKEN_PAGE = "https://edstem.org/{region}/settings/api-tokens"
SOURCE = "ed"  # in state.sources, and documents' `source`
PAGE = 100  # threads per request (Ed's most)
MAX_PAGES = 300
# What a listed thread must have for the app to read it.
THREAD_FIELDS = ("id", "type", "title", "content", "created_at", "category", "is_pinned")

# What went wrong, as the app tells it.
REJECTED, UNREACHABLE, CHANGED = "token rejected", "can't reach Ed", "Ed changed"


class EdError(Exception):
    def __init__(self, reason: str):
        super().__init__(reason)
        self.reason = reason


class EdClient:
    def __init__(self, token: str, region: str = "us", transport: httpx.AsyncBaseTransport | None = None):
        self.region = region
        self._http = httpx.AsyncClient(
            base_url=API[region],
            headers={"Authorization": f"Bearer {token}", "User-Agent": USER_AGENT},
            timeout=httpx.Timeout(30, connect=15),
            transport=transport,
        )

    async def __aenter__(self) -> EdClient:
        return self

    async def __aexit__(self, *exc: object) -> None:
        await self._http.aclose()

    async def get(self, path: str, **params: Any) -> dict[str, Any]:
        for attempt in range(4):
            try:
                resp = await self._http.get(path, params=params)
            except httpx.HTTPError as e:
                raise EdError(UNREACHABLE) from e
            if resp.status_code == 429 and attempt < 3:  # slow down, as asked
                await asyncio.sleep(min(float(resp.headers.get("Retry-After") or 2 ** attempt), 30))
                continue
            break
        try:
            data = resp.json()
        except ValueError:
            raise EdError(UNREACHABLE if not resp.is_success else CHANGED)
        if resp.status_code == 401 or (isinstance(data, dict) and data.get("code") == "bad_token"):
            raise EdError(REJECTED)
        if not resp.is_success:
            raise EdError(UNREACHABLE)
        if not isinstance(data, dict):
            raise EdError(CHANGED)
        return data

    async def user(self) -> dict[str, Any]:
        """You, and your courses on Ed."""
        data = await self.get("user")
        if not isinstance(data.get("user"), dict) or not isinstance(data.get("courses"), list):
            raise EdError(CHANGED)
        return data

    async def threads(self, course: int) -> tuple[list[dict[str, Any]], dict[int, dict[str, Any]]]:
        """All of a course's threads, newest first, as listed (their replies aren't), and who
        wrote them (id -> name, course_role)."""
        threads: list[dict[str, Any]] = []
        users: dict[int, dict[str, Any]] = {}
        for _ in range(MAX_PAGES):
            data = await self.get(f"courses/{course}/threads", limit=PAGE, offset=len(threads), sort="new")
            page = data.get("threads")
            if not isinstance(page, list) or any(not isinstance(t, dict) or any(k not in t for k in THREAD_FIELDS) for t in page):
                raise EdError(CHANGED)
            users |= {u["id"]: u for u in data.get("users") or [] if isinstance(u, dict) and "id" in u}
            threads += page
            if len(page) < PAGE:
                break
        return threads, users


async def find(token: str) -> tuple[str, dict[str, Any]]:
    """Which region's Ed the token is for, and what /user says there."""
    reasons = []
    for region in API:
        async with EdClient(token, region) as client:
            try:
                return region, await client.user()
            except EdError as e:
                reasons.append(e.reason)
    raise EdError(REJECTED if REJECTED in reasons else reasons[0])


def courses(user: dict[str, Any]) -> list[dict[str, Any]]:
    """Your Ed courses, as the app shows them."""
    out = []
    for x in user["courses"]:
        c, role = x.get("course"), x.get("role")
        if not isinstance(c, dict) or not isinstance(c.get("id"), int):
            raise EdError(CHANGED)
        term = " ".join(str(c.get(k) or "") for k in ("session", "year")).strip()
        out.append({"id": c["id"], "code": str(c.get("code") or ""), "name": str(c.get("name") or ""),
                    "term": term, "archived": c.get("status") == "archived",
                    "role": (role or {}).get("role") if isinstance(role, dict) else None})
    return out


def _keys(code: str) -> set[str]:
    """A code's department-and-number keys ("cs70", "compsci70"): what two codes of one course share."""
    return {k for k in code_keys(code) if k[0].isalpha() and re.search(r"\d", k)}


def match(ed: list[dict[str, Any]], canvas: list[Course]) -> dict[int, int]:
    """Canvas course -> the Ed course that's the same course: same term, same code ("CS 70" is
    "COMPSCI 70-LEC-001"). Of several Canvas courses (a lecture and its section), the closest,
    then the lecture. Each Ed course goes to one Canvas course at most."""
    out: dict[int, int] = {}
    for e in ed:
        keys = _keys(e["code"])
        if not keys or not e["term"]:
            continue
        found = [(len(keys & _keys(c.code)), "lec" in c.code.lower(), -c.id, c.id) for c in canvas
                 if c.id not in out and (c.term or "").casefold() == e["term"].casefold() and keys & _keys(c.code)]
        if found:
            out[max(found)[3]] = e["id"]
    return out


# -- what's on Ed, as the app's documents ------------------------------------------------------

def _utc(when: Any) -> str | None:
    """Ed's times ("2026-05-16T11:35:00.1+10:00") as Canvas writes them, so they sort together."""
    try:
        return datetime.fromisoformat(str(when)).astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    except ValueError:
        return None


_TAGS = {"paragraph": "p", "bold": "strong", "italic": "em", "underline": "u", "strike": "s", "code": "code",
         "list-item": "li", "figure": "figure", "callout": "blockquote", "table": "table", "tr": "tr", "td": "td",
         "th": "th", "sup": "sup", "sub": "sub"}


def _attr(v: str | None) -> str:
    return html.escape(v or "", quote=True)


def _html(el: ET.Element) -> str:
    inner = html.escape(el.text or "") + "".join(_html(c) + html.escape(c.tail or "") for c in el)
    tag = el.tag
    if tag == "heading":
        level = min(max(int(el.get("level") or 1) + 1, 2), 6)  # (Ed's 1 is the post's biggest; the page has a title)
        return f"<h{level}>{inner}</h{level}>"
    if tag == "list":
        name = "ol" if el.get("style") == "number" else "ul"
        return f"<{name}>{inner}</{name}>"
    if tag == "link":
        return f'<a href="{_attr(el.get("href"))}">{inner}</a>'
    if tag == "image":
        return f'<img src="{_attr(el.get("src"))}" alt="">'
    if tag == "file":
        return f'<p><a href="{_attr(el.get("url"))}">{html.escape(el.get("filename") or el.get("url") or "")}</a></p>'
    if tag in ("pre", "snippet"):
        return f"<pre><code>{html.escape(''.join(el.itertext()))}</code></pre>"
    if tag == "math":
        return f"<code>${html.escape(''.join(el.itertext()))}$</code>"
    if tag == "spoiler":
        return f"<details><summary>…</summary>{inner}</details>"
    if tag == "break":
        return "<br>"
    if tag in _TAGS:
        return f"<{_TAGS[tag]}>{inner}</{_TAGS[tag]}>"
    return inner  # (a tag we don't know: its text)


def to_html(content: str) -> str:
    """An Ed post's body (its own XML: <document><paragraph>...) as HTML."""
    try:
        root = ET.fromstring(content)
    except ET.ParseError:
        return "".join(f"<p>{html.escape(line)}</p>" for line in content.splitlines() if line.strip())
    return _html(root)


def document(t: dict[str, Any], users: dict[int, dict[str, Any]], course: int, ed_course: int, region: str) -> Document:
    """A thread as the course's document: an announcement, or a post (kind `post`). The fields
    are what Canvas's announcements have, so the app shows both alike; `ed` has the rest."""
    who = users.get(t.get("user_id") or 0) or {}
    anonymous = bool(t.get("is_anonymous")) or not who
    staff = not anonymous and who.get("course_role") not in (None, "student")
    raw = {
        "title": t["title"],
        "message": to_html(t["content"]),
        "posted_at": _utc(t["created_at"]),
        "author": {"display_name": None if anonymous else who.get("name")},
        "read_state": "read" if t.get("is_seen") else "unread",
        "html_url": f"https://edstem.org/{region}/courses/{ed_course}/discussion/{t['id']}",
        "source": SOURCE,
        "ed": {"number": t.get("number"), "type": t["type"], "category": t.get("category") or "",
               "subcategory": t.get("subcategory") or "", "pinned": bool(t["is_pinned"]),
               "megathread": bool(t.get("is_megathread")), "private": bool(t.get("is_private")),
               "answered": bool(t.get("is_answered")), "staff_answered": bool(t.get("is_staff_answered")),
               "replies": t.get("reply_count") or 0, "watched": bool(t.get("is_watched")),
               "starred": bool(t.get("is_starred")), "staff": staff, "anonymous": anonymous},
    }
    kind = "announcement" if t["type"] == "announcement" else "post"
    return Document(course, kind, f"ed-{t['id']}", t["title"] or f"#{t.get('number')}", raw["posted_at"] or "", raw)


KINDS = ("announcement",)  # what's kept of a course's threads


def news(d: Document) -> bool:
    """Whether it's news when it shows up: announcements, and what staff post or pin."""
    return d.kind == "announcement" or d.raw["ed"]["staff"] or d.raw["ed"]["pinned"]


SAME_WITHIN = timedelta(days=2)  # an announcement posted on Canvas and Ed both, a little apart


def _title(title: str) -> str:
    return re.sub(r"[\s!.?:]+$", "", " ".join(title.casefold().split()))


def _time(iso: Any) -> datetime | None:
    try:
        return datetime.fromisoformat(str(iso).replace("Z", "+00:00"))
    except ValueError:
        return None


def _canvas_copies(e: Engine, course: int) -> dict[str, list[datetime]]:
    """The course's Canvas announcements: title -> when each was posted."""
    out: dict[str, list[datetime]] = {}
    for title, raw in e.state.db.execute(
            "SELECT title, raw FROM documents WHERE course_id = ? AND kind = 'announcement' AND source = 'canvas'", (course,)):
        if when := _time(json.loads(raw or "{}").get("posted_at")):
            out.setdefault(_title(title), []).append(when)
    return out


def _on_canvas(d: Document, canvas: dict[str, list[datetime]]) -> bool:
    """An Ed announcement that's also one of the course's Canvas announcements (many are posted
    in both): the same title, posted about the same time."""
    when = _time(d.raw["posted_at"])
    return when is not None and any(abs(when - t) <= SAME_WITHIN for t in canvas.get(_title(d.title), []))


async def _course(e: Engine, client: EdClient, course: int, ed_course: int) -> None:
    threads, users = await client.threads(ed_course)
    canvas = _canvas_copies(e, course)
    docs = [d for d in (document(t, users, course, ed_course, client.region) for t in threads)
            if d.kind in KINDS and not (d.kind == "announcement" and _on_canvas(d, canvas))]
    first = not e.state.has_documents(course, SOURCE)
    e.state.save_documents(course, docs, SOURCE)
    e.state.record_arrivals(course, [(d.kind, d.id, d.raw["posted_at"]) for d in docs if news(d)], first=first)
    e.state.commit()


async def refresh(e: Engine, client: EdClient) -> list[dict[str, Any]]:
    """Your Ed courses, kept; and each Canvas course not linked yet (nor set to none) linked to
    its match on Ed."""
    found = courses(await client.user())
    e.state.save_ed_courses(found)
    linked = {x for x in e.settings.ed_courses.values() if x}
    new = {cid: eid for cid, eid in match([x for x in found if x["id"] not in linked], e.state.courses()).items()
           if cid not in e.settings.ed_courses}
    if new:
        set_ed_courses(e.root / META_DIR / "config.toml", new)
        e.settings.ed_courses.update(new)
    return found


async def sync(e: Engine, token: str, region: str, courses: list[int] | None = None) -> str | None:
    """What's on Ed for `courses` (None: all; each as its Ed course has it now), as a sync does
    it. What went wrong (None: nothing), also kept in state.sources. A course that went wrong
    keeps what it had; one that has no Ed course any more loses what came from Ed."""
    try:
        async with EdClient(token, region) as client:
            mine = {x["id"] for x in await refresh(e, client)}
            failed: str | None = None
            for c in e.state.courses():
                if courses is not None and c.id not in courses:
                    continue
                ed_course = e.settings.ed_courses.get(c.id)
                if not ed_course:
                    if e.state.has_documents(c.id, SOURCE):
                        e.state.save_documents(c.id, [], SOURCE)
                    continue
                if ed_course not in mine:  # (you left it on Ed: what it had stays)
                    continue
                try:
                    await _course(e, client, c.id, ed_course)
                except EdError as err:
                    if err.reason == REJECTED:
                        raise
                    failed = failed or err.reason
            if failed:
                raise EdError(failed)
    except EdError as err:
        e.state.record_source(SOURCE, err.reason)
        e.state.commit()
        return err.reason
    e.state.record_source(SOURCE)
    e.state.commit()
    return None
