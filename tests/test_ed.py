"""Ed: connecting it, which Canvas course each Ed course is, and syncing what's on it."""

from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone
from pathlib import Path

import httpx
import pytest
from fastapi.testclient import TestClient

from canvas_sync import Engine, content, ed, server
from canvas_sync.catalog import catalog
from canvas_sync.places import Place
from canvas_sync.things import Thing
from canvas_sync.config import Account, Settings, set_ed_courses
from canvas_sync.models import Course
from fake_canvas import BASE, FakeCanvas, pull, wait_for_sync
from fake_ed import TOKEN, FakeEd


@pytest.fixture
def fake_ed() -> FakeEd:
    f = FakeEd(region="au")
    f.course(501, "MATH 221", "Linear Algebra")
    f.course(502, "Cubstart", "Web DeCal", session="Spring")
    return f


@pytest.fixture
def web(fake: FakeCanvas, fake_ed: FakeEd, monkeypatch, tmp_path) -> dict[str, str]:
    """Canvas and Ed (fakes, told apart by host), and the Keychain and account file kept to the
    test. Returns the Keychain."""
    real = httpx.AsyncClient

    def handle(req: httpx.Request) -> httpx.Response:
        return fake_ed.handle(req) if req.url.host.endswith("edstem.org") else fake.handle(req)

    monkeypatch.setattr(httpx, "AsyncClient", lambda **kw: real(**{**kw, "transport": httpx.MockTransport(handle)}))
    saved: dict[str, str] = {BASE: "t"}
    monkeypatch.setattr("canvas_sync.config.ACCOUNT_FILE", tmp_path / "home" / "config.toml")
    monkeypatch.setattr(Account, "token", lambda self: saved.get(self.base_url))
    monkeypatch.setattr(Account, "ed_token", lambda self: saved.get(f"edstem:{self.ed_region}"))
    monkeypatch.setattr(Account, "set_ed_token", lambda self, region, t: saved.__setitem__(f"edstem:{region}", t))
    monkeypatch.setattr(Account, "clear_ed_token", lambda self: saved.pop(f"edstem:{self.ed_region}", None))
    return saved


def client(root: Path, tmp_path: Path) -> TestClient:
    app = server.create_app(Account(BASE, root, "Test"), "s", prefs_path=tmp_path / "prefs.toml")
    return TestClient(app, headers={"Authorization": "Bearer s"})


def links(root: Path) -> dict[int, int]:
    return Settings.load(root / ".canvas" / "config.toml").ed_courses


def test_match():
    canvas = [
        Course(1, "Discrete Math", "COMPSCI 70-LEC-001", "Spring 2026"),
        Course(2, "Multivariable Calculus", "MATH 53-DIS-205/207", "Fall 2026"),
        Course(3, "Multivariable Calculus", "MATH 53-LEC-002", "Fall 2026"),
        Course(4, "CS 61B (Spring 2026)", "CS61B SP26", "Spring 2026"),
        Course(5, "Physics", "PHYSICS 7B-LEC-001 Speliotopoulos", "Fall 2026"),
    ]
    found = [
        {"id": 70, "code": "CS 70", "term": "Spring 2026"},
        {"id": 53, "code": "MATH 53", "term": "Fall 2026"},
        {"id": 610, "code": "CS61Bx", "term": "Spring 2026"},  # another course, of the same term
        {"id": 611, "code": "CS 61B", "term": "Fall 2025"},  # the same course, another term
        {"id": 7, "code": "PHYSICS 7B LEC 001 Speliotopoulos", "term": "Fall 2026"},
        {"id": 1, "code": "Data 001", "term": "All All"},
    ]
    assert ed.match(found, canvas) == {1: 70, 3: 53, 5: 7}  # MATH 53: its lecture, not the section


