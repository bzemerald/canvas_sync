"""Three kinds of configuration.

* The account (Canvas URL + which folder to sync into) lives in ~/.config/canvas-sync,
  the token in the macOS Keychain.
* Everything about *how* to sync lives in <root>/.canvas/config.toml, which is meant
  to be edited by hand (comments are preserved when the CLI edits it).
* The desktop app's own preferences (language, automatic syncing) live in
  ~/.config/canvas-sync/app.toml: they belong to this computer, not to a sync folder.
"""

from __future__ import annotations

import functools
import os
import threading
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, TypeVar

import keyring
import keyring.errors
import tomlkit

from .things import (
    PLACES, Entry, Thing, entries, is_old, is_old_layout, old_defaults, old_layout, old_pinned, parse_entry,
)

KEYRING_SERVICE = "canvas-sync"
ACCOUNT_FILE = Path(os.environ.get("CANVAS_SYNC_HOME", "~/.config/canvas-sync")).expanduser() / "config.toml"
PREFS_FILE = ACCOUNT_FILE.parent / "app.toml"

DEFAULT_VIEW_DIRS = {"modules": "Modules", "files": "Files", "attachments": "Attachments"}

SETTINGS_TEMPLATE = """\
# How canvas-sync lays out and syncs this folder. Edit freely.

[courses]
# Which courses `canvas pull` syncs: "active" (current enrollments) or "favorites".
select = "active"
include = []   # course ids to sync in addition
exclude = []   # course ids to never sync
hidden = []    # course ids the app doesn't show (in its sidebar, search, what's new)

[course_names]
# Rename a course folder:  12345 = "Linear Algebra"

[course_aliases]
# Extra names search understands for a course:  12345 = ["linalg", "线代"]

[course_icons]
# A course's icon in the app (without one here, the app picks one from its department):
# 12345 = { icon = "atom", color = "blue" }   # or { emoji = "🧪" }, or { icon = "none" }

[layout]
# Course folder relative to this root. Fields: {term} {code} {name} {id}
course_dir = "{term}/{code}"
# A file that appears in several views is stored once, in the first view listed
# here that contains it; the other views get symlinks to it.
views = ["modules", "files"]
link_other_views = true
# Where files go that appear in none of `views` (e.g. only linked from a page).
fallback_view = "attachments"
# Folders you deleted or stopped syncing in the app: files Canvas adds to them later
# aren't downloaded. Paths as Canvas names would make them (see [folder_names]).
skip_folders = []

[layout.view_dirs]
modules = "Modules"
files = "Files"
attachments = "Attachments"

[sync]
max_file_mb = 300
on_conflict = "rename_local"    # both changed: rename_local | rename_remote | skip
on_local_delete = "ignore"      # you deleted a file: ignore (don't re-download) | restore
on_local_move = "follow"        # you moved a file: follow (remember new spot) | restore
on_remote_delete = "keep"       # removed from Canvas: keep | delete_if_unmodified (to Trash)

# Placement rules, first match wins. `match` is a case-insensitive glob against
# "<view>/<folder>/<filename>" for every place the file appears in Canvas, e.g.
# "files/Lecture Slides/*.pdf" or "modules/*week*/*.pdf".
#
# [[rules]]
# match = "files/Lecture Slides/*.pdf"
# to = "Slides"          # folder relative to the course folder
# course = 12345         # optional: only in this course
# keep_views = false     # true: also keep symlinks in the normal views
# skip = false           # true: don't download matching files at all

[search.abbreviations]
# Added to the built-in ones (mt = midterm, hw = homework, sol = solution, ...).
# exam = ["midterm", "final", "prelim"]

[folder_names]
# Folders you renamed in the app. Key: the path Canvas names would give the folder;
# value: what it's called instead. New files from Canvas keep going into it.
# "Fall 2026/MATH 221/Modules/01 Week 1" = "Week 1 - Vectors"

# A course's page in the app, arranged for it: its tabs, the cards on its overview, and what's in
# its 工具与链接. Each is a list of the course's things (written as in [[pinned]] below, leaving
# out `course`; folders and files in its folder; web links too), each with a `title` of your own
# if you like, and `hidden = true` to hide it. A course's views are its own (overview, modules, announcements, assignments, grades,
# files, syllabus, pages; on the overview also tools, which is 工具与链接), and so are its tools
# and Canvas (view "canvas") in 工具与链接: they're hidden, never taken away. A list without any
# of them follows the default arrangement (set in the app), with what's in it after.
# [course_layouts.12345]
# tabs = [
#     {type = "view", view = "overview"},
#     {type = "doc", kind = "page", id = "schedule", title = "Syllabus"},
#     {type = "view", view = "syllabus", hidden = true},
#     ...
# ]
# overview = [{type = "note", id = "a1b2"}, {type = "folder", path = "Fall 2026/MATH 221/Files/Labs"}]
# links = [{type = "link", url = "https://math221.example.edu", title = "Course website"}]

[sidebar]
# The app's sidebar order, as you drag it: terms by Canvas's name for them, courses by id.
# Terms and courses not listed come first and in the usual order (new terms on top).
# term_order = ["Fall 2026", "Spring 2026"]
# course_order = [12345, 67890]

# The app's sidebar: what's pinned (置顶), in order, each with a `title` of your own if you like.
# Anything can be:
#   type = "course", course = 12345
#   type = "folder", path = "Fall 2026/MATH 221/Modules"         (relative to this folder)
#   type = "file", path = "Fall 2026/MATH 221/Files/schedule.pdf"
#   type = "doc", course = 12345, kind = "page", id = "schedule" (kind: announcement | assignment | page)
#   type = "module", course = 12345, module = 678
#   type = "tool", course = 12345, tool = 90                     (an external tool in the course's menu)
#   type = "link", url = "https://math221.example.edu"
#   type = "note", course = 12345, id = "a1b2"                   (kept in .canvas/notes)
#   type = "view", course = 12345, view = "assignments"          (one of a course's views)
#   type = "search", query = "mt1"                               (a smart folder: a saved search)
#
# [[pinned]]
# type = "search"
# title = "Midterm 1"
# query = "mt1"
# courses = [12345]                   # optional: only these courses
# kinds = ["file", "announcement"]    # optional: file | page | assignment | announcement | syllabus
# content = false                     # true: also match text inside files and pages, not just names
"""

