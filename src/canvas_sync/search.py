"""Full-text search over everything we know about the synced courses.

The index lives in <root>/.canvas/index.db, separate from state.db: it is a cache
built from state.db and the files on disk, and can be deleted at any time.

A query like "221 mt1" is read as: tokens naming a course ("221" -> MATH 221) become
a course filter; every other token must match, either literally or through one of
its expansions ("mt1" -> "mt 1" | "midterm 1" | "mid term 1" | ...).
"""

from __future__ import annotations

import hashlib
import json
import re
import sqlite3
from collections.abc import Callable, Iterator
from dataclasses import asdict, dataclass, field
from pathlib import Path, PurePosixPath
from typing import Any
from urllib.parse import urlsplit

from .config import Settings
from .models import Course
from .state import State
from .text import extract, html_to_text

DEFAULT_ABBREVIATIONS: dict[str, list[str]] = {
    "mt": ["midterm", "mid term", "prelim"],
    "hw": ["homework", "problem set", "pset", "assignment"],
    "ps": ["problem set", "pset", "homework"],
    "pset": ["problem set", "homework"],
    "lec": ["lecture", "slides"],
    "disc": ["discussion", "recitation", "section"],
    "rec": ["recitation", "discussion"],
    "sol": ["solution", "answer key", "answers"],
    "soln": ["solution", "answer key", "answers"],
    "ans": ["answer", "solution"],
    "syl": ["syllabus"],
    "proj": ["project"],
    "qz": ["quiz"],
    "rev": ["review"],
    "oh": ["office hours"],
    "ann": ["announcement"],
    "期中": ["midterm", "mt", "prelim"],
    "期末": ["final"],
    "考试": ["exam", "midterm", "final"],
    "作业": ["homework", "assignment", "problem set"],
    "课件": ["lecture", "slides"],
    "讲义": ["lecture", "notes"],
    "答案": ["solution", "answer"],
    "大纲": ["syllabus"],
}

# Department names as registrars write them -> what students type.
DEPARTMENTS: dict[str, list[str]] = {
    "compsci": ["cs"], "comsci": ["cs"], "cmpsc": ["cs"], "eleng": ["ee"], "elecengr": ["ee"],
    "eecs": ["cs", "ee"], "mathematics": ["math"], "statistics": ["stat", "stats"], "stat": ["stats"],
    "physics": ["phys"], "chemistry": ["chem"], "chem": ["chemistry"], "economics": ["econ"],
    "psychology": ["psych"], "biology": ["bio"], "integbi": ["ib"], "mcellbi": ["mcb"],
    "mecheng": ["me"], "civeng": ["ce"], "bioeng": ["be"], "neurosc": ["neu"],
}

SCHEMA = """
CREATE TABLE IF NOT EXISTS items (
    id INTEGER PRIMARY KEY,
    key TEXT UNIQUE NOT NULL,   -- file:<id> | <kind>:<course>:<doc id>
    course_id INTEGER, kind TEXT, title TEXT,
    path TEXT,                  -- local file, relative to root
    url TEXT,                   -- Canvas page, relative to the Canvas base URL
    date TEXT,
    stamp TEXT,                 -- everything above + content_stamp; unchanged = skip
    content_stamp TEXT          -- unchanged = keep the extracted text
);
CREATE VIRTUAL TABLE IF NOT EXISTS fts USING fts5(
    title, folder, body, tokenize = 'unicode61 remove_diacritics 2'
);
"""

# Index-time and query-time splitting the default tokenizer doesn't do. U+200B is a
# separator to FTS5 but invisible in snippets.
_ZW = "​"
_LETTER_DIGIT = re.compile(r"(?<=[^\W\d_])(?=\d)|(?<=\d)(?=[^\W\d_])")
_CJK = re.compile(r"([぀-ヿ㐀-䶿一-鿿가-힯豈-﫿])")
_NORM = re.compile(r"[\W_]+")
_HIT_START, _HIT_END = "\x02", "\x03"

ProgressHandler = Callable[[int, int, str], None]  # (done, total, current item)


def _prep(text: str) -> str:
    return _CJK.sub(rf"{_ZW}\1{_ZW}", _LETTER_DIGIT.sub(_ZW, text))


def _norm(text: str) -> str:
    return _NORM.sub("", text.lower())


def _is_cjk(text: str) -> bool:
    return bool(_CJK.search(text))


@dataclass
class IndexStats:
    indexed: int = 0      # items whose entry was (re)written
    extracted: int = 0    # files whose text was (re)read
    removed: int = 0
    total: int = 0


