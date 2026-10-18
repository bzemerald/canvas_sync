"""The places things are put: 置顶 in the sidebar, and each course's tabs, overview and 工具与链接
(its links). Each is a list of entries (see things.py).

Within a course anything goes anywhere; between courses there's a border. A course's places hold
only its things: its views, documents, modules, tools and notes, the folders and files in its
folder, searches of just that course; and web links, which are no course's. 置顶 is where things
of different courses meet.

A course's places have things of their own, which can be hidden but not taken away: its views
are its tabs, and its overview's cards; its tools, its syllabus and the course on Canvas are its
links. The rest are what you put there. A course's tabs and overview follow the default
arrangement (app.toml; any course's can be made it) unless arranged for the course: then what's
stored for them has their own things in it, in their order. Its links are in the order Canvas
has them, unless arranged too. 置顶 has nothing of its own.
"""

from __future__ import annotations

from pathlib import Path
from typing import TYPE_CHECKING, Any

from . import content
from .search import course_label
from .things import PLACES, Entry, Thing, at_home, course_thing, view

if TYPE_CHECKING:
    from .engine import Engine

TAB_VIEWS = ("overview", "modules", "announcements", "discussion", "assignments", "grades", "files", "syllabus", "pages")
CARD_VIEWS = ("assignments", "announcements", "discussion", "modules", "files", "grades", "tools", "syllabus")
LINK_VIEWS = ("syllabus", "canvas")
USUALLY_HIDDEN = {"overview": ("syllabus",)}


def usual(place: str) -> list[Entry]:
    """How a course's tabs or overview are arranged until you set a default."""
    names = TAB_VIEWS if place == "tabs" else CARD_VIEWS if place == "overview" else ()
    return [Entry(view(None, v), hidden=v in USUALLY_HIDDEN.get(place, ())) for v in names]


class Place:
    """One of a course's places: what it can hold, which things are its own, how it's arranged.
    `dir`: the course's folder (None: not synced, so nothing in it)."""

    def __init__(self, name: str, course: int, tools: list[int], default: list[Entry], dir: str | None = None):
        self.name, self.course, self.dir = name, course, dir
        views = TAB_VIEWS if name == "tabs" else CARD_VIEWS if name == "overview" else LINK_VIEWS
        tool_things = [Thing("tool", course=course, tool=t) for t in tools] if name == "links" else []
        self.things = [*tool_things, *(view(course, v) for v in views)]  # what it has of its own, now
        present = set(self.things)
        mine = [e for e in (Entry(at_home(x.thing, course), x.title, x.hidden) for x in default) if e.thing in present]
        hidden = USUALLY_HIDDEN.get(name, ())
        self.default = fill(mine, [Entry(t, hidden=t.type == "view" and t.view in hidden) for t in self.things])

    def holds(self, thing: Thing) -> bool:
        """Whether it's the course's (or a web link), so it can be here."""
        if thing.type == "link":
            return True
        if thing.type == "course":
            return False
        if thing.type in ("folder", "file"):
            return self.dir is not None and thing.path is not None and (thing.path == self.dir or thing.path.startswith(self.dir + "/"))
        if thing.type == "search":
            return thing.courses == (self.course,)
        return thing.course == self.course

    def own(self, thing: Thing) -> bool:
        """One of the place's own things (a tool the course has taken away still is)."""
        if thing.course != self.course:
            return False
        if self.name == "links":
            return thing.type == "tool" or (thing.type == "view" and thing.view in LINK_VIEWS)
        return thing.type == "view" and thing.view in (TAB_VIEWS if self.name == "tabs" else CARD_VIEWS)

    def arranged(self, stored: list[Entry]) -> list[Entry]:
        """What it holds: its own arrangement if what's stored has its own things in it; else the
        default, then what was added. Own things that aren't there any more (a tool) aren't in
        it; ones it doesn't mention are put where the default has them."""
        base = stored if self.is_arranged(stored) else [*self.default, *stored]
        present = set(self.things)
        return fill([e for e in base if self.holds(e.thing) and (not self.own(e.thing) or e.thing in present)], self.default)

    def is_arranged(self, stored: list[Entry]) -> bool:
        return any(self.own(e.thing) for e in stored)

    def added(self, stored: list[Entry]) -> list[Entry]:
        return [e for e in stored if not self.own(e.thing)]

    def settle(self, stored: list[Entry]) -> list[Entry]:
        """What to keep of an arrangement: just what was added, when that comes to the same."""
        return self.added(stored) if self.arranged(self.added(stored)) == self.arranged(stored) else stored


def fill(base: list[Entry], default: list[Entry]) -> list[Entry]:
    """`base` with the entries of `default` it hasn't got, each after the one before it in
    `default` (at the start if there's none)."""
    out = list(base)
    for i, e in enumerate(default):
        if any(x.thing == e.thing for x in out):
            continue
        at = 0
        for before in reversed(default[:i]):
            j = next((j for j, x in enumerate(out) if x.thing == before.thing), None)
            if j is not None:
                at = j + 1
                break
        out.insert(at, e)
    return out


def describe(entries: list[Entry], e: Engine) -> list[dict[str, Any]]:
    """Entries as the app shows them: each with what its thing is called now (`name`: what Canvas
    or the sync folder calls it; None for what the app names), whether it's still there, and the
    course it's in."""
    courses = {c.id: c for c in e.state.courses()}
    dirs = {e.layout.course_dir(c).as_posix(): c.id for c in courses.values()}
    tools: dict[int, dict[int, str | None]] = {}

    def in_course(path: str) -> int | None:
        return next((cid for d, cid in dirs.items() if path == d or path.startswith(d + "/")), None)

    def one(sql: str, *args: Any) -> str | None:
        row = e.state.db.execute(sql, args).fetchone()
        return row[0] if row else None

    out = []
    for entry in entries:
        t = entry.thing
        name: str | None = None
        exists = t.course in courses if t.course is not None else True
        course = t.course
        if t.type == "course" and t.course in courses:
            name = course_label(courses[t.course], e.settings)
        elif t.type in ("folder", "file"):
            assert t.path is not None
            name, course = Path(t.path).name, in_course(t.path)
            exists = (e.root / t.path).is_dir() if t.type == "folder" else (e.root / t.path).is_file()
        elif t.type == "doc":
            name = one("SELECT title FROM documents WHERE course_id = ? AND kind = ? AND id = ?", t.course, t.kind, t.id)
            exists = name is not None
        elif t.type == "module":
            name = one("SELECT name FROM modules WHERE course_id = ? AND id = ?", t.course, t.module)
            exists = name is not None
        elif t.type == "tool":
            assert t.course is not None
            if t.course not in tools:
                tools[t.course] = {x["id"]: x["label"] for x in content.tools(e.state, t.course)}
            name, exists = tools[t.course].get(t.tool or 0), t.tool in tools[t.course]
        out.append({**entry.to_dict(), "name": name, "exists": exists, "in_course": course})
    return out


def as_course(entries: list[Entry], dirs: dict[str, int]) -> list[Entry]:
    """A course's own folder, pinned, is the course (pinned before courses could be, or dragged
    from 全部文件)."""
    out: list[Entry] = []
    for x in entries:
        if x.thing.type == "folder" and x.thing.path in dirs:
            x = Entry(course_thing(dirs[x.thing.path]), x.title, x.hidden)
        if all(y.thing != x.thing for y in out):
            out.append(x)
    return out

