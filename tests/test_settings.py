"""The app's settings: preferences, signing in and out, syncing by itself."""

from __future__ import annotations

import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

import httpx
import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

from canvas_sync import CanvasClient, server
from canvas_sync.config import Account, AppPrefs, Settings
from fake_canvas import BASE, FakeCanvas, wait_for_sync

PREFS = "prefs.toml"


@pytest.fixture
def keychain(monkeypatch, tmp_path) -> dict[str, str]:
    """The Keychain and the account file, kept to this test."""
    saved: dict[str, str] = {}
    monkeypatch.setattr("canvas_sync.config.ACCOUNT_FILE", tmp_path / "home" / "config.toml")
    monkeypatch.setattr(Account, "token", lambda self: saved.get(self.base_url))
    monkeypatch.setattr(Account, "set_token", lambda self, t: saved.__setitem__(self.base_url, t))
    monkeypatch.setattr(Account, "clear_token", lambda self: saved.pop(self.base_url, None))
    return saved


@pytest.fixture
def canvas(fake: FakeCanvas, monkeypatch) -> FakeCanvas:
    """The fake Canvas, for the sign-in check and for syncing."""
    real = httpx.AsyncClient  # (patched for every user of httpx, CanvasClient too: that brings its own transport)
    monkeypatch.setattr("canvas_sync.server.httpx.AsyncClient", lambda **kw: real(**{"transport": httpx.MockTransport(fake.handle), **kw}))
    monkeypatch.setattr(
        "canvas_sync.server.CanvasClient",
        lambda url, token: CanvasClient(url, token, transport=httpx.MockTransport(fake.handle)),
    )
    return fake


def client(account: Account | None, tmp_path: Path, background: bool = False) -> TestClient:
    app = server.create_app(account, "s", prefs_path=tmp_path / PREFS, background=background)
    return TestClient(app, headers={"Authorization": "Bearer s"})


def test_prefs(root, tmp_path, keychain):
    with client(Account(BASE, root), tmp_path) as api:
        assert api.get("/api/prefs").json() == {"language": "system", "auto_sync": 60, "sync_on_launch": True,
                                                "select": "active"}
        got = api.post("/api/prefs", json={"language": "en", "auto_sync": 180}).json()
        assert (got["language"], got["auto_sync"], got["sync_on_launch"]) == ("en", 180, True)
        assert AppPrefs.load(tmp_path / PREFS) == AppPrefs("en", 180, True)
        assert api.post("/api/prefs", json={"auto_sync": 7}).status_code == 400
        assert api.post("/api/prefs", json={"language": "fr"}).status_code == 400
        assert api.post("/api/prefs", json={"select": "favorites"}).json()["select"] == "favorites"
        config = root / ".canvas" / "config.toml"
        assert Settings.load(config).select == "favorites" and "# Which courses" in config.read_text()  # comments kept
        assert api.post("/api/prefs", json={"select": "all"}).status_code == 400
    (tmp_path / PREFS).write_text("language = 3\nauto_sync = \"soon\"\n")  # edited by hand, badly
    assert AppPrefs.load(tmp_path / PREFS) == AppPrefs()