ICON_KEYS = ("icon", "color", "emoji")


@dataclass
class CourseLayout:
    """A course's places in the app, as stored for it (see places.py): its tabs, its overview,
    its 工具与链接 (links)."""
    tabs: list[Entry] = field(default_factory=list)
    overview: list[Entry] = field(default_factory=list)
    links: list[Entry] = field(default_factory=list)

    @classmethod
    def parse(cls, d: dict[str, Any], course: int, tools: list[int] | None = None) -> CourseLayout:
        if is_old_layout(d):
            return cls(**old_layout(d, course, tools))
        return cls(*(entries(d.get(place), course) for place in PLACES))

CHOICES = {
    "select": {"active", "favorites"},
    "on_conflict": {"rename_local", "rename_remote", "skip"},
    "on_local_delete": {"ignore", "restore"},
    "on_local_move": {"follow", "restore"},
    "on_remote_delete": {"keep", "delete_if_unmodified"},
}


class ConfigError(Exception):
    pass


@dataclass
class Rule:
    match: str
    to: str = ""
    course: int | None = None
    keep_views: bool = False
    skip: bool = False


@dataclass
class Settings:
    select: str = "active"
    include: list[int] = field(default_factory=list)
    exclude: list[int] = field(default_factory=list)
    hidden: list[int] = field(default_factory=list)   # not shown in the app
    course_names: dict[int, str] = field(default_factory=dict)
    course_dir: str = "{term}/{code}"
    views: list[str] = field(default_factory=lambda: ["modules", "files"])
    link_other_views: bool = True
    fallback_view: str = "attachments"
    view_dirs: dict[str, str] = field(default_factory=lambda: dict(DEFAULT_VIEW_DIRS))
    max_file_mb: float = 300
    on_conflict: str = "rename_local"
    on_local_delete: str = "ignore"
    on_local_move: str = "follow"
    on_remote_delete: str = "keep"
    rules: list[Rule] = field(default_factory=list)
    course_aliases: dict[int, list[str]] = field(default_factory=dict)
    course_icons: dict[int, dict[str, str]] = field(default_factory=dict)  # {icon, color} or {emoji}
    course_layouts: dict[int, CourseLayout] = field(default_factory=dict)  # courses' pages, as arranged
    abbreviations: dict[str, list[str]] = field(default_factory=dict)
    pinned: list[Entry] = field(default_factory=list)  # 置顶
    folder_names: dict[str, str] = field(default_factory=dict)
    skip_folders: list[str] = field(default_factory=list)
    term_order: list[str] = field(default_factory=list)   # the sidebar, as you arranged it
    course_order: list[int] = field(default_factory=list)

    @classmethod
    def load(cls, path: Path) -> Settings:
        try:
            data: dict[str, Any] = tomlkit.parse(path.read_text()).unwrap()
        except Exception as e:
            raise ConfigError(f"{path}: {e}") from e
        d = cls()
        courses, layout, sync = data.get("courses", {}), data.get("layout", {}), data.get("sync", {})
        sidebar = data.get("sidebar", {})
        s = cls(
            select=courses.get("select", d.select),
            include=[int(x) for x in courses.get("include", [])],
            exclude=[int(x) for x in courses.get("exclude", [])],
            hidden=[int(x) for x in courses.get("hidden", [])],
            course_names={int(k): str(v) for k, v in data.get("course_names", {}).items()},
            course_dir=layout.get("course_dir", d.course_dir),
            views=list(layout.get("views", d.views)),
            link_other_views=bool(layout.get("link_other_views", d.link_other_views)),
            fallback_view=layout.get("fallback_view", d.fallback_view),
            view_dirs={**DEFAULT_VIEW_DIRS, **layout.get("view_dirs", {})},
            max_file_mb=float(sync.get("max_file_mb", d.max_file_mb)),
            on_conflict=sync.get("on_conflict", d.on_conflict),
            on_local_delete=sync.get("on_local_delete", d.on_local_delete),
            on_local_move=sync.get("on_local_move", d.on_local_move),
            on_remote_delete=sync.get("on_remote_delete", d.on_remote_delete),
            rules=[_rule(r) for r in data.get("rules", [])],
            course_aliases={int(k): _strings(v) for k, v in data.get("course_aliases", {}).items()},
            course_layouts={
                int(k): CourseLayout.parse(v, int(k)) for k, v in data.get("course_layouts", {}).items() if isinstance(v, dict)
            },
            course_icons={
                int(k): {str(kk): str(vv) for kk, vv in v.items() if kk in ICON_KEYS}
                for k, v in data.get("course_icons", {}).items() if isinstance(v, dict)
            },
            abbreviations={
                str(k).lower(): [x.lower() for x in _strings(v)]
                for k, v in data.get("search", {}).get("abbreviations", {}).items()
            },
            pinned=_pinned(data),
            folder_names={str(k).strip("/"): str(v) for k, v in data.get("folder_names", {}).items()},
            skip_folders=[str(x).strip("/") for x in layout.get("skip_folders", [])],
            term_order=[str(x) for x in sidebar.get("term_order", [])],
            course_order=[int(x) for x in sidebar.get("course_order", [])],
        )
        for name, allowed in CHOICES.items():
            if getattr(s, name) not in allowed:
                raise ConfigError(f"{path}: {name} must be one of {sorted(allowed)}")
        for v in [*s.views, s.fallback_view]:
            if v not in DEFAULT_VIEW_DIRS:
                raise ConfigError(f"{path}: unknown view {v!r}; use {sorted(DEFAULT_VIEW_DIRS)}")
        return s


