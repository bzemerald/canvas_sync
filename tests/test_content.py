"""The course page: overview, announcements / assignments / pages, and images in them."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import httpx
import pytest
from fastapi.testclient import TestClient

from canvas_sync import CanvasClient, Engine, content
from canvas_sync.config import Account
from canvas_sync.server import create_app
from fake_canvas import BASE, COURSE, FakeCanvas, pull, wait_for_sync

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
    assert o["announcements"][0]["author"] == "Prof"
    assert [f["name"] for f in o["new_files"]] == ["hw6.pdf", "lec1.pdf"]  # newest upload first
    assert o["counts"] == {"modules": 1, "announcements": 2, "assignments": 4, "pages": 2, "files": 2, "syllabus": True,
                           "grades": False}


def test_items_and_one_item(root, course):
    pull(root, course)
    with Engine(root) as e:
        assert [a["title"] for a in content.items(e.state, e.root, 1, "assignment", NOW)] == ["HW 6", "Project", "HW 5", "Reading"]
        assert [p["title"] for p in content.items(e.state, e.root, 1, "page")] == ["Intro", "Another"]  # front page first
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
    o = api.get("/api/courses/1/overview").json()
    assert o["counts"]["pages"] == 2
    assert [m["name"] for m in o["current_modules"]] == ["Week 1"]  # (the one with the newest upload)
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


def test_modules(root, course):
    course.module(2, "Week 2", [
        {"id": 21, "type": "SubHeader", "title": "Before class"},
        {"id": 22, "type": "Page", "title": "Intro", "page_url": "intro", "indent": 1},
        {"id": 23, "type": "Assignment", "title": "HW 6", "content_id": 10,
         "completion_requirement": {"type": "must_submit", "completed": True}},
        {"id": 24, "type": "File", "title": "hw6.pdf", "content_id": 101},
        {"id": 25, "type": "ExternalUrl", "title": "Textbook", "external_url": "https://book.test"},
        {"id": 26, "type": "ExternalTool", "title": "Gradescope", "html_url": f"{BASE}/courses/1/modules/items/26"},
        {"id": 27, "type": "Quiz", "title": "Quiz 1", "html_url": f"{BASE}/courses/1/quizzes/5"},
    ])
    pull(root, course)
    with Engine(root) as e:
        week1, week2 = content.modules(e.state, e.root, e.layout, 1, NOW)
    assert week1["name"] == "Week 1" and week1["folder"] == f"{COURSE}/Modules/01 Week 1"
    assert week1["items"][0] == {"id": None, "type": "File", "title": "lec1.pdf", "indent": 0, "done": False,
                                      "new": False, "file": f"{COURSE}/Modules/01 Week 1/lec1.pdf"}
    by_title = {i["title"]: i for i in week2["items"]}
    assert by_title["Before class"]["type"] == "SubHeader"
    assert by_title["Intro"]["doc"] == {"kind": "page", "id": "intro"} and by_title["Intro"]["indent"] == 1
    assert by_title["HW 6"]["doc"] == {"kind": "assignment", "id": "10"} and by_title["HW 6"]["done"]
    assert by_title["hw6.pdf"]["file"] == f"{COURSE}/Modules/02 Week 2/hw6.pdf"
    assert by_title["Textbook"]["external"] == "https://book.test"
    assert by_title["Gradescope"]["url"] == "/courses/1/modules/items/26"
    assert by_title["Quiz 1"]["url"] == "/courses/1/quizzes/5"
    # Week 2 has both the newest upload and the next deadline.
    assert (week1["current"], week2["current"]) == (False, True)


def test_modules_survive_a_failed_fetch_but_not_being_turned_off(root, course):
    pull(root, course)
    course.modules_status = 400  # a failure that isn't "turned off" (and isn't retried, unlike 5xx)
    pull(root, course)
    with Engine(root) as e:
        assert [m["name"] for m in e.state.modules(1)] == ["Week 1"]  # kept from before
    course.modules_status = 404  # the course turned modules off
    pull(root, course)
    with Engine(root) as e:
        assert e.state.modules(1) == []


# -- what's new, submissions, grades ---------------------------------------------------------


def test_whats_new(api, course, root, monkeypatch):
    monkeypatch.setattr("canvas_sync.server.open_path", lambda p, **kw: None)
    api.post("/api/courses/1/seen")  # start with nothing new
    course.announcements += [
        {"id": 9, "title": "Exam moved", "posted_at": "2026-10-14T00:00:00Z", "message": "", "read_state": "unread"},
        {"id": 6, "title": "Read already", "posted_at": "2026-10-14T00:00:00Z", "message": "", "read_state": "read"},
    ]
    course.assignments += [
        {"id": 20, "name": "HW 7", "submission_types": ["online_upload"], "submission": {"workflow_state": "unsubmitted"}},
        {"id": 21, "name": "Done already", "submission_types": ["online_upload"],
         "submission": {"workflow_state": "submitted", "submitted_at": "2026-10-14T00:00:00Z"}},
    ]
    course.pages["new"] = {"url": "new", "title": "New page", "body": ""}
    course.put(102, "lec2.pdf", b"l2", folder=10)
    course.put(100, "lec1.pdf", b"v2", version="2026-10-14T00:00:00Z")  # a new version
    assert api.post("/api/sync", json={}).status_code == 202
    wait_for_sync(api)

    o = api.get("/api/courses/1/overview").json()
    assert o["new"] == {"announcements": 1, "assignments": 1, "pages": 1, "files": 2}
    assert [a["title"] for a in o["announcements"] if a["new"]] == ["Exam moved"]  # not the one read on Canvas
    assert {f["name"]: f["updated"] for f in o["new_files"] if f["new"]} == {"lec2.pdf": False, "lec1.pdf": True}
    assert next(c for c in api.get("/api/courses").json() if c["id"] == 1)["new"] == 5
    by_title = {i["title"]: i for m in api.get("/api/courses/1/modules").json() for i in m["items"]}
    assert by_title["lec1.pdf"]["new"]

    # Opening something is seeing it.
    api.get("/api/courses/1/items/announcement/9")
    api.post("/api/open", json={"path": f"{COURSE}/Files/lec2.pdf"})
    api.post("/api/open", json={"path": f"{COURSE}/Modules/01 Week 1/lec1.pdf", "reveal": True})  # only showing it
    o = api.get("/api/courses/1/overview").json()
    assert o["new"] == {"announcements": 0, "assignments": 1, "pages": 1, "files": 1}
    assert api.post("/api/courses/1/seen", json={"kinds": ["page"]}).json()["pages"] == 0
    assert api.post("/api/courses/1/seen", json={"kinds": ["movie"]}).status_code == 400
    assert api.post("/api/courses/1/seen").json() == {"announcements": 0, "assignments": 0, "pages": 0, "files": 0}

    # Handing it in on Canvas also makes it old news.
    course.assignments.append({"id": 22, "name": "HW 8", "submission_types": ["online_upload"]})
    pull(root, course)
    assert api.get("/api/courses/1/overview").json()["new"]["assignments"] == 1
    course.assignments[-1]["submission"] = {"workflow_state": "submitted", "submitted_at": "2026-10-15T00:00:00Z"}
    pull(root, course)
    assert api.get("/api/courses/1/overview").json()["new"]["assignments"] == 0


def test_what_a_course_had_when_first_synced_isnt_news_unless_recent(root, course):
    now = datetime.now(timezone.utc)
    course.files[101]["created_at"] = iso(now - timedelta(days=2))
    course.files[100]["created_at"] = iso(now - timedelta(days=30))
    course.announcements[0]["posted_at"] = iso(now - timedelta(days=1))  # unread on Canvas
    course.announcements[1]["posted_at"] = iso(now - timedelta(days=1))  # read there already
    pull(root, course)
    with Engine(root) as e:
        n = content.news(e.state, e.root, 1)
    assert (set(n["file"]), set(n["announcement"]), n["assignment"], n["page"]) == ({"101"}, {"7"}, {}, {})


def test_new_files_in_the_file_browser(root, fake):
    pull(root, fake)
    fake.put(102, "lec2.pdf", b"l2")
    fake.module(1, "Week 1", [{"type": "File", "content_id": 100}, {"type": "File", "content_id": 102}])
    fake.modules = fake.modules[1:]
    pull(root, fake)
    with Engine(root) as e:
        week = {x.name: x for x in e.list_dir(f"{COURSE}/Modules/01 Week 1")}
        top = {x.name: x for x in e.list_dir(COURSE)}
        term = {x.name: x for x in e.list_dir("Fall 2026")}
    assert (week["lec2.pdf"].new, week["lec1.pdf"].new) == ("new", None)
    assert top["Modules"].new_inside == top["Files"].new_inside == 1
    assert term["MATH 221"].new_inside == 1  # the file and its view link are one file


def test_external_tools(root, course):
    course.tabs = [
        {"id": "home", "label": "Home", "type": "internal", "position": 1},
        {"id": "context_external_tool_6", "label": "Ed", "type": "external", "position": 4,
         "html_url": "/courses/1/external_tools/6"},
        {"id": "context_external_tool_5", "label": "Gradescope", "type": "external", "position": 3,
         "html_url": "/courses/1/external_tools/5"},
        {"id": "context_external_tool_7", "label": "Hidden", "type": "external", "hidden": True},
    ]
    course.assignments[0]["submission_types"] = ["external_tool"]
    course.assignments[0]["external_tool_tag_attributes"] = {"url": "https://www.gradescope.com/auth/lti/callback"}
    course.module(2, "Week 2", [{"id": 26, "type": "ExternalTool", "title": "Ed",
                                 "external_url": "https://edstem.org/lti", "html_url": f"{BASE}/courses/1/modules/items/26"}])
    pull(root, course)
    with Engine(root) as e:
        o = content.overview(e.state, e.root, 1, NOW)
        [ed] = content.modules(e.state, e.root, e.layout, 1, NOW)[1]["items"]
    assert o["tools"] == [{"id": 5, "label": "Gradescope", "url": "/courses/1/external_tools/5"},
                          {"id": 6, "label": "Ed", "url": "/courses/1/external_tools/6"}]
    assert o["upcoming"][0]["tool"] == {"assignment_id": 10, "name": "Gradescope"}
    assert ed["tool"] == {"module_item_id": 26, "name": "Ed"} and ed["url"] == "/courses/1/modules/items/26"

    # Failing to list them keeps what's known, and doesn't hold up deletions of files.
    course.tabs_status = 400
    plan = pull(root, course)
    assert all(s.complete for s in plan.snapshots)
    with Engine(root) as e:
        assert len(content.tools(e.state, 1)) == 2


def test_tool_names():
    assert content.tool_name("https://www.gradescope.com/auth/lti/callback") == "Gradescope"
    assert content.tool_name("https://foo.quiz-lti-iad-prod.instructure.com/lti/launch") == "New Quizzes"
    assert content.tool_name("https://lti.perusall.com/x") == "Perusall"
    assert content.tool_name("https://app.mytool.io/lti") == "Mytool"
    assert content.tool_name("https://abc.instructure.com/x") is None
    assert content.tool_name("https://rollcall.instructure.com/launch") == "Roll Call"
    assert content.tool_name(None) is None


def test_launch(api, course, monkeypatch):
    opened = []
    monkeypatch.setattr("canvas_sync.server.webbrowser.open", opened.append)
    r = api.post("/api/launch", json={"course_id": 1, "tool_id": 5}).json()
    assert r == {"opened": course.launch_url, "signed_in": True} and opened == [course.launch_url]
    assert course.launches[-1] == {"id": "5", "launch_type": "course_navigation"}
    api.post("/api/launch", json={"course_id": 1, "module_item_id": 26})
    assert course.launches[-1] == {"launch_type": "module_item", "module_item_id": "26"}
    api.post("/api/launch", json={"course_id": 1, "assignment_id": 10})
    assert course.launches[-1] == {"launch_type": "assessment", "assignment_id": "10"}
    api.post("/api/launch", json={"course_id": 1, "url": "https://tool.test/lti"})
    assert course.launches[-1] == {"url": "https://tool.test/lti"}

    # Canvas won't: the tool's page on Canvas instead.
    course.launch_status = 401
    r = api.post("/api/launch", json={"course_id": 1, "module_item_id": 26}).json()
    assert r == {"opened": f"{BASE}/courses/1/modules/items/26", "signed_in": False}
    r = api.post("/api/launch", json={"course_id": 1, "url": "https://tool.test/lti"}).json()
    assert r["opened"] == f"{BASE}/courses/1/external_tools/retrieve?url=https%3A%2F%2Ftool.test%2Flti"
    # A launch link anywhere but Canvas isn't followed.
    course.launch_status, course.launch_url = 200, "https://evil.test/x"
    assert api.post("/api/launch", json={"course_id": 1, "tool_id": 5}).json()["signed_in"] is False
    assert api.post("/api/launch", json={"course_id": 1, "url": "javascript:x"}).status_code == 400
    assert api.post("/api/launch", json={"course_id": 1}).status_code == 400


def test_submission_status():
    online = {"submission_types": ["online_upload"]}
    def status(sub, a=online):
        return content.submission({**a, "submission": sub})
    assert status({"workflow_state": "unsubmitted"})["status"] == "unsubmitted"
    assert status({"workflow_state": "unsubmitted"}, {"submission_types": ["external_tool"]})["status"] is None  # Gradescope
    assert status({"workflow_state": "unsubmitted", "missing": True})["status"] == "missing"
    s = status({"workflow_state": "submitted", "submitted_at": "x", "late": True})
    assert (s["status"], s["late"], s["score"]) == ("submitted", True, None)
    s = status({"workflow_state": "graded", "submitted_at": "x", "score": 8.5, "grade": "8.5", "graded_at": "y"})
    assert (s["status"], s["score"], s["graded_at"]) == ("graded", 8.5, "y")
    # Graded but not posted: Canvas leaves the score out, so it's just handed in.
    assert status({"workflow_state": "graded", "submitted_at": "x", "score": None, "grade": None})["status"] == "submitted"
    assert status({"workflow_state": "unsubmitted", "excused": True})["status"] == "excused"
    assert content.submission(online)["status"] is None  # Canvas didn't say (not a student)


def test_grades(root, course):
    course.course["enrollments"] = [{"type": "student", "computed_current_score": 91.5, "computed_current_grade": "A-",
                                     "computed_final_score": 60.2, "computed_final_grade": "D-"}]
    course.assignments[0]["submission"] = {"workflow_state": "graded", "score": 9, "grade": "9", "graded_at": "2026-10-14T00:00:00Z"}
    course.assignments.append({"id": 30, "name": "Attendance", "grading_type": "not_graded"})
    pull(root, course)
    with Engine(root) as e:
        g = content.grades(e.state, e.root, 1)
        o = content.overview(e.state, e.root, 1, NOW)
    assert g["total"] == {"current_score": 91.5, "current_grade": "A-", "final_score": 60.2, "final_grade": "D-"}
    assert [a["title"] for a in g["assignments"]] == ["Project", "HW 6", "HW 5", "Reading"]  # latest due first
    assert g["assignments"][1]["score"] == 9
    assert o["counts"]["grades"] and [a["title"] for a in o["grades"]["recent"]] == ["HW 6"]

    # A course that hides totals (or a teacher): nothing to show, not a 0.
    course.course["enrollments"] = [{"type": "student"}]
    pull(root, course)
    with Engine(root) as e:
        assert content.grades(e.state, e.root, 1)["total"] is None
