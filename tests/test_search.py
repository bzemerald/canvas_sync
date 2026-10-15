"""Search index: text extraction, query parsing, incremental updates, the local API."""

from __future__ import annotations

import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from canvas_sync import Engine
from canvas_sync.config import Account
from canvas_sync.server import create_app
from fake_canvas import BASE, COURSE, FakeCanvas, pull, set_config


def make_pdf(text: str) -> bytes:
    stream = f"BT /F1 12 Tf 72 720 Td ({text}) Tj ET".encode()
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R"
        b" /Resources << /Font << /F1 5 0 R >> >> >>",
        b"<< /Length %d >>\nstream\n%s\nendstream" % (len(stream), stream),
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ]
    out, offsets = bytearray(b"%PDF-1.4\n"), []
    for n, body in enumerate(objects, 1):
        offsets.append(len(out))
        out += b"%d 0 obj\n%s\nendobj\n" % (n, body)
    xref = len(out)
    out += b"xref\n0 %d\n0000000000 65535 f \n" % (len(objects) + 1)
    out += b"".join(b"%010d 00000 n \n" % o for o in offsets)
    out += b"trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (len(objects) + 1, xref)
    return bytes(out)


@pytest.fixture
def course(fake: FakeCanvas) -> FakeCanvas:
    fake.put(200, "MT1 Practice.pdf", b"x")
    fake.put(201, "Midterm 1 Solutions.pdf", b"x")
    fake.put(202, "Lecture 3.pdf", make_pdf("Eigenvalue decomposition of symmetric matrices"))
    fake.put(203, "HW3.pdf", b"x")
    fake.put(204, "notes.txt", "Mid-semester feedback form".encode())
    fake.announcements.append({
        "id": 7, "title": "考试安排", "posted_at": "2026-10-01T00:00:00Z",
        "message": "<p>期中考试在下周三, room 101.</p>",
        "html_url": f"{BASE}/courses/1/discussion_topics/7",
    })
    fake.assignments.append({
        "id": 9, "name": "Problem Set 4", "due_at": "2026-10-20T23:59:00Z",
        "description": "<p>Late work loses 10% per day.</p>",
        "html_url": f"{BASE}/courses/1/assignments/9",
    })
    return fake


def reindex(root: Path):
    with Engine(root) as e:
        return e.reindex()


def search(root: Path, q: str) -> list[str]:
    with Engine(root) as e:
        return [h.title for h in e.search(q)]


def test_abbreviations_and_numbers(root, course):
    pull(root, course)
    reindex(root)
    assert set(search(root, "221 mt")) == {"MT1 Practice.pdf", "Midterm 1 Solutions.pdf"}
    assert set(search(root, "mt1")) == {"MT1 Practice.pdf", "Midterm 1 Solutions.pdf"}
    assert "MT1 Practice.pdf" in search(root, "midterm")  # and the other way round
    assert set(search(root, "hw")) == {"HW3.pdf", "Problem Set 4"}
    assert search(root, "hw3") == ["HW3.pdf"]
    assert search(root, "ps") == ["Problem Set 4"]  # but not "psychology"-style prefixes
    assert search(root, "lec 3") == ["Lecture 3.pdf", "HW3.pdf"]  # HW3 is in the Lectures folder


def test_file_and_page_text_is_searched_with_snippets(root, course):
    pull(root, course)
    reindex(root)
    with Engine(root) as e:
        [hit] = e.search("221 eigen")
    assert hit.title == "Lecture 3.pdf" and hit.path == f"{COURSE}/Files/Lectures/Lecture 3.pdf"
    assert ("Eigenvalue", True) in hit.snippet
    assert search(root, "late work") == ["Problem Set 4"]
    assert search(root, "feedback") == ["notes.txt"]


def test_chinese(root, course):
    pull(root, course)
    reindex(root)
    assert search(root, "安排") == ["考试安排"]       # title
    assert search(root, "下周三") == ["考试安排"]     # inside a longer run of CJK text
    assert "Midterm 1 Solutions.pdf" in search(root, "期中")  # through the abbreviation


def test_course_filter_and_aliases(root, course):
    pull(root, course)
    reindex(root)
    assert len(search(root, "221")) == 8  # just a course: everything in it, newest first
    assert search(root, "math eigen") == ["Lecture 3.pdf"]
    assert search(root, "lin eigen") == ["Lecture 3.pdf"]  # prefix of the course name
    assert search(root, "cs61a eigen") == []                # not a course: must match text
    set_config(root, "[course_aliases]\n", "[course_aliases]\n1 = [\"线代\"]\n")
    assert search(root, "线代 eigen") == ["Lecture 3.pdf"]


def test_custom_abbreviation(root, course):
    pull(root, course)
    reindex(root)
    set_config(root, "# exam = [", 'fb = ["feedback"]\n# exam = [')
    assert search(root, "fb") == ["notes.txt"]


def test_reindex_is_incremental(root, course):
    pull(root, course)
    first = reindex(root)
    assert first.indexed == first.total == 8 and first.extracted == 6
    again = reindex(root)
    assert (again.indexed, again.extracted, again.removed) == (0, 0, 0)

    (root / COURSE / "Files/Lectures/notes.txt").write_text("my own annotations")
    edited = reindex(root)
    assert (edited.indexed, edited.extracted) == (1, 1)
    assert search(root, "annotations") == ["notes.txt"]

    (root / COURSE / "Files/Lectures/HW3.pdf").unlink()
    pull(root, course)  # recorded as deleted by you
    assert reindex(root).removed == 1
    assert search(root, "hw3") == []


@pytest.fixture
def client(root, course, monkeypatch):
    pull(root, course)
    reindex(root)
    monkeypatch.setattr("canvas_sync.server.open_path", lambda p, reveal=False: None)
    app = create_app(Account(BASE, root), "secret")
    return TestClient(app, headers={"Authorization": "Bearer secret"})


def test_api(client, root):
    assert client.get("/api/health").json()["ok"]
    assert TestClient(client.app).get("/api/health").status_code == 401
    [c] = client.get("/api/courses").json()
    assert c["code"] == "MATH 221" and c["dir"] == COURSE
    hits = client.get("/api/search", params={"q": "221 eigen"}).json()
    assert hits[0]["title"] == "Lecture 3.pdf"
    assert {"text": "Eigenvalue", "match": True} in hits[0]["snippet"]
    assert client.post("/api/open", json={"path": hits[0]["path"]}).status_code == 200
    assert client.post("/api/open", json={"path": "../../etc/passwd"}).status_code == 400
    assert client.post("/api/open", json={"url": "https://evil.test"}).status_code == 400


def test_api_sync_job(root, course, monkeypatch):
    import httpx

    from canvas_sync import CanvasClient

    monkeypatch.setattr(
        "canvas_sync.server.CanvasClient",
        lambda url, token: CanvasClient(url, token, transport=httpx.MockTransport(course.handle)),
    )
    monkeypatch.setattr(Account, "token", lambda self: "t")
    with TestClient(create_app(Account(BASE, root), "s"), headers={"Authorization": "Bearer s"}) as c:
        assert c.post("/api/sync").status_code == 202
        state = c.get("/api/sync").json()
        for _ in range(100):
            if not state["running"]:
                break
            time.sleep(0.02)
            state = c.get("/api/sync").json()
        assert state["phase"] == "done" and state["errors"] == []
        assert state["changes"]["download"] == 6
        assert c.get("/api/search", params={"q": "eigen"}).json()[0]["title"] == "Lecture 3.pdf"