def _strings(v: Any) -> list[str]:
    return [str(x) for x in v] if isinstance(v, list) else [str(v)]


F = TypeVar("F", bound=Callable[..., Any])
_writing = threading.RLock()


def _writes(fn: F) -> F:
    """config.toml read, changed and written back, one change at a time (the app's requests come
    in on threads of their own)."""
    @functools.wraps(fn)
    def locked(*args: Any, **kwargs: Any) -> Any:
        with _writing:
            return fn(*args, **kwargs)
    return locked  # type: ignore[return-value]


def _pinned(data: dict[str, Any]) -> list[Entry]:
    """置顶. ([[smart_folders]] is where smart folders were before anything could be pinned.)"""
    tables = [x for x in [*data.get("pinned", []), *data.get("smart_folders", [])] if isinstance(x, dict)]
    out: list[Entry] = []
    for e in (old_pinned(x) if is_old(x) else parse_entry(x) for x in tables):
        if e is not None and all(x.thing != e.thing for x in out):
            out.append(e)
    return out


def load_pinned(path: Path) -> list[Entry]:
    return _pinned(tomlkit.parse(path.read_text()).unwrap())


def _dump(doc: Any) -> str:
    """The file, with a blank line before each table (tomlkit leaves none after one it replaced)."""
    out: list[str] = []
    for line in tomlkit.dumps(doc).split("\n"):
        if line.startswith("[") and out and out[-1].strip() and not out[-1].startswith("#"):
            out.append("")
        if line.strip() or (out and out[-1].strip()):
            out.append(line)
    return "\n".join(out)