def test_sign_in_from_scratch(tmp_path, canvas, keychain):
    canvas.valid_tokens = {"good"}
    with client(None, tmp_path) as api:
        assert api.get("/api/health").json()["set_up"] is False
        assert api.get("/api/courses").status_code == 409  # nothing to show yet
        assert api.get("/api/prefs").json()["language"] == "system"  # (the sign-in page has a language too)
        assert api.get("/api/account").json()["set_up"] is False

        def setup(**kw):
            return api.post("/api/account/setup", json={"url": "canvas.test", "token": "good", "root": str(tmp_path / "Canvas"), **kw})
        assert setup(url="ftp://canvas.test").json()["detail"] == "not a web address"
        assert setup(url="http://canvas.test").json()["detail"] == "https only"
        assert setup(token="bad").json()["detail"] == "token rejected"
        (tmp_path / "Documents").mkdir()
        (tmp_path / "Documents" / "thesis.docx").write_text("x")
        assert setup(root=str(tmp_path / "Documents")).json()["detail"] == "folder not empty"

        r = setup(url="https://canvas.test/courses/1/pages/intro")  # any page there will do
        assert r.json() == {"set_up": True, "signed_in": True, "base_url": BASE, "root": str((tmp_path / "Canvas").resolve()),
                            "user": "Test"}
        assert keychain == {BASE: "good"}
        assert Account.load() == Account(BASE, (tmp_path / "Canvas").resolve(), "Test")
        assert api.get("/api/courses").status_code == 200
        assert wait_for_sync(api)["phase"] == "done"  # signing in starts the first sync
        assert [c["id"] for c in api.get("/api/courses").json()] == [1]
        assert api.get("/api/sync").json()["last_synced"]


def test_sign_out_and_in_again(root, tmp_path, canvas, keychain):
    keychain[BASE] = "old"
    canvas.valid_tokens = {"new"}
    with client(Account(BASE, root, "Test"), tmp_path) as api:
        assert api.get("/api/account/check").json() == {"ok": False, "error": "token rejected"}  # it expired
        assert api.post("/api/account/token", json={"token": "nope"}).status_code == 400
        assert keychain[BASE] == "old"
        assert api.post("/api/account/token", json={"token": "new"}).json()["signed_in"]
        assert api.get("/api/account/check").json() == {"ok": True, "user": "Test"}

        assert api.post("/api/account/signout").json()["signed_in"] is False
        assert keychain == {}
        assert api.post("/api/sync", json={}).json()["detail"] == "not signed in to Canvas"
        assert api.get("/api/courses").status_code == 200  # what's synced is still there
        # Another school can't take over this folder: its courses would mix with these.
        r = api.post("/api/account/setup", json={"url": "other.test", "token": "new", "root": str(root)})
        assert r.json()["detail"] == "folder belongs to another Canvas site"


def test_sync_on_launch(root, tmp_path, canvas, keychain, monkeypatch):
    keychain[BASE] = "t"
    monkeypatch.setattr(server, "STARTUP_DELAY", 0.01)

    def launch_and_watch(seconds: float) -> str:
        with client(Account(BASE, root), tmp_path, background=True) as api:
            deadline = time.monotonic() + seconds
            while time.monotonic() < deadline:
                state = api.get("/api/sync").json()
                if state["phase"] in ("done", "failed"):
                    break
                time.sleep(0.02)
            return state["phase"]

    assert launch_and_watch(2) == "done"  # never synced: it syncs
    assert launch_and_watch(0.2) == "idle"  # just did: it doesn't
    AppPrefs(sync_on_launch=False).save(tmp_path / PREFS)
    monkeypatch.setattr(server, "LAUNCH_GRACE", timedelta(0))
    assert launch_and_watch(0.2) == "idle"


def test_automatic_sync_is_due():
    now = datetime(2026, 10, 15, 12, tzinfo=timezone.utc)
    assert server._due(None, timedelta(hours=1), now)
    assert not server._due(now - timedelta(minutes=59), timedelta(hours=1), now)
    assert server._due(now - timedelta(minutes=61), timedelta(hours=1), now)


def test_canvas_site():
    assert server._canvas_site(" bcourses.berkeley.edu ") == "https://bcourses.berkeley.edu"
    assert server._canvas_site("https://bcourses.berkeley.edu/courses/1/") == "https://bcourses.berkeley.edu"
    assert server._canvas_site("http://localhost:3000") == "http://localhost:3000"
    for bad in ("http://bcourses.berkeley.edu", "mailto:x@y", "https://"):
        with pytest.raises(HTTPException):
            server._canvas_site(bad)


