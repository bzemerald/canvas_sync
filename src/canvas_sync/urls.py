"""Where things are on Canvas, relative to the site: a course, its views, a file, a module, a
document. The app works out a course's and a document's itself, for things it has no address for
(app/src/lib/canvas.ts); tests/shared/canvas_urls.json is what both must say."""

from __future__ import annotations

from typing import Any
from urllib.parse import quote

from .documents import doc_url, on_ed

# Where a course's views are on its site ("": its own page; what's on Ed and its tools have none).
VIEW_PATHS = {
    "overview": "", "modules": "/modules", "announcements": "/announcements", "ed": "", "assignments": "/assignments",
    "grades": "/grades", "files": "/files", "syllabus": "/assignments/syllabus", "pages": "/pages", "tools": "", "canvas": "",
}
# Where Canvas keeps each kind of document (an announcement is a discussion topic).
DOC_PATHS = {"page": "pages", "assignment": "assignments", "announcement": "discussion_topics"}
_UNESCAPED = "!'()*"  # (with these, `quote` is JavaScript's encodeURIComponent)


def course_url(course: int) -> str:
    return f"/courses/{course}"


def view_url(course: int, view: str) -> str:
    return course_url(course) + VIEW_PATHS[view]


def file_url(course: int, file_id: int) -> str:
    return f"{course_url(course)}/files/{file_id}"


def module_url(course: int, module: int) -> str:
    return f"{course_url(course)}/modules#module_{module}"


def document_url(course: int, kind: str, doc_id: str, raw: dict[str, Any] | None = None) -> str | None:
    """Where a document is: the syllabus at its view; another where Canvas says (`raw`: what its
    API gave; Ed's is in full), else where Canvas keeps one of its kind. None: on Ed, which
    didn't say."""
    if kind == "syllabus":
        return view_url(course, "syllabus")
    if raw and (url := doc_url(raw)):
        return url
    if kind not in DOC_PATHS or on_ed(kind, doc_id):
        return None
    return f"{course_url(course)}/{DOC_PATHS[kind]}/{quote(doc_id, safe=_UNESCAPED)}"
