"""Search by what the text means, not only its words: "can I get an extension" finds the
announcement about Flextensions; "Ohm's law", the problem that uses it. A small English model
(model2vec's potion-retrieval-32M: a static embedding, ~125 MB) turns passages of the index's text,
and a query, into vectors; a query finds the passages nearest to it. English only: what's typed in
Chinese is found by its words.

Off unless turned on in 设置 (AppPrefs.meaning). Then the model is downloaded to the app's folder
(`models/`), and every item's text is cut into passages, kept with their vectors in index.db
(`passages`), made again for an item only when it changes (`meant`: what they were made from).
"""

from __future__ import annotations

import re
import threading
from collections.abc import Callable, Sequence
from pathlib import Path
from typing import TYPE_CHECKING, Any, Protocol

import numpy as np

if TYPE_CHECKING:
    from .search import Hit, Index

MODEL = "minishlab/potion-retrieval-32M"
REVISION = "6fc8051fab2a1e0ee76689cf08c853792ac285e7"  # (the one tried; another is a change to try)
FILES = ("config.json", "modules.json", "tokenizer.json", "model.safetensors")
NEAR = 0.5   # how near (cosine) a passage has to be to a query to count
SIZE = 400   # characters to a passage, about (cut at sentence ends)
MOST = 150   # passages of one item at most (a long PDF: its start)

SCHEMA = """
CREATE TABLE IF NOT EXISTS passages (
    item INTEGER NOT NULL,   -- items.id
    n INTEGER NOT NULL,      -- which of its passages
    text TEXT NOT NULL,      -- "title: passage"
    vec BLOB NOT NULL,       -- float16, of length 1
    PRIMARY KEY (item, n)
);
CREATE TABLE IF NOT EXISTS meant (item INTEGER PRIMARY KEY, stamp TEXT NOT NULL);  -- items.stamp passages are of
"""


class Embed(Protocol):
    def __call__(self, texts: Sequence[str]) -> np.ndarray: ...  # a row of length 1 for each


ProgressHandler = Callable[[int, int], None]  # (done, total)


# -- the model ----------------------------------------------------------------------------------


def model_dir(home: Path) -> Path:
    return home / "models" / MODEL.split("/")[1]


def downloaded(home: Path) -> bool:
    return all((model_dir(home) / f).is_file() for f in FILES)


def download(home: Path, on_progress: ProgressHandler | None = None) -> None:
    """The model's files, from Hugging Face (bytes done, of all), each written whole or not at all."""
    import httpx

    folder = model_dir(home)
    folder.mkdir(parents=True, exist_ok=True)
    urls = {f: f"https://huggingface.co/{MODEL}/resolve/{REVISION}/{f}" for f in FILES}
    with httpx.Client(follow_redirects=True, timeout=httpx.Timeout(30, read=120)) as client:
        sizes = {f: int(client.head(u).raise_for_status().headers.get("content-length", 0)) for f, u in urls.items()}
        total, done = sum(sizes.values()), 0
        for f, url in urls.items():
            target = folder / f
            if target.is_file():
                done += sizes[f]
                continue
            part = target.with_name(target.name + ".part")
            with client.stream("GET", url) as r, part.open("wb") as out:
                r.raise_for_status()
                for chunk in r.iter_bytes(1 << 20):
                    out.write(chunk)
                    done += len(chunk)
                    if on_progress:
                        on_progress(done, total)
            part.replace(target)


_MODELS: dict[Path, Any] = {}
_LOCK = threading.Lock()


def embedder(home: Path) -> Embed:
    """The model, loaded once (a second or so; ~70 MB in memory, as float16)."""
    folder = model_dir(home)
    with _LOCK:
        model = _MODELS.get(folder)
        if model is None:
            from model2vec import StaticModel

            model = _MODELS[folder] = StaticModel.from_pretrained(folder, quantize_to="float16")

    def embed(texts: Sequence[str]) -> np.ndarray:
        v = np.asarray(model.encode(list(texts), use_multiprocessing=False, batch_size=512), dtype=np.float32)
        return v / np.maximum(np.linalg.norm(v, axis=1, keepdims=True), 1e-9)

    return embed


def forget(home: Path) -> None:
    """The model out of memory (turned off)."""
    with _LOCK:
        _MODELS.pop(model_dir(home), None)


# -- passages -----------------------------------------------------------------------------------


def cut(title: str, body: str) -> list[str]:
    """An item's text in passages of about SIZE characters, at sentence ends, each with its title."""
    text = re.sub(r"\s+", " ", body.replace("\u200b", "")).strip()  # (the index's word breaks out)
    out: list[str] = []
    passage = ""
    for sentence in re.split(r"(?<=[.!?。！？])\s+", text) if text else []:
        if passage and len(passage) + len(sentence) > SIZE:
            out.append(passage)
            passage = ""
        passage = f"{passage} {sentence}" if passage else sentence
        while len(passage) > 2 * SIZE:  # (no sentence ends: a table, a list)
            out.append(passage[: 2 * SIZE])
            passage = passage[2 * SIZE:]
    if passage:
        out.append(passage)
    return [f"{title}: {p}" for p in out[:MOST]]


# Each index's vectors, kept until its passages change: (what they were then, passages' rowids,
# their items, the vectors). Passages made again can leave "what they were" as it was: sync drops them.
_VECTORS: dict[str, tuple[tuple[int, int], np.ndarray, np.ndarray, np.ndarray]] = {}


