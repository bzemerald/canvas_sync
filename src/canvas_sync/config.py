"""Two kinds of configuration.

* The account (Canvas URL + which folder to sync into) lives in ~/.config/canvas-sync,
  the token in the macOS Keychain.
* Everything about *how* to sync lives in <root>/.canvas/config.toml, which is meant
  to be edited by hand (comments are preserved when the CLI edits it).
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import keyring
import tomlkit

KEYRING_SERVICE = "canvas-sync"
ACCOUNT_FILE = Path(os.environ.get("CANVAS_SYNC_HOME", "~/.config/canvas-sync")).expanduser() / "config.toml"

DEFAULT_VIEW_DIRS = {"modules": "Modules", "files": "Files", "attachments": "Attachments"}

SETTINGS_TEMPLATE = """\
# How canvas-sync lays out and syncs this folder. Edit freely.

[courses]
# Which courses `canvas pull` syncs: "active" (current enrollments) or "favorites".
select = "active"
include = []   # course ids to sync in addition
exclude = []   # course ids to never sync

[course_names]
# Rename a course folder:  12345 = "Linear Algebra"

[layout]
# Course folder relative to this root. Fields: {term} {code} {name} {id}
course_dir = "{term}/{code}"
# A file that appears in several views is stored once, in the first view listed
# here that contains it; the other views get symlinks to it.
views = ["modules", "files"]
link_other_views = true
# Where files go that appear in none of `views` (e.g. only linked from a page).
fallback_view = "attachments"

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


@dataclass
class Settings:
    select: str = "active"
    include: list[int] = field(default_factory=list)
    exclude: list[int] = field(default_factory=list)
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

    @classmethod
    def load(cls, path: Path) -> Settings:
        try:
            data: dict[str, Any] = tomlkit.parse(path.read_text()).unwrap()
        except Exception as e:
            raise ConfigError(f"{path}: {e}") from e
        d = cls()
        courses, layout, sync = data.get("courses", {}), data.get("layout", {}), data.get("sync", {})
        s = cls(
            select=courses.get("select", d.select),
            include=[int(x) for x in courses.get("include", [])],
            exclude=[int(x) for x in courses.get("exclude", [])],
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
        )
        for name, allowed in CHOICES.items():
            if getattr(s, name) not in allowed:
                raise ConfigError(f"{path}: {name} must be one of {sorted(allowed)}")
        for v in [*s.views, s.fallback_view]:
            if v not in DEFAULT_VIEW_DIRS:
                raise ConfigError(f"{path}: unknown view {v!r}; use {sorted(DEFAULT_VIEW_DIRS)}")
        return s


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


@dataclass
class Account:
    base_url: str
    root: Path

    @classmethod
    def load(cls) -> Account | None:
        data: dict[str, Any] = {}
        if ACCOUNT_FILE.exists():
            data = tomlkit.parse(ACCOUNT_FILE.read_text()).unwrap()
        url = os.environ.get("CANVAS_URL") or data.get("base_url")
        root = os.environ.get("CANVAS_ROOT") or data.get("root")
        if not url or not root:
            return None
        return cls(url.rstrip("/"), Path(root).expanduser())

    def save(self) -> None:
        ACCOUNT_FILE.parent.mkdir(parents=True, exist_ok=True)
        doc = tomlkit.document()
        doc["base_url"] = self.base_url
        doc["root"] = str(self.root)
        ACCOUNT_FILE.write_text(tomlkit.dumps(doc))

    def token(self) -> str | None:
        return os.environ.get("CANVAS_TOKEN") or keyring.get_password(KEYRING_SERVICE, self.base_url)

    def set_token(self, token: str) -> None:
        keyring.set_password(KEYRING_SERVICE, self.base_url, token)
