"""Find every file a course exposes, wherever the instructor happened to put it.

Instructors hide the Files tab, attach files only through modules, or just link
them from a page. So we crawl all of those and merge by file id; each file ends up
with the list of places (`Source`s) it appears in, and the layout decides from there.
"""

from __future__ import annotations

import asyncio
import re
from collections import defaultdict
from collections.abc import Awaitable, Sequence
from dataclasses import dataclass, field
from typing import Any, TypeVar

import httpx

from .api import CanvasClient, CanvasError
from .models import Course, Document, RemoteFile, Source

T = TypeVar("T")

# Matches /courses/1/files/2, /api/v1/courses/1/files/2, /files/2, and (to reject) /users/1/files/2.
FILE_REF = re.compile(r"(?:/(courses|users|groups)/(\d+))?/files/(\d+)")

ATTACHMENT_DIRS = {
    "page": "Pages",
    "assignment": "Assignments",
    "announcement": "Announcements",
    "syllabus": "Syllabus",
}


@dataclass
class CourseSnapshot:
    course: Course
    files: dict[int, RemoteFile] = field(default_factory=dict)
    documents: list[Document] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    unavailable: list[str] = field(default_factory=list)  # features the course has turned off
    # The course's modules as Canvas lists them (with items), for the app's 模块 tab.
    # None if they couldn't be fetched this time: keep what was stored before.
    modules: list[dict[str, Any]] | None = None
    # Your grade in the course as Canvas computes it; None if it couldn't be fetched.
    grades: dict[str, Any] | None = None
    # False if some listing failed for a transient reason, so a file missing from
    # this snapshot does not mean it was deleted from Canvas.
    complete: bool = True


def file_refs(html: str | None, course_id: int) -> list[int]:
    ids: list[int] = []
    for scope, owner, file_id in FILE_REF.findall(html or ""):
        if not scope or (scope == "courses" and int(owner) == course_id):
            ids.append(int(file_id))
    return list(dict.fromkeys(ids))


def _folder_parts(full_name: str) -> tuple[str, ...]:
    # "course files/Lectures/Week 1" -> ("Lectures", "Week 1")
    return tuple(p for p in full_name.split("/")[1:] if p)