def _rows(items: list[Entry], home: int | None = None) -> Any:
    """Entries as a list of inline tables, one per line."""
    a = tomlkit.array()
    for e in items:
        t = tomlkit.inline_table()
        t.update(e.to_dict(home, compact=True))
        a.append(t)
    return a.multiline(True)


@_writes
def save_pinned(path: Path, items: list[Entry]) -> None:
    """置顶, in order."""
    doc = tomlkit.parse(path.read_text())
    for key in ("pinned", "smart_folders"):
        if key in doc:
            del doc[key]
    if items:
        aot = tomlkit.aot()
        for e in items:
            t = tomlkit.table()
            t.update(e.to_dict(compact=True))
            aot.append(t)
        doc["pinned"] = aot
    path.write_text(_dump(doc))


@_writes
def change_things(path: Path, change: Callable[[Thing], Thing]) -> None:
    """Every thing in every place (置顶, courses' pages) as `change` makes it."""
    s = Settings.load(path)
    doc = tomlkit.parse(path.read_text())
    pinned = [Entry(change(e.thing), e.title, e.hidden) for e in s.pinned]
    for course, layout in s.course_layouts.items():
        for place in PLACES:
            now = getattr(layout, place)
            moved = [Entry(change(e.thing), e.title, e.hidden) for e in now]
            if moved != now:
                _put_place(doc, course, place, moved)
    path.write_text(_dump(doc))
    if pinned != s.pinned:
        save_pinned(path, pinned)


@_writes
def save_sidebar_order(path: Path, terms: list[str] | None = None, courses: list[int] | None = None) -> None:
    """The sidebar's order of terms and of courses (within their terms), as dragged in the app."""
    doc = tomlkit.parse(path.read_text())
    table = doc.setdefault("sidebar", tomlkit.table())
    if terms is not None:
        table["term_order"] = list(dict.fromkeys(terms))
    if courses is not None:
        table["course_order"] = list(dict.fromkeys(courses))
    path.write_text(tomlkit.dumps(doc))


