"""Ed: connecting it, which Canvas course each Ed course is, and syncing what's on it."""

from __future__ import annotations

from pathlib import Path

import httpx
import pytest
from fastapi.testclient import TestClient

from canvas_sync import ed, server
from canvas_sync.config import Account, Settings
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