@dataclass
class Hit:
    kind: str
    course_id: int
    course: str           # course code
    title: str
    path: str | None
    url: str | None
    date: str | None
    snippet: list[tuple[str, bool]] = field(default_factory=list)  # (text, is_match)

    def to_dict(self) -> dict[str, Any]:
        d = asdict(self)
        d["snippet"] = [{"text": t, "match": m} for t, m in self.snippet]
        return d


@dataclass
class Query:
    course_ids: list[int]
    groups: list[list[tuple[str, bool]]]  # AND of groups, OR within a group: (term, exact)

    def fts(self) -> str:
        return " AND ".join("(" + " OR ".join(_fts_term(*t) for t in g) + ")" for g in self.groups)


def _fts_term(term: str, exact: bool = False) -> str:
    """One alternative as an FTS5 phrase. Prefix-match words of 3+ letters and CJK, so
    'lec' finds 'lecture' but 'ps' doesn't find 'psychology'."""
    prepped = _prep(term).strip(_ZW + " ")
    last = re.split(rf"[\s{_ZW}\W]+", prepped)[-1] if prepped else ""
    prefix = not exact and ((len(last) >= 3 and not last.isdigit()) or _is_cjk(last))
    return '"' + prepped.replace('"', '""') + '"' + ("*" if prefix else "")


# -- query parsing -----------------------------------------------------------------


def code_keys(code: str) -> set[str]:
    """The parts of a course code people type: "COMPSCI 70-LEC-001" -> compsci, 70;
    "CS61B SP26" -> cs, 61b, cs61b; "DATA C8" -> data, c8, 8. Only up to the course
    number, so sections ("001"), terms ("SP26") and "LEC" don't count."""
    keys: set[str] = set()
    depts: list[str] = []
    for chunk in re.split(r"[\W_]+", code.lower()):
        parts = re.findall(r"[^\W\d_]+|\d+[^\W\d_]*", chunk)
        number = next((p for p in parts if p[0].isdigit()), None)
        words = [p for p in parts[: parts.index(number) if number else None] if len(p) > 1]
        depts += words
        keys |= set(words)
        if number:
            keys |= {chunk, number}
            for d in depts:  # COMPSCI 70 -> cs70
                keys |= {alias + number for alias in [d, *DEPARTMENTS.get(d, [])]}
                keys |= set(DEPARTMENTS.get(d, []))
            return keys
    return set()  # no course number: only the full code/name match


class CourseMatcher:
    def __init__(self, courses: list[Course], settings: Settings):
        self.exact: dict[str, set[int]] = {}
        self.prefixable: list[tuple[str, int]] = []
        for c in courses:
            names = [c.code, c.name, settings.course_names.get(c.id, "")]
            aliases = settings.course_aliases.get(c.id, [])
            keys = {_norm(n) for n in [*names, *aliases] if n} | code_keys(c.code)
            for k in keys - {""}:
                self.exact.setdefault(k, set()).add(c.id)
            self.prefixable += [(_norm(n), c.id) for n in [*names, *aliases] if n]

    def match(self, token: str, allow_prefix: bool) -> set[int]:
        t = _norm(token)
        if not t:
            return set()
        if t in self.exact:
            return self.exact[t]
        if allow_prefix and (len(t) >= 3 or _is_cjk(t)):
            return {cid for key, cid in self.prefixable if key.startswith(t)}
        return set()


def expand(token: str, abbreviations: dict[str, list[str]]) -> list[tuple[str, bool]]:
    """Alternatives for one query token, as (term, exact) pairs."""
    t = token.lower()
    alts = [(t, False), *((a, False) for a in abbreviations.get(t, []))]
    if m := re.fullmatch(r"(\D+?)[\s_-]*(\d+)", t):  # mt1 -> midterm 1, hw3 -> homework 3
        alts += [(f"{a} {m[2]}", False) for a in abbreviations.get(m[1], [])]
    # And the other way round: "midterm" also finds "MT1.pdf" (whole word only, so
    # "announcement" -> "ann" doesn't find "annual").
    alts += [(k, True) for k, v in abbreviations.items() if t in v and not _is_cjk(k)]
    seen: dict[str, bool] = {}
    for term, exact in alts:
        seen[term] = seen.get(term, True) and exact
    return list(seen.items())


