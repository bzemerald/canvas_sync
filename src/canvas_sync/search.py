"""Full-text search over everything we know about the synced courses.

The index lives in <root>/.canvas/index.db, separate from state.db: it is a cache
built from state.db and the files on disk, and can be deleted at any time.

A query like "221 mt1" is read as: tokens naming a course ("221" -> MATH 221) become
a course filter; every other token must match, either literally or through one of
its expansions ("mt1" -> "mt 1" | "midterm 1" | "mid term 1" | ...).
"""

from __future__ import annotations

import bisect
import hashlib
import json
import re
import sqlite3
from collections.abc import Callable, Iterable, Iterator
from dataclasses import asdict, dataclass, field
from pathlib import Path, PurePosixPath
from typing import Any
from urllib.parse import urlsplit

from rapidfuzz import process
from rapidfuzz.distance import DamerauLevenshtein

from .config import Settings
from .layout import Layout
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
    # Series in Chinese ("第3讲", "实验2"), and kinds of things (the index has the kind as a word).
    "讲": ["lecture"],
    "课": ["lecture", "lesson"],
    "周": ["week"],
    "章": ["chapter"],
    "单元": ["unit"],
    "实验": ["lab"],
    "测验": ["quiz"],
    "小测": ["quiz"],
    "讨论": ["discussion", "section"],
    "讨论课": ["discussion", "section"],
    "习题": ["problem set", "exercise", "homework"],
    "项目": ["project"],
    "论文": ["essay", "paper"],
    "公告": ["announcement"],
    "页面": ["page"],
    "文件": ["file"],
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
    content_stamp TEXT,         -- unchanged = keep the extracted text
    quiet INTEGER NOT NULL DEFAULT 0,  -- what students asked on Ed: found after the rest that matches as well
    source TEXT NOT NULL DEFAULT 'canvas'  -- where it came from (canvas, ed)
);
CREATE VIRTUAL TABLE IF NOT EXISTS fts USING fts5(
    title, folder, body, tokenize = 'unicode61 remove_diacritics 2'
);
CREATE VIRTUAL TABLE IF NOT EXISTS fts_words USING fts5vocab(fts, 'row');  -- every word, and in how many items
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


normalized = _norm  # (letters and digits, lower-cased: how course words are compared)


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
    match: str = "name"   # name: the title or a folder matched; content: only the text inside
    doc_id: str | None = None  # pages, assignments, announcements: their id in the course
    source: str = "canvas"  # where it came from (canvas, ed)

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


def course_label(c: Course, settings: Settings) -> str:
    """What the app calls a course: the name you gave it, else its course code."""
    layout = Layout(settings)
    renamed = settings.folder_names.get(layout.canonical_course_dir(c).as_posix())
    return renamed or settings.course_names.get(c.id) or c.code


# A term in a course's code: "Spring", "SP26", "FL25", "2026".
_TERM = re.compile(r"(spring|summer|fall|autumn|winter|sp|su|sm|fa|fl|wi)\d{0,4}|(19|20)\d\d")


def code_keys(code: str) -> set[str]:
    """The parts of a course code people type: "COMPSCI 70-LEC-001" -> compsci, 70;
    "CS61B SP26" -> cs, 61b, cs61b; "DATA C8" -> data, c8, 8. Only up to the course
    number, so sections ("001"), terms ("SP26") and "LEC" don't count."""
    keys: set[str] = set()
    depts: list[str] = []
    for chunk in re.split(r"[\W_]+", code.lower()):
        if _TERM.fullmatch(chunk):  # "BC INTEGBI (Spring 26)": no course number before the term
            break
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
            # A course folder you renamed (to "线代", say) answers to that name too.
            renamed = settings.folder_names.get(Layout(settings).canonical_course_dir(c).as_posix())
            aliases = [*settings.course_aliases.get(c.id, []), *([renamed] if renamed else [])]
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


def singular(word: str) -> str:
    """A word without its plural ending ("labs": lab, "quizzes": quiz; "class" stays)."""
    if len(word) <= 3 or not word.endswith("s") or re.search(r"(ss|us|is)$", word):
        return word
    if word.endswith("zzes"):
        return word[:-3]
    if re.search(r"(ch|sh|x|ss)es$", word):
        return word[:-2]
    if word.endswith("ies"):
        return word[:-3] + "y"
    return word[:-1]


_ROMAN = {"ii": 2, "iii": 3, "iv": 4, "vi": 6, "vii": 7, "viii": 8, "ix": 9}  # ("V" alone: RISC-V)


