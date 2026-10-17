"""Search index: text extraction, query parsing, incremental updates, the local API."""

from __future__ import annotations

import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from canvas_sync import Engine
from canvas_sync.config import Account
from canvas_sync.server import create_app
from canvas_sync.search import code_keys
from fake_canvas import BASE, COURSE, FakeCanvas, make_pdf, pull, set_config


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
    with Engine(root) as e:
        assert [h.title for h in e.search("eigen", course_ids=[1])] == ["Lecture 3.pdf"]
        assert e.search("eigen", course_ids=[2]) == []
        assert len(e.search("", course_ids=[1])) == 8
    set_config(root, "[course_aliases]\n", "[course_aliases]\n1 = [\"线代\"]\n")
    assert search(root, "线代 eigen") == ["Lecture 3.pdf"]


def test_series_by_what_the_course_calls_it(root, course):
    """"ws5" is Worksheet 5 where there are worksheets, though no abbreviation says so; and the
    numbers match as numbers ("hw03" is HW3)."""
    course.put(208, "Worksheet 5.pdf", b"x")
    course.put(209, "notes on sheets.pdf", make_pdf("Do worksheet 5 before section"))
    pull(root, course)
    reindex(root)
    assert set(search(root, "ws5")) == {"Worksheet 5.pdf", "notes on sheets.pdf"}
    assert search(root, "ws6") == []
    assert search(root, "hw03") == ["HW3.pdf"]
    assert "Lecture 3.pdf" in search(root, "lectures")  # (plurals)


def test_api_find_takes_words_and_what_narrows_them(client):
    """/find is the app's search as you type: it has read the query (courses, times) itself."""
    def find(**params):
        return [h["title"] for h in client.get("/api/find", params=params).json()["hits"]]

    assert set(find(q="hw")) == {"HW3.pdf", "Problem Set 4"}
    assert find(q="hw", since="2026-10-20T00:00:00Z", until="2026-10-21T00:00:00Z") == ["Problem Set 4"]  # (due then)
    assert find(q="hw", since="2026-10-21T00:00:00Z") == []
    assert find(q='"problem set"') == ["Problem Set 4"]
    assert find(q='"set 4 late"') == []  # (as it is, not word by word)
    # A word, found where it's written (the files' folder), not the course: the app read courses
    # out of what was typed already.
    assert "Problem Set 4" not in find(q="221") and "Lecture 3.pdf" in find(q="221")
    assert find(q="eigen", course=[1]) == ["Lecture 3.pdf"] and find(q="eigen", course=[2]) == []
    assert find(q="公告") == ["考试安排"]  # (a kind of thing, as the index has it)
    assert find(q="late", kind=["assignment"]) == ["Problem Set 4"] and find(q="late", kind=["page"]) == []


def test_a_courses_number_is_before_its_term():
    assert code_keys("CS61B SP26") == {"cs", "61b", "cs61b"}
    assert code_keys("DATA 100/200 (Spring 2026)") == {"data", "100", "data100"}
    assert code_keys("BC INTEGBI (Spring 26)") == set()  # (26 is the term's, not a course number)
    assert code_keys("Freshman/Transfer Edge 2025") == set()


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
    monkeypatch.setattr("canvas_sync.server.open_path", lambda p, **kw: None)
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


def test_expansions_match_whole_words_only(root, course):
    # "mt" expands to "prelim" (Cornell's word for a midterm); that must not find
    # "Preliminary Exercises", though typing "prelim" yourself still finds it.
    course.put(205, "PreLab1.pdf", make_pdf("Preliminary Exercises"))
    course.put(206, "Midterms Overview.pdf", b"x")
    pull(root, course)
    reindex(root)
    found = search(root, "mt")
    assert "PreLab1.pdf" not in found
    assert "Midterms Overview.pdf" in found  # plurals still count
    assert "PreLab1.pdf" in search(root, "prelim")


def test_names_first_then_content_and_names_only(root, course):
    course.put(207, "Week 5 slides.pdf", make_pdf("Midterm next Thursday"))
    pull(root, course)
    reindex(root)
    with Engine(root) as e:
        hits = e.search("midterm")
        assert [h.match for h in hits] == sorted((h.match for h in hits), key=["name", "content"].index)
        assert ("Week 5 slides.pdf", "content") in [(h.title, h.match) for h in hits]
        assert ("Midterm 1 Solutions.pdf", "name") in [(h.title, h.match) for h in hits]
        names = [h.title for h in e.search("midterm", names_only=True)]
        assert "Midterm 1 Solutions.pdf" in names and "Week 5 slides.pdf" not in names


def test_search_within_a_folder(root, fake):
    """The search box on a course's 文件 tab keeps to the folder you're in, counting files that
    are there as view links (stored in another view)."""
    fake.put(101, "lec2.pdf", b"w2")
    fake.module(2, "Week 2", [{"type": "File", "content_id": 101}])
    pull(root, fake)
    with Engine(root) as e:
        e.reindex()
        assert [h.title for h in e.search("lec", under=f"{COURSE}/Modules/01 Week 1")] == ["lec1.pdf"]
        # Files/Lectures holds both as links to the copies in Modules.
        assert sorted(h.title for h in e.search("lec", under=f"{COURSE}/Files/Lectures")) == ["lec1.pdf", "lec2.pdf"]
        assert e.search("lec", under=f"{COURSE}/Files/Lec") == []  # a folder, not a prefix of a name
        assert sorted(h.title for h in e.search("lec", under=COURSE)) == ["lec1.pdf", "lec2.pdf"]