def parse(query: str, matcher: CourseMatcher, abbreviations: dict[str, list[str]]) -> Query:
    """Course tokens may come anywhere, but loose (prefix) course matching only applies to
    the first token, so "221 data" searches MATH 221 for "data" instead of also pulling
    in "Data Structures"."""
    tokens = [t for t in re.split(r"\s+", query.strip()) if re.search(r"\w", t)]
    course_ids: set[int] = set()
    groups = []
    for i, tok in enumerate(tokens):
        hit = matcher.match(tok, allow_prefix=(i == 0)) if not course_ids else matcher.match(tok, False)
        is_abbr = tok.lower() in abbreviations
        if hit and not is_abbr:
            course_ids |= hit
        else:
            groups.append(expand(tok, abbreviations))
    return Query(sorted(course_ids), groups)


# -- the index ----------------------------------------------------------------------


@dataclass
class _Item:
    key: str
    course_id: int
    kind: str
    title: str
    path: str | None
    url: str | None
    date: str | None
    folder: str
    content_stamp: str
    body: Callable[[], str]

    def stamp(self) -> str:
        return json.dumps([self.title, self.path, self.url, self.date, self.folder, self.content_stamp])


def _relative_url(url: str | None) -> str | None:
    if not url:
        return None
    parts = urlsplit(url)
    return parts.path + (f"?{parts.query}" if parts.query else "")


DOC_BODY = {"page": "body", "assignment": "description", "announcement": "message", "syllabus": "syllabus_body"}


