"""What a course's documents (announcements, assignments, pages, the syllabus, posts on Ed) are,
from what Canvas and Ed say of them (`raw`): where their text is, where they are on the web, and
which are from Ed."""

from __future__ import annotations

from typing import Any
from urllib.parse import urlsplit

# By kind, where a document's HTML is in what its API gave.
DOC_BODY = {"page": "body", "assignment": "description", "announcement": "message", "syllabus": "syllabus_body",
            "post": "message"}


def relative_url(url: str | None) -> str | None:
    if not url:
        return None
    parts = urlsplit(url)
    return parts.path + (f"?{parts.query}" if parts.query else "")


def whole_url(url: str | None, base_url: str) -> str | None:
    """A link as kept (Canvas's relative to the site, others in full), in full."""
    if not url:
        return None
    return url if url.startswith(("http://", "https://")) else base_url + url


def doc_url(raw: dict[str, Any]) -> str | None:
    """Where a document is on the web: on Canvas, relative to the site; from elsewhere (Ed),
    in full."""
    return raw.get("html_url") if raw.get("source") else relative_url(raw.get("html_url"))


def on_ed(kind: str, doc_id: str) -> bool:
    """Whether a document is from Ed (see ed.document), whatever its kind: what the `ed` view has.
    (Not a page: its id comes from its title, and "Ed Discussion" is ed-discussion.)"""
    return kind in ("announcement", "post") and doc_id.startswith("ed-")


def canvas_copy(kind: str, raw: dict[str, Any]) -> bool:
    """What staff put on Ed that's one of the course's Canvas announcements too, as an announcement
    or a post: on Ed it's listed as itself; elsewhere, and in search, it's Canvas's. (A student's
    question with the same title is just that.)"""
    ed = raw.get("ed") or {}
    return bool(ed.get("on_canvas")) and (kind == "announcement" or bool(ed.get("staff")))