def series_in(title: str) -> list[tuple[str, int]]:
    """The numbered things a title is: "Homework 3: RISC-V" is homework 3, "EE64_HW6_Sol.pdf"
    hw 6, "Problem Set #3" problem set 3 (and set 3). (As the app's query.ts has it.)"""
    spaced = _LETTER_DIGIT.sub(" ", re.sub(r"[\s_\-./\\()\[\]{},:;#+~]+", " ", title))
    spaced = re.sub(r"(?<=[a-z])(?=[A-Z])", " ", spaced)
    words = spaced.lower().split()
    out: list[tuple[str, int]] = []
    wordish = lambda w: bool(re.fullmatch(r"[^\W\d_]{2,}", w)) or _is_cjk(w)  # noqa: E731
    said = spaced.split()
    for i in range(1, len(words)):
        n = int(words[i]) if re.fullmatch(r"\d{1,4}", words[i]) else 1 if said[i] == "I" else _ROMAN.get(words[i])
        if n is None:
            continue
        before = words[i - 1]
        if before == "第":
            after = re.sub(r"^[次个]", "", words[i + 1]) if i + 1 < len(words) else ""
            if after and _is_cjk(after):
                out.append((after, n))
        elif wordish(before):
            out.append((before, n))
            if i > 1 and wordish(words[i - 2]) and not _is_cjk(before):
                out.append((f"{words[i - 2]} {before}", n))
    return out


def same_series(a: str, b: str, abbreviations: dict[str, list[str]]) -> bool:
    """Whether a series as typed (`a`) is one a title has (`b`): the same word, the start of it
    ("lec", "lecture"), its initials ("ps", "problem set"), one of its abbreviations either way or
    both of the same ("hw" and "homework", "mt" and "prelim"); or, for a word without any, letters
    of it in order ("ws", "worksheet"). (As the app's query.ts has it.)"""
    a, b = " ".join(map(singular, a.split(" "))), " ".join(map(singular, b.split(" ")))
    if a == b or a.replace(" ", "") == b.replace(" ", ""):  # ("prelab", "PreLab": pre lab)
        return True
    short, long = (a, b) if len(a) <= len(b) else (b, a)
    if len(short) >= 3 and long.startswith(short):
        return True
    if " " in long and " " not in short and short == "".join(w[0] for w in long.split()):
        return True
    of_a = [singular(x) for x in abbreviations.get(a, [])]
    of_b = [singular(x) for x in abbreviations.get(b, [])]
    if b in of_a or a in of_b or set(of_a) & set(of_b):
        return True
    flat = long.replace(" ", "")
    if short in abbreviations or len(short) < 2 or _is_cjk(short) or len(short) * 2 > len(flat) or flat[0] != short[0]:
        return False
    rest = iter(flat[1:])
    return all(ch in rest for ch in short[1:])


def _and_plural(term: str) -> list[str]:
    """An expansion and its plural, so "midterm" also matches "Midterms"."""
    last = term.rsplit(" ", 1)[-1]
    if not last.isalpha() or _is_cjk(last) or last.endswith("s"):
        return [term]
    return [term, term + ("es" if re.search(r"(x|ch|sh)$", last) else "s")]


def expand(token: str, abbreviations: dict[str, list[str]], series: Iterable[str] = ()) -> list[tuple[str, bool]]:
    """Alternatives for one query token, as (term, exact) pairs. What you typed may be the
    start of a word ("lec" finds "lecture"); what we expand it to must be a whole word, or
    "mt" -> "prelim" would find "Preliminary Exercises". `series`: what the courses searched
    number things in ("worksheet": "ws3" is worksheet 3 there)."""
    t = token.lower()
    alts = [(t, False), *((p, True) for a in abbreviations.get(t, []) for p in _and_plural(a))]
    if singular(t) != t:  # "lectures" finds "Lecture 3"
        alts.append((singular(t), False))
    if m := re.fullmatch(r"(\D+?)[\s_#-]*(\d+)", t):  # mt1 -> midterm 1, hw3 -> homework 3
        numbers = dict.fromkeys([m[2], str(int(m[2]))])
        if len(numbers) > 1:  # hw03 is hw3
            alts.append((f"{m[1]}{int(m[2])}", False))
        alts += [(f"{a} {n}", True) for a in abbreviations.get(m[1], []) for n in numbers]
        alts += [(f"{s} {n}", True) for s in series if s != m[1] and same_series(m[1], s, abbreviations) for n in numbers]
    # And the other way round: "midterm" also finds "MT1.pdf" (whole word only, so
    # "announcement" -> "ann" doesn't find "annual").
    alts += [(k, True) for k, v in abbreviations.items() if t in v and not _is_cjk(k)]
    seen: dict[str, bool] = {}
    for term, exact in alts:
        seen[term] = seen.get(term, True) and exact
    return list(seen.items())