async def discover_course(client: CanvasClient, course: Course) -> CourseSnapshot:
    cid = course.id
    snap = CourseSnapshot(course)

    async def fetch(what: str, call: Awaitable[T], default: T) -> T:
        try:
            return await call
        except CanvasError as e:
            if e.status in (401, 403, 404):
                snap.unavailable.append(what)
            else:
                snap.warnings.append(f"{what}: {e}")
                snap.complete = False
        except httpx.HTTPError as e:
            snap.warnings.append(f"{what}: {e!r}")
            snap.complete = False
        return default

    empty: list[dict[str, Any]] = []
    folders, files, modules, pages, assignments, announcements, syllabus = await asyncio.gather(
        fetch("folders", client.folders(cid), empty),
        fetch("files", client.files(cid), empty),
        fetch("modules", client.modules(cid), None),
        fetch("pages", client.pages(cid), empty),
        fetch("assignments", client.assignments(cid), empty),
        fetch("announcements", client.announcements(cid), empty),
        fetch("syllabus", client.course(cid, ["syllabus_body", "total_scores"]), None),
    )

    snap.modules = modules if modules is not None else ([] if "modules" in snap.unavailable else None)
    if syllabus is not None:
        snap.grades = _grades(syllabus)
    modules = modules or []

    # 1. The Files tree.
    folder_paths = {f["id"]: _folder_parts(f.get("full_name", "")) for f in folders}
    for d in files:
        rf = RemoteFile.from_api(d, cid)
        rf.add_source(Source("files", folder_paths.get(d.get("folder_id"), ())))
        snap.files[rf.id] = rf

    # 2. Modules. Pages/assignments inside a module also lend that module to the
    #    files they link, so "Week 3 > Reading page > paper.pdf" lands in Week 3.
    refs: dict[int, list[Source]] = defaultdict(list)
    page_modules: dict[str, list[Source]] = defaultdict(list)
    assignment_modules: dict[int, list[Source]] = defaultdict(list)
    for m in modules:
        src = Source("modules", (f"{m.get('position', 0):02d} {m.get('name') or 'Module'}",))
        for item in m.get("items") or []:
            kind = item.get("type")
            if kind == "File" and item.get("content_id"):
                refs[item["content_id"]].append(src)
            elif kind == "Page" and item.get("page_url"):
                page_modules[item["page_url"]].append(src)
            elif kind == "Assignment" and item.get("content_id"):
                assignment_modules[item["content_id"]].append(src)

    # 3. HTML bodies. The pages list may be disabled while module pages still load.
    page_urls = list(dict.fromkeys([p["url"] for p in pages if p.get("url")] + list(page_modules)))
    bodies = await asyncio.gather(
        *(fetch(f"page {u}", client.page(cid, u), None) for u in page_urls)
    )

    def collect(kind: str, doc_id: Any, title: str, updated: str | None, html: str | None,
                raw: dict[str, Any], also: Sequence[Source] = ()) -> None:
        snap.documents.append(Document(cid, kind, str(doc_id), title, updated or "", raw))
        folder = (ATTACHMENT_DIRS[kind],) if kind == "syllabus" else (ATTACHMENT_DIRS[kind], title)
        for fid in file_refs(html, cid):
            refs[fid].append(Source("attachments", folder))
            refs[fid].extend(also)

    for p in bodies:
        if p:
            collect("page", p["url"], p.get("title") or p["url"], p.get("updated_at"),
                    p.get("body"), p, page_modules.get(p["url"], []))
    for a in assignments:
        collect("assignment", a["id"], a.get("name") or str(a["id"]), a.get("updated_at"),
                a.get("description"), a, assignment_modules.get(a["id"], []))
    for a in announcements:
        title = a.get("title") or str(a["id"])
        collect("announcement", a["id"], title, a.get("posted_at"), a.get("message"), a)
        # Files attached to an announcement are often not in the course Files at all.
        for att in a.get("attachments") or []:
            rf = snap.files.setdefault(att["id"], RemoteFile.from_api(att, cid))
            rf.add_source(Source("attachments", (ATTACHMENT_DIRS["announcement"], title)))
    if syllabus and syllabus.get("syllabus_body"):
        collect("syllabus", cid, "Syllabus", None, syllabus["syllabus_body"],
                {"syllabus_body": syllabus["syllabus_body"]})

    # 4. Files we only know by id (Files tab hidden, or linked from HTML).
    missing = [fid for fid in refs if fid not in snap.files]
    if missing:
        found = await asyncio.gather(*(_try_file(client, cid, fid) for fid in missing))
        for d in found:
            if d is not None:
                snap.files[d["id"]] = RemoteFile.from_api(d, cid)
        gone = sum(d is None for d in found)
        if gone:
            snap.warnings.append(f"{gone} linked file(s) are not accessible")

    for fid, sources in refs.items():
        if fid in snap.files:
            for s in sources:
                snap.files[fid].add_source(s)
    return snap


def _grades(course: dict[str, Any]) -> dict[str, Any]:
    """Your total from your student enrollment ({} if you aren't a student, or the course
    hides totals: Canvas leaves the scores out then)."""
    for e in course.get("enrollments") or []:
        if e.get("type") in ("student", "StudentEnrollment") and "computed_current_score" in e:
            return {
                "current_score": e.get("computed_current_score"), "current_grade": e.get("computed_current_grade"),
                "final_score": e.get("computed_final_score"), "final_grade": e.get("computed_final_grade"),
            }
    return {}


async def _try_file(client: CanvasClient, course_id: int, file_id: int) -> dict[str, Any] | None:
    try:
        return await client.file(course_id, file_id)
    except (CanvasError, httpx.HTTPError):
        return None
