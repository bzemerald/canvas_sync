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
from .layout import Layout, sanitize
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
            "modules": len(state.modules(course_id)),
            "announcements": count["announcement"],
            "assignments": count["assignment"],
            "pages": count["page"],
            "files": len(files),
            "syllabus": bool(syllabus and (syllabus.get("syllabus_body") or "").strip()),
        },
    }


def modules(state: State, root: Path, layout: Layout, course_id: int, now: datetime | None = None) -> list[dict[str, Any]]:
    """The course's modules, each item saying where it leads in the app: a local file, a
    page / assignment / announcement shown here, a web link, or the item on Canvas."""
    now = now or datetime.now(timezone.utc)
    course = next((c for c in state.courses() if c.id == course_id), None)
    raw_modules = state.modules(course_id)
    if course is None or not raw_modules:
        return []
    docs = {(k, i): raw for k, i, _, raw in _docs(state, course_id)}
    files = {r.id: r for r in state.files_for_course(course_id)}
    created: dict[int, str] = {}
    for row in state.db.execute("SELECT id, raw FROM files WHERE course_id = ?", (course_id,)):
        raw = json.loads(row["raw"] or "{}")
        created[row["id"]] = raw.get("created_at") or raw.get("updated_at") or ""

    def target(item: dict[str, Any]) -> dict[str, Any]:
        kind, cid = item.get("type"), item.get("content_id")
        canvas = relative_url(item.get("html_url"))
        if kind == "File" and cid in files:
            rec = files[cid]
            if rec.ignored:
                return {"deleted": True, "url": canvas}
            if rec.path and (root / rec.path).exists():
                return {"file": rec.path}
            return {"url": canvas or f"/courses/{course_id}/files/{cid}"}
        if kind == "Page" and ("page", item.get("page_url")) in docs:
            return {"doc": {"kind": "page", "id": item["page_url"]}}
        if kind == "Assignment" and ("assignment", str(cid)) in docs:
            return {"doc": {"kind": "assignment", "id": str(cid)},
                    "due_at": docs[("assignment", str(cid))].get("due_at")}
        if kind == "Discussion" and ("announcement", str(cid)) in docs:
            return {"doc": {"kind": "announcement", "id": str(cid)}}
        if kind == "ExternalUrl" and item.get("external_url"):
            return {"external": item["external_url"]}
        return {"url": canvas} if canvas else {}

    # "Current": the module with the newest upload, and the one with the next deadline.
    newest = max(((created.get(i.get("content_id"), ""), m["id"]) for m in raw_modules for i in m.get("items") or []
                  if i.get("type") == "File"), default=("", None))[1]
    soonest: tuple[datetime, Any] | None = None
    out = []
    for m in raw_modules:
        items = []
        for it in m.get("items") or []:
            t = target(it)
            if (due := _when(t.get("due_at"))) and due >= now and (soonest is None or due < soonest[0]):
                soonest = (due, m["id"])
            title = it.get("title")
            if not title and it.get("type") == "File" and it.get("content_id") in files:
                title = files[it["content_id"]].name
            items.append({
                "id": it.get("id"), "type": it.get("type"), "title": title or "", "indent": it.get("indent") or 0,
                "done": bool((it.get("completion_requirement") or {}).get("completed")), **t,
            })
        name = m.get("name") or "Module"
        folder = layout.renamed(
            layout.canonical_course_dir(course) / layout.s.view_dirs.get("modules", "modules")
            / sanitize(f"{m.get('position', 0):02d} {name}")
        )
        out.append({
            "id": m["id"], "name": name, "position": m.get("position") or 0,
            "unlock_at": m.get("unlock_at"), "state": m.get("state"),  # Canvas's: locked / unlocked / started / completed
            "folder": folder.as_posix() if (root / folder).is_dir() else None,
            "items": items,
        })
    current = {newest, soonest[1] if soonest else None} - {None}
    for m in out:
        m["current"] = m["id"] in current
    return out
