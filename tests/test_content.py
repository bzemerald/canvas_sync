"""The course page: overview, announcements / assignments / pages, and images in them."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import httpx
import pytest
from fastapi.testclient import TestClient

from canvas_sync import CanvasClient, Engine, content
from canvas_sync.config import Account
from canvas_sync.server import create_app
from fake_canvas import BASE, COURSE, FakeCanvas, pull

NOW = datetime(2026, 10, 15, 12, tzinfo=timezone.utc)
PNG = b"\x89PNG\r\n\x1a\n fake"


def iso(dt: datetime) -> str:
    return dt.strftime("%Y-%m-%dT%H:%M:%SZ")


@pytest.fixture
def course(fake: FakeCanvas) -> FakeCanvas:
    fake.put(101, "hw6.pdf", b"hw", folder=10)
    fake.files[101]["created_at"] = "2026-10-10T00:00:00Z"
    fake.files[100]["created_at"] = "2026-08-30T00:00:00Z"
    for n, (name, due) in enumerate([
        ("HW 6", NOW + timedelta(days=2)), ("HW 5", NOW - timedelta(days=5)),
        ("Project", NOW + timedelta(days=40)), ("Reading", None),
    ]):
        fake.assignments.append({
            "id": 10 + n, "name": name, "due_at": iso(due) if due else None, "points_possible": 10,
            "description": '<p>See <a href="/courses/1/files/101/download">hw6.pdf</a></p>' if n == 0 else "",
            "html_url": f"{BASE}/courses/1/assignments/{10 + n}", "submission_types": ["online_upload"],
        })
    fake.announcements += [
        {"id": 7, "title": "Midterm room", "posted_at": "2026-10-12T00:00:00Z", "message": "<p>Room 101</p>",
         "author": {"display_name": "Prof"}, "read_state": "unread",
         "attachments": [{"id": 101, "display_name": "hw6.pdf"}]},
        {"id": 8, "title": "Welcome", "posted_at": "2026-08-25T00:00:00Z", "message": "<p>Hi</p>", "read_state": "read"},
    ]
    fake.pages["intro"] = {"url": "intro", "title": "Intro", "body": "<p>x</p>", "front_page": True}
    fake.pages["zz"] = {"url": "zz", "title": "Another", "body": "<p>y</p>"}
    fake.course["syllabus_body"] = "<p>Grading: 50% exams</p>"
    return fake


def test_overview(root, course):
    pull(root, course)
    with Engine(root) as e:
        o = content.overview(e.state, e.root, 1, NOW)
    assert [a["title"] for a in o["upcoming"]] == ["HW 6"]  # not past, not 40 days out, not undated
    assert [a["title"] for a in o["announcements"]] == ["Midterm room", "Welcome"]
    assert o["announcements"][0]["unread"] and o["announcements"][0]["author"] == "Prof"
    assert [f["name"] for f in o["new_files"]] == ["hw6.pdf", "lec1.pdf"]  # newest upload first
    assert o["counts"] == {"announcements": 2, "assignments": 4, "pages": 2, "files": 2, "syllabus": True}


def test_items_and_one_item(root, course):
    pull(root, course)
    with Engine(root) as e:
        assert [a["title"] for a in content.items(e.state, 1, "assignment")] == ["HW 6", "Project", "HW 5", "Reading"]
        assert [p["title"] for p in content.items(e.state, 1, "page")] == ["Intro", "Another"]  # front page first
        hw = content.item(e.state, e.root, 1, "assignment", "10")
        assert hw["files"] == {"101": {"path": f"{COURSE}/Files/hw6.pdf", "name": "hw6.pdf"}}
        ann = content.item(e.state, e.root, 1, "announcement", "7")
        assert ann["attachments"] == [{"id": 101, "name": "hw6.pdf", "path": f"{COURSE}/Files/hw6.pdf"}]
        assert content.item(e.state, e.root, 1, "syllabus", "1")["html"] == "<p>Grading: 50% exams</p>"
        assert content.item(e.state, e.root, 1, "page", "nope") is None


def test_search_hits_say_which_item(root, course):
    pull(root, course)
    with Engine(root) as e:
        e.reindex()
        [hit] = e.search("midterm room")
    assert (hit.kind, hit.doc_id, hit.course_id) == ("announcement", "7", 1)


@pytest.fixture
def api(root, course, monkeypatch):
    pull(root, course)
    course.media["/equation_images/x2"] = (PNG, "image/png")
    course.media["/courses/1/pages/intro"] = (b"<html>", "text/html")
    monkeypatch.setattr(
        "canvas_sync.server.CanvasClient",
        lambda url, token: CanvasClient(url, token, transport=httpx.MockTransport(course.handle)),
    )
    monkeypatch.setattr(Account, "token", lambda self: "secret-token")
    with TestClient(create_app(Account(BASE, root), "s"), headers={"Authorization": "Bearer s"}) as c:
        yield c


def test_api_course_page(api):
    assert api.get("/api/courses/1/overview").json()["counts"]["pages"] == 2
    assert [a["id"] for a in api.get("/api/courses/1/items", params={"kind": "announcement"}).json()] == ["7", "8"]
    assert api.get("/api/courses/1/items", params={"kind": "file"}).status_code == 400
    assert api.get("/api/courses/1/items/page/intro").json()["title"] == "Intro"
    assert api.get("/api/courses/1/items/page/nope").status_code == 404


def test_media(api, course, monkeypatch, root):
    # A Canvas file we have: straight from disk, no network.
    course.seen_auth.clear()
    r = api.get("/api/media", params={"url": "/courses/1/files/101/preview"})
    assert r.content == b"hw" and course.seen_auth == []
    # Something else on Canvas: fetched with the token, then cached.
    r = api.get("/api/media", params={"url": f"{BASE}/equation_images/x2"})
    assert r.content == PNG and r.headers["content-type"] == "image/png"
    assert course.seen_auth == ["Bearer secret-token"]
    assert api.get("/api/media", params={"url": "/equation_images/x2"}).content == PNG
    assert len(course.seen_auth) == 1  # (cached)
    # Not an image: refused.
    assert api.get("/api/media", params={"url": "/courses/1/pages/intro"}).status_code == 415
    # Another site: fetched without the Canvas token.
    sent: list[httpx.Request] = []

    def elsewhere(req: httpx.Request) -> httpx.Response:
        sent.append(req)
        return httpx.Response(200, content=PNG, headers={"content-type": "image/png"})

    real = httpx.AsyncClient
    monkeypatch.setattr("canvas_sync.server.httpx.AsyncClient", lambda **kw: real(transport=httpx.MockTransport(elsewhere), **kw))
    assert api.get("/api/media", params={"url": "https://imgur.test/a.png"}).content == PNG
    assert "authorization" not in sent[0].headers
    assert api.get("/api/media", params={"url": "file:///etc/passwd"}).status_code == 400


def test_open_external_links_only(api, monkeypatch):
    opened = []
    monkeypatch.setattr("canvas_sync.server.webbrowser.open", opened.append)
    assert api.post("/api/open", json={"external": "https://example.com/x"}).status_code == 200
    assert api.post("/api/open", json={"external": "javascript:alert(1)"}).status_code == 400
    assert opened == ["https://example.com/x"]