def test_connect_and_link(root, tmp_path, fake, fake_ed, web):
    pull(root, fake)
    with client(root, tmp_path) as api:
        assert api.get("/api/ed").json()["connected"] is False
        assert api.post("/api/ed/connect", json={"token": "nope"}).json()["detail"] == "token rejected"

        info = api.post("/api/ed/connect", json={"token": f" {TOKEN} "}).json()
        assert info["connected"] and info["user"] == "Ann Ed" and info["error"] is None
        assert info["token_page"] == "https://edstem.org/au/settings/api-tokens"  # it found the region
        assert {c["id"]: c["course"] for c in info["courses"]} == {501: 1, 502: None}
        assert web["edstem:au"] == TOKEN and links(root) == {1: 501}
        assert Account.load().ed_region == "au"
        wait_for_sync(api)

        # Not this course after all: it stays that way, through syncs and connecting again.
        info = api.put("/api/ed/link", json={"ed": 501, "course": None}).json()
        assert {c["id"]: c["course"] for c in info["courses"]} == {501: None, 502: None}
        assert links(root) == {1: 0}
        api.post("/api/ed/connect", json={"token": TOKEN})
        assert wait_for_sync(api)["ed_error"] is None
        assert links(root) == {1: 0}

        # Any Ed course can be any course's.
        info = api.put("/api/ed/link", json={"ed": 502, "course": 1}).json()
        assert {c["id"]: c["course"] for c in info["courses"]} == {501: None, 502: 1}
        assert api.put("/api/ed/link", json={"ed": 502, "course": 99}).status_code == 404
        # Another Ed course set to none leaves its match's own link alone.
        api.put("/api/ed/link", json={"ed": 501, "course": None})
        assert links(root) == {1: 502}

        api.post("/api/ed/disconnect")
        assert api.get("/api/ed").json()["connected"] is False
        assert "edstem:au" not in web
        assert links(root) == {1: 502}  # kept, for connecting again


def test_ed_failing_doesnt_stop_a_sync(root, tmp_path, fake, fake_ed, web):
    with client(root, tmp_path) as api:
        api.post("/api/ed/connect", json={"token": TOKEN})
        wait_for_sync(api)
        fake_ed.status = 500
        api.post("/api/sync", json={})
        state = wait_for_sync(api)
        assert state["phase"] == "done" and state["ed_error"] == "can't reach Ed"
        info = api.get("/api/ed").json()
        assert info["error"] == "can't reach Ed" and info["ok_at"]  # (when it last worked)
        assert len(info["courses"]) == 2  # what came from Ed before stays

        web["edstem:au"] = "revoked"
        fake_ed.status = 200
        api.post("/api/sync", json={})
        assert wait_for_sync(api)["ed_error"] == "token rejected"

        web["edstem:au"] = TOKEN
        api.post("/api/sync", json={})
        assert wait_for_sync(api)["ed_error"] is None
        assert api.get("/api/ed").json()["error"] is None


def ed_sync(root: Path) -> str | None:
    async def go():
        with Engine(root) as e:
            return await ed.sync(e, TOKEN, "au")
    return asyncio.run(go())


def ago(days: float) -> str:
    return (datetime.now(timezone(timedelta(hours=10))) - timedelta(days=days)).isoformat()


@pytest.fixture
def linked(root, fake, fake_ed, web) -> FakeEd:
    """MATH 221 synced from Canvas, and its Ed course linked to it."""
    pull(root, fake)
    set_ed_courses(root / ".canvas" / "config.toml", {1: 501})
    return fake_ed


def test_ed_announcements_are_the_courses(root, fake, linked):
    fake.announcements.append({"id": 9, "title": "Welcome", "message": "<p>Hello</p>", "posted_at": "2026-10-10T00:00:00Z",
                               "html_url": f"{BASE}/courses/1/discussion_topics/9"})
    pull(root, fake)
    body = ('<document version="2.0"><paragraph>HW 3 is due <bold>Friday</bold>; see '
            '<link href="https://x.edu/hw3">the spec</link>.</paragraph></document>')
    linked.thread(501, 9001, "HW 3 deadline moved", body, type="announcement", user=1, created="2026-10-16T09:00:00+10:00")
    linked.thread(501, 9002, "Is lecture recorded?")  # a question: not an announcement
    # Posted on Canvas and Ed both: it's one announcement (Canvas's).
    linked.thread(501, 9003, "welcome!", type="announcement", user=1, created="2026-10-10T12:00:00+10:00")
    linked.thread(501, 9004, "Welcome", type="announcement", user=1, created="2026-09-01T09:00:00+10:00")  # (another)
    linked.thread(501, 9005, "Welcome", user=1, created="2026-10-10T12:00:00+10:00", is_pinned=True)  # (pinned, as a post)
    assert ed_sync(root) is None

    with Engine(root) as e:
        items = content.items(e.state, e.root, 1, "announcement")
        assert [(a["id"], a["title"]) for a in items] == [("ed-9001", "HW 3 deadline moved"), ("9", "Welcome"), ("ed-9004", "Welcome")]
        a = items[0]
        assert a["date"] == "2026-10-15T23:00:00Z"  # (as Canvas writes times: they sort together)
        assert a["author"] == "Prof Ed" and a["source"] == "ed"
        assert a["url"] == "https://edstem.org/au/courses/501/discussion/9001"
        it = content.item(e.state, e.root, 1, "announcement", "ed-9001")
        assert it["html"] == ('<p>HW 3 is due <strong>Friday</strong>; see '
                              '<a href="https://x.edu/hw3">the spec</a>.</p>')
        # The pinned post is in the discussion, but not news: the Canvas announcement is.
        assert [p["id"] for p in content.items(e.state, e.root, 1, "post")] == ["ed-9005", "ed-9002"]
        assert "ed-9005" not in content.news(e.state, e.root, 1)["post"]
        e.reindex()
        assert [h.title for h in e.search("deadline moved")] == ["HW 3 deadline moved"]

    # Each source keeps its own: syncing Canvas leaves Ed's, and the other way round.
    pull(root, fake)
    ed_sync(root)
    with Engine(root) as e:
        assert {a["id"] for a in content.items(e.state, e.root, 1, "announcement")} == {"ed-9001", "9", "ed-9004"}


