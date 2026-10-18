"""Everything search can go to by name: the courses, the views they have something in, their
announcements, assignments, pages, posts on Ed (what's pinned and staff's), modules and tools, the files and folders synced for them, and
what you put in places (web links, notes, smart folders). Each is a thing (see things.py), with
what it's called and when it's from; the text inside is the index's (search.py). Courses you hid
aren't in it, nor anything of theirs.

Names are what Canvas or the sync folder calls things (`name`), or None for what the app names
(a view, a link, a note); `title` is a name you gave it in a place (置顶, a course's page), and
`aliases` are the other names it answers to. `canvas_url`: where it is on Canvas (relative).
A course's `keys` are what it is as one word of a query ("cs70", "53", a name you gave it: what
the app's query.ts reads as narrowing search to it).
"""

from __future__ import annotations

import json
import re
from pathlib import Path, PurePosixPath
from typing import TYPE_CHECKING, Any

from . import content
from .search import DEFAULT_ABBREVIATIONS, code_keys, course_label, doc_url, normalized, relative_url
from .state import META_DIR
from .things import Entry, Thing, course_thing, view

if TYPE_CHECKING:
    from .engine import Engine

DOC_KINDS = ("announcement", "assignment", "page", "post")


def catalog(e: Engine) -> list[dict[str, Any]]:
    courses = [c for c in e.state.courses() if c.id not in e.settings.hidden]
    shown = {c.id for c in courses}
    out: dict[Thing, dict[str, Any]] = {}

    def add(thing: Thing, *, course: int | None = None, **fields: Any) -> dict[str, Any]:
        d = out.get(thing)
        if d is None:
            d = out[thing] = {**thing.to_dict(), "name": None, "title": "", "aliases": [],
                              "in_course": course if course is not None else thing.course}
        for k, v in fields.items():
            if v is not None:
                d[k] = v
        return d

    # Courses, and the views each has something in.
    has: dict[int, set[str]] = {c.id: {"overview", "files", "tools", "canvas"} for c in courses}
    for cid, kind, n in e.state.db.execute("SELECT course_id, kind, count(*) FROM documents GROUP BY course_id, kind"):
        if cid in has and n:
            has[cid].add({"announcement": "announcements", "assignment": "assignments", "page": "pages",
                          "post": "discussion"}.get(kind, ""))
    for (cid,) in e.state.db.execute("SELECT DISTINCT course_id FROM modules"):
        if cid in has:
            has[cid].add("modules")
    for c in courses:
        canonical = e.layout.canonical_course_dir(c).as_posix()
        names = [c.code, c.name, e.settings.course_names.get(c.id), e.settings.folder_names.get(canonical),
                 *e.settings.course_aliases.get(c.id, []), *sorted(code_keys(c.code))]
        label = course_label(c, e.settings)
        yours = [label, c.code, e.settings.course_names.get(c.id), e.settings.folder_names.get(canonical),
                 *e.settings.course_aliases.get(c.id, [])]
        keys = {normalized(n) for n in yours if n} | {k for k in code_keys(c.code) if re.search(r"\d", k)}
        add(course_thing(c.id), name=label, term=c.term, canvas_url=f"/courses/{c.id}",
            aliases=list(dict.fromkeys(n for n in names if n and n != label)), keys=sorted(keys - {""}))
        if (g := e.state.grades(c.id)) and g.get("current_score") is not None:
            has[c.id].add("grades")

    # Announcements, assignments, pages (the syllabus is a view).
    for row in e.state.db.execute("SELECT course_id, kind, id, title, updated_at, raw FROM documents"):
        cid, kind = row["course_id"], row["kind"]
        if cid not in shown:
            continue
        raw = json.loads(row["raw"] or "{}")
        if kind == "syllabus":
            if (raw.get("syllabus_body") or "").strip():
                has[cid].add("syllabus")
            continue
        if kind not in DOC_KINDS:
            continue
        ed = raw.get("ed") or {}
        if kind == "post" and not (ed.get("pinned") or ed.get("staff")):
            continue  # (by name: what's pinned on Ed, and staff's posts; the questions are the index's)
        fields: dict[str, Any] = {"name": row["title"], "canvas_url": doc_url(raw), "source": raw.get("source")}
        if kind in ("announcement", "post"):
            fields["date"] = raw.get("posted_at")
        elif kind == "assignment":
            status = content.submission(raw)["status"]
            if status == "graded":
                has[cid].add("grades")
            fields |= {"date": raw.get("due_at"), "due": raw.get("due_at"), "status": status}
        else:
            fields |= {"date": raw.get("updated_at") or row["updated_at"],
                       "canvas_url": fields["canvas_url"] or f"/courses/{cid}/pages/{row['id']}"}
        add(Thing("doc", course=cid, kind=kind, id=row["id"]), **fields)
    for c in courses:
        for v in ("overview", "modules", "announcements", "discussion", "assignments", "grades", "files", "syllabus", "pages",
                  "tools", "canvas"):
            if v in has[c.id]:
                add(view(c.id, v))

    # Modules, and the external tools in each course's menu.
    for row in e.state.db.execute("SELECT course_id, id, name FROM modules ORDER BY course_id, position, id"):
        if row["course_id"] in shown:
            add(Thing("module", course=row["course_id"], module=row["id"]), name=row["name"] or None,
                canvas_url=f"/courses/{row['course_id']}/modules#module_{row['id']}")
    for c in courses:
        for t in content.tools(e.state, c.id):
            add(Thing("tool", course=c.id, tool=t["id"]), name=t["label"], canvas_url=t["url"])

    # Files synced for the courses (where they are, not their links in other folders), and the
    # folders they're in (a course's own folder is the course).
    dirs = {e.layout.course_dir(c).as_posix(): c.id for c in courses}
    links: dict[int, list[str]] = {}
    for path, fid in e.state.db.execute("SELECT path, file_id FROM links"):
        links.setdefault(fid, []).append(path)
    folders: dict[str, int] = {}
    for row in e.state.db.execute(
        "SELECT id, course_id, path, raw FROM files WHERE path IS NOT NULL AND ignored = 0 ORDER BY path"
    ):
        cid, path = row["course_id"], row["path"]
        if cid not in shown or not (e.root / path).is_file():
            continue
        raw = json.loads(row["raw"] or "{}")
        add(Thing("file", path=path), course=cid, name=PurePosixPath(path).name,
            date=raw.get("created_at") or raw.get("updated_at"), canvas_url=f"/courses/{cid}/files/{row['id']}")
        for p in [path, *links.get(row["id"], [])]:
            for parent in PurePosixPath(p).parents:
                folder = parent.as_posix()
                if folder in dirs or folder == "." or not any(folder.startswith(d + "/") for d in dirs):
                    break
                folders.setdefault(folder, cid)
    for folder, cid in folders.items():
        if (e.root / folder).is_dir():
            add(Thing("folder", path=folder), course=cid, name=PurePosixPath(folder).name)

    # What you put in places: 置顶, and each course's tabs, overview and 工具与链接. What's there
    # answers to the names you gave it; links, notes and smart folders are only there.
    placed: list[tuple[Entry, int | None]] = [(x, None) for x in e.settings.pinned]
    for cid, layout in e.settings.course_layouts.items():
        if cid in shown:
            placed += [(x, cid) for place in (layout.tabs, layout.overview, layout.links) for x in place]
    for entry, home in placed:
        t = entry.thing
        if t.type == "course" or (t.type in ("folder", "file") and t not in out):
            continue  # (a course is there already; a folder or file that isn't synced or isn't there)
        if (t.course is not None and t.course not in shown) or (t.type == "search" and t.courses and not set(t.courses) & shown):
            continue
        if t.type in ("doc", "module", "tool", "view") and t not in out:
            continue  # (gone from Canvas, or a view with nothing in it)
        course = t.course if t.course is not None else home if t.type in ("link", "note") else (
            t.courses[0] if t.type == "search" and len(t.courses) == 1 else None)
        d = add(t, course=course)
        if entry.title:
            d["title"] = d["title"] or entry.title
            if entry.title not in d["aliases"]:
                d["aliases"].append(entry.title)
        if t.type == "note" and t.course is not None and "text" not in d:
            d["text"] = _note_start(e.root / META_DIR / "notes" / str(t.course) / f"{t.id}.md")
    return list(out.values())


def abbreviations(e: Engine) -> dict[str, list[str]]:
    """What words stand for in search: the built-in abbreviations, and yours (config.toml)."""
    return {**DEFAULT_ABBREVIATIONS, **e.settings.abbreviations}


def _note_start(path: Path) -> str:
    """A note's first line (what it's about), for finding it by."""
    try:
        text = path.read_text()
    except OSError:
        return ""
    return next((line.strip() for line in text.splitlines() if line.strip()), "")[:120]