class Meaning:
    """The passages of an index (search.Index), and what's found by them."""

    def __init__(self, index: Index):
        self.index = index
        self.db = index.db
        self.db.executescript(SCHEMA)

    def counts(self) -> tuple[int, int]:
        """Items there are, and how many have their passages."""
        items = self.db.execute("SELECT count(*) FROM items").fetchone()[0]
        meant = self.db.execute("SELECT count(*) FROM meant m JOIN items i ON i.id = m.item AND i.stamp = m.stamp").fetchone()[0]
        return items, meant

    def sync(self, embed: Embed, on_progress: ProgressHandler | None = None) -> int:
        """Passages for what's new or changed in the index; what's gone, gone. How many items it did."""
        todo = self.db.execute(
            """SELECT i.id, i.title, i.stamp, f.body FROM items i JOIN fts f ON f.rowid = i.id
               LEFT JOIN meant m ON m.item = i.id WHERE m.stamp IS NULL OR m.stamp != i.stamp"""
        ).fetchall()
        batch: list[tuple[int, str, list[str]]] = []

        def write() -> None:
            texts = [t for _, _, ts in batch for t in ts]
            vectors = iter(embed(texts).astype(np.float16)) if texts else iter(())
            for item, stamp, ts in batch:
                self.db.execute("DELETE FROM passages WHERE item = ?", (item,))
                self.db.executemany("INSERT INTO passages (item, n, text, vec) VALUES (?, ?, ?, ?)",
                                    [(item, n, t, next(vectors).tobytes()) for n, t in enumerate(ts)])
                self.db.execute("INSERT OR REPLACE INTO meant (item, stamp) VALUES (?, ?)", (item, stamp))
            self.db.commit()  # (an interrupted run keeps what it did)
            _VECTORS.pop(self.index.path, None)
            batch.clear()

        for done, (item, title, stamp, body) in enumerate(todo, 1):
            batch.append((item, stamp, cut(title, body or "")))
            if sum(len(ts) for _, _, ts in batch) >= 512 or done == len(todo):
                write()
                if on_progress:
                    on_progress(done, len(todo))
        self.db.execute("DELETE FROM passages WHERE item NOT IN (SELECT id FROM items)")
        self.db.execute("DELETE FROM meant WHERE item NOT IN (SELECT id FROM items)")
        self.db.commit()
        _VECTORS.pop(self.index.path, None)
        return len(todo)

    def _vectors(self) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        version = tuple(self.db.execute("SELECT count(*), coalesce(max(rowid), 0) FROM passages").fetchone())
        kept = _VECTORS.get(self.index.path)
        if kept and kept[0] == version:
            return kept[1], kept[2], kept[3]
        rows = self.db.execute("SELECT rowid, item, vec FROM passages").fetchall()
        rowids = np.array([r[0] for r in rows], dtype=np.int64)
        items = np.array([r[1] for r in rows], dtype=np.int64)
        vecs = (np.frombuffer(b"".join(r[2] for r in rows), dtype=np.float16).reshape(len(rows), -1).astype(np.float32)
                if rows else np.zeros((0, 1), dtype=np.float32))
        _VECTORS[self.index.path] = (version, rowids, items, vecs)
        return rowids, items, vecs

    def search(self, query: str, embed: Embed, codes: dict[int, str], course_ids: list[int] | None = None,
               kinds: list[str] | None = None, since: str | None = None, until: str | None = None,
               limit: int = 20, source: str | None = None) -> list[Hit]:
        """What has passages nearest to `query` (at least NEAR), nearest first; the passage is the
        snippet. Narrowed as Index.search is (courses, kinds, dates, source)."""
        from .search import Hit

        rowids, items, vecs = self._vectors()
        if not len(items):
            return []
        where, args = [], []
        if course_ids:
            where.append(f"course_id IN ({','.join('?' * len(course_ids))})")
            args += course_ids
        if kinds:
            where.append(f"kind IN ({','.join('?' * len(kinds))})")
            args += kinds
        if source:
            where.append("source = ?")
            args.append(source)
        if since:
            where.append("date >= ?")
            args.append(since)
        if until:
            where.append("date < ?")
            args.append(until)
        allowed = {r[0] for r in self.db.execute(f"SELECT id FROM items WHERE {' AND '.join(where)}", args)} if where else None
        scores = vecs @ embed([query])[0]
        best: dict[int, tuple[float, int]] = {}  # item -> (how near, passage's rowid)
        for i in np.argsort(-scores)[: limit * 30]:
            if scores[i] < NEAR or len(best) >= limit:
                break
            item = int(items[i])
            if item not in best and (allowed is None or item in allowed):
                best[item] = (float(scores[i]), int(rowids[i]))
        hits = []
        for item, (_, rowid) in best.items():
            r = self.db.execute("SELECT * FROM items WHERE id = ?", (item,)).fetchone()
            text = self.db.execute("SELECT text FROM passages WHERE rowid = ?", (rowid,)).fetchone()
            if r is None or text is None:
                continue
            passage = text[0][len(r["title"]) + 2:] if text[0].startswith(r["title"] + ": ") else text[0]
            hits.append(Hit(kind=r["kind"], course_id=r["course_id"], course=codes.get(r["course_id"], str(r["course_id"])),
                            title=r["title"], path=r["path"], url=r["url"], date=r["date"],
                            snippet=[(passage[:240] + ("…" if len(passage) > 240 else ""), False)], match="meaning",
                            doc_id=r["key"].split(":", 2)[2] if r["kind"] != "file" else None, source=r["source"]))
        return hits