@_writes
def update_skip_folders(path: Path, add: list[str] = (), remove_under: list[str] = ()) -> None:  # type: ignore[assignment]
    """Add folders to [layout] skip_folders, and drop those at or under `remove_under`."""
    doc = tomlkit.parse(path.read_text())
    layout = doc.setdefault("layout", tomlkit.table())
    current = [str(x) for x in layout.get("skip_folders", [])]
    gone = lambda p: any(p == r or p.startswith(r + "/") for r in remove_under)  # noqa: E731
    wanted = [p for p in dict.fromkeys([*current, *add]) if not gone(p)]
    if wanted != current:
        arr = tomlkit.array()
        arr.extend(wanted)
        layout["skip_folders"] = arr
        path.write_text(tomlkit.dumps(doc))


@_writes
def record_folder_rename(path: Path, canonical: str, name: str | None, old: str, new: str) -> None:
    """Remember that the folder Canvas names would put at `canonical` is called `name`
    (None: its own name again), and point what's anywhere in the app at `old` or below to `new`."""
    doc = tomlkit.parse(path.read_text())
    names = doc.get("folder_names")
    if names is None:
        names = doc["folder_names"] = tomlkit.table()
    if name is None:
        names.pop(canonical, None)
    else:
        names[canonical] = name
    path.write_text(tomlkit.dumps(doc))
    change_things(path, lambda t: t.moved(old, new))


def _rule(r: dict[str, Any]) -> Rule:
    if "match" not in r:
        raise ConfigError(f"rule without `match`: {r}")
    return Rule(
        match=str(r["match"]),
        to=str(r.get("to", "")),
        course=int(r["course"]) if "course" in r else None,
        keep_views=bool(r.get("keep_views", False)),
        skip=bool(r.get("skip", False)),
    )


@_writes
def set_course_select(path: Path, select: str) -> None:
    """Sync the active courses or the favorites, keeping the file's comments."""
    if select not in CHOICES["select"]:
        raise ConfigError(f"select must be one of {sorted(CHOICES['select'])}")
    doc = tomlkit.parse(path.read_text())
    doc.setdefault("courses", tomlkit.table())["select"] = select
    path.write_text(tomlkit.dumps(doc))


def set_course_hidden(path: Path, course_id: int, hidden: bool, *, syncing: bool | None = None) -> None:
    """Hide a course in the app, or show it again; `syncing` False also stops syncing it (into
    `exclude`), True takes it out of `exclude` again (it syncs if `select` picks it)."""
    set_courses_hidden(path, [course_id], hidden, syncing=syncing)


@_writes
def set_courses_hidden(path: Path, course_ids: list[int], hidden: bool, *, syncing: bool | None = None) -> None:
    """set_course_hidden for several courses at once (a whole term)."""
    doc = tomlkit.parse(path.read_text())
    courses = doc.setdefault("courses", tomlkit.table())
    for key in ("hidden", "exclude", "include"):
        if key not in courses:
            courses[key] = tomlkit.array()

    def put(key: str, course_id: int, present: bool) -> None:
        if present and course_id not in courses[key]:
            courses[key].append(course_id)
        elif not present and course_id in courses[key]:
            courses[key].remove(course_id)

    for course_id in course_ids:
        put("hidden", course_id, hidden)
        if syncing is not None:
            put("exclude", course_id, not syncing)
            if not syncing:
                put("include", course_id, False)
    path.write_text(tomlkit.dumps(doc))


@_writes
def set_course_icon(path: Path, course_id: int, icon: dict[str, str] | None) -> None:
    """A course's icon in the app ({icon, color} or {emoji}); None: back to the app's pick."""
    doc = tomlkit.parse(path.read_text())
    icons = doc.setdefault("course_icons", tomlkit.table())
    key = str(course_id)
    if icon is None:
        if key in icons:
            del icons[key]
    else:
        value = tomlkit.inline_table()
        value.update({k: v for k, v in icon.items() if k in ICON_KEYS and v})
        icons[key] = value
    path.write_text(tomlkit.dumps(doc))