# Words that say little by themselves ("can I get an extension": extension). Left out of what
# has to be found when a query has others. (As the app's query.ts has them.)
STOPWORDS = frozenset("""
a an the and or but if of to in on at by for with from about as into than then so
is are was were be been being am do does did done can could will would should shall must might get
i me my we us our you your he him his she her it its they them their
this that these those there here what which who whom whose when where why how
""".split())


def _without_stopwords(tokens: list[str]) -> list[str]:
    content = [t for t in tokens if t.lower() not in STOPWORDS]
    return content if content else tokens


def parse_words(query: str, abbreviations: dict[str, list[str]], series: Iterable[str] = ()) -> Query:
    """The words of a query the app has read (its query.ts took the courses, times and the like
    out): each to be found ("can", "the" and the like only when nothing else is), "quoted"
    ones only as they are."""
    groups = []
    words = _without_stopwords([m[2] for m in re.finditer(r'"([^"]*)"?|(\S+)', query) if m[2] and re.search(r"\w", m[2])])
    for m in re.finditer(r'"([^"]*)"?|(\S+)', query):
        if m[1] is not None:
            if m[1].strip():
                groups.append([(m[1].strip().lower(), True)])
        elif m[2] in words:
            groups.append(expand(m[2], abbreviations, series))
    return Query([], groups)


def parse(query: str, matcher: CourseMatcher, abbreviations: dict[str, list[str]], series: Iterable[str] = ()) -> Query:
    """Course tokens may come anywhere, but loose (prefix) course matching only applies to
    the first token, so "221 data" searches MATH 221 for "data" instead of also pulling
    in "Data Structures"."""
    tokens = _without_stopwords([t for t in re.split(r"\s+", query.strip()) if re.search(r"\w", t)])
    course_ids: set[int] = set()
    groups = []
    for i, tok in enumerate(tokens):
        hit = matcher.match(tok, allow_prefix=(i == 0)) if not course_ids else matcher.match(tok, False)
        is_abbr = tok.lower() in abbreviations
        if hit and not is_abbr:
            course_ids |= hit
        else:
            groups.append(expand(tok, abbreviations, series))
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
    quiet: bool = False
    source: str = "canvas"

    def stamp(self) -> str:
        return json.dumps([self.title, self.path, self.url, self.date, self.folder, self.content_stamp, self.quiet,
                           self.source])


def relative_url(url: str | None) -> str | None:
    if not url:
        return None
    parts = urlsplit(url)
    return parts.path + (f"?{parts.query}" if parts.query else "")


DOC_BODY = {"page": "body", "assignment": "description", "announcement": "message", "syllabus": "syllabus_body",
            "post": "message"}


def _replies(rs: list[dict[str, Any]]) -> Iterator[dict[str, Any]]:
    """Replies on Ed, and theirs."""
    for r in rs:
        yield r
        yield from _replies(r.get("replies") or [])


def doc_url(raw: dict[str, Any]) -> str | None:
    """Where a document is on the web: on Canvas, relative to the site; from elsewhere (Ed),
    in full."""
    return raw.get("html_url") if raw.get("source") else relative_url(raw.get("html_url"))


# The words of each index, kept until it changes: (what it was then, the words sorted, how many
# items each is in). An item changed in place leaves "what it was" as it was: sync drops them.
_WORDS: dict[str, tuple[tuple[int, int], list[str], dict[str, int]]] = {}


