"""Persistent sync state in <root>/.canvas/state.db (SQLite)."""

from __future__ import annotations

import json
import sqlite3
from collections.abc import Iterable
from dataclasses import dataclass, fields
from datetime import datetime, timedelta, timezone
from pathlib import Path

from .models import Course, Document, RemoteFile
from .times import time_of

# What can be new to you (see `arrivals`).
NEWS_KINDS = ("announcement", "assignment", "page", "file", "post")
# The first time a course is synced, what Canvas dates within this many days is still news.
RECENT_DAYS = 7


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()

SCHEMA = """
CREATE TABLE IF NOT EXISTS courses (
    id INTEGER PRIMARY KEY, name TEXT, code TEXT, term TEXT, synced_at TEXT
);
CREATE TABLE IF NOT EXISTS files (
    id INTEGER PRIMARY KEY,
    course_id INTEGER NOT NULL,
    -- latest remote metadata
    name TEXT NOT NULL,
    size INTEGER,
    version TEXT,
    remote_deleted INTEGER NOT NULL DEFAULT 0,
    raw TEXT,
    -- local side
    path TEXT,              -- where the real file is, relative to root (NULL = not downloaded)
    pinned_path TEXT,       -- user-chosen location that overrides the layout
    ignored INTEGER NOT NULL DEFAULT 0,
    -- the pristine copy in .canvas/originals/<id>
    base_hash TEXT, base_version TEXT, base_size INTEGER,
    -- stat() of `path` when it was last known identical to the base (skips re-hashing)
    snap_mtime REAL, snap_size INTEGER
);
CREATE INDEX IF NOT EXISTS files_course ON files(course_id);
CREATE TABLE IF NOT EXISTS links (path TEXT PRIMARY KEY, file_id INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS modules (
    course_id INTEGER, id INTEGER, position INTEGER, name TEXT, raw TEXT,  -- raw includes the items
    PRIMARY KEY (course_id, id)
);
-- A course's announcements, assignments, pages, syllabus; `source`: where from (canvas, ed).
CREATE TABLE IF NOT EXISTS documents (
    course_id INTEGER, kind TEXT, id TEXT, title TEXT, updated_at TEXT, raw TEXT,
    source TEXT NOT NULL DEFAULT 'canvas',
    PRIMARY KEY (course_id, kind, id)
);
-- Your grade in each course as Canvas computes it (NULL scores: not shown to students).
CREATE TABLE IF NOT EXISTS grades (course_id INTEGER PRIMARY KEY, raw TEXT);
-- Each course's navigation tabs, as you see them (its external tools are among them).
CREATE TABLE IF NOT EXISTS tabs (course_id INTEGER PRIMARY KEY, raw TEXT);
-- What's new to you: when each announcement / assignment / page / file first showed up
-- here, and when you opened it (NULL: not yet). `updated`: a file came back in a new version.
CREATE TABLE IF NOT EXISTS arrivals (
    course_id INTEGER, kind TEXT, id TEXT, arrived_at TEXT, seen_at TEXT, updated INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (course_id, kind, id)
);
-- Courses whose arrivals are recorded, since when. What a course had before that isn't news.
CREATE TABLE IF NOT EXISTS tracked (course_id INTEGER PRIMARY KEY, since TEXT);
-- What you open in the app, by the app's key for it: how often, and when last. And what you'd
-- typed in search when you opened it. What you go to most, and lately, comes first.
CREATE TABLE IF NOT EXISTS opened (key TEXT PRIMARY KEY, count INTEGER NOT NULL, last TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS picks (
    query TEXT, key TEXT, count INTEGER NOT NULL, last TEXT NOT NULL,
    PRIMARY KEY (query, key)
);
-- Your courses on Ed, as Ed last listed them (which Canvas course each is: config.toml's [ed]).
CREATE TABLE IF NOT EXISTS ed_courses (id INTEGER PRIMARY KEY, raw TEXT);
-- Where things come from besides Canvas (Ed): when it last worked, and what went wrong since.
CREATE TABLE IF NOT EXISTS sources (name TEXT PRIMARY KEY, ok_at TEXT, error TEXT);
"""