def _put_place(doc: Any, course_id: int, place: str, items: list[Entry]) -> None:
    layouts = doc.setdefault("course_layouts", tomlkit.table(is_super_table=True))
    key = str(course_id)
    table = layouts.get(key)
    if table is None:
        table = layouts[key] = tomlkit.table()
    if items:
        table[place] = _rows(items, course_id)
    elif place in table:
        del table[place]
    if not table:
        del layouts[key]


@_writes
def save_course_place(path: Path, course_id: int, place: str, items: list[Entry]) -> None:
    """One of a course's places as arranged for it (tabs, overview, links); [] : nothing of its own."""
    if place not in PLACES:
        raise ConfigError(f"no place {place!r}; places are {PLACES}")
    doc = tomlkit.parse(path.read_text())
    _put_place(doc, course_id, place, items)
    path.write_text(_dump(doc))


def needs_migration(path: Path) -> bool:
    """config.toml has things written the old way (before things had a type: see things.py)."""
    data = tomlkit.parse(path.read_text()).unwrap()
    layouts = [v for v in data.get("course_layouts", {}).values() if isinstance(v, dict)]
    return "smart_folders" in data or any(is_old(x) for x in data.get("pinned", [])) or any(map(is_old_layout, layouts))


@_writes
def migrate(path: Path, tools: Callable[[int], list[int]] | None = None) -> bool:
    """Write what config.toml has the old way the new way. `tools`: a course's tools, in Canvas's
    order. True if there was any."""
    if not needs_migration(path):
        return False
    data = tomlkit.parse(path.read_text()).unwrap()
    old_layouts = {int(k): v for k, v in data.get("course_layouts", {}).items() if isinstance(v, dict) and is_old_layout(v)}
    s = Settings.load(path)
    save_pinned(path, s.pinned)
    doc = tomlkit.parse(path.read_text())
    for course, table in old_layouts.items():
        doc["course_layouts"][str(course)] = tomlkit.table()
        layout = CourseLayout.parse(table, course, tools(course) if tools else None)
        for place in PLACES:
            _put_place(doc, course, place, getattr(layout, place))
        if str(course) in doc["course_layouts"] and not doc["course_layouts"][str(course)]:
            del doc["course_layouts"][str(course)]
    path.write_text(_dump(doc))
    return True


@_writes
def set_course_listed(path: Path, course_id: int, *, sync: bool) -> None:
    """Move a course id into `include` (sync=True) or `exclude`, keeping the file's comments."""
    doc = tomlkit.parse(path.read_text())
    courses = doc.setdefault("courses", tomlkit.table())
    add, remove = ("include", "exclude") if sync else ("exclude", "include")
    for key in (add, remove):
        if key not in courses:
            courses[key] = tomlkit.array()
    if course_id in courses[remove]:
        courses[remove].remove(course_id)
    if course_id not in courses[add]:
        courses[add].append(course_id)
    path.write_text(tomlkit.dumps(doc))


# -- account ------------------------------------------------------------------


# -- the app's preferences ----------------------------------------------------

LANGUAGES = ("system", "zh", "en")
AUTO_SYNC_MINUTES = (0, 30, 60, 180, 360, 1440)  # 0: off


