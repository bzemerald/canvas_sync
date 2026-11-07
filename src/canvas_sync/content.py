"""A course as the app's course page shows it: an overview of what needs attention, and
its announcements, assignments, pages, syllabus and grades, from what the last pull stored.

HTML is returned as Canvas wrote it; the app sanitizes it. With it comes a map from the
Canvas files it links to their local copies, so links and images can open those.

What's "new" is what arrived since you last opened it (see `State.record_arrivals`), less
what you've already read or handed in on Canvas.
"""

from __future__ import annotations

import json
import re
from datetime import datetime, timedelta, timezone
from pathlib import Path
from dataclasses import asdict
from collections.abc import Callable, Iterable
from typing import TYPE_CHECKING, Any
from urllib.parse import urlsplit

from .discover import file_refs
from .layout import Layout, sanitize
from .search import DOC_BODY, canvas_copy, course_label, doc_url, relative_url
from .state import NEWS_KINDS, FileRecord, State
from .text import html_to_text

if TYPE_CHECKING:
    from .engine import Engine

KINDS = ("announcement", "assignment", "page", "syllabus", "post")

# Ways of handing in that Canvas itself sees. Elsewhere (Gradescope, on paper) it can't
# tell whether you did, so it isn't "not submitted".
NATIVE_SUBMISSIONS = {
    "online_upload", "online_text_entry", "online_url", "media_recording", "online_quiz", "discussion_topic",
    "student_annotation",
}
HANDED_IN = {"submitted", "graded", "excused"}

# What to call a tool, by its site, where the domain alone says it badly.
TOOL_NAMES = {"gradescope": "Gradescope", "edstem": "Ed", "quiz-lti": "New Quizzes", "piazza": "Piazza", "zoom": "Zoom",
              "panopto": "Panopto", "kaltura": "Kaltura", "turnitin": "Turnitin", "perusall": "Perusall",
              "theexpertta": "Expert TA", "rollcall": "Roll Call", "iclicker": "iClicker", "mcgraw": "McGraw Hill",
              "pearson": "Pearson", "macmillan": "Macmillan", "wiley": "Wiley", "hypothes": "Hypothesis"}
HOSTING = {"instructure", "amazonaws", "herokuapp", "azurewebsites", "cloudfront", "edu"}


def courses(e: Engine) -> list[dict[str, Any]]:
    """Your courses, as the app lists them: each with what you call it, where its folder is,
    and how much is new in it."""
    out = []
    for c in e.state.courses():
        d, canonical = e.layout.course_dir(c), e.layout.canonical_course_dir(c)
        new = news_counts(news(e.state, e.root, c.id))
        term_renamed = len(d.parts) > 1 and d.parent.name != canonical.parent.name
        out.append({
            **asdict(c), "dir": d.as_posix(),
            "display_code": e.settings.course_names.get(c.id) or c.code,
            "label": course_label(c, e.settings),       # what the app calls it
            "renamed": d.name != canonical.name,         # you gave it a name
            "default_name": canonical.name,              # renaming to this undoes that
            "term_label": d.parent.name if term_renamed else c.term,
            # Where what's from each part of Canvas goes (files, modules, attachments).
            "source_dirs": {k: e.layout.renamed(canonical / v).as_posix() for k, v in e.settings.view_dirs.items()},
            "new": new["total"],                         # things you haven't opened
            "new_in": new,                               # and in each view
            "icon": e.settings.course_icons.get(c.id),  # chosen; None: the app picks one
            "hidden": c.id in e.settings.hidden,      # not shown in the sidebar or search
            "excluded": c.id in e.settings.exclude,   # not synced
        })
    return out


def tool_name(url: str | None) -> str | None:
    """"Gradescope" for https://www.gradescope.com/auth/lti/callback; None if unclear."""
    host = urlsplit(url or "").hostname or ""
    for key, name in TOOL_NAMES.items():
        if key in host:
            return name
    labels = host.split(".")
    label = labels[-2] if len(labels) >= 2 else ""
    return label.capitalize() if label and label not in HOSTING else None


def tools(state: State, course_id: int) -> list[dict[str, Any]]:
    """The external tools in the course's menu (Gradescope, Ed, Zoom...), in its order."""
    out = []
    for t in sorted(state.tabs(course_id), key=lambda t: t.get("position") or 0):
        m = re.fullmatch(r"context_external_tool_(\d+)", str(t.get("id") or ""))
        if t.get("type") == "external" and m and not t.get("hidden"):
            out.append({"id": int(m[1]), "label": t.get("label") or None, "url": relative_url(t.get("html_url"))})
    return out


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


