"""Three kinds of configuration.

* The account (Canvas URL + which folder to sync into) lives in ~/.config/canvas-sync,
  the token in the macOS Keychain.
* Everything about *how* to sync lives in <root>/.canvas/config.toml, which is meant
  to be edited by hand (comments are preserved when the CLI edits it).
* The desktop app's own preferences (language, automatic syncing) live in
  ~/.config/canvas-sync/app.toml: they belong to this computer, not to a sync folder.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import keyring
import keyring.errors
import tomlkit

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

[sidebar]
# The app's sidebar order, as you drag it: terms by Canvas's name for them, courses by id.
# Terms and courses not listed come first and in the usual order (new terms on top).
# term_order = ["Fall 2026", "Spring 2026"]
# course_order = [12345, 67890]

# The app's sidebar: pinned folders, and smart folders (saved searches), in order.
#
# [[pinned]]
# course = 12345                        # a course
#
# [[pinned]]
# path = "Fall 2026/MATH 221/Modules"   # a folder
#
# [[pinned]]
# name = "Midterm 1"                    # a smart folder
# query = "mt1"
# courses = [12345]                   # optional: only these courses
# kinds = ["file", "announcement"]    # optional: file | page | assignment | announcement | syllabus
# content = false                     # true: also match text inside files and pages, not just names
"""

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


KINDS = {"file", "page", "assignment", "announcement", "syllabus"}


@dataclass
class SmartFolder:
    name: str
    query: str = ""
    courses: list[int] = field(default_factory=list)
    kinds: list[str] = field(default_factory=list)
    content: bool = False  # also match the text inside, not just titles and folder names


@dataclass(frozen=True)
class PinnedFolder:
    path: str  # relative to the sync folder


@dataclass(frozen=True)
class PinnedCourse:
    course: int  # Canvas course id: a course, not its folder, so it survives renames and layouts


Pinned = PinnedFolder | PinnedCourse | SmartFolder


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
    abbreviations: dict[str, list[str]] = field(default_factory=dict)
    pinned: list[Pinned] = field(default_factory=list)
    folder_names: dict[str, str] = field(default_factory=dict)
    skip_folders: list[str] = field(default_factory=list)
    term_order: list[str] = field(default_factory=list)   # the sidebar, as you arranged it
    course_order: list[int] = field(default_factory=list)

    @property
    def smart_folders(self) -> list[SmartFolder]:
        return [p for p in self.pinned if isinstance(p, SmartFolder)]

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
            abbreviations={
                str(k).lower(): [x.lower() for x in _strings(v)]
                for k, v in data.get("search", {}).get("abbreviations", {}).items()
            },
            pinned=[_pinned_item(f) for f in data.get("pinned", [])]
            + [_smart_folder(f) for f in data.get("smart_folders", [])],
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


def _smart_folder(f: dict[str, Any]) -> SmartFolder:
    if not f.get("name"):
        raise ConfigError(f"smart folder without `name`: {f}")
    kinds = _strings(f.get("kinds", []))
    if bad := set(kinds) - KINDS:
        raise ConfigError(f"smart folder {f['name']!r}: unknown kinds {sorted(bad)}; use {sorted(KINDS)}")
    return SmartFolder(str(f["name"]), str(f.get("query", "")), [int(c) for c in f.get("courses", [])], kinds,
                       bool(f.get("content", False)))


def _pinned_item(d: dict[str, Any]) -> Pinned:
    if "course" in d:
        return PinnedCourse(int(d["course"]))
    if "path" in d:
        return PinnedFolder(str(d["path"]).strip("/"))
    return _smart_folder(d)


def _pinned_table(item: Pinned) -> Any:
    t = tomlkit.table()
    if isinstance(item, PinnedFolder):
        t["path"] = item.path
        return t
    if isinstance(item, PinnedCourse):
        t["course"] = item.course
        return t
    t["name"] = item.name
    t["query"] = item.query
    if item.courses:
        t["courses"] = item.courses
    if item.kinds:
        t["kinds"] = item.kinds
    if item.content:
        t["content"] = True
    return t


def load_pinned(path: Path) -> list[Pinned]:
    data = tomlkit.parse(path.read_text()).unwrap()
    # [[smart_folders]] is where smart folders lived before pinning existed.
    return [_pinned_item(x) for x in data.get("pinned", [])] + [_smart_folder(x) for x in data.get("smart_folders", [])]


def save_pinned(path: Path, items: list[Pinned]) -> None:
    """Write the sidebar's pinned list (folders and smart folders, in order)."""
    doc = tomlkit.parse(path.read_text())
    for key in ("pinned", "smart_folders"):
        if key in doc:
            del doc[key]
    if items:
        aot = tomlkit.aot()
        for item in items:
            aot.append(_pinned_table(item))
        doc["pinned"] = aot
    path.write_text(tomlkit.dumps(doc))


