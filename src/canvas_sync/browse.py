"""What the app shows for a folder: what's on disk, plus what canvas-sync knows about it.

Finder shows files; this also says which ones came from Canvas, which you changed,
which are view links to a file stored elsewhere, and which you deleted (they're still
listed, so they can be brought back).
"""

from __future__ import annotations

import os
import posixpath
import re
from collections.abc import Iterable
from dataclasses import dataclass, field
from pathlib import Path, PurePosixPath
from typing import Protocol

from .layout import Layout
from .state import META_DIR, State

# Local changes `restore` undoes. ("moved" alone isn't one: your folders are yours to arrange.)
RESTORABLE = {"modified", "missing", "ignored"}
GONE = {"missing", "ignored"}


class Status(Protocol):
    path: str | None
    file_id: int
    course_id: int
    states: list[str]


@dataclass
class Entry:
    name: str
    path: str                     # relative to root
    type: str                     # dir | file
    size: int | None = None
    mtime: float | None = None
    file_id: int | None = None    # set if the file came from Canvas
    course_id: int | None = None  # files: their course; dirs: set if this is a course's folder
    url: str | None = None        # the file on Canvas, relative to the Canvas site
    link: str | None = None       # a view link: path of the real file it points at
    states: list[str] = field(default_factory=list)  # modified moved missing ignored untracked remote_deleted
    deleted: bool = False         # not on disk any more because you deleted it
    changes: int = 0              # dirs: files below with changes `restore` can undo
    modified_inside: int = 0      # dirs: files below you changed
    deleted_inside: int = 0       # dirs: files below you deleted
    skipped: bool = False         # in (or, dirs: is) a folder you deleted or stopped syncing; Canvas's new files don't come here
    new: str | None = None        # files: "new" (arrived since you last opened it) or "updated" (a new version)
    new_inside: int = 0           # dirs: files below that are new to you
    renamed_from: str | None = None  # dirs: what Canvas calls it, if you renamed it


def _natural(name: str) -> list[object]:
    """"Week 2" before "Week 10"."""
    return [int(t) if t.isdigit() else t for t in re.split(r"(\d+)", name.casefold())]


def list_dir(root: Path, state: State, layout: Layout, statuses: Iterable[Status], rel: str) -> list[Entry]:
    base = (root / rel) if rel else root
    if not base.resolve().is_relative_to(root.resolve()) or not base.is_dir():
        raise LookupError(f"{rel or '.'} is not a folder in {root}")
    statuses = list(statuses)
    by_id = {s.file_id: s for s in statuses}
    at = {s.path: s for s in statuses if s.path and not GONE & set(s.states)}  # where files are now
    moved = {s.file_id for s in statuses if "moved" in s.states}  # their old path may hold something else now
    tracked = {r.path: r for r in state.all_files() if r.path and not r.ignored and r.id not in moved}
    links = {row[0]: row[1] for row in state.db.execute("SELECT path, file_id FROM links")}
    course_dirs = {layout.course_dir(c).as_posix(): c.id for c in state.courses()}
    changed = [s.path for s in statuses if s.path and RESTORABLE & set(s.states)]
    modified = [s.path for s in statuses if s.path and "modified" in s.states]
    gone = [s.path for s in statuses if s.path and GONE & set(s.states)]
    unseen = {int(i): updated for (_, _, i), updated in state.unseen(kind="file").items()}
    new_at = {r.path: r.id for r in tracked.values() if r.id in unseen}  # each new file, and its view links
    new_at |= {p: fid for p, fid in links.items() if fid in unseen}

    def skipped(path: str) -> bool:
        return layout.skipped(PurePosixPath(layout.canonical(path)))

    # Folders you renamed, where they are now -> what Canvas calls them. (Worked out forwards, from
    # the renames of a course's folders, its term's or what's in it: an old rename that no course's
    # folder goes through renames nothing.)
    canon_dirs = [layout.canonical_course_dir(c).as_posix() for c in state.courses()]
    was_named = {
        layout.renamed(PurePosixPath(k)).as_posix(): posixpath.basename(k) for k in layout.s.folder_names
        if any(d == k or d.startswith(k + "/") or k.startswith(d + "/") for d in canon_dirs)
    }

    def renamed_from(path: str) -> str | None:
        was = was_named.get(path)
        return was if was != posixpath.basename(path) else None

    def canvas(fid: int, cid: int, path: str) -> dict[str, object]:
        s = by_id.get(fid)
        return {"file_id": fid, "course_id": cid, "url": f"/courses/{cid}/files/{fid}",
                "states": list(s.states) if s else [], "skipped": skipped(path),
                "new": ("updated" if unseen[fid] else "new") if fid in unseen else None}

    out: list[Entry] = []
    with os.scandir(base) as it:
        for d in it:
            if d.name.startswith(".") or (not rel and d.name == META_DIR):
                continue
            path = f"{rel}/{d.name}" if rel else d.name
            try:
                st = d.stat()  # follows links
            except OSError:
                st = None  # a dangling link
            if d.is_symlink() and path in links and (rec := state.get(links[path])):
                real = by_id[rec.id].path if rec.id in by_id and by_id[rec.id].path else rec.path
                out.append(Entry(d.name, path, "file", st and st.st_size, st and st.st_mtime,
                                 link=real, **canvas(rec.id, rec.course_id, path)))  # type: ignore[arg-type]
            elif st is not None and d.is_dir():
                prefix = path + "/"
                out.append(Entry(d.name, path, "dir", mtime=st.st_mtime, course_id=course_dirs.get(path),
                                 changes=sum(p.startswith(prefix) for p in changed),
                                 modified_inside=sum(p.startswith(prefix) for p in modified),
                                 deleted_inside=sum(p.startswith(prefix) for p in gone),
                                 skipped=skipped(path), renamed_from=renamed_from(path),
                                 new_inside=len({fid for p, fid in new_at.items() if p.startswith(prefix)})))
            elif st is not None:
                s, rec = at.get(path), tracked.get(path)
                fid, cid = (s.file_id, s.course_id) if s else (rec.id, rec.course_id) if rec else (None, None)
                extra = canvas(fid, cid, path) if fid is not None and cid is not None else {}
                out.append(Entry(d.name, path, "file", st.st_size, st.st_mtime, **extra))  # type: ignore[arg-type]

    # Files you deleted (or deleted and then pulled, so they're no longer synced), and
    # folders that are gone with them, so what's in them can still be brought back.
    gone_dirs: dict[str, int] = {}
    prefix = rel + "/" if rel else ""
    for s in statuses:
        if not (s.path and GONE & set(s.states) and s.path.startswith(prefix)) or os.path.lexists(root / s.path):
            continue
        child = s.path[len(prefix):].split("/")[0]
        if "/" not in s.path[len(prefix):]:
            out.append(Entry(posixpath.basename(s.path), s.path, "file", deleted=True,
                             **canvas(s.file_id, s.course_id, s.path)))  # type: ignore[arg-type]
        elif not os.path.lexists(root / (prefix + child)):
            gone_dirs[prefix + child] = gone_dirs.get(prefix + child, 0) + 1
    for path, n in gone_dirs.items():
        out.append(Entry(posixpath.basename(path), path, "dir", deleted=True, changes=n, deleted_inside=n,
                         skipped=skipped(path)))

    out.sort(key=lambda e: (e.type != "dir", _natural(e.name)))
    return out