def test_what_is_new_from_ed(root, linked):
    linked.thread(501, 9001, "Old news", type="announcement", user=1, created=ago(30))
    linked.thread(501, 9002, "This week", type="announcement", user=1, created=ago(1))
    ed_sync(root)
    with Engine(root) as e:
        # The first time, as for a course: only what's recent is new.
        assert set(content.news(e.state, e.root, 1)["announcement"]) == {"ed-9002"}
    linked.thread(501, 9003, "Later", type="announcement", user=1, created=ago(0), is_seen=True)
    linked.thread(501, 9004, "Later still", type="announcement", user=1, created=ago(0))
    ed_sync(root)
    with Engine(root) as e:
        assert set(content.news(e.state, e.root, 1)["announcement"]) == {"ed-9002", "ed-9004"}  # (9003: read on Ed)


def test_ed_going_wrong_keeps_what_came(root, linked):
    linked.thread(501, 9001, "Exam room", type="announcement", user=1)
    ed_sync(root)
    linked.threads[501][0].pop("category")  # Ed changed what it says
    assert ed_sync(root) == "Ed changed"
    with Engine(root) as e:
        assert [a["id"] for a in content.items(e.state, e.root, 1, "announcement")] == ["ed-9001"]

    # A course that's no longer linked to its Ed course doesn't keep what came from there.
    set_ed_courses(root / ".canvas" / "config.toml", {1: 0})
    assert ed_sync(root) is None
    with Engine(root) as e:
        assert content.items(e.state, e.root, 1, "announcement") == []


def test_to_html():
    xml = ('<document version="2.0"><heading level="1">Exam</heading><list style="number"><list-item>'
           '<paragraph>Bring <code>id</code> &amp; a pen</paragraph></list-item></list>'
           '<snippet language="py">if a &lt; b: pass</snippet><image src="https://static.edstem.org/a.png"/></document>')
    assert ed.to_html(xml) == ('<h2>Exam</h2><ol><li><p>Bring <code>id</code> &amp; a pen</p></li></ol>'
                               '<pre><code>if a &lt; b: pass</code></pre><img src="https://static.edstem.org/a.png" alt="">')
    assert ed.to_html("not <xml") == "<p>not &lt;xml</p>"


