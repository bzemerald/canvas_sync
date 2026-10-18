"""Ed (edstem.org), where many courses talk: announcements, a thread per assignment, questions.

Ed has no documented API. What it serves its own pages is used, as smartspot2/edapi found it,
read-only, with a token you make in Ed's settings. Each Ed course belongs to one Canvas course
(matched by its code and term; changeable in 设置): what's on it is that course's.
"""

from __future__ import annotations

import asyncio
import re
from typing import TYPE_CHECKING, Any

import httpx

from . import __version__
from .config import set_ed_courses
from .models import Course
from .search import code_keys
from .state import META_DIR

if TYPE_CHECKING:
    from .engine import Engine

# Ed keeps each region's accounts apart, each with its API at its own address.
API = {"us": "https://us.edstem.org/api/", "eu": "https://eu.edstem.org/api/", "au": "https://edstem.org/api/"}
USER_AGENT = f"canvas-sync/{__version__}"  # Ed's firewall turns away requests without one
TOKEN_PAGE = "https://edstem.org/{region}/settings/api-tokens"
SOURCE = "ed"  # in state.sources

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


async def sync(e: Engine, token: str, region: str) -> str | None:
    """Everything from Ed, as a sync does it. What went wrong (None: nothing), also kept in
    state.sources; what came before stays."""
    try:
        async with EdClient(token, region) as client:
            await refresh(e, client)
    except EdError as err:
        e.state.record_source(SOURCE, err.reason)
        e.state.commit()
        return err.reason
    e.state.record_source(SOURCE)
    e.state.commit()
    return None
