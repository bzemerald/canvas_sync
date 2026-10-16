"""Persistent sync state in <root>/.canvas/state.db (SQLite)."""

from __future__ import annotations

import json
import sqlite3
from collections.abc import Iterable
from dataclasses import dataclass, fields
from datetime import datetime, timedelta, timezone
from pathlib import Path

from .models import Course, Document, RemoteFile

META_DIR = ".canvas"
# What can be new to you (see `arrivals`).
NEWS_KINDS = ("announcement", "assignment", "page", "file")
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
    snap_mtime REAL, snap_size INTEGER, snap_inode INTEGER
);
CREATE INDEX IF NOT EXISTS files_course ON files(course_id);
CREATE TABLE IF NOT EXISTS links (path TEXT PRIMARY KEY, file_id INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS modules (
    course_id INTEGER, id INTEGER, position INTEGER, name TEXT, raw TEXT,  -- raw includes the items
    PRIMARY KEY (course_id, id)
);
CREATE TABLE IF NOT EXISTS documents (
    course_id INTEGER, kind TEXT, id TEXT, title TEXT, updated_at TEXT, raw TEXT,
    PRIMARY KEY (course_id, kind, id)
);
-- Your grade in each course as Canvas computes it (NULL scores: not shown to students).
CREATE TABLE IF NOT EXISTS grades (course_id INTEGER PRIMARY KEY, raw TEXT);
-- What's new to you: when each announcement / assignment / page / file first showed up
-- here, and when you opened it (NULL: not yet). `updated`: a file came back in a new version.
CREATE TABLE IF NOT EXISTS arrivals (
    course_id INTEGER, kind TEXT, id TEXT, arrived_at TEXT, seen_at TEXT, updated INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (course_id, kind, id)
);
-- Courses whose arrivals are recorded, since when. What a course had before that isn't news.
CREATE TABLE IF NOT EXISTS tracked (course_id INTEGER PRIMARY KEY, since TEXT);
"""

LOCAL_COLUMNS = (
    "path", "pinned_path", "ignored", "base_hash", "base_version", "base_size",
    "snap_mtime", "snap_size", "snap_inode",
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
    snap_inode: int | None


_RECORD_COLUMNS = ", ".join(f.name for f in fields(FileRecord))


class State:
    def __init__(self, db_path: Path):
        self.db = sqlite3.connect(db_path)
        self.db.row_factory = sqlite3.Row
        self.db.execute("PRAGMA journal_mode = WAL")  # readers (search, GUI) don't block a pull
        self.db.executescript(SCHEMA)

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

    def courses(self) -> list[Course]:
        rows = self.db.execute("SELECT id, name, code, term FROM courses ORDER BY term, code")
        return [Course(r["id"], r["name"], r["code"], r["term"]) for r in rows]

    def save_modules(self, course_id: int, modules: list[dict]) -> None:
        self.db.execute("DELETE FROM modules WHERE course_id = ?", (course_id,))
        self.db.executemany(
            "INSERT OR REPLACE INTO modules VALUES (?, ?, ?, ?, ?)",
            [(course_id, m["id"], m.get("position") or 0, m.get("name") or "", json.dumps(m)) for m in modules],
        )

    def modules(self, course_id: int) -> list[dict]:
        rows = self.db.execute("SELECT raw FROM modules WHERE course_id = ? ORDER BY position, id", (course_id,))
        return [json.loads(r[0]) for r in rows]

    def save_documents(self, course_id: int, docs: list[Document]) -> None:
        self.db.execute("DELETE FROM documents WHERE course_id = ?", (course_id,))
        self.db.executemany(
            "INSERT OR REPLACE INTO documents VALUES (?, ?, ?, ?, ?, ?)",
            [(d.course_id, d.kind, d.id, d.title, d.updated_at, json.dumps(d.raw)) for d in docs],
        )

    def save_grades(self, course_id: int, grades: dict) -> None:
        self.db.execute("INSERT OR REPLACE INTO grades VALUES (?, ?)", (course_id, json.dumps(grades)))

    def grades(self, course_id: int) -> dict | None:
        row = self.db.execute("SELECT raw FROM grades WHERE course_id = ?", (course_id,)).fetchone()
        return json.loads(row[0]) if row else None

    # -- what's new -------------------------------------------------------------------

    def record_arrivals(self, course_id: int, items: Iterable[tuple[str, str, str | None]],
                        now: datetime | None = None) -> None:
        """Note items (kind, id, when Canvas says it appeared) showing up for the first time.
        The first time for a course, only what appeared in the last RECENT_DAYS is news: the
        rest counts as seen already."""
        now = now or datetime.now(timezone.utc)
        first = self.db.execute("SELECT 1 FROM tracked WHERE course_id = ?", (course_id,)).fetchone() is None
        if first:
            self.db.execute("INSERT INTO tracked VALUES (?, ?)", (course_id, now.isoformat()))

        def recent(when: str | None) -> bool:
            try:
                t = datetime.fromisoformat((when or "").replace("Z", "+00:00"))
            except ValueError:
                return False
            return t.tzinfo is not None and now - timedelta(days=RECENT_DAYS) <= t <= now

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

    def unseen(self, course_id: int | None = None, kind: str | None = None) -> dict[tuple[int, str, str], bool]:
        """(course, kind, id) -> whether it's an update, for everything not opened yet."""
        sql, args = "SELECT course_id, kind, id, updated FROM arrivals WHERE seen_at IS NULL", []
        if course_id is not None:
            sql, args = sql + " AND course_id = ?", [*args, course_id]
        if kind is not None:
            sql, args = sql + " AND kind = ?", [*args, kind]
        return {(r[0], r[1], r[2]): bool(r[3]) for r in self.db.execute(sql, args)}

    def mark_seen(self, course_id: int, items: Iterable[tuple[str, str]] | None = None,
                  kinds: Iterable[str] | None = None) -> None:
        """Mark items opened; with no items, everything new in the course (of `kinds`)."""
        now = _now()
        if items is not None:
            self.db.executemany(
                "UPDATE arrivals SET seen_at = ? WHERE course_id = ? AND kind = ? AND id = ? AND seen_at IS NULL",
                [(now, course_id, k, i) for k, i in items],
            )
            return
        kinds = list(kinds or [])
        only = f" AND kind IN ({', '.join('?' * len(kinds))})" if kinds else ""
        self.db.execute(
            f"UPDATE arrivals SET seen_at = ? WHERE course_id = ? AND seen_at IS NULL{only}", (now, course_id, *kinds)
        )
