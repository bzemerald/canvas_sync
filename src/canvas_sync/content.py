"""A course as the app's course page shows it: an overview of what needs attention, and
its announcements, assignments, pages and syllabus, from what the last pull stored.

HTML is returned as Canvas wrote it; the app sanitizes it. With it comes a map from the
Canvas files it links to their local copies, so links and images can open those.
"""

from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from .discover import file_refs
from .search import DOC_BODY, relative_url
from .state import State
from .text import html_to_text

KINDS = ("announcement", "assignment", "page", "syllabus")


def _when(iso: str | None) -> datetime | None:
    if not iso:
        return None
    try:
        return datetime.fromisoformat(iso.replace("Z", "+00:00"))
    except ValueError:
        return None


def _docs(state: State, course_id: int, kind: str | None = None) -> list[tuple[str, str, str, dict[str, Any]]]:
    sql = "SELECT kind, id, title, raw FROM documents WHERE course_id = ?" + (" AND kind = ?" if kind else "")
    rows = state.db.execute(sql, (course_id, kind) if kind else (course_id,))
    return [(r["kind"], r["id"], r["title"], json.loads(r["raw"] or "{}")) for r in rows]


def _summary(course_id: int, kind: str, doc_id: str, title: str, raw: dict[str, Any]) -> dict[str, Any]:
    out: dict[str, Any] = {"kind": kind, "id": doc_id, "title": title, "url": relative_url(raw.get("html_url"))}
    if kind == "announcement":
        text = html_to_text(raw.get("message"))
        out |= {
            "date": raw.get("posted_at"),
            "author": (raw.get("author") or {}).get("display_name") or raw.get("user_name"),
            "unread": raw.get("read_state") == "unread",  # as Canvas has it
            "preview": text[:160],
        }
    elif kind == "assignment":
        out |= {
            "date": raw.get("due_at"),
            "due_at": raw.get("due_at"),
            "unlock_at": raw.get("unlock_at"),
            "lock_at": raw.get("lock_at"),
            "points": raw.get("points_possible"),
            "submission_types": raw.get("submission_types") or [],
        }
    elif kind == "page":
        out |= {"date": raw.get("updated_at"), "front_page": bool(raw.get("front_page"))}
        out["url"] = out["url"] or f"/courses/{course_id}/pages/{doc_id}"
    elif kind == "syllabus":
        out["url"] = f"/courses/{course_id}/assignments/syllabus"
    return out


def items(state: State, course_id: int, kind: str) -> list[dict[str, Any]]:
    """Summaries of one kind of item, in the order the app lists them."""
    out = [_summary(course_id, k, i, t, raw) for k, i, t, raw in _docs(state, course_id, kind)]
    if kind == "assignment":
        # Upcoming soonest first, then past ones most recent first, then undated.
        now = datetime.now(timezone.utc)
        def order(a: dict[str, Any]) -> tuple[int, float]:
            due = _when(a["due_at"])
            if due is None:
                return (2, 0)
            return (0, due.timestamp()) if due >= now else (1, -due.timestamp())
        out.sort(key=order)
    elif kind == "page":
        out.sort(key=lambda p: (not p["front_page"], p["title"].casefold()))
    else:
        out.sort(key=lambda a: a.get("date") or "", reverse=True)
    return out


def _local_files(state: State, root: Path, ids: list[int]) -> dict[str, dict[str, str]]:
    out = {}
    for fid in ids:
        rec = state.get(fid)
        if rec and rec.path and not rec.ignored and (root / rec.path).exists():
            out[str(fid)] = {"path": rec.path, "name": Path(rec.path).name}
    return out


def item(state: State, root: Path, course_id: int, kind: str, doc_id: str) -> dict[str, Any] | None:
    """One item in full: its summary, its HTML, and the local copies of files it refers to."""
    for k, i, title, raw in _docs(state, course_id, kind):
        if i != doc_id:
            continue
        html = raw.get(DOC_BODY.get(kind, ""), "") or ""
        attached = [a for a in raw.get("attachments") or [] if a.get("id")]
        refs = list(dict.fromkeys([*file_refs(html, course_id), *(a["id"] for a in attached)]))
        local = _local_files(state, root, refs)
        return _summary(course_id, k, i, title, raw) | {
            "html": html,
            "files": local,  # Canvas file id -> local copy
            "attachments": [
                {"id": a["id"], "name": a.get("display_name") or a.get("filename") or str(a["id"]),
                 "path": local.get(str(a["id"]), {}).get("path")}
                for a in attached
            ],
        }
    return None


def overview(state: State, root: Path, course_id: int, now: datetime | None = None) -> dict[str, Any]:
    """What a course page opens with: what's due, what was said, what's new."""
    now = now or datetime.now(timezone.utc)
    docs = _docs(state, course_id)
    count = {k: sum(d[0] == k for d in docs) for k in KINDS}
    syllabus = next((raw for k, _, _, raw in docs if k == "syllabus"), None)

    assignments = [_summary(course_id, k, i, t, raw) for k, i, t, raw in docs if k == "assignment"]
    upcoming = sorted(
        (a for a in assignments if (due := _when(a["due_at"])) and now - timedelta(hours=12) <= due <= now + timedelta(days=21)),
        key=lambda a: a["due_at"],
    )
    announcements = sorted(
        (_summary(course_id, k, i, t, raw) for k, i, t, raw in docs if k == "announcement"),
        key=lambda a: a.get("date") or "", reverse=True,
    )

    files = []
    for r in state.db.execute(
        "SELECT id, path, raw FROM files WHERE course_id = ? AND path IS NOT NULL AND ignored = 0", (course_id,)
    ):
        if (root / r["path"]).exists():
            raw = json.loads(r["raw"] or "{}")
            files.append({"file_id": r["id"], "path": r["path"], "name": Path(r["path"]).name,
                          "date": raw.get("created_at") or raw.get("updated_at")})
    files.sort(key=lambda f: f["date"] or "", reverse=True)

    return {
        "upcoming": upcoming[:8],
        "announcements": announcements[:5],
        "new_files": files[:8],
        "counts": {
            "announcements": count["announcement"],
            "assignments": count["assignment"],
            "pages": count["page"],
            "files": len(files),
            "syllabus": bool(syllabus and (syllabus.get("syllabus_body") or "").strip()),
        },
    }