@dataclass
class AppPrefs:
    language: str = "system"     # system | zh | en
    auto_sync: int = 60          # minutes between syncs while the app runs; 0: off
    sync_on_launch: bool = True  # sync when the app starts (unless it just did)
    meaning: bool = False        # search by meaning, too (meaning.py: an English model, downloaded)
    # The default arrangement of a course's tabs and overview, for courses not arranged for
    # themselves: their views (of no course in particular). []: the usual.
    tabs: list[Entry] = field(default_factory=list)
    overview: list[Entry] = field(default_factory=list)

    @classmethod
    def load(cls, path: Path | None = None) -> AppPrefs:
        """What's saved; anything missing or unrecognized is the default."""
        path = path or PREFS_FILE
        try:
            data = tomlkit.parse(path.read_text()).unwrap() if path.exists() else {}
        except Exception:
            data = {}
        d = cls()
        language = data.get("language", d.language)
        auto_sync = data.get("auto_sync", d.auto_sync)
        old = old_defaults(data)  # (tab_order, hidden_tabs, overview_order, overview_hidden)

        def default(place: str) -> list[Entry]:
            mine = [e for e in entries(data.get(place), template=True) if e.thing.type == "view" and e.thing.course is None]
            return mine or old.get(place, [])
        return cls(
            language=language if language in LANGUAGES else d.language,
            auto_sync=auto_sync if auto_sync in AUTO_SYNC_MINUTES else d.auto_sync,
            sync_on_launch=bool(data.get("sync_on_launch", d.sync_on_launch)),
            meaning=bool(data.get("meaning", d.meaning)),
            tabs=default("tabs"),
            overview=default("overview"),
        )

    @classmethod
    def migrate(cls, path: Path | None = None) -> None:
        """app.toml as an older version wrote it (tab_order, overview_order...), the way this one does."""
        path = path or PREFS_FILE
        try:
            data = tomlkit.parse(path.read_text()).unwrap() if path.exists() else {}
        except Exception:
            return
        if any(k in data for k in ("tab_order", "hidden_tabs", "overview_order", "overview_hidden")):
            cls.load(path).save(path)

    def save(self, path: Path | None = None) -> None:
        if self.language not in LANGUAGES:
            raise ConfigError(f"language must be one of {LANGUAGES}")
        if self.auto_sync not in AUTO_SYNC_MINUTES:
            raise ConfigError(f"auto_sync must be one of {AUTO_SYNC_MINUTES} (minutes)")
        for e in [*self.tabs, *self.overview]:
            if e.thing.type != "view" or e.thing.course is not None:
                raise ConfigError("a default arrangement has a course's views, of no course in particular")
        path = path or PREFS_FILE
        path.parent.mkdir(parents=True, exist_ok=True)
        doc = tomlkit.document()
        doc.add(tomlkit.comment("The canvas-sync desktop app's preferences (set in its 设置 / Settings)."))
        doc["language"] = self.language
        doc["auto_sync"] = self.auto_sync
        doc["sync_on_launch"] = self.sync_on_launch
        doc["meaning"] = self.meaning
        for place in ("tabs", "overview"):
            if getattr(self, place):
                doc.add(tomlkit.nl())
                doc.add(tomlkit.comment(f"Every course's {place}, unless arranged for itself (as in config.toml)."))
                doc[place] = _rows(getattr(self, place))
        path.write_text(tomlkit.dumps(doc))


@dataclass
class Account:
    base_url: str
    root: Path
    user: str | None = None  # your name on Canvas, as of signing in

    @classmethod
    def load(cls) -> Account | None:
        data: dict[str, Any] = {}
        if ACCOUNT_FILE.exists():
            data = tomlkit.parse(ACCOUNT_FILE.read_text()).unwrap()
        url = os.environ.get("CANVAS_URL") or data.get("base_url")
        root = os.environ.get("CANVAS_ROOT") or data.get("root")
        if not url or not root:
            return None
        return cls(url.rstrip("/"), Path(root).expanduser(), data.get("user") or None)

    def save(self) -> None:
        ACCOUNT_FILE.parent.mkdir(parents=True, exist_ok=True)
        doc = tomlkit.document()
        doc["base_url"] = self.base_url
        doc["root"] = str(self.root)
        if self.user:
            doc["user"] = self.user
        ACCOUNT_FILE.write_text(tomlkit.dumps(doc))

    def token(self) -> str | None:
        return os.environ.get("CANVAS_TOKEN") or keyring.get_password(KEYRING_SERVICE, self.base_url)

    def set_token(self, token: str) -> None:
        keyring.set_password(KEYRING_SERVICE, self.base_url, token)

    def clear_token(self) -> None:
        """Sign out: forget the token (the files stay)."""
        try:
            keyring.delete_password(KEYRING_SERVICE, self.base_url)
        except keyring.errors.PasswordDeleteError:
            pass