def test_sidebar_order(root, tmp_path, keychain):
    with client(Account(BASE, root), tmp_path) as api:
        assert api.get("/api/sidebar").json() == {"terms": [], "courses": []}
        api.post("/api/sidebar", json={"terms": ["Spring 2026", "Fall 2026", "Spring 2026"]})
        assert api.post("/api/sidebar", json={"courses": [3, 1, 2]}).json() == {"terms": ["Spring 2026", "Fall 2026"], "courses": [3, 1, 2]}
    settings = Settings.load(root / ".canvas" / "config.toml")
    assert (settings.term_order, settings.course_order) == (["Spring 2026", "Fall 2026"], [3, 1, 2])


def test_hide_a_course(root, tmp_path, canvas, keychain):
    keychain[BASE] = "t"
    canvas.put(101, "midterm.pdf", b"x")
    with client(Account(BASE, root), tmp_path) as api:
        api.post("/api/sync", json={})
        wait_for_sync(api)
        api.post("/api/reindex")
        api.put("/api/pinned", json={"entries": [{"type": "course", "course": 1}]})
        assert [h["title"] for h in api.get("/api/search", params={"q": "midterm"}).json()] == ["midterm.pdf"]

        assert api.post("/api/courses/1/hide", json={"hidden": True, "syncing": False}).json() == {"hidden": True, "excluded": True}
        [c] = api.get("/api/courses").json()
        assert (c["hidden"], c["excluded"]) == (True, True)
        assert api.get("/api/pinned").json() == []  # unpinned
        assert api.get("/api/search", params={"q": "midterm"}).json() == []  # out of search...
        assert api.get("/api/search", params={"q": "midterm", "course": 1}).json()  # ...unless you ask for it
        canvas.put(102, "final.pdf", b"y")
        api.post("/api/sync", json={})
        assert wait_for_sync(api)["changes"] == {}  # not synced any more

        assert api.post("/api/courses/1/hide", json={"hidden": False, "syncing": True}).json() == {"hidden": False, "excluded": False}
        api.post("/api/sync", json={})
        assert wait_for_sync(api)["changes"] == {"download": 1}
        # A course that isn't pinned hides just the same, and can keep syncing.
        assert api.post("/api/courses/1/hide", json={"hidden": True}).json() == {"hidden": True, "excluded": False}
        api.post("/api/courses/1/hide", json={"hidden": False})
    settings = Settings.load(root / ".canvas" / "config.toml")
    assert (settings.hidden, settings.exclude) == ([], [])


def test_course_icons(root, tmp_path, keychain):
    with client(Account(BASE, root), tmp_path) as api:
        assert api.post("/api/courses/1/icon", json={"icon": "atom", "color": "blue"}).json() == {"icon": {"icon": "atom", "color": "blue"}}
        assert api.post("/api/courses/2/icon", json={"emoji": "🧪"}).json() == {"icon": {"emoji": "🧪"}}
        assert api.post("/api/courses/1/icon", json={"icon": "../x"}).status_code == 400
        assert api.post("/api/courses/2/icon", json={}).json() == {"icon": None}  # back to the app's pick
    assert Settings.load(root / ".canvas" / "config.toml").course_icons == {1: {"icon": "atom", "color": "blue"}}


def test_hide_a_whole_term(root, tmp_path, keychain):
    with client(Account(BASE, root), tmp_path) as api:
        api.put("/api/pinned", json={"entries": [{"type": "course", "course": 2}]})
        r = api.post("/api/courses/hide", json={"courses": [1, 2, 3], "hidden": True, "syncing": False}).json()
        assert r == {"hidden": [1, 2, 3], "excluded": [1, 2, 3]}
        assert api.get("/api/pinned").json() == []
        r = api.post("/api/courses/hide", json={"courses": [1, 2], "hidden": False, "syncing": True}).json()
        assert r == {"hidden": [], "excluded": []}
    settings = Settings.load(root / ".canvas" / "config.toml")
    assert (settings.hidden, settings.exclude) == ([3], [3])