class Index:
    def __init__(self, db_path: Path):
        self.db = sqlite3.connect(db_path)
        self.db.row_factory = sqlite3.Row
        self.db.execute("PRAGMA journal_mode = WAL")
        self.db.executescript(SCHEMA)

    def close(self) -> None:
        self.db.commit()
        self.db.close()

    def _wanted(self, state: State, root: Path) -> Iterator[_Item]:
        links: dict[int, list[str]] = {}
        for row in state.db.execute("SELECT path, file_id FROM links"):
            links.setdefault(row[1], []).append(row[0])
        for r in state.all_files():
            if r.ignored or (r.remote_deleted and not r.path):
                continue
            local = root / r.path if r.path else None
            try:
                st = local.stat() if local and local.is_file() else None
            except OSError:
                st = None
            places = [p for p in [r.path, *links.get(r.id, [])] if p]
            folder = " / ".join(dict.fromkeys(str(PurePosixPath(p).parent) for p in places))
            title = PurePosixPath(r.path).name if r.path else r.name
            if title != r.name:
                folder += f" / {r.name}"
            raw = json.loads(state.db.execute("SELECT raw FROM files WHERE id = ?", (r.id,)).fetchone()[0] or "{}")
            yield _Item(
                key=f"file:{r.id}", course_id=r.course_id, kind="file", title=title,
                path=r.path if st else None, url=f"/courses/{r.course_id}/files/{r.id}",
                date=raw.get("modified_at") or raw.get("updated_at"),
                folder=f"file {folder}",
                content_stamp=f"{st.st_size}:{st.st_mtime_ns}" if st else "",
                body=(lambda p=local: extract(p)) if st else (lambda: ""),
            )
        for row in state.db.execute("SELECT course_id, kind, id, title, updated_at, raw FROM documents"):
            raw = json.loads(row["raw"] or "{}")
            html = raw.get(DOC_BODY.get(row["kind"], ""), "") or ""
            cid, kind = row["course_id"], row["kind"]
            url = _relative_url(raw.get("html_url"))
            if kind == "syllabus":
                url = f"/courses/{cid}/assignments/syllabus"
            elif kind == "page" and not url:
                url = f"/courses/{cid}/pages/{row['id']}"
            yield _Item(
                key=f"{kind}:{cid}:{row['id']}", course_id=cid, kind=kind, title=row["title"],
                path=None, url=url,
                date=raw.get("due_at") or raw.get("posted_at") or row["updated_at"] or None,
                folder=kind + (f" due {raw['due_at'][:10]}" if raw.get("due_at") else ""),
                content_stamp=hashlib.sha1(html.encode()).hexdigest(),
                body=lambda h=html: html_to_text(h),
            )

    def sync(self, state: State, root: Path, on_progress: ProgressHandler | None = None) -> IndexStats:
        """Bring the index in line with state.db and the disk. Only re-reads files whose
        size or mtime changed."""
        existing = {
            r["key"]: (r["id"], r["stamp"], r["content_stamp"])
            for r in self.db.execute("SELECT id, key, stamp, content_stamp FROM items")
        }
        wanted = list(self._wanted(state, root))
        stats = IndexStats(total=len(wanted))
        todo = [w for w in wanted if w.key not in existing or existing[w.key][1] != w.stamp()]
        for done, item in enumerate(todo):
            old = existing.get(item.key)
            body = None
            if old and old[2] == item.content_stamp:
                row = self.db.execute("SELECT body FROM fts WHERE rowid = ?", (old[0],)).fetchone()
                body = row[0] if row else None
            if body is None:
                if on_progress and item.kind == "file":
                    on_progress(done, len(todo), item.title)
                body = _prep(item.body())
                stats.extracted += item.kind == "file" and bool(item.path)
            values = (item.course_id, item.kind, item.title, item.path, item.url, item.date,
                      item.stamp(), item.content_stamp)
            if old:
                rowid = old[0]
                self.db.execute(
                    """UPDATE items SET course_id=?, kind=?, title=?, path=?, url=?, date=?, stamp=?,
                       content_stamp=? WHERE id=?""", (*values, rowid))
                self.db.execute("DELETE FROM fts WHERE rowid = ?", (rowid,))
            else:
                rowid = self.db.execute(
                    """INSERT INTO items (course_id, kind, title, path, url, date, stamp, content_stamp, key)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""", (*values, item.key)).lastrowid
            self.db.execute("INSERT INTO fts (rowid, title, folder, body) VALUES (?, ?, ?, ?)",
                            (rowid, _prep(item.title), _prep(item.folder), body))
            stats.indexed += 1
            if done % 25 == 24:
                self.db.commit()  # an interrupted run keeps what it did
        gone = existing.keys() - {w.key for w in wanted}
        for key in gone:
            rowid = existing[key][0]
            self.db.execute("DELETE FROM fts WHERE rowid = ?", (rowid,))
            self.db.execute("DELETE FROM items WHERE id = ?", (rowid,))
        stats.removed = len(gone)
        self.db.commit()
        if on_progress:
            on_progress(len(todo), len(todo), "")
        return stats

    def search(self, query: str, courses: list[Course], settings: Settings, limit: int = 50,
               course_ids: list[int] | None = None) -> list[Hit]:
        """`course_ids` restricts the search to those courses, whatever the query says."""
        abbreviations = {**DEFAULT_ABBREVIATIONS, **settings.abbreviations}
        q = parse(query, CourseMatcher(courses, settings), abbreviations)
        if course_ids:
            q.course_ids = sorted(set(course_ids) & set(q.course_ids)) if q.course_ids else list(course_ids)
            if not q.course_ids:
                return []
        codes = {c.id: settings.course_names.get(c.id) or c.code for c in courses}
        where, args = [], []
        if q.course_ids:
            where.append(f"i.course_id IN ({','.join('?' * len(q.course_ids))})")
            args += q.course_ids
        if q.groups:
            # bm25 alone can't tell "Lecture 3.pdf" from "HW3.pdf" in a "Lectures" folder when
            # nearly every file there matches "lec": everything matching in the title wins.
            sql = f"""SELECT i.*, snippet(fts, -1, '{_HIT_START}', '{_HIT_END}', '…', 14) AS snip
                      FROM fts JOIN items i ON i.id = fts.rowid
                      WHERE fts MATCH ? {''.join(' AND ' + w for w in where)}
                      ORDER BY fts.rowid IN (SELECT rowid FROM fts WHERE fts MATCH ?) DESC,
                               bm25(fts, 10.0, 3.0, 1.0)
                      LIMIT ?"""
            args = [q.fts(), *args, f"title : ({q.fts()})", limit]
        elif q.course_ids:  # just a course: its most recent items
            sql = f"""SELECT i.*, NULL AS snip FROM items i WHERE {' AND '.join(where)}
                      ORDER BY i.date IS NULL, i.date DESC LIMIT ?"""
            args.append(limit)
        else:
            return []
        return [
            Hit(kind=r["kind"], course_id=r["course_id"], course=codes.get(r["course_id"], str(r["course_id"])),
                title=r["title"], path=r["path"], url=r["url"], date=r["date"],
                snippet=_segments(r["snip"]) if r["snip"] else [])
            for r in self.db.execute(sql, args)
        ]


def _segments(snippet: str) -> list[tuple[str, bool]]:
    out: list[tuple[str, bool]] = []
    for part in re.split(f"({_HIT_START}.*?{_HIT_END})", snippet.replace(_ZW, "").replace("\n", " ")):
        if part.startswith(_HIT_START):
            out.append((part[1:-1], True))
        elif part:
            out.append((part, False))
    return out