def on_ed(kind: str, doc_id: str) -> bool:
    """Whether a document is from Ed (see ed.document), whatever its kind: what the `ed` view has.
    (Not a page: its id comes from its title, and "Ed Discussion" is ed-discussion.)"""
    return kind in ("announcement", "post") and doc_id.startswith("ed-")


# The views that count what's new in them: whether (kind, id) is in each.
NEWS_VIEWS: dict[str, Callable[[str, str], bool]] = {
    "announcements": lambda kind, _: kind == "announcement",
    "assignments": lambda kind, _: kind == "assignment",
    "pages": lambda kind, _: kind == "page",
    "files": lambda kind, _: kind == "file",
    "ed": on_ed,
}


def submission(assignment: dict[str, Any]) -> dict[str, Any]:
    """Where you are with an assignment. status: graded / submitted / missing / excused /
    unsubmitted, or None when Canvas can't know (handed in elsewhere, or nothing to hand in).
    A grade not posted yet doesn't show: Canvas leaves it out."""
    s = assignment.get("submission")
    if not isinstance(s, dict):
        return {"status": None}
    graded = s.get("workflow_state") == "graded" and (s.get("score") is not None or s.get("grade") is not None)
    if s.get("excused"):
        status = "excused"
    elif graded:
        status = "graded"
    elif s.get("submitted_at") or s.get("workflow_state") in ("submitted", "pending_review"):
        status = "submitted"
    elif s.get("missing"):
        status = "missing"
    elif set(assignment.get("submission_types") or []) & NATIVE_SUBMISSIONS:
        status = "unsubmitted"
    else:
        status = None
    return {
        "status": status,
        "late": bool(s.get("late")) and status in ("submitted", "graded"),
        "submitted_at": s.get("submitted_at"),
        "graded_at": s.get("graded_at") if graded else None,
        "score": s.get("score") if graded else None,
        "grade": s.get("grade") if graded else None,
    }


def _summary(course_id: int, kind: str, doc_id: str, title: str, raw: dict[str, Any], new: bool = False) -> dict[str, Any]:
    out: dict[str, Any] = {"kind": kind, "id": doc_id, "title": title, "url": doc_url(raw), "new": new}
    if raw.get("source"):
        out["source"] = raw["source"]  # (from elsewhere: Ed)
    if "ed" in raw:  # where it is on Ed, who wrote it, how it's going (see ed.document)
        out["ed"] = {k: v for k, v in raw["ed"].items() if k != "thread"}
    if kind in ("announcement", "post"):
        text = html_to_text(raw.get("message"))
        out |= {
            "date": raw.get("posted_at"),
            "author": (raw.get("author") or {}).get("display_name") or raw.get("user_name"),
            "preview": text[:160],
        }
    elif kind == "assignment":
        out |= {
            "date": raw.get("due_at"),
            "due_at": raw.get("due_at"),
            "unlock_at": raw.get("unlock_at"),
            "lock_at": raw.get("lock_at"),
            "points": raw.get("points_possible"),
            "grading_type": raw.get("grading_type"),
            "submission_types": raw.get("submission_types") or [],
            **submission(raw),
        }
        if "external_tool" in out["submission_types"]:  # handed in on Gradescope etc.: open it there
            tag = raw.get("external_tool_tag_attributes") or {}
            out["tool"] = {"assignment_id": int(doc_id), "name": tool_name(tag.get("url"))}
    elif kind == "page":
        out |= {"date": raw.get("updated_at"), "front_page": bool(raw.get("front_page"))}
        out["url"] = out["url"] or f"/courses/{course_id}/pages/{doc_id}"
    elif kind == "syllabus":
        out["url"] = f"/courses/{course_id}/assignments/syllabus"
    return out


def _still_new(kind: str, raw: dict[str, Any]) -> bool:
    if kind in ("announcement", "post"):  # read on Canvas (or Ed); or a copy of a Canvas announcement
        return raw.get("read_state") != "read" and not (raw.get("ed") or {}).get("on_canvas")
    if kind == "assignment":
        return submission(raw)["status"] not in HANDED_IN
    return True


def _file_there(rec: FileRecord | None, root: Path) -> bool:
    """Whether a new file counts: it's still on Canvas and in the sync folder, and being synced."""
    return bool(rec and rec.path and not rec.ignored and not rec.remote_deleted and (root / rec.path).exists())


