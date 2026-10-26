"""What search can go to by name (catalog.py), and what you open (for putting it first)."""

from __future__ import annotations

import httpx
import pytest
from fastapi.testclient import TestClient

from canvas_sync import CanvasClient, Engine
from canvas_sync.catalog import catalog
from canvas_sync.config import Account, save_course_place, save_pinned, set_course_hidden
from canvas_sync.things import Entry, Thing
from canvas_sync.server import create_app
from fake_canvas import BASE, COURSE, FakeCanvas, pull

CONFIG = ".canvas/config.toml"


@pytest.fixture
def course(fake: FakeCanvas) -> FakeCanvas:
    fake.assignments.append({"id": 10, "name": "HW 3", "due_at": "2026-10-20T07:00:00Z", "submission_types": ["online_upload"],
                             "html_url": f"{BASE}/courses/1/assignments/10", "submission": {"workflow_state": "unsubmitted"}})
    fake.announcements.append({"id": 7, "title": "Midterm room", "posted_at": "2026-10-12T00:00:00Z", "message": "<p>Room 101</p>"})
    fake.pages["schedule"] = {"url": "schedule", "title": "Schedule", "body": "<p>x</p>"}
    fake.tabs = [{"id": "context_external_tool_5", "label": "Gradescope", "type": "external", "position": 3,
                  "html_url": "/courses/1/external_tools/5"}]
    return fake


def by_type(things: list[dict], type_: str) -> list[dict]:
    return [t for t in things if t["type"] == type_]


@pytest.mark.links
def test_catalog_names_everything_of_the_courses(root, course):
    pull(root, course)
    with Engine(root) as e:
        things = catalog(e)
    [c] = by_type(things, "course")
    assert c["course"] == 1 and c["name"] == "MATH 221" and c["term"] == "Fall 2026"
    assert {"Linear Algebra", "221", "math221"} <= set(c["aliases"])  # (its code as people type it)
    assert c["keys"] == ["221", "math221"]  # what it is as one word of a query ("math" alone is a word)
    # Its views with something in them: no grades yet, no syllabus.
    assert {v["view"] for v in by_type(things, "view")} == {
        "overview", "modules", "announcements", "assignments", "files", "pages", "tools", "canvas"}
    docs = {(d["kind"], d["name"]): d for d in by_type(things, "doc")}
    assert set(docs) == {("assignment", "HW 3"), ("announcement", "Midterm room"), ("page", "Schedule")}
    hw = docs[("assignment", "HW 3")]
    assert hw["due"] == "2026-10-20T07:00:00Z" and hw["status"] == "unsubmitted" and hw["in_course"] == 1
    assert hw["canvas_url"] == "/courses/1/assignments/10"
    assert [m["name"] for m in by_type(things, "module")] == ["Week 1"]
    assert [(t["tool"], t["name"]) for t in by_type(things, "tool")] == [(5, "Gradescope")]
    [f] = by_type(things, "file")
    assert (f["path"], f["name"], f["in_course"]) == (f"{COURSE}/Modules/01 Week 1/lec1.pdf", "lec1.pdf", 1)
    # The folders files are in (and their links), but not the course's own folder: that's the course.
    assert {d["path"] for d in by_type(things, "folder")} == {
        f"{COURSE}/Modules", f"{COURSE}/Modules/01 Week 1", f"{COURSE}/Files", f"{COURSE}/Files/Lectures"}


def test_catalog_has_what_you_put_in_places_under_your_names(root, course):
    pull(root, course)
    cfg = root / CONFIG
    link = Thing("link", url="https://math221.example.edu")
    save_pinned(cfg, [Entry(Thing("file", path=f"{COURSE}/Modules/01 Week 1/lec1.pdf"), "First lecture"),
                      Entry(Thing("search", query="mt", courses=(1,)), "Midterms")])
    save_course_place(cfg, 1, "links", [Entry(link, "Course website")])
    save_course_place(cfg, 1, "overview", [Entry(Thing("note", course=1, id="n1"))])
    (root / ".canvas/notes/1").mkdir(parents=True)
    (root / ".canvas/notes/1/n1.md").write_text("\n  Exam: chapters 1-4\nmore")
    with Engine(root) as e:
        things = catalog(e)
    [f] = by_type(things, "file")
    assert f["title"] == "First lecture" and "First lecture" in f["aliases"]
    [s] = by_type(things, "search")
    assert (s["query"], s["title"], s["in_course"]) == ("mt", "Midterms", 1)
    [w] = by_type(things, "link")
    assert (w["url"], w["title"], w["in_course"]) == ("https://math221.example.edu", "Course website", 1)
    [n] = by_type(things, "note")
    assert n["text"] == "Exam: chapters 1-4" and n["in_course"] == 1


def test_catalog_leaves_out_hidden_courses(root, course):
    pull(root, course)
    save_pinned(root / CONFIG, [Entry(Thing("module", course=1, module=1))])
    set_course_hidden(root / CONFIG, 1, True)
    with Engine(root) as e:
        assert catalog(e) == []


def test_api_catalog_and_what_you_open(root, course, monkeypatch):
    pull(root, course)
    monkeypatch.setattr("canvas_sync.server.CanvasClient",
                        lambda url, token: CanvasClient(url, token, transport=httpx.MockTransport(course.handle)))
    monkeypatch.setattr(Account, "token", lambda self: "t")
    with TestClient(create_app(Account(BASE, root), "s"), headers={"Authorization": "Bearer s"}) as api:
        got = api.get("/api/catalog").json()
        assert any(t["type"] == "course" for t in got["things"]) and got["opened"] == {} and got["picks"] == []
        assert "midterm" in got["abbreviations"]["mt"]  # (what the app's search matches names by, too)
        assert api.post("/api/opened", json={"key": "course:1", "query": "  Math   221 "}).status_code == 200
        assert api.post("/api/opened", json={"key": "course:1"}).status_code == 200
        assert api.post("/api/opened", json={"key": " "}).status_code == 400
        got = api.get("/api/catalog").json()
    assert got["opened"]["course:1"]["count"] == 2
    assert [(p["query"], p["key"], p["count"]) for p in got["picks"]] == [("math 221", "course:1", 1)]