def test_ed_posts_are_the_courses_discussion(root, tmp_path, linked, web):
    linked.thread(501, 9001, "HW 3 megathread", user=1, created=ago(5), is_pinned=True, is_megathread=True, category="Homework")
    linked.thread(501, 9002, "Office hours moved", user=1, created=ago(3))
    linked.thread(501, 9003, "Is lecture recorded?", created=ago(2), category="Lectures")
    linked.reply(501, 9001, "Q2 has a typo: it's x^2")
    linked.reply(501, 9003, "Yes, on bCourses")
    ed_sync(root)
    replies_fetched = [r for r in linked.requests if "/api/threads/" in r]
    assert replies_fetched == ["edstem.org/api/threads/9001"]  # (the pinned megathread's; the question's: when opened)

    with Engine(root) as e:
        posts = content.items(e.state, e.root, 1, "post")
        assert [p["title"] for p in posts] == ["HW 3 megathread", "Is lecture recorded?", "Office hours moved"]  # pinned first
        assert posts[0]["ed"]["category"] == "Homework" and posts[0]["ed"]["staff"] and posts[0]["ed"]["replies"] == 1
        o = content.overview(e.state, e.root, 1)
        assert [p["title"] for p in o["posts"]] == ["HW 3 megathread", "Office hours moved"]  # pinned, then staff's
        assert o["counts"]["posts"] == 3
        # What's new: staff's and what's pinned, not every question.
        assert set(content.news(e.state, e.root, 1)["post"]) == {"ed-9001", "ed-9002"}
        it = content.item(e.state, e.root, 1, "post", "ed-9001")
        assert [(r["author"], r["staff"], r["html"]) for r in it["replies"]] == [("Prof Ed", True, "<p>Q2 has a typo: it's x^2</p>")]

    web["edstem:au"] = TOKEN
    app = server.create_app(Account(BASE, root, "Test", ed_region="au"), "s", prefs_path=tmp_path / "prefs.toml")
    with TestClient(app, headers={"Authorization": "Bearer s"}) as api:
        it = api.get("/api/courses/1/items/post/ed-9003").json()  # opened: its replies are fetched
        assert [r["html"] for r in it["replies"]] == ["<p>Yes, on bCourses</p>"]
        n = len(linked.requests)
        api.get("/api/courses/1/items/post/ed-9003")
        assert len(linked.requests) == n  # (none new since: not again)

    # Replies kept through syncs, fetched again only when there are more.
    linked.requests.clear()
    ed_sync(root)
    assert [r for r in linked.requests if "/api/threads/" in r] == []
    linked.reply(501, 9001, "Due date extended to Monday")
    ed_sync(root)
    assert [r for r in linked.requests if "/api/threads/" in r] == ["edstem.org/api/threads/9001"]
    with Engine(root) as e:
        assert len(content.item(e.state, e.root, 1, "post", "ed-9001")["replies"]) == 2


def test_ed_posts_are_found_and_go_anywhere_in_their_course(root, tmp_path, linked):
    linked.thread(501, 9001, "HW 3 megathread", user=1, is_megathread=True, is_pinned=True, category="Homework")
    linked.thread(501, 9002, "HW 3 question", category="Homework")
    linked.thread(501, 9003, "Grading", body='<document version="2.0"><paragraph>How are labs graded?</paragraph></document>')
    linked.reply(501, 9001, "Q4 uses the RMS voltage", user=1)
    ed_sync(root)
    with Engine(root) as e:
        e.reindex()
        assert [h.title for h in e.search("rms voltage")] == ["HW 3 megathread"]  # what staff answered
        assert [h.title for h in e.search("homework", kinds=["post"])] == ["HW 3 megathread", "HW 3 question"]  # its category
        assert [h.title for h in e.search("hw 3", kinds=["post"])] == ["HW 3 megathread", "HW 3 question"]  # (students' after)
        # "ed": only what came from Ed (not the Canvas announcement that says the same words).
        e.state.db.execute("INSERT INTO documents (course_id, kind, id, title, updated_at, raw) VALUES (1, 'announcement', '7', 'HW 3 out', '', '{}')")
        e.reindex()
        assert {h.source for h in e.search("hw 3")} == {"canvas", "ed"}
        assert {(h.title, h.source) for h in e.index.search("hw 3", e.state.courses(), e.settings, source="ed")} == {
            ("HW 3 megathread", "ed"), ("HW 3 question", "ed")}
        found = {(x["type"], x.get("kind"), x.get("name")) for x in catalog(e)}
        assert ("doc", "post", "HW 3 megathread") in found and ("doc", "post", "HW 3 question") not in found
        assert ("view", None, None) in {(x["type"], x.get("kind"), x.get("name")) for x in catalog(e) if x.get("view") == "discussion"}

    # A post is the course's: it can be a tab of it, and pinned; not another course's.
    post = {"type": "doc", "course": 1, "kind": "post", "id": "ed-9001"}
    with client(root, tmp_path) as api:
        tabs = api.get("/api/courses/1/layout").json()["tabs"]
        api.put("/api/courses/1/layout/tabs", json={"entries": [*tabs, {**post, "title": "HW 3 Q&A", "hidden": False}]})
        tab = api.get("/api/courses/1/layout").json()["tabs"][-1]
        assert (tab["id"], tab["title"], tab["name"], tab["exists"]) == ("ed-9001", "HW 3 Q&A", "HW 3 megathread", True)
        api.put("/api/pinned", json={"entries": [{**post, "title": "", "hidden": False}]})
        assert api.get("/api/pinned").json()[0]["name"] == "HW 3 megathread"
    assert Place("tabs", 2, [], []).holds(Thing("doc", course=1, kind="post", id="ed-9001")) is False