def news(state: State, root: Path, course_id: int) -> dict[str, dict[str, bool]]:
    """What's new to you in a course: kind -> {id: whether it's a new version (files)}."""
    out: dict[str, dict[str, bool]] = {k: {} for k in NEWS_KINDS}
    unseen = state.unseen(course_id)
    if not unseen:
        return out
    docs = {(k, i): raw for k, i, _, raw in _docs(state, course_id)}
    for (_, kind, i), updated in unseen.items():
        if kind == "file":
            if _file_there(state.get(int(i)), root):
                out["file"][i] = updated  # (not one taken off Canvas since)
        elif (kind, i) in docs and _still_new(kind, docs[(kind, i)]):
            out[kind][i] = False
    return out


def new_files(state: State, root: Path) -> list[str]:
    """Where the new files are, links too: what can be marked read (what `news` counts)."""
    paths = state.unseen_files()
    there = {fid for _, fid in paths.values() if _file_there(state.get(fid), root)}
    return sorted(p for p, (_, fid) in paths.items() if fid in there)


def news_counts(n: dict[str, dict[str, bool]]) -> dict[str, int]:
    """How many new things each view has, and `total` (an announcement on Ed is in two views: once)."""
    new = [(kind, i) for kind, ids in n.items() for i in ids]
    return {view: sum(has(k, i) for k, i in new) for view, has in NEWS_VIEWS.items()} | {"total": len(new)}


def mark_seen(state: State, course_id: int, views: Iterable[str] | None = None) -> None:
    """Mark everything new in a course opened, or everything new in some of its views."""
    if views is None:
        return state.mark_seen(course_id)
    has = [NEWS_VIEWS[v] for v in views]
    state.mark_seen(course_id, [(k, i) for _, k, i in state.unseen(course_id) if any(h(k, i) for h in has)])


def items(state: State, root: Path, course_id: int, kind: str, now: datetime | None = None) -> list[dict[str, Any]]:
    """Summaries of one kind of item, in the order the app lists them (`now`: for what's upcoming)."""
    new = news(state, root, course_id).get(kind, {})
    out = [_summary(course_id, k, i, t, raw, i in new) for k, i, t, raw in _docs(state, course_id, kind) if not canvas_copy(k, raw)]
    if kind == "assignment":
        # Upcoming soonest first, then past ones most recent first, then undated.
        now = now or datetime.now(timezone.utc)
        def order(a: dict[str, Any]) -> tuple[int, float]:
            due = _when(a["due_at"])
            if due is None:
                return (2, 0)
            return (0, due.timestamp()) if due >= now else (1, -due.timestamp())
        out.sort(key=order)
    elif kind == "page":
        out.sort(key=lambda p: (not p["front_page"], p["title"].casefold()))
    elif kind == "post":
        out.sort(key=_ed_order)
    else:
        out.sort(key=lambda a: a.get("date") or "", reverse=True)
    return out


def _ed_order(p: dict[str, Any]) -> tuple[bool, float]:
    """As Ed lists things: pinned first, then newest."""
    return (not p["ed"]["pinned"], _desc(p.get("date")))


def _on_ed(course_id: int, docs: list[tuple[str, str, str, dict[str, Any]]], new: dict[str, dict[str, bool]]) -> list[dict[str, Any]]:
    return sorted((_summary(course_id, k, i, t, raw, i in new[k]) for k, i, t, raw in docs if on_ed(k, i)), key=_ed_order)


def ed_items(state: State, root: Path, course_id: int) -> list[dict[str, Any]]:
    """Everything a course has on Ed, as Ed lists it, each the kind it is."""
    return _on_ed(course_id, _docs(state, course_id), news(state, root, course_id))


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
        thread = (raw.get("ed") or {}).get("thread")
        return _summary(course_id, k, i, title, raw, i in news(state, root, course_id).get(kind, {})) | {
            "replies": thread["replies"] if thread else None,  # (on Ed: its answers and comments, once fetched)
            "html": html,
            "files": local,  # Canvas file id -> local copy
            "attachments": [
                {"id": a["id"], "name": a.get("display_name") or a.get("filename") or str(a["id"]),
                 "path": local.get(str(a["id"]), {}).get("path")}
                for a in attached
            ],
        }
    return None