def _smart_names(items: list[Pinned]) -> list[str | None]:
    return [i.name if isinstance(i, SmartFolder) else None for i in items]


def save_smart_folder(path: Path, folder: SmartFolder, replaces: str | None = None) -> None:
    """Add `folder` to the pinned list, or replace the one called `replaces` in place."""
    if set(folder.kinds) - KINDS:
        raise ConfigError(f"unknown kinds {sorted(set(folder.kinds) - KINDS)}")
    items = load_pinned(path)
    names = _smart_names(items)
    if folder.name != replaces and folder.name in names:
        raise ConfigError(f"a smart folder called {folder.name!r} already exists")
    if replaces is not None and replaces in names:
        items[names.index(replaces)] = folder
    else:
        items.append(folder)
    save_pinned(path, items)


def delete_smart_folder(path: Path, name: str) -> None:
    items = load_pinned(path)
    names = _smart_names(items)
    if name not in names:
        raise LookupError(f"no smart folder called {name!r}")
    del items[names.index(name)]
    save_pinned(path, items)


def pin(path: Path, item: PinnedFolder | PinnedCourse) -> None:
    items = load_pinned(path)
    if item not in items:
        save_pinned(path, [*items, item])


def unpin(path: Path, item: PinnedFolder | PinnedCourse) -> None:
    items = load_pinned(path)
    if item not in items:
        raise LookupError(f"{item} is not pinned")
    save_pinned(path, [i for i in items if i != item])


def pin_folder(path: Path, folder: str) -> None:
    pin(path, PinnedFolder(folder.strip("/")))


def unpin_folder(path: Path, folder: str) -> None:
    unpin(path, PinnedFolder(folder.strip("/")))


def move_pinned(path: Path, index: int, to: int) -> None:
    items = load_pinned(path)
    if not (0 <= index < len(items) and 0 <= to < len(items)):
        raise LookupError("no such position")
    items.insert(to, items.pop(index))
    save_pinned(path, items)


def save_sidebar_order(path: Path, terms: list[str] | None = None, courses: list[int] | None = None) -> None:
    """The sidebar's order of terms and of courses (within their terms), as dragged in the app."""
    doc = tomlkit.parse(path.read_text())
    table = doc.setdefault("sidebar", tomlkit.table())
    if terms is not None:
        table["term_order"] = list(dict.fromkeys(terms))
    if courses is not None:
        table["course_order"] = list(dict.fromkeys(courses))
    path.write_text(tomlkit.dumps(doc))


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


def record_folder_rename(path: Path, canonical: str, name: str | None, old: str, new: str) -> None:
    """Remember that the folder Canvas names would put at `canonical` is called `name`
    (None: its own name again), and point pinned folders at `old` or below to `new`."""
    doc = tomlkit.parse(path.read_text())
    names = doc.get("folder_names")
    if names is None:
        names = doc["folder_names"] = tomlkit.table()
    if name is None:
        names.pop(canonical, None)
    else:
        names[canonical] = name
    path.write_text(tomlkit.dumps(doc))
    moved = [
        PinnedFolder(new + i.path[len(old):]) if isinstance(i, PinnedFolder) and (i.path == old or i.path.startswith(old + "/")) else i
        for i in load_pinned(path)
    ]
    save_pinned(path, moved)


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
    doc = tomlkit.parse(path.read_text())
    courses = doc.setdefault("courses", tomlkit.table())
    for key in ("hidden", "exclude", "include"):
        if key not in courses:
            courses[key] = tomlkit.array()

    def put(key: str, present: bool) -> None:
        if present and course_id not in courses[key]:
            courses[key].append(course_id)
        elif not present and course_id in courses[key]:
            courses[key].remove(course_id)

    put("hidden", hidden)
    if syncing is not None:
        put("exclude", not syncing)
        if not syncing:
            put("include", False)
    path.write_text(tomlkit.dumps(doc))


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
        return cls(
            language=language if language in LANGUAGES else d.language,
            auto_sync=auto_sync if auto_sync in AUTO_SYNC_MINUTES else d.auto_sync,
            sync_on_launch=bool(data.get("sync_on_launch", d.sync_on_launch)),
        )

    def save(self, path: Path | None = None) -> None:
        if self.language not in LANGUAGES:
            raise ConfigError(f"language must be one of {LANGUAGES}")
        if self.auto_sync not in AUTO_SYNC_MINUTES:
            raise ConfigError(f"auto_sync must be one of {AUTO_SYNC_MINUTES} (minutes)")
        path = path or PREFS_FILE
        path.parent.mkdir(parents=True, exist_ok=True)
        doc = tomlkit.document()
        doc.add(tomlkit.comment("The canvas-sync desktop app's preferences (set in its 设置 / Settings)."))
        doc["language"] = self.language
        doc["auto_sync"] = self.auto_sync
        doc["sync_on_launch"] = self.sync_on_launch
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
