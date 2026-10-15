"""Plain data objects shared by every layer."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal

# Where in Canvas a file was found. A file can show up in several places at once.
#   files:       the course Files tree
#   modules:     a module item (or a page/assignment inside a module links to it)
#   attachments: linked from a page / assignment / announcement / the syllabus
SourceKind = Literal["files", "modules", "attachments"]


@dataclass(frozen=True)
class Course:
    id: int
    name: str
    code: str
    term: str | None = None
    is_favorite: bool = False

    @classmethod
    def from_api(cls, d: dict[str, Any]) -> Course:
        name = d.get("name") or str(d["id"])
        return cls(
            id=d["id"],
            name=name,
            code=d.get("course_code") or name,
            term=(d.get("term") or {}).get("name"),
            is_favorite=bool(d.get("is_favorite")),
        )


@dataclass(frozen=True)
class Source:
    kind: SourceKind
    folder: tuple[str, ...]  # e.g. ("Lectures", "Week 1"), ("03 Week 3",), ("Pages", "Readings")


@dataclass
class RemoteFile:
    id: int
    course_id: int
    name: str
    size: int
    version: str  # Canvas modified_at; changes when the content changes
    url: str | None  # download URL; None when locked
    locked: bool
    sources: list[Source] = field(default_factory=list)
    raw: dict[str, Any] = field(default_factory=dict, repr=False)

    @classmethod
    def from_api(cls, d: dict[str, Any], course_id: int) -> RemoteFile:
        return cls(
            id=d["id"],
            course_id=course_id,
            name=d.get("display_name") or d.get("filename") or str(d["id"]),
            size=d.get("size") or 0,
            version=d.get("modified_at") or d.get("updated_at") or "",
            url=d.get("url") or None,
            locked=bool(d.get("locked_for_user")),
            raw=d,
        )

    def add_source(self, source: Source) -> None:
        if source not in self.sources:
            self.sources.append(source)


@dataclass
class Document:
    """A non-file piece of course content (page, assignment, ...), kept for future UIs."""

    course_id: int
    kind: str  # page | assignment | announcement | syllabus
    id: str
    title: str
    updated_at: str
    raw: dict[str, Any] = field(repr=False)