def overview(state: State, root: Path, course_id: int, now: datetime | None = None,
             layout: Layout | None = None) -> dict[str, Any]:
    """What a course page opens with: what's due, what was said, what's new, how you're doing;
    with `layout`, this week's modules too (the 当前模块 card)."""
    now = now or datetime.now(timezone.utc)
    docs = _docs(state, course_id)
    count = {k: sum(d[0] == k and not canvas_copy(k, d[3]) for d in docs) for k in KINDS}
    syllabus = next((raw for k, _, _, raw in docs if k == "syllabus"), None)
    new = news(state, root, course_id)

    assignments = [_summary(course_id, k, i, t, raw, i in new["assignment"]) for k, i, t, raw in docs if k == "assignment"]
    upcoming = sorted(
        (a for a in assignments if (due := _when(a["due_at"])) and now - timedelta(hours=12) <= due <= now + timedelta(days=21)),
        key=lambda a: a["due_at"],
    )
    announcements = sorted(
        (_summary(course_id, k, i, t, raw, i in new["announcement"]) for k, i, t, raw in docs if k == "announcement" and not canvas_copy(k, raw)),
        key=lambda a: a.get("date") or "", reverse=True,
    )
    on_ed_now = _on_ed(course_id, docs, new)
    total = _total(state, course_id)
    graded = sorted((a for a in assignments if a["status"] == "graded"), key=lambda a: a["graded_at"] or "", reverse=True)

    files = []
    for r in state.db.execute(
        "SELECT id, path, raw FROM files WHERE course_id = ? AND path IS NOT NULL AND ignored = 0", (course_id,)
    ):
        if (root / r["path"]).exists():
            raw = json.loads(r["raw"] or "{}")
            files.append({"file_id": r["id"], "path": r["path"], "name": Path(r["path"]).name,
                          "date": raw.get("created_at") or raw.get("updated_at"),
                          "new": str(r["id"]) in new["file"], "updated": new["file"].get(str(r["id"]), False)})
    # Newest uploads, and anything else new to you (a new version of an old file).
    files.sort(key=lambda f: f["date"] or "", reverse=True)
    shown = files[:8]
    shown += [f for f in files[8:] if f["new"]][:8]

    out = {
        "upcoming": upcoming[:8],
        "announcements": announcements[:5],
        # Of what's on Ed: what's pinned, announcements and what staff posted, not every question.
        "ed": [p for p in on_ed_now if p["ed"]["pinned"] or p["ed"]["staff"] or p["kind"] == "announcement"][:5],
        "new_files": shown,
        "grades": {"total": total, "recent": graded[:3]},
        "tools": tools(state, course_id),
        "new": news_counts(new),
        "counts": {
            "modules": len(state.modules(course_id)),
            "announcements": count["announcement"],
            "assignments": count["assignment"],
            "pages": count["page"],
            "ed": len(on_ed_now),
            "files": len(files),
            "syllabus": bool(syllabus and (syllabus.get("syllabus_body") or "").strip()),
            "grades": total is not None or bool(graded),
        },
    }
    if layout is not None:
        out["current_modules"] = [m for m in modules(state, root, layout, course_id, now) if m["current"]][:2]
    return out


def _desc(iso: str | None) -> float:
    """Newest first, as a sort key."""
    t = _when(iso)
    return -t.timestamp() if t else 0.0


def _total(state: State, course_id: int) -> dict[str, Any] | None:
    g = state.grades(course_id)
    return g if g and g.get("current_score") is not None else None


def grades(state: State, root: Path, course_id: int) -> dict[str, Any]:
    """Your total as Canvas computes it, and each assignment's grade, latest due first."""
    new = news(state, root, course_id)["assignment"]
    out = [_summary(course_id, k, i, t, raw, i in new) for k, i, t, raw in _docs(state, course_id, "assignment")
           if raw.get("grading_type") != "not_graded"]
    dated = sorted((a for a in out if a["due_at"]), key=lambda a: a["due_at"], reverse=True)
    return {"total": _total(state, course_id), "assignments": dated + [a for a in out if not a["due_at"]]}


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
    new = news(state, root, course_id)
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
        if kind == "ExternalTool" and item.get("id"):
            return {"tool": {"module_item_id": item["id"], "name": tool_name(item.get("external_url"))},
                    **({"url": canvas} if canvas else {})}
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
            fresh = False
            if "file" in t:
                fresh = str(it.get("content_id")) in new["file"]
            elif "doc" in t:
                fresh = t["doc"]["id"] in new.get(t["doc"]["kind"], {})
            items.append({
                "id": it.get("id"), "type": it.get("type"), "title": title or "", "indent": it.get("indent") or 0,
                "done": bool((it.get("completion_requirement") or {}).get("completed")), "new": fresh, **t,
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
