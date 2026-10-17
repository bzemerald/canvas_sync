"""What the app can put somewhere.

A *thing* is a course; a folder or a file in the sync folder; one of a course's announcements,
assignments or pages; a module; an external tool; a web link; a saved search; a note; or one of
a course's views (its overview, its files, its grades...). Places in the app (置顶 in the
sidebar; a course's tabs, its overview, its 工具与链接) are lists of *entries*: a thing, the name
you gave it there (if any), and whether it's hidden there.

A thing is written down the same way in config.toml and by the app: its `type`, and the fields
that say which one it is. In a course's own places, `course` is left out for that course's things.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any
from urllib.parse import urlsplit

# A course's views: what its built-in tabs and cards show. `tools` is its tools and links (工具与
# 链接); `canvas` the course on Canvas.
VIEWS = ("overview", "modules", "announcements", "assignments", "grades", "files", "syllabus", "pages", "tools", "canvas")
DOC_KINDS = ("announcement", "assignment", "page")  # (the syllabus is a view)
SEARCH_KINDS = ("file", "page", "assignment", "announcement", "syllabus")
NOTE_ID = re.compile(r"[a-z0-9-]{1,40}")

# By type, the fields that say which one a thing is.
FIELDS: dict[str, tuple[str, ...]] = {
    "course": ("course",),
    "folder": ("path",),
    "file": ("path",),
    "doc": ("course", "kind", "id"),
    "module": ("course", "module"),
    "tool": ("course", "tool"),
    "link": ("url",),
    "search": ("query", "courses", "kinds", "content"),
    "note": ("course", "id"),
    "view": ("course", "view"),
}
IN_A_COURSE = ("doc", "module", "tool", "note", "view")  # a course's own things (`course` says whose)
TITLE_MAX = 200
PLACES = ("tabs", "overview", "links")  # a course's (see places.py); and 置顶


@dataclass(frozen=True)
class Thing:
    type: str
    course: int | None = None
    path: str | None = None  # folder, file: relative to the sync folder
    kind: str | None = None  # doc
    id: str | None = None  # doc, note
    module: int | None = None
    tool: int | None = None
    url: str | None = None
    view: str | None = None
    query: str | None = None  # search
    courses: tuple[int, ...] = ()  # search: only these courses (none: all)
    kinds: tuple[str, ...] = ()  # search: only these kinds (none: all)
    content: bool = False  # search: also the text inside, not just names

    def to_dict(self, home: int | None = None, *, compact: bool = False) -> dict[str, Any]:
        """As written down. `home`: the course whose place it's in (its own `course` is left
        out); `compact`: a search's empty fields left out too (config.toml)."""
        out: dict[str, Any] = {"type": self.type}
        for k in FIELDS[self.type]:
            v = getattr(self, k)
            if v is None or (k == "course" and v == home):  # (a default's views are of no course)
                continue
            if compact and self.type == "search" and k != "query" and not v:
                continue
            out[k] = list(v) if isinstance(v, tuple) else v
        return out

    def moved(self, old: str, new: str) -> Thing:
        """The same thing after the folder at `old` was renamed to `new`."""
        if self.path is not None and (self.path == old or self.path.startswith(old + "/")):
            return Thing(self.type, path=new + self.path[len(old):])
        return self


def course_thing(course: int) -> Thing:
    return Thing("course", course=course)


def view(course: int | None, name: str) -> Thing:
    return Thing("view", course=course, view=name)


def at_home(thing: Thing, home: int) -> Thing:
    """A thing of no course yet (a view in the default arrangement) as `home`'s."""
    if thing.type in IN_A_COURSE and thing.course is None:
        return Thing(**{**thing.__dict__, "course": home})
    return thing


def _int(v: Any) -> int | None:
    return v if isinstance(v, int) and not isinstance(v, bool) else None


def _path(v: Any) -> str | None:
    if not isinstance(v, str):
        return None
    p = v.strip("/")
    return p if p and ".." not in p.split("/") else None


