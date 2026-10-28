"""`canvas mcp`: an AI assistant reading the courses, read-only, from what was synced."""

from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient
from mcp import Client

from canvas_sync import Engine
from canvas_sync.agent import create_server
from canvas_sync.config import Account
from canvas_sync.server import create_app
from fake_canvas import BASE, COURSE, FakeCanvas, make_pdf, pull

NOW = datetime.now(timezone.utc)


def iso(dt: datetime) -> str:
    return dt.strftime("%Y-%m-%dT%H:%M:%SZ")


@pytest.fixture
def course(fake: FakeCanvas) -> FakeCanvas:
    fake.put(101, "hw6.pdf", make_pdf("Problem 1: diagonalize the matrix"), folder=10)
    for n, (name, due) in enumerate([("HW 6", NOW + timedelta(days=2)), ("HW 5", NOW - timedelta(days=5)),
                                     ("Project", NOW + timedelta(days=40))]):
        fake.assignments.append({
            "id": 10 + n, "name": name, "due_at": iso(due), "points_possible": 10,
            "description": '<p>See <a href="/courses/1/files/101/download">hw6.pdf</a></p>' if n == 0 else "",
            "html_url": f"{BASE}/courses/1/assignments/{10 + n}", "submission_types": ["online_upload"],
            "submission": {"workflow_state": "unsubmitted"},
        })
    fake.assignments.append({"id": 20, "name": "Lab 1", "due_at": iso(NOW + timedelta(days=1)),
                             "submission_types": ["external_tool"], "html_url": f"{BASE}/courses/1/assignments/20"})
    fake.announcements.append({
        "id": 7, "title": "Midterm room", "posted_at": iso(NOW - timedelta(days=1)), "message": "<p>Room 101, bring a pencil</p>",
        "author": {"display_name": "Prof"}, "read_state": "unread", "attachments": [{"id": 101, "display_name": "hw6.pdf"}],
    })
    fake.course["syllabus_body"] = "<p>Grading: 50% exams</p>"
    return fake


def call(root: Path | None, name: str, **args: Any) -> tuple[bool, Any]:
    """(whether it failed, what it said)."""
    async def go() -> tuple[bool, Any]:
        async with Client(create_server(Account(BASE, root) if root else None)) as c:
            r = await c.call_tool(name, args)
            return r.is_error, r.content[0].text if r.is_error else r.structured_content
    return asyncio.run(go())


def ok(root: Path, name: str, **args: Any) -> Any:
    failed, said = call(root, name, **args)
    assert not failed, said
    return said


def test_finding_and_reading(root, course):
    pull(root, course)
    with Engine(root) as e:
        e.reindex()
    assert [c["code"] for c in ok(root, "list_courses")["courses"]] == ["MATH 221"]

    found = ok(root, "search", query="midterm room")["results"]
    assert found[0]["thing"] == {"type": "doc", "course": 1, "kind": "announcement", "id": "7"}
    it = ok(root, "read", course="221", kind="announcement", id="7")
    assert it["content"] == "Room 101, bring a pencil" and it["author"] == "Prof"
    assert it["files"] == [{"name": "hw6.pdf", "path": f"{COURSE}/Files/hw6.pdf"}]  # (to read by path)

    pdf = ok(root, "read", path=f"{COURSE}/Files/hw6.pdf", max_chars=9)
    assert pdf["content"] == "Problem 1" and pdf["course"] == "MATH 221" and "offset=9" in pdf["more"]
    assert ok(root, "search", query="diagonalize")["results"][0]["path"] == f"{COURSE}/Files/hw6.pdf"  # (the text inside)
    assert ok(root, "read", course="MATH 221", kind="syllabus")["content"] == "Grading: 50% exams"

    soon = ok(root, "upcoming", days=7)["assignments"]
    assert [a["title"] for a in soon] == ["Lab 1", "HW 6"]
    assert soon[0]["status"].startswith("unknown") and "not on Canvas" in soon[0]["hand_in"]  # (on Gradescope, say)
    assert soon[1]["status"] == "unsubmitted" and soon[1]["link"] == f"{BASE}/courses/1/assignments/10"
    assert [a["title"] for a in ok(root, "list_items", course="221", kind="assignment")["items"]] == [
        "Lab 1", "HW 6", "Project", "HW 5"]
    assert [a["title"] for a in ok(root, "course_overview", course="221")["due_soon"]] == ["Lab 1", "HW 6"]
    assert ok(root, "modules", course="221")["modules"][0]["items"][0]["path"] == f"{COURSE}/Modules/01 Week 1/lec1.pdf"
    assert {e["name"] for e in ok(root, "list_files", course="221")["entries"]} == {"Files", "Modules"}
    assert {e["name"] for e in ok(root, "list_files", folder=f"{COURSE}/Files")["entries"]} == {"hw6.pdf", "Lectures"}


def test_whats_new(root, course):
    pull(root, course)
    with Engine(root) as e:
        e.state.mark_seen(1)
        e.state.commit()
    before = datetime.now(timezone.utc).isoformat()
    course.announcements.append({"id": 9, "title": "Exam moved", "posted_at": iso(NOW), "message": "", "read_state": "unread"})
    course.put(102, "lec2.pdf", b"l2")
    pull(root, course)
    new = ok(root, "whats_new")
    assert {x["title"] for x in new["new"]} == {"Exam moved", "lec2.pdf"} and new["sync"]["last_synced"]
    since = ok(root, "whats_new", since=before)["new"]
    assert {x["title"] for x in since} == {"Exam moved", "lec2.pdf"} and not any(x["opened"] for x in since)
    assert ok(root, "whats_new", since=iso(NOW + timedelta(days=1)))["new"] == []


def test_nothing_changes(root, course):
    """Reading isn't the student reading: nothing is marked opened or recorded."""
    pull(root, course)
    with Engine(root) as e:
        e.reindex()

    def tables() -> list[Any]:
        with Engine(root) as e:
            return [e.state.db.execute(f"SELECT * FROM {t} ORDER BY 1, 2").fetchall() for t in ("arrivals", "opened", "picks")]

    config = (root / ".canvas" / "config.toml").read_text()
    was = tables()
    ok(root, "read", course="221", kind="announcement", id="7")
    ok(root, "read", path=f"{COURSE}/Files/hw6.pdf")
    ok(root, "search", query="midterm")
    ok(root, "whats_new")
    ok(root, "course_overview", course="221")
    assert tables() == was and (root / ".canvas" / "config.toml").read_text() == config


def test_what_it_wont_do(root, course, tmp_path):
    pull(root, course)
    for path in ["../secret.txt", ".canvas/state.db", "/etc/passwd"]:
        failed, said = call(root, "read", path=path)
        assert failed and ("outside the sync folder" in said or "own folder" in said), path
    failed, said = call(root, "read", course="cs70", kind="page", id="x")
    assert failed and "list_courses" in said
    failed, said = call(None, "list_courses")
    assert failed and "isn't set up" in said
    failed, said = call(tmp_path / "nowhere", "list_courses")
    assert failed and "sync" in said


def test_the_app_says_how_to_start_it(root):
    with TestClient(create_app(Account(BASE, root), "s"), headers={"Authorization": "Bearer s"}) as api:
        got = api.get("/api/mcp").json()
    assert got["args"] == ["mcp"] and Path(got["command"]).name in ("canvas", "canvas.exe")
