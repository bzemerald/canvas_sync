"""Search by meaning (meaning.py), with a stand-in for the model: words of the same sense, one
direction each (so tests don't download anything)."""

from __future__ import annotations

import re
from pathlib import Path

import numpy as np
import pytest
from fastapi.testclient import TestClient

from canvas_sync import Engine, meaning
from canvas_sync.config import Account, AppPrefs
from canvas_sync.meaning import Meaning, cut
from canvas_sync.server import create_app
from fake_canvas import BASE, FakeCanvas, make_pdf, pull

SENSES = {"extension": 0, "extensions": 0, "flextensions": 0, "deadline": 0, "late": 0,
          "resistor": 1, "ohm": 1, "ohms": 1, "voltage": 1, "neuron": 2, "synapse": 2}


def embed(texts):
    out = np.zeros((len(texts), 3), dtype=np.float32)
    for i, t in enumerate(texts):
        for w in re.findall(r"[a-z]+", t.lower()):
            if w in SENSES:
                out[i, SENSES[w]] += 1
    return out / np.maximum(np.linalg.norm(out, axis=1, keepdims=True), 1e-9)


@pytest.fixture
def course(fake: FakeCanvas) -> FakeCanvas:
    fake.put(300, "Circuits.pdf", make_pdf("A resistor obeys Ohm's law: voltage is current times resistance."))
    fake.put(301, "Neurons.pdf", make_pdf("A neuron passes signals across a synapse."))
    fake.announcements.append({"id": 8, "title": "Flextensions", "posted_at": "2026-10-01T00:00:00Z",
                               "message": "<p>Use Flextensions to ask for more time on homework.</p>",
                               "html_url": f"{BASE}/courses/1/discussion_topics/8"})
    return fake


def index(root: Path) -> Engine:
    e = Engine(root)
    e.reindex()
    return e


def test_text_is_cut_into_passages_with_its_title():
    text = " ".join(f"Sentence number {i} is here." for i in range(60))
    parts = cut("Notes", text)
    assert len(parts) > 3 and all(p.startswith("Notes: ") for p in parts)
    assert all(len(p) <= len("Notes: ") + 2 * meaning.SIZE for p in parts)
    assert cut("Empty", "  ") == []
    assert len(cut("Table", "x" * 5000)) == 7  # (no sentence ends: cut anyway)


def test_passages_are_made_once_and_again_for_what_changes(root, course):
    pull(root, course)
    with index(root) as e:
        m = Meaning(e.index)
        assert m.sync(embed) == m.counts()[0] and m.counts()[0] == m.counts()[1]
        assert m.sync(embed) == 0  # (nothing changed)
    (root / "Fall 2026/MATH 221/Files/Lectures/Neurons.pdf").write_bytes(make_pdf("Synapse and neuron, again."))
    with index(root) as e:
        assert Meaning(e.index).sync(embed) == 1


def test_found_by_meaning_what_its_words_dont_find(root, course):
    pull(root, course)
    with index(root) as e:
        m = Meaning(e.index)
        m.sync(embed)
        assert e.index.search("extension", e.state.courses(), e.settings, literal=True) == []  # (by its words)
        [hit] = m.search("can I get an extension", embed, {1: "MATH 221"})
        assert (hit.title, hit.kind, hit.match) == ("Flextensions", "announcement", "meaning")
        assert "ask for more time" in hit.snippet[0][0]
        assert [h.title for h in m.search("ohms", embed, {})] == ["Circuits.pdf"]
        assert m.search("ohms", embed, {}, kinds=["announcement"]) == []  # (narrowed as the index is)
        assert m.search("ohms", embed, {}, course_ids=[2]) == []
        assert m.search("nothing like it", embed, {}) == []


def test_api_find_has_what_meaning_finds_when_its_on(root, course, monkeypatch):
    pull(root, course)
    with index(root) as e:
        Meaning(e.index).sync(embed)
    monkeypatch.setattr(meaning, "downloaded", lambda home: True)
    monkeypatch.setattr(meaning, "embedder", lambda home: embed)
    client = TestClient(create_app(Account(BASE, root), "s"), headers={"Authorization": "Bearer s"})

    def find(q):
        return [(h["title"], h["match"]) for h in client.get("/api/find", params={"q": q}).json()["hits"]]

    assert find("an extension") == []  # (off)
    AppPrefs(meaning=True).save()
    try:
        assert find("an extension") == [("Flextensions", "meaning")]
        assert find("extension") == []  # (one word: by its words only)
        state = client.get("/api/meaning").json()
        assert state["on"] and state["model"] and state["items"] == state["covered"]
    finally:
        AppPrefs().save()


def test_turning_it_on_answers_with_what_its_doing(root, course, monkeypatch):
    """The app polls only while something's being done: the answer to turning it on says so."""
    monkeypatch.setattr(meaning, "download", lambda home, on_progress=None: None)
    client = TestClient(create_app(Account(BASE, root), "s"), headers={"Authorization": "Bearer s"})
    try:
        assert client.post("/api/meaning", json={"on": True}).json()["phase"] == "downloading"
    finally:
        AppPrefs().save()