def parse(d: Any, home: int | None = None, *, template: bool = False) -> Thing | None:
    """A thing as written down; None if it doesn't make sense. `home`: the course whose place it's
    in (things of that course may leave `course` out). `template`: in the default arrangement,
    which is every course's: its views are of no course in particular."""
    if not isinstance(d, dict) or d.get("type") not in FIELDS:
        return None
    t = d["type"]
    course = _int(d.get("course")) if "course" in d else home
    if t in IN_A_COURSE and course is None and not (template and t == "view"):
        return None
    if t == "course":
        return course_thing(course) if course is not None else None
    if t in ("folder", "file"):
        path = _path(d.get("path"))
        return Thing(t, path=path) if path else None
    if t == "doc":
        kind, i = d.get("kind"), d.get("id")
        return Thing(t, course=course, kind=kind, id=i) if kind in DOC_KINDS and isinstance(i, str) and i else None
    if t == "module":
        m = _int(d.get("module"))
        return Thing(t, course=course, module=m) if m is not None else None
    if t == "tool":
        n = _int(d.get("tool"))
        return Thing(t, course=course, tool=n) if n is not None else None
    if t == "link":
        url = d.get("url")
        return Thing(t, url=url) if isinstance(url, str) and urlsplit(url).scheme in ("http", "https") else None
    if t == "search":
        query, courses, kinds = d.get("query", ""), d.get("courses", []), d.get("kinds", [])
        if not isinstance(query, str) or not isinstance(courses, list) or not isinstance(kinds, list):
            return None
        if any(_int(c) is None for c in courses) or any(k not in SEARCH_KINDS for k in kinds):
            return None
        return Thing(t, query=query.strip(), courses=tuple(sorted(set(courses))),
                     kinds=tuple(k for k in SEARCH_KINDS if k in kinds), content=d.get("content") is True)
    if t == "note":
        i = d.get("id")
        return Thing(t, course=course, id=i) if isinstance(i, str) and NOTE_ID.fullmatch(i) else None
    name = d.get("view")
    return view(course, name) if name in VIEWS else None


@dataclass(frozen=True)
class Entry:
    """A thing in a place: what you call it there ("": its own name), and whether it's hidden there."""
    thing: Thing
    title: str = ""
    hidden: bool = False

    def to_dict(self, home: int | None = None, *, compact: bool = False) -> dict[str, Any]:
        out = self.thing.to_dict(home, compact=compact)
        if self.title or not compact:
            out["title"] = self.title
        if self.hidden or not compact:
            out["hidden"] = self.hidden
        return out


def parse_entry(d: Any, home: int | None = None, *, template: bool = False) -> Entry | None:
    thing = parse(d, home, template=template)
    if thing is None:
        return None
    title = d.get("title", "")
    return Entry(thing, title.strip()[:TITLE_MAX] if isinstance(title, str) else "", d.get("hidden") is True)


def entries(items: Any, home: int | None = None, *, template: bool = False) -> list[Entry]:
    """The entries of a list as written down: what makes sense, each thing once."""
    out: list[Entry] = []
    for d in items if isinstance(items, list) else []:
        e = parse_entry(d, home, template=template)
        if e is not None and all(x.thing != e.thing for x in out):
            out.append(e)
    return out


# -- as canvas-sync wrote them before things had a type ---------------------------------------
# (read, so that config.toml and app.toml from then still work; see config.migrate)

OLD_TABS = ("overview", "modules", "announcements", "assignments", "grades", "files", "syllabus", "pages")
OLD_CARDS = {"upcoming": "assignments", "announcements": "announcements", "modules": "modules", "files": "files",
             "grades": "grades", "links": "tools"}


OLD_LAYOUT_KEYS = ("cards", "extra_cards", "hidden_tabs", "tab_items", "hidden_links")


def is_old(d: Any) -> bool:
    """A [[pinned]] table, or an item in a list, written the old way (untyped)."""
    return not isinstance(d, dict) or d.get("type") not in FIELDS


def is_old_layout(d: dict[str, Any]) -> bool:
    return any(k in d for k in OLD_LAYOUT_KEYS) or any(is_old(x) for k in ("tabs", "links") for x in d.get(k) or [])


def _old_doc(course: int, kind: Any, i: Any) -> Thing | None:
    if kind == "syllabus":
        return view(course, "syllabus")
    return parse({"type": "doc", "course": course, "kind": kind, "id": i})


def old_pinned(d: dict[str, Any]) -> Entry | None:
    """A [[pinned]] (or [[smart_folders]]) table. Their titles were what things were called when
    pinned, not names of your own; links' and smart folders' are."""
    title = str(d.get("title", ""))
    if "url" in d:
        thing = parse({"type": "link", "url": d["url"]})
        return Entry(thing, title) if thing else None
    if "file" in d:
        thing = parse({"type": "file", "path": d["file"]})
    elif "course" in d:
        course = _int(d["course"])
        if course is None:
            return None
        thing = (_old_doc(course, d["kind"], d.get("id")) if "kind" in d
                 else parse({"type": "module", "course": course, "module": d["module"]}) if "module" in d
                 else parse({"type": "tool", "course": course, "tool": d["tool"]}) if "tool" in d
                 else course_thing(course))
    elif "path" in d:
        thing = parse({"type": "folder", "path": d["path"]})
    elif "name" in d:
        thing = parse({"type": "search", "query": d.get("query", ""), "courses": d.get("courses", []),
                       "kinds": d.get("kinds", []), "content": d.get("content", False)})
        return Entry(thing, str(d["name"]).strip()) if thing else None
    else:
        return None
    return Entry(thing) if thing else None


def _old_tab_item(d: Any, course: int) -> Entry | None:
    if not isinstance(d, dict):
        return None
    t = d.get("type")
    thing = (parse({"type": t, "path": d.get("path")}) if t in ("folder", "file")
             else _old_doc(course, d.get("kind"), d.get("doc")) if t == "doc"
             else parse({"type": t, "course": course, t: d.get(t)}) if t in ("module", "tool")
             else parse({"type": "link", "url": d.get("url")}) if t == "link" else None)
    return Entry(thing, str(d.get("title", ""))) if thing else None