class Index:
    def __init__(self, db_path: Path):
        self.path = str(db_path)
        self.db = sqlite3.connect(db_path)
        self.db.row_factory = sqlite3.Row
        self.db.execute("PRAGMA journal_mode = WAL")
        self.db.executescript(SCHEMA)
        columns = {r[1] for r in self.db.execute("PRAGMA table_info(items)")}  # (from before Ed)
        if "quiet" not in columns:
            self.db.execute("ALTER TABLE items ADD COLUMN quiet INTEGER NOT NULL DEFAULT 0")
        if "source" not in columns:
            self.db.execute("ALTER TABLE items ADD COLUMN source TEXT NOT NULL DEFAULT 'canvas'")

    def close(self) -> None:
        self.db.commit()
        self.db.close()

    def _wanted(self, state: State, root: Path) -> Iterator[_Item]:
        links: dict[int, list[str]] = {}
        for row in state.db.execute("SELECT path, file_id FROM links"):
            links.setdefault(row[1], []).append(row[0])
        for r in state.all_files():
            # Files you stopped syncing are still yours to search; deleted ones aren't there.
            if (r.ignored and not (r.path and (root / r.path).is_file())) or (r.remote_deleted and not r.path):
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
        for row in state.db.execute("SELECT course_id, kind, id, title, updated_at, raw, source FROM documents"):
            raw = json.loads(row["raw"] or "{}")
            html = raw.get(DOC_BODY.get(row["kind"], ""), "") or ""
            cid, kind = row["course_id"], row["kind"]
            url = doc_url(raw)
            if kind == "syllabus":
                url = f"/courses/{cid}/assignments/syllabus"
            elif kind == "page" and not url:
                url = f"/courses/{cid}/pages/{row['id']}"
            ed = raw.get("ed") or {}
            # On Ed: what staff answered is part of it (the rest of the replies isn't), and its
            # category is where it is ("cs70 homework" finds what's in Homework).
            said = [r["html"] for r in _replies((ed.get("thread") or {}).get("replies", [])) if r["staff"] or r["endorsed"]]
            yield _Item(
                key=f"{kind}:{cid}:{row['id']}", course_id=cid, kind=kind, title=row["title"],
                path=None, url=url,
                date=raw.get("due_at") or raw.get("posted_at") or row["updated_at"] or None,
                folder=" ".join([kind, *([f"due {raw['due_at'][:10]}"] if raw.get("due_at") else []),
                                 ed.get("category", ""), ed.get("subcategory", "")]).strip(),
                content_stamp=hashlib.sha1("".join([html, *said]).encode()).hexdigest(),
                body=lambda h=html, more=said: "\n".join(html_to_text(x) for x in [h, *more]),
                quiet=kind == "post" and not (ed.get("staff") or ed.get("pinned")),
                source=row["source"],
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
                      item.stamp(), item.content_stamp, item.quiet, item.source)
            if old:
                rowid = old[0]
                self.db.execute(
                    """UPDATE items SET course_id=?, kind=?, title=?, path=?, url=?, date=?, stamp=?,
                       content_stamp=?, quiet=?, source=? WHERE id=?""", (*values, rowid))
                self.db.execute("DELETE FROM fts WHERE rowid = ?", (rowid,))
            else:
                rowid = self.db.execute(
                    """INSERT INTO items (course_id, kind, title, path, url, date, stamp, content_stamp, quiet, source, key)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""", (*values, item.key)).lastrowid
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
        if todo or gone:
            _WORDS.pop(self.path, None)
        if on_progress:
            on_progress(len(todo), len(todo), "")
        return stats

    def words(self) -> tuple[list[str], dict[str, int]]:
        """The words in the index (of letters only, 3 or more), sorted, and how many items each is in."""
        version = tuple(self.db.execute("SELECT count(*), coalesce(max(id), 0) FROM items").fetchone())
        kept = _WORDS.get(self.path)
        if kept and kept[0] == version:
            return kept[1], kept[2]
        docs = {t: n for t, n in self.db.execute("SELECT term, doc FROM fts_words") if len(t) >= 3 and t.isascii() and t.isalpha()}
        _WORDS[self.path] = (version, sorted(docs), docs)
        return _WORDS[self.path][1], docs

    def corrections(self, query: str, abbreviations: dict[str, list[str]]) -> dict[str, str]:
        """Words of a query (as parse_words reads it) that nothing in the index has or starts with,
        and for each, the word it has that's a letter or two off ("midtrem": midterm), the more
        common if there are a few. Not "quoted" ones, abbreviations, short ones, or Chinese."""
        words, docs = self.words()
        out: dict[str, str] = {}
        for m in re.finditer(r'"[^"]*"?|(\S+)', query):
            w = re.sub(r"\d+$", "", (m[1] or "").lower())  # (of one of a series, its name: "lectrue9")
            if len(w) < 4 or not (w.isascii() and w.isalpha()) or w in abbreviations or w in out:
                continue
            if any((i := bisect.bisect_left(words, x)) < len(words) and words[i].startswith(x) for x in {w, singular(w)}):
                continue  # (there, or the start of what is)
            near = process.extract(w, words, scorer=DamerauLevenshtein.distance, score_cutoff=1 if len(w) <= 5 else 2, limit=20)
            if near:
                out[w] = min(near, key=lambda n: (n[1], -docs[n[0]], n[0]))[0]
        return out

    @staticmethod
    def corrected(query: str, fixes: dict[str, str]) -> str:
        """The query with misspelled words (`fixes`, from `corrections`) taken for those meant."""
        def fix(m: re.Match[str]) -> str:
            if not m[1]:
                return m[0]
            word, number = re.fullmatch(r"(.*?)(\d*)", m[1]).groups()  # type: ignore[union-attr]
            return fixes.get(word.lower(), word) + number
        return re.sub(r'"[^"]*"?|(\S+)', fix, query)

    def series(self, course_ids: list[int] | None) -> set[str]:
        """What the courses number things in, by their titles ("Worksheet 5": worksheet)."""
        where = f"WHERE course_id IN ({','.join('?' * len(course_ids))})" if course_ids else ""
        titles = self.db.execute(f"SELECT DISTINCT title FROM items {where}", course_ids or []).fetchall()
        return {name for (title,) in titles for name, _ in series_in(title)}

    def search(self, query: str, courses: list[Course], settings: Settings, limit: int = 50,
               course_ids: list[int] | None = None, kinds: list[str] | None = None,
               names_only: bool = False, under: str | None = None, also: list[str] = (),
               literal: bool = False, since: str | None = None, until: str | None = None,
               source: str | None = None) -> list[Hit]:
        """`course_ids` restricts the search to those courses, whatever the query says;
        `kinds` to those kinds of item. With either, an empty query lists everything in them.
        `names_only` skips items where only the text inside matches. `under`: only files in
        that folder (or at the paths in `also`: files a view link in it points to). `literal`:
        the query is only words (no courses in it: see parse_words). `since`/`until`: only
        items from then (ISO times; an assignment's is when it's due). `source`: only what came
        from there (ed)."""
        abbreviations = {**DEFAULT_ABBREVIATIONS, **settings.abbreviations}
        numbered = re.search(r"[^\W\d_][\s_#-]*\d", query)
        series = self.series(course_ids) if numbered else set()
        q = (parse_words(query, abbreviations, series) if literal
             else parse(query, CourseMatcher(courses, settings), abbreviations, series))
        if course_ids:
            q.course_ids = sorted(set(course_ids) & set(q.course_ids)) if q.course_ids else list(course_ids)
            if not q.course_ids:
                return []
        codes = {c.id: course_label(c, settings) for c in courses}
        where, args = [], []
        if q.course_ids:
            where.append(f"i.course_id IN ({','.join('?' * len(q.course_ids))})")
            args += q.course_ids
        if kinds:
            where.append(f"i.kind IN ({','.join('?' * len(kinds))})")
            args += kinds
        if source:
            where.append("i.source = ?")
            args.append(source)
        if since:
            where.append("i.date >= ?")
            args.append(since)
        if until:
            where.append("i.date < ?")
            args.append(until)
        if under is not None:
            like = under.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "/%"
            others = f" OR i.path IN ({','.join('?' * len(also))})" if also else ""
            where.append(f"(i.path = ? OR i.path LIKE ? ESCAPE '\\'{others})")
            args += [under, like, *also]
        if q.groups:
            # bm25 alone can't tell "Lecture 3.pdf" from "HW3.pdf" in a "Lectures" folder when
            # nearly every file there matches "lec": title matches first, then folder matches,
            # then files that only mention it inside.
            expr = q.fts()
            names = f"{{title folder}} : ({expr})"
            # The snippet is the text inside around what matched (the title shows already; the
            # folder column is for matching, not reading).
            sql = f"""SELECT i.*, snippet(fts, 2, '{_HIT_START}', '{_HIT_END}', '…', 14) AS snip,
                             fts.rowid IN (SELECT rowid FROM fts WHERE fts MATCH ?) AS in_title,
                             fts.rowid IN (SELECT rowid FROM fts WHERE fts MATCH ?) AS in_name
                      FROM fts JOIN items i ON i.id = fts.rowid
                      WHERE fts MATCH ? {''.join(' AND ' + w for w in where)}
                      ORDER BY in_title DESC, in_name DESC, i.quiet, bm25(fts, 10.0, 3.0, 1.0)
                      LIMIT ?"""
            args = [f"title : ({expr})", names, names if names_only else expr, *args, limit]
        elif where:  # just a course and/or kinds: the most recent items
            sql = f"""SELECT i.*, NULL AS snip, 1 AS in_name FROM items i WHERE {' AND '.join(where)}
                      ORDER BY i.date IS NULL, i.date DESC LIMIT ?"""
            args.append(limit)
        else:
            return []
        return [
            Hit(kind=r["kind"], course_id=r["course_id"], course=codes.get(r["course_id"], str(r["course_id"])),
                title=r["title"], path=r["path"], url=r["url"], date=r["date"],
                snippet=_segments(r["snip"]) if r["snip"] and _HIT_START in r["snip"] else [],
                match="name" if r["in_name"] else "content",
                doc_id=r["key"].split(":", 2)[2] if r["kind"] != "file" else None, source=r["source"])
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
