"""Decide where each remote file lives locally.

Pure function of (settings, remote files, pins): no filesystem access, so it can be
previewed and tested in isolation. Order of precedence for a file's location:

1. a pin (the user moved the file in Finder, or a conflict resolution chose a spot)
2. the first matching [[rules]] entry
3. the first entry of `views` the file appears in; other views get symlinks
"""

from __future__ import annotations

import fnmatch
import re
from collections.abc import Iterable
from dataclasses import dataclass
from pathlib import PurePosixPath

from .config import Rule, Settings
from .models import Course, RemoteFile, Source

_INVALID = re.compile(r'[\x00-\x1f/\\:*?"<>|]')


def sanitize(name: str, max_len: int = 150) -> str:
    """Make a Canvas name safe as a single path component (on macOS and Windows)."""
    name = _INVALID.sub("_", name).strip().rstrip(".")
    if not name:
        return "_"
    if len(name) > max_len:
        stem, dot, ext = name.rpartition(".")
        if dot and 0 < len(ext) <= 10:
            name = f"{stem[: max_len - len(ext) - 1]}.{ext}"
        else:
            name = name[:max_len]
    return name


@dataclass(frozen=True)
class Placement:
    primary: PurePosixPath  # where the real file goes, relative to root
    links: tuple[PurePosixPath, ...] = ()  # symlinks pointing at it


class Layout:
    def __init__(self, settings: Settings):
        self.s = settings

    def course_dir(self, course: Course) -> PurePosixPath:
        override = self.s.course_names.get(course.id)
        fields = {
            "term": course.term or "No Term",
            "code": override or course.code,
            "name": override or course.name,
            "id": str(course.id),
        }
        safe = {k: sanitize(v) for k, v in fields.items()}
        return PurePosixPath(*(seg.format(**safe) for seg in self.s.course_dir.split("/") if seg))

    def place_course(
        self, course: Course, files: Iterable[RemoteFile], pins: dict[int, str]
    ) -> dict[int, Placement | None]:
        """Placement for every file (None = excluded by a rule). Name clashes get ' (2)'.

        Files are processed in id order so that existing files keep their names
        when a newer upload (higher id) arrives with the same name.
        """
        cdir = self.course_dir(course)
        taken = {p.casefold() for p in pins.values()}  # APFS is case-insensitive
        result: dict[int, Placement | None] = {}
        for f in sorted(files, key=lambda f: f.id):
            if f.id in pins:
                result[f.id] = Placement(PurePosixPath(pins[f.id]))
                continue
            p = self.place(cdir, course, f)
            if p is not None:
                p = Placement(_claim(p.primary, taken), tuple(_claim(l, taken) for l in p.links))
            result[f.id] = p
        return result

    def place(self, cdir: PurePosixPath, course: Course, f: RemoteFile) -> Placement | None:
        name = sanitize(f.name)

        def path_in(src: Source) -> PurePosixPath:
            view_dir = self.s.view_dirs.get(src.kind, src.kind)
            return cdir.joinpath(view_dir, *map(sanitize, src.folder), name)

        candidates = [path_in(s) for v in self.s.views for s in f.sources if s.kind == v]
        if not candidates:
            fb = self.s.fallback_view
            candidates = [path_in(s) for s in f.sources if s.kind == fb] or [
                cdir / self.s.view_dirs.get(fb, fb) / name
            ]
        candidates = list(dict.fromkeys(candidates))

        rule = self.rule_for(course, f)
        if rule is not None:
            if rule.skip:
                return None
            primary = cdir.joinpath(*(sanitize(p) for p in rule.to.split("/") if p), name)
            others = candidates if rule.keep_views else []
        else:
            primary, others = candidates[0], candidates[1:]
        links = tuple(p for p in others if p != primary) if self.s.link_other_views else ()
        return Placement(primary, links)

    def rule_for(self, course: Course, f: RemoteFile) -> Rule | None:
        name = sanitize(f.name)
        keys = ["/".join([s.kind, *map(sanitize, s.folder), name]).casefold() for s in f.sources]
        keys = keys or [name.casefold()]
        for rule in self.s.rules:
            if rule.course is not None and rule.course != course.id:
                continue
            pattern = rule.match.casefold()
            if any(fnmatch.fnmatchcase(k, pattern) for k in keys):
                return rule
        return None


def _claim(path: PurePosixPath, taken: set[str]) -> PurePosixPath:
    candidate, n = path, 2
    while candidate.as_posix().casefold() in taken:
        candidate = path.with_name(f"{path.stem} ({n}){path.suffix}")
        n += 1
    taken.add(candidate.as_posix().casefold())
    return candidate