KEEP_OPENED = 2000  # rows of `opened` (and of `picks`) kept: the oldest go

LOCAL_COLUMNS = (
    "path", "pinned_path", "ignored", "base_hash", "base_version", "base_size",
    "snap_mtime", "snap_size",
)


@dataclass
class FileRecord:
    id: int
    course_id: int
    name: str
    size: int | None
    version: str | None
    remote_deleted: bool
    path: str | None
    pinned_path: str | None
    ignored: bool
    base_hash: str | None
    base_version: str | None
    base_size: int | None
    snap_mtime: float | None
    snap_size: int | None


_RECORD_COLUMNS = ", ".join(f.name for f in fields(FileRecord))
_DOCUMENT_COLUMNS = "course_id, kind, id, title, updated_at, raw, source"


def _document(row: sqlite3.Row) -> Document:
    return Document(row["course_id"], row["kind"], row["id"], row["title"], row["updated_at"], json.loads(row["raw"] or "{}"),
                    row["source"])


class State:
    def __init__(self, db_path: Path):
        self.db = sqlite3.connect(db_path)
        self.db.row_factory = sqlite3.Row
        self.db.execute("PRAGMA journal_mode = WAL")  # readers (search, GUI) don't block a pull
        self.db.executescript(SCHEMA)
        if "source" not in {r[1] for r in self.db.execute("PRAGMA table_info(documents)")}:  # (from before Ed)
            self.db.execute("ALTER TABLE documents ADD COLUMN source TEXT NOT NULL DEFAULT 'canvas'")

    def close(self) -> None:
        self.db.commit()
        self.db.close()

    def commit(self) -> None:
        self.db.commit()

    # -- files --------------------------------------------------------------------

    def _records(self, where: str, *args: object) -> list[FileRecord]:
        rows = self.db.execute(f"SELECT {_RECORD_COLUMNS} FROM files WHERE {where}", args)
        return [FileRecord(**dict(r)) for r in rows]

    def get(self, file_id: int) -> FileRecord | None:
        recs = self._records("id = ?", file_id)
        return recs[0] if recs else None

    def files_for_course(self, course_id: int) -> list[FileRecord]:
        return self._records("course_id = ?", course_id)

    def all_files(self) -> list[FileRecord]:
        return self._records("1")

    def synced_files(self) -> list[FileRecord]:
        """Files that are synced and have a place, in the order of their paths."""
        return self._records("path IS NOT NULL AND ignored = 0 ORDER BY path")

    def file_raw(self, file_id: int) -> dict:
        """A file as Canvas's API gave it ({}: none we know)."""
        row = self.db.execute("SELECT raw FROM files WHERE id = ?", (file_id,)).fetchone()
        return json.loads(row[0] or "{}") if row else {}

    def files_raw(self, course_id: int | None = None) -> dict[int, dict]:
        """Every file (or a course's) as Canvas's API gave it, by its id."""
        where, args = (" WHERE course_id = ?", (course_id,)) if course_id is not None else ("", ())
        return {r[0]: json.loads(r[1] or "{}") for r in self.db.execute("SELECT id, raw FROM files" + where, args)}

    def by_path(self, path: str) -> FileRecord | None:
        recs = self._records("path = ? COLLATE NOCASE", path)
        if recs:
            return recs[0]
        row = self.db.execute("SELECT file_id FROM links WHERE path = ? COLLATE NOCASE", (path,)).fetchone()
        return self.get(row[0]) if row else None

    def upsert_remote(self, f: RemoteFile) -> None:
        self.db.execute(
            """INSERT INTO files (id, course_id, name, size, version, raw, remote_deleted)
               VALUES (?, ?, ?, ?, ?, ?, 0)
               ON CONFLICT(id) DO UPDATE SET course_id = excluded.course_id,
                 name = excluded.name, size = excluded.size, version = excluded.version,
                 raw = excluded.raw, remote_deleted = 0""",
            (f.id, f.course_id, f.name, f.size, f.version, json.dumps(f.raw)),
        )

    def update(self, file_id: int, **values: object) -> None:
        bad = set(values) - set(LOCAL_COLUMNS) - {"remote_deleted"}
        if bad:
            raise ValueError(f"not updatable: {bad}")
        assignments = ", ".join(f"{k} = ?" for k in values)
        self.db.execute(f"UPDATE files SET {assignments} WHERE id = ?", (*values.values(), file_id))

    def rekey(self, old_id: int, new_id: int) -> None:
        """Carry local state from a file Canvas replaced over to its successor."""
        old = self.get(old_id)
        if old is None:
            return
        self.update(new_id, **{c: getattr(old, c) for c in LOCAL_COLUMNS})
        self.db.execute("UPDATE links SET file_id = ? WHERE file_id = ?", (new_id, old_id))
        self.db.execute("DELETE FROM files WHERE id = ?", (old_id,))

    # -- links --------------------------------------------------------------------

    def links(self) -> dict[str, int]:
        """Every view link: where it is -> the file it shows."""
        return {r[0]: r[1] for r in self.db.execute("SELECT path, file_id FROM links")}

    def file_links(self) -> dict[int, list[str]]:
        """Each file's view links: where they are."""
        out: dict[int, list[str]] = {}
        for path, file_id in self.links().items():
            out.setdefault(file_id, []).append(path)
        return out

    def linked_from(self, folder: str) -> list[str]:
        """Where the files are that the view links at or under `folder` show."""
        rows = self.db.execute(
            "SELECT f.path FROM links l JOIN files f ON f.id = l.file_id WHERE f.path IS NOT NULL"
            " AND (l.path = ? OR substr(l.path, 1, ?) = ?)", (folder, len(folder) + 1, folder + "/"))
        return [r[0] for r in rows]

    def links_for_course(self, course_id: int) -> dict[str, int]:
        rows = self.db.execute(
            "SELECT l.path, l.file_id FROM links l JOIN files f ON f.id = l.file_id WHERE f.course_id = ?",
            (course_id,),
        )
        return {r[0]: r[1] for r in rows}

    def is_link(self, path: str) -> bool:
        return self.db.execute("SELECT 1 FROM links WHERE path = ? COLLATE NOCASE", (path,)).fetchone() is not None

    def add_link(self, path: str, file_id: int) -> None:
        self.db.execute("INSERT OR REPLACE INTO links (path, file_id) VALUES (?, ?)", (path, file_id))

    def remove_link(self, path: str) -> None:
        self.db.execute("DELETE FROM links WHERE path = ?", (path,))

    # -- courses & documents --------------------------------------------------------

    def save_course(self, c: Course) -> None:
        self.db.execute(
            "INSERT OR REPLACE INTO courses (id, name, code, term, synced_at) VALUES (?, ?, ?, ?, ?)",
            (c.id, c.name, c.code, c.term, _now()),
        )

    def last_synced(self) -> datetime | None:
        """When a pull last stored a course."""
        row = self.db.execute("SELECT max(synced_at) FROM courses").fetchone()
        try:
            return datetime.fromisoformat(row[0]) if row and row[0] else None
        except ValueError:
            return None

    def courses(self) -> list[Course]:
        rows = self.db.execute("SELECT id, name, code, term FROM courses ORDER BY term, code")
        return [Course(r["id"], r["name"], r["code"], r["term"]) for r in rows]

    def course(self, course_id: int) -> Course | None:
        r = self.db.execute("SELECT id, name, code, term FROM courses WHERE id = ?", (course_id,)).fetchone()
        return Course(r["id"], r["name"], r["code"], r["term"]) if r else None

    def synced_at(self) -> dict[int, str]:
        """When each course was last synced."""
        return {r[0]: r[1] for r in self.db.execute("SELECT id, synced_at FROM courses")}

    def save_modules(self, course_id: int, modules: list[dict]) -> None:
        self.db.execute("DELETE FROM modules WHERE course_id = ?", (course_id,))
        self.db.executemany(
            "INSERT OR REPLACE INTO modules VALUES (?, ?, ?, ?, ?)",
            [(course_id, m["id"], m.get("position") or 0, m.get("name") or "", json.dumps(m)) for m in modules],
        )

    def modules(self, course_id: int) -> list[dict]:
        rows = self.db.execute("SELECT raw FROM modules WHERE course_id = ? ORDER BY position, id", (course_id,))
        return [json.loads(r[0]) for r in rows]

    def module_name(self, course_id: int, module_id: int) -> str | None:
        """What a module is called (None: there's no such module)."""
        row = self.db.execute("SELECT name FROM modules WHERE course_id = ? AND id = ?", (course_id, module_id)).fetchone()
        return row[0] if row else None

    def module_names(self) -> list[tuple[int, int, str]]:
        """Every module: its course, its id and its name, each course's in its order."""
        rows = self.db.execute("SELECT course_id, id, name FROM modules ORDER BY course_id, position, id")
        return [(r[0], r[1], r[2]) for r in rows]

    def save_documents(self, course_id: int, docs: list[Document], source: str = "canvas") -> None:
        """A course's documents from one source, as it has them now (the other sources' stay)."""
        self.db.execute("DELETE FROM documents WHERE course_id = ? AND source = ?", (course_id, source))
        self.db.executemany(
            "INSERT OR REPLACE INTO documents (course_id, kind, id, title, updated_at, raw, source) VALUES (?, ?, ?, ?, ?, ?, ?)",
            [(d.course_id, d.kind, d.id, d.title, d.updated_at, json.dumps(d.raw), source) for d in docs],
        )

    def has_documents(self, course_id: int, source: str) -> bool:
        return self.db.execute("SELECT 1 FROM documents WHERE course_id = ? AND source = ? LIMIT 1",
                               (course_id, source)).fetchone() is not None

    def documents(self, course_id: int | None = None, kind: str | None = None, source: str | None = None) -> list[Document]:
        """The documents stored: all of them, or only a course's, of a kind, from a source."""
        where = [(column, v) for column, v in (("course_id", course_id), ("kind", kind), ("source", source)) if v is not None]
        sql = f"SELECT {_DOCUMENT_COLUMNS} FROM documents" + (" WHERE " + " AND ".join(f"{c} = ?" for c, _ in where) if where else "")
        return [_document(r) for r in self.db.execute(sql, [v for _, v in where])]

    def document(self, course_id: int, kind: str, doc_id: str) -> Document | None:
        row = self.db.execute(f"SELECT {_DOCUMENT_COLUMNS} FROM documents WHERE course_id = ? AND kind = ? AND id = ?",
                              (course_id, kind, doc_id)).fetchone()
        return _document(row) if row else None

    def document_title(self, course_id: int, kind: str, doc_id: str) -> str | None:
        """What a document is called (None: there's no such document)."""
        row = self.db.execute("SELECT title FROM documents WHERE course_id = ? AND kind = ? AND id = ?",
                              (course_id, kind, doc_id)).fetchone()
        return row[0] if row else None

    def update_document(self, d: Document) -> None:
        """A stored document's `raw`, as it is now (an Ed thread with its replies fetched)."""
        self.db.execute("UPDATE documents SET raw = ? WHERE course_id = ? AND kind = ? AND id = ?",
                        (json.dumps(d.raw), d.course_id, d.kind, d.id))

    def save_grades(self, course_id: int, grades: dict) -> None:
        self.db.execute("INSERT OR REPLACE INTO grades VALUES (?, ?)", (course_id, json.dumps(grades)))

    def grades(self, course_id: int) -> dict | None:
        row = self.db.execute("SELECT raw FROM grades WHERE course_id = ?", (course_id,)).fetchone()
        return json.loads(row[0]) if row else None

    def save_tabs(self, course_id: int, tabs: list[dict]) -> None:
        self.db.execute("INSERT OR REPLACE INTO tabs VALUES (?, ?)", (course_id, json.dumps(tabs)))

    def tabs(self, course_id: int) -> list[dict]:
        row = self.db.execute("SELECT raw FROM tabs WHERE course_id = ?", (course_id,)).fetchone()
        return json.loads(row[0]) if row else []

    # -- other sources ----------------------------------------------------------------

    def save_ed_courses(self, courses: list[dict]) -> None:
        self.db.execute("DELETE FROM ed_courses")
        self.db.executemany("INSERT INTO ed_courses VALUES (?, ?)", [(c["id"], json.dumps(c)) for c in courses])

    def ed_courses(self) -> list[dict]:
        return [json.loads(r[0]) for r in self.db.execute("SELECT raw FROM ed_courses ORDER BY id")]

    def record_source(self, name: str, error: str | None = None) -> None:
        """How fetching from a source went just now: fine (None), or what went wrong."""
        if error is None:
            self.db.execute("INSERT OR REPLACE INTO sources VALUES (?, ?, NULL)", (name, _now()))
        else:
            self.db.execute("INSERT INTO sources VALUES (?, NULL, ?) ON CONFLICT(name) DO UPDATE SET error = excluded.error",
                            (name, error))

    def source(self, name: str) -> dict[str, str | None]:
        row = self.db.execute("SELECT ok_at, error FROM sources WHERE name = ?", (name,)).fetchone()
        return {"ok_at": row[0], "error": row[1]} if row else {"ok_at": None, "error": None}

    # -- what's new -------------------------------------------------------------------

    def record_arrivals(self, course_id: int, items: Iterable[tuple[str, str, str | None]],
                        now: datetime | None = None, first: bool | None = None) -> None:
        """Note items (kind, id, when Canvas says it appeared) showing up for the first time.
        The first time for a course, only what appeared in the last RECENT_DAYS is news: the
        rest counts as seen already. `first`: whether it's the first time for these items'
        source (default: for the course)."""
        now = now or datetime.now(timezone.utc)
        untracked = self.db.execute("SELECT 1 FROM tracked WHERE course_id = ?", (course_id,)).fetchone() is None
        if untracked:
            self.db.execute("INSERT INTO tracked VALUES (?, ?)", (course_id, now.isoformat()))
        first = untracked if first is None else first

        def recent(when: str | None) -> bool:
            t = time_of(when)
            return t is not None and t.tzinfo is not None and now - timedelta(days=RECENT_DAYS) <= t <= now

        stamp = now.isoformat()
        self.db.executemany(
            "INSERT OR IGNORE INTO arrivals (course_id, kind, id, arrived_at, seen_at) VALUES (?, ?, ?, ?, ?)",
            [(course_id, kind, i, stamp, stamp if first and not recent(when) else None) for kind, i, when in items],
        )

    def record_update(self, course_id: int, file_id: int) -> None:
        """A file came again in a new version: new to you until you open it."""
        self.db.execute(
            """INSERT INTO arrivals (course_id, kind, id, arrived_at, seen_at, updated) VALUES (?, 'file', ?, ?, NULL, 1)
               ON CONFLICT(course_id, kind, id) DO UPDATE SET arrived_at = excluded.arrived_at, seen_at = NULL, updated = 1""",
            (course_id, str(file_id), _now()),
        )

    def arrived(self, course_id: int, since: str = "") -> list[dict]:
        """What arrived in a course since `since` (an ISO time; "": ever), opened or not: kind, id,
        arrived_at, seen_at, updated. Not what was there when the course first synced: that came in
        seen at once, and isn't news."""
        rows = self.db.execute(
            """SELECT kind, id, arrived_at, seen_at, updated FROM arrivals
               WHERE course_id = ? AND arrived_at >= ? AND (seen_at IS NULL OR seen_at != arrived_at)""", (course_id, since))
        return [dict(r) for r in rows]

    def unseen(self, course_id: int | None = None, kind: str | None = None) -> dict[tuple[int, str, str], bool]:
        """(course, kind, id) -> whether it's an update, for everything not opened yet."""
        sql, args = "SELECT course_id, kind, id, updated FROM arrivals WHERE seen_at IS NULL", []
        if course_id is not None:
            sql, args = sql + " AND course_id = ?", [*args, course_id]
        if kind is not None:
            sql, args = sql + " AND kind = ?", [*args, kind]
        return {(r[0], r[1], r[2]): bool(r[3]) for r in self.db.execute(sql, args)}

    def mark_seen(self, course_id: int, items: Iterable[tuple[str, str]] | None = None) -> None:
        """Mark items opened; with no items, everything new in the course."""
        now = _now()
        if items is not None:
            self.db.executemany(
                "UPDATE arrivals SET seen_at = ? WHERE course_id = ? AND kind = ? AND id = ? AND seen_at IS NULL",
                [(now, course_id, k, i) for k, i in items],
            )
            return
        self.db.execute("UPDATE arrivals SET seen_at = ? WHERE course_id = ? AND seen_at IS NULL", (now, course_id))

    def unseen_files(self) -> dict[str, tuple[int, int]]:
        """Where each file not opened yet is (its links too) -> its course and id."""
        unseen = {int(i): course for (course, _, i) in self.unseen(kind="file")}
        paths = [(r.path, r.id) for r in self.all_files() if r.path and r.id in unseen and not r.ignored]
        paths += [(p, fid) for p, fid in self.links().items() if fid in unseen]
        return {p: (unseen[fid], fid) for p, fid in paths}

    def mark_paths_seen(self, files: Iterable[str] = (), folders: Iterable[str] = ()) -> None:
        """Mark new files of the sync folder opened: these (at any of their paths), and those in
        these folders ("": all of it), and their links."""
        wanted = {f.strip("/") for f in files}
        prefixes = tuple(f.strip("/") + "/" if f.strip("/") else "" for f in folders)
        courses: dict[int, set[tuple[str, str]]] = {}
        for path, (course, fid) in self.unseen_files().items():
            if path in wanted or path.startswith(prefixes):
                courses.setdefault(course, set()).add(("file", str(fid)))
        for course, items in courses.items():
            self.mark_seen(course, items)

    # -- what you open ------------------------------------------------------------------

    def record_opened(self, key: str, query: str = "") -> None:
        """You opened `key` (having typed `query` in search, if any)."""
        now = _now()
        self.db.execute(
            """INSERT INTO opened VALUES (?, 1, ?)
               ON CONFLICT(key) DO UPDATE SET count = count + 1, last = excluded.last""", (key, now))
        if query:
            self.db.execute(
                """INSERT INTO picks VALUES (?, ?, 1, ?)
                   ON CONFLICT(query, key) DO UPDATE SET count = count + 1, last = excluded.last""", (query, key, now))
        for table in ("opened", "picks"):
            self.db.execute(
                f"DELETE FROM {table} WHERE rowid NOT IN (SELECT rowid FROM {table} ORDER BY last DESC LIMIT ?)",
                (KEEP_OPENED,))

    def usage(self, limit: int = 500) -> dict[str, object]:
        """What you opened lately: key -> {count, last}; and what you'd typed for what: [{query, key,
        count, last}], latest first."""
        opened = {r[0]: {"count": r[1], "last": r[2]}
                  for r in self.db.execute("SELECT key, count, last FROM opened ORDER BY last DESC LIMIT ?", (limit,))}
        picks = [{"query": r[0], "key": r[1], "count": r[2], "last": r[3]}
                 for r in self.db.execute("SELECT query, key, count, last FROM picks ORDER BY last DESC LIMIT ?", (limit,))]
        return {"opened": opened, "picks": picks}
