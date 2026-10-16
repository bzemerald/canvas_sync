"""Persistent sync state in <root>/.canvas/state.db (SQLite)."""

from __future__ import annotations

import json
import sqlite3
from dataclasses import dataclass, fields
from datetime import datetime, timezone
from pathlib import Path

from .models import Course, Document, RemoteFile

META_DIR = ".canvas"

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
            (c.id, c.name, c.code, c.term, datetime.now(timezone.utc).isoformat()),
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