def _old_card(d: Any, course: int) -> Entry | None:
    if not isinstance(d, dict):
        return None
    t, title = d.get("type"), str(d.get("title", ""))
    if t in OLD_CARDS:
        thing: Thing | None = view(course, OLD_CARDS[t])
    elif t == "syllabus":
        thing = view(course, "syllabus")
    elif t in ("folder", "file"):
        thing = parse({"type": t, "path": d.get("path")})
    elif t == "note":
        thing = parse({"type": "note", "course": course, "id": d.get("id")})
    elif t == "page":
        thing = parse({"type": "doc", "course": course, "kind": "page", "id": d.get("page")})
    elif t == "module":
        thing = parse({"type": "module", "course": course, "module": d.get("module")})
    elif t == "search":
        thing = parse({"type": "search", "query": d.get("query", ""), "courses": [course], "content": d.get("content", False)})
    else:
        thing = None
    return Entry(thing, title) if thing else None


def _once(items: list[Entry | None]) -> list[Entry]:
    out: list[Entry] = []
    for e in items:
        if e is not None and all(x.thing != e.thing for x in out):
            out.append(e)
    return out


def old_layout(d: dict[str, Any], course: int, tools: list[int] | None = None) -> dict[str, list[Entry]]:
    """A [course_layouts.<id>] table from then: `tabs` as names (and "x:<id>" for `tab_items`),
    `hidden_tabs`, `cards` (shown ones; or `extra_cards` after the default ones), `hidden_links`
    and `links`. As places (see places.py): arranged ones have the course's own things in them;
    else just what was added. `tools`: the course's, in Canvas's order (which 工具与链接 had)."""
    out: dict[str, list[Entry]] = {}
    items = {f"x:{x.get('id')}": _old_tab_item(x, course) for x in d.get("tab_items", []) or [] if isinstance(x, dict)}
    if "tabs" in d or "hidden_tabs" in d:
        hidden = set(d.get("hidden_tabs") or [])
        names = [x for x in d.get("tabs") or [] if isinstance(x, str)]
        names += [x for x in (*OLD_TABS, *items) if x not in names]
        out["tabs"] = _once([Entry(view(course, x), hidden=x in hidden) if x in OLD_TABS else items.get(x) for x in names])
    else:
        out["tabs"] = _once(list(items.values()))
    if "cards" in d:
        shown = _once([_old_card(c, course) for c in d.get("cards") or []])
        # A built-in card left out was hidden.
        out["overview"] = shown + [Entry(view(course, v), hidden=True) for v in (*OLD_CARDS.values(), "syllabus")
                                   if all(e.thing != view(course, v) for e in shown)]
    else:
        out["overview"] = _once([_old_card(c, course) for c in d.get("extra_cards") or []])
    # 工具与链接: the course's tools, its syllabus and Canvas, hidden by name; then links you added.
    hidden = [str(x) for x in d.get("hidden_links") or []]
    order = tools or []
    hidden_tools = sorted((int(m[1]) for key in hidden if (m := re.fullmatch(r"tool:(\d+)", key))),
                          key=lambda n: order.index(n) if n in order else len(order))
    links: list[Entry | None] = [Entry(Thing("tool", course=course, tool=n), hidden=True) for n in hidden_tools]
    links += [Entry(view(course, key), hidden=True) for key in ("syllabus", "canvas") if key in hidden]
    for n, x in enumerate(d.get("links") or []):
        thing = parse({"type": "link", "url": x.get("url")}) if isinstance(x, dict) else None
        links.append(Entry(thing, str(x.get("title", "")), f"link:{n}" in hidden) if thing else None)
    out["links"] = _once(links)
    return out


def old_defaults(data: dict[str, Any]) -> dict[str, list[Entry]]:
    """app.toml's default arrangement from then: `tab_order`, `hidden_tabs`, `overview_order`,
    `overview_hidden` (names of built-in tabs and cards)."""
    out: dict[str, list[Entry]] = {}
    if "tab_order" in data or "hidden_tabs" in data:
        hidden = set(data.get("hidden_tabs") or [])
        order = [x for x in data.get("tab_order") or [] if x in OLD_TABS]
        out["tabs"] = [Entry(view(None, x), hidden=x in hidden) for x in dict.fromkeys([*order, *OLD_TABS])]
    if "overview_order" in data or "overview_hidden" in data:
        hidden = set(data.get("overview_hidden") or [])
        order = [x for x in data.get("overview_order") or [] if x in OLD_CARDS]
        out["overview"] = [Entry(view(None, OLD_CARDS[x]), hidden=x in hidden) for x in dict.fromkeys([*order, *OLD_CARDS])]
        out["overview"].append(Entry(view(None, "syllabus"), hidden=True))
    return out
