"""The app's settings: preferences, signing in and out, syncing by itself."""

from __future__ import annotations

import threading
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

import httpx
import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

from canvas_sync import CanvasClient, Engine, server
from canvas_sync.config import Account, AppPrefs, Settings
from fake_canvas import BASE, FakeCanvas, pull, wait_for_sync

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
                                                "launcher_key": "", "select": "active"}
        got = api.post("/api/prefs", json={"language": "en", "auto_sync": 180}).json()
        assert (got["language"], got["auto_sync"], got["sync_on_launch"]) == ("en", 180, True)
        assert AppPrefs.load(tmp_path / PREFS) == AppPrefs("en", 180, True)
        assert api.post("/api/prefs", json={"auto_sync": 7}).status_code == 400
        assert api.post("/api/prefs", json={"language": "fr"}).status_code == 400
        assert api.post("/api/prefs", json={"launcher_key": "Control+Alt+KeyK"}).json()["launcher_key"] == "Control+Alt+KeyK"
        assert api.post("/api/prefs", json={"launcher_key": "KeyK"}).status_code == 400  # no modifier
        assert api.post("/api/prefs", json={"launcher_key": ""}).json()["launcher_key"] == ""
        assert api.post("/api/prefs", json={"select": "favorites"}).json()["select"] == "favorites"
        config = root / ".canvas" / "config.toml"
        assert Settings.load(config).select == "favorites" and "# Which courses" in config.read_text(encoding="utf-8")  # comments kept
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
        assert r.json() == {"set_up": True, "signed_in": True, "auth": "token", "base_url": BASE, "root": str((tmp_path / "Canvas").resolve()),
                            "user": "Test"}
        assert keychain == {BASE: "good"}
        assert Account.load() == Account(BASE, (tmp_path / "Canvas").resolve(), "Test")
        assert api.get("/api/courses").status_code == 200
        # Which courses sync is chosen first: Canvas keeps most past courses "active".
        assert api.get("/api/health").json()["choosing"] is True
        assert api.get("/api/sync").json()["phase"] == "idle"
        assert api.put("/api/courses/choice", json={"sync": [1], "skip": []}).json()["running"]  # starts the first sync
        assert wait_for_sync(api)["phase"] == "done"
        assert [c["id"] for c in api.get("/api/courses").json()] == [1]
        assert api.get("/api/sync").json()["last_synced"]
        assert api.get("/api/health").json()["choosing"] is False


def test_choose_courses(root, tmp_path, canvas, keychain):
    keychain[BASE] = "t"
    canvas.course["term"] = {"name": "Fall 2026", "start_at": "2026-08-20T07:00:00Z", "end_at": "2026-12-20T08:00:00Z"}
    canvas.others = [
        {"id": 2, "name": "Discrete Math", "course_code": "CS 70", "term": {"name": "Spring 2025"}, "is_favorite": True},
        {"id": 3, "name": "Closed", "course_code": "X 1", "access_restricted_by_date": True},
    ]
    config = root / ".canvas" / "config.toml"
    with client(Account(BASE, root), tmp_path) as api:
        got = api.get("/api/courses/choice").json()
        assert (got["select"], got["chosen"]) == ("active", False)
        assert [(c["id"], c["term"], c["syncing"]) for c in got["courses"]] == [(1, "Fall 2026", True), (2, "Spring 2025", True)]
        assert got["courses"][0]["term_end"] == "2026-12-20T08:00:00Z" and got["courses"][1]["favorite"]

        assert api.put("/api/courses/choice", json={"sync": [1], "skip": [2]}).json()["running"]
        assert wait_for_sync(api)["phase"] == "done"
        s = Settings.load(config)
        assert (s.exclude, s.include) == ([2], [])
        got = api.get("/api/courses/choice").json()
        assert got["chosen"] and [c["syncing"] for c in got["courses"]] == [True, False]

        # Chosen again later (in 设置): it's saved, and nothing starts by itself.
        api.post("/api/prefs", json={"select": "favorites"})
        assert not api.put("/api/courses/choice", json={"sync": [1, 2], "skip": []}).json()["running"]
        s = Settings.load(config)
        assert (s.exclude, s.include) == ([], [1, 2])  # (not starred, 1 syncs only because it's listed)
        assert "# Which courses" in config.read_text(encoding="utf-8")


def test_sync_folder_missing(root, tmp_path, canvas, keychain):
    keychain[BASE] = "t"
    with client(Account(BASE, root, "Test"), tmp_path) as api:
        api.post("/api/sync", json={})
        wait_for_sync(api)
        root.rename(tmp_path / "Moved")  # moved, renamed or deleted
        h = api.get("/api/health").json()
        assert (h["folder_missing"], h["choosing"]) == (True, False)
        assert api.get("/api/courses").json()["detail"] == "sync folder missing"
        assert api.get("/api/prefs").status_code == 200

        def folder(path, new):
            return api.post("/api/account/folder", json={"root": str(path), "new": new})
        (tmp_path / "Other").mkdir()
        (tmp_path / "Other" / "notes.txt").write_text("x")
        assert folder(tmp_path / "Other", False).json()["detail"] == "not a sync folder"
        assert folder(tmp_path / "Other", True).json()["detail"] == "folder not empty"

        # Found where it went: it's used as it was, and syncs.
        assert folder(tmp_path / "Moved", False).json()["root"] == str((tmp_path / "Moved").resolve())
        assert Account.load().root == (tmp_path / "Moved").resolve()
        assert api.get("/api/health").json()["folder_missing"] is False
        assert wait_for_sync(api)["phase"] == "done"
        assert [c["id"] for c in api.get("/api/courses").json()] == [1]

        # Or a new one: its courses are chosen before it syncs.
        (tmp_path / "Moved").rename(tmp_path / "Gone")
        assert folder(tmp_path / "Fresh", True).json()["signed_in"]
        assert api.get("/api/health").json()["choosing"] is True
        assert api.get("/api/sync").json()["phase"] == "done"  # (the last one; none started)
        assert api.get("/api/courses").json() == []


def test_sign_out_and_in_again(root, tmp_path, canvas, keychain):
    keychain[BASE] = "old"
    canvas.valid_tokens = {"new"}
    with client(Account(BASE, root, "Test"), tmp_path) as api:
        assert api.get("/api/account/check").json() == {"ok": False, "error": "token rejected"}  # it expired
        assert api.post("/api/account/credentials", json={"token": "nope"}).status_code == 400
        assert keychain[BASE] == "old"
        assert api.post("/api/account/credentials", json={"token": "new"}).json()["signed_in"]
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

    assert launch_and_watch(0.2) == "idle"  # never synced: the courses are chosen first
    pull(root, canvas)
    with Engine(root) as e:  # (as if long ago)
        e.state.db.execute("UPDATE courses SET synced_at = '2026-01-01T00:00:00+00:00'")
        e.state.commit()
    assert launch_and_watch(2) == "done"  # last synced long ago: it syncs
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


def moved_setup(api, root, tmp_path):
    """A synced folder, with things of yours in it."""
    assert api.post("/api/sync").status_code == 202
    assert wait_for_sync(api)["phase"] == "done"
    (root / ".canvas" / "notes").mkdir(exist_ok=True)
    (root / ".canvas" / "notes" / "mine.md").write_text("note")
    (root / "my own.txt").write_text("mine")
    (root / ".hidden").write_text("hidden")
    (root / "link").symlink_to("my own.txt")
    return sorted(p.relative_to(root).as_posix() for p in root.rglob("*") if "-wal" not in p.name and "-shm" not in p.name)


def assert_moved(api, old, new, files):
    assert sorted(p.relative_to(new).as_posix() for p in new.rglob("*")
                  if "-wal" not in p.name and "-shm" not in p.name) == files
    assert (new / "link").is_symlink() and (new / "link").read_text() == "mine"
    assert not old.exists()
    assert Account.load().root == new
    h = api.get("/api/health").json()
    assert h["root"] == str(new) and h["folder_missing"] is False
    assert [c["id"] for c in api.get("/api/courses").json()] == [1]


def test_move_folder_keeps_everything(root, tmp_path, canvas, keychain):
    keychain[BASE] = "t"
    canvas.put(1, "lec.pdf", b"lecture")
    with client(Account(BASE, root, "Test"), tmp_path) as api:
        files = moved_setup(api, root, tmp_path)
        new = (tmp_path / "Elsewhere" / "Canvas").resolve()  # (not there yet)
        got = api.post("/api/account/move", json={"root": str(new)}).json()
        assert got["root"] == str(new) and got["left_behind"] is None
        assert_moved(api, root, new, files)

        # It goes on from there: nothing downloaded again, nothing looks changed.
        lecture = next(new.rglob("lec.pdf"))
        before = lecture.stat().st_ino
        assert api.post("/api/sync").status_code == 202
        assert wait_for_sync(api)["phase"] == "done"
        assert lecture.stat().st_ino == before
        assert not [p for p in new.rglob("*") if "updated" in p.name or "mine)" in p.name]


def test_move_folder_to_another_disk(root, tmp_path, canvas, keychain, monkeypatch):
    keychain[BASE] = "t"
    canvas.put(1, "lec.pdf", b"lecture")
    import errno
    import os as real_os

    def no_rename(a, b, **kw):
        raise OSError(errno.EXDEV, "cross-device")
    with client(Account(BASE, root, "Test"), tmp_path) as api:
        files = moved_setup(api, root, tmp_path)
        new = (tmp_path / "Disk").resolve()
        monkeypatch.setattr("canvas_sync.local.os.rename", no_rename)
        got = api.post("/api/account/move", json={"root": str(new)}).json()
        monkeypatch.setattr("canvas_sync.local.os.rename", real_os.rename)
        assert got["root"] == str(new) and got["left_behind"] is None
        assert_moved(api, root, new, files)

        # A copy's inode isn't the old one, and its time may not be: still nothing looks changed.
        assert api.post("/api/sync").status_code == 202
        assert wait_for_sync(api)["phase"] == "done"
        assert not [p for p in new.rglob("*") if "updated" in p.name or "mine)" in p.name]


def test_move_folder_fails_leaving_it_as_it_was(root, tmp_path, canvas, keychain, monkeypatch):
    import errno
    import shutil

    keychain[BASE] = "t"
    real_rename, real_copy, real_usage = server.os.rename, shutil.copy2, shutil.disk_usage
    canvas.put(1, "lec.pdf", b"lecture")
    canvas.put(2, "hw.pdf", b"homework")
    new = (tmp_path / "New").resolve()
    with client(Account(BASE, root, "Test"), tmp_path) as api:
        files = moved_setup(api, root, tmp_path)
        before = (root / "my own.txt").read_text()

        def check(status, detail):
            r = api.post("/api/account/move", json={"root": str(new)})
            assert r.status_code == status and detail in r.json()["detail"]
            assert sorted(p.relative_to(root).as_posix() for p in root.rglob("*")
                          if "-wal" not in p.name and "-shm" not in p.name) == files
            assert (root / "my own.txt").read_text() == before
            assert Account.load() is None or Account.load().root == root
            assert not new.exists()  # (made for this, and gone again)
            assert api.get("/api/health").json()["folder_missing"] is False

        # The same disk: what had moved goes back.
        n = [0]

        def second_fails(a, b, **kw):
            n[0] += 1
            if n[0] == 2:
                raise PermissionError("in use")
            real_rename(a, b)
        monkeypatch.setattr("canvas_sync.local.os.rename", second_fails)
        check(400, "could not move")

        # Another disk: what was copied is cleared.
        def exdev(a, b, **kw):
            raise OSError(errno.EXDEV, "cross-device")
        copies = [0]

        def third_copy_fails(a, b, **kw):
            copies[0] += 1
            if copies[0] == 3:
                raise OSError("disk full")
            return real_copy(a, b, **kw)
        monkeypatch.setattr("canvas_sync.local.os.rename", exdev)
        monkeypatch.setattr("canvas_sync.local.shutil.copy2", third_copy_fails)
        check(400, "could not move")
        monkeypatch.setattr("canvas_sync.local.shutil.copy2", real_copy)

        monkeypatch.setattr("canvas_sync.local.shutil.disk_usage", lambda p: real_usage(p)._replace(free=0))
        check(400, "not enough room")


def test_move_folder_only_to_an_empty_folder(root, tmp_path, canvas, keychain):
    keychain[BASE] = "t"
    with client(Account(BASE, root, "Test"), tmp_path) as api:
        files = moved_setup(api, root, tmp_path)

        def move(path):
            return api.post("/api/account/move", json={"root": str(path)})
        assert move(root).json()["detail"] == "can't move into itself"
        assert move(root / "sub").json()["detail"] == "can't move into itself"
        assert move(root.parent).json()["detail"] == "move target not empty"  # (it holds this one)
        full = tmp_path / "Full"
        full.mkdir()
        (full / ".canvas").mkdir()
        assert move(full).json()["detail"] == "move target not empty"
        (tmp_path / "a file").write_text("x")
        assert move(tmp_path / "a file").json()["detail"] == "not a folder"
        assert sorted(p.relative_to(root).as_posix() for p in root.rglob("*")
                      if "-wal" not in p.name and "-shm" not in p.name) == files

        # What a file manager leaves in a folder doesn't count.
        tidy = (tmp_path / "Tidy").resolve()
        tidy.mkdir()
        (tidy / ".DS_Store").write_text("x")
        assert move(tidy).json()["root"] == str(tidy)


def test_nothing_touches_the_folder_while_it_moves(root, tmp_path, canvas, keychain, monkeypatch):
    keychain[BASE] = "t"
    seen = {}
    with client(Account(BASE, root, "Test"), tmp_path) as api:
        moved_setup(api, root, tmp_path)
        real = server.move_sync_folder

        def looking(src, dst, use):
            seen["courses"] = api.get("/api/courses").status_code
            seen["sync"] = api.post("/api/sync").status_code
            h = api.get("/api/health").json()
            seen["health"] = (h["folder_missing"], h["choosing"])
            seen["state"] = api.get("/api/sync").status_code
            seen["again"] = api.post("/api/account/move", json={"root": str(tmp_path / "Other")}).status_code
            return real(src, dst, use)
        monkeypatch.setattr(server, "move_sync_folder", looking)
        assert api.post("/api/account/move", json={"root": str(tmp_path / "New")}).status_code == 200
    assert seen == {"courses": 409, "sync": 409, "health": (False, False), "state": 200, "again": 409}
    assert not (tmp_path / "Other").exists()


def test_a_move_waits_for_what_is_being_answered(root, tmp_path, canvas, keychain, monkeypatch):
    keychain[BASE] = "t"
    order: list[str] = []
    asked, answer = threading.Event(), threading.Event()
    with client(Account(BASE, root, "Test"), tmp_path) as api:
        moved_setup(api, root, tmp_path)
        real_status, real_move = Engine.status, server.move_sync_folder

        def slow(self, *args, **kw):
            asked.set()
            answer.wait(5)
            order.append("answered")
            return real_status(self, *args, **kw)

        def moving(src, dst, use):
            order.append("moved")
            return real_move(src, dst, use)
        monkeypatch.setattr(Engine, "status", slow)
        monkeypatch.setattr(server, "move_sync_folder", moving)
        reading = threading.Thread(target=lambda: api.get("/api/status"))
        reading.start()
        assert asked.wait(5)
        moved: list[int] = []
        move = threading.Thread(target=lambda: moved.append(
            api.post("/api/account/move", json={"root": str(tmp_path / "New")}).status_code))
        move.start()
        time.sleep(0.5)
        assert order == []  # (still being answered: the move waits)
        answer.set()
        reading.join(5)
        move.join(10)
    assert order == ["answered", "moved"] and moved == [200]


def test_a_move_that_cannot_go_back_says_where_things_are(root, tmp_path, canvas, keychain, monkeypatch):
    import os as real_os

    keychain[BASE] = "t"
    real_rename = real_os.rename
    new = (tmp_path / "New").resolve()
    with client(Account(BASE, root, "Test"), tmp_path) as api:
        moved_setup(api, root, tmp_path)
        n = [0]

        def stuck(a, b, **kw):  # the second fails; putting the first back fails too
            n[0] += 1
            if n[0] == 2 or Path(a).parent == new:
                raise PermissionError("in use")
            real_rename(a, b)
        monkeypatch.setattr("canvas_sync.local.os.rename", stuck)
        monkeypatch.setattr("canvas_sync.local.time.sleep", lambda s: None)
        r = api.post("/api/account/move", json={"root": str(new)})
    assert r.status_code == 400 and r.json()["detail"] == f"partly moved\n{root.resolve()}\n{new}"
    assert len(list(new.iterdir())) == 1  # (the one that wouldn't go back)
    assert Account.load() is None or Account.load().root == root


def test_a_move_to_a_disk_without_links_says_so(root, tmp_path, canvas, keychain, monkeypatch):
    import errno

    keychain[BASE] = "t"
    new = (tmp_path / "Stick").resolve()
    with client(Account(BASE, root, "Test"), tmp_path) as api:
        files = moved_setup(api, root, tmp_path)

        def exdev(a, b, **kw):
            raise OSError(errno.EXDEV, "cross-device")

        def no_links(target, link, **kw):
            raise OSError(errno.EPERM, "not here")
        monkeypatch.setattr("canvas_sync.local.os.rename", exdev)
        monkeypatch.setattr("canvas_sync.local.os.symlink", no_links)
        r = api.post("/api/account/move", json={"root": str(new)})
        assert r.status_code == 400 and r.json()["detail"] == "links not supported there"
        assert not new.exists()
        assert sorted(p.relative_to(root).as_posix() for p in root.rglob("*")
                      if "-wal" not in p.name and "-shm" not in p.name) == files


def test_move_folder_waits_for_a_sync(root, tmp_path, canvas, keychain, monkeypatch):
    keychain[BASE] = "t"

    async def still_going(*args, **kw):
        pass
    monkeypatch.setattr(server, "_run_sync", still_going)  # (so the job stays at its first phase)
    with client(Account(BASE, root, "Test"), tmp_path) as api:
        assert api.post("/api/sync").status_code == 202
        assert api.get("/api/sync").json()["running"]
        assert api.post("/api/account/move", json={"root": str(tmp_path / "New")}).status_code == 409
        assert not (tmp_path / "New").exists()


def test_the_folder_opens_in_the_file_manager(root, tmp_path, canvas, keychain, monkeypatch):
    opened = []
    monkeypatch.setattr(server, "open_path", lambda p, **kw: opened.append((p, kw)))
    with client(Account(BASE, root, "Test"), tmp_path) as api:
        assert api.post("/api/open", json={"path": ""}).status_code == 200
    assert opened == [(root, {"reveal": False, "preview": False})]


# -- signing in with a browser (for schools that don't let students make tokens) -------------------

def test_auth_is_kept_as_one_string():
    from canvas_sync import Auth
    assert Auth.parse("abc~123") == Auth(token="abc~123")
    session = Auth(cookies={"canvas_session": "s", "_csrf_token": "c"})
    assert Auth.parse(session.secret()) == session and session.kind == "session"


def test_sync_with_a_browser_sign_in(root, fake):
    from canvas_sync import Auth, CanvasError
    fake.valid_sessions = {"s1"}
    fake.put(1, "notes.pdf", b"x")
    fake.files[1]["url"] = "https://files.test/blob"  # (in file storage, elsewhere)

    async def sync(auth: Auth) -> dict[str, str] | None:
        async with CanvasClient(BASE, auth, transport=httpx.MockTransport(fake.handle)) as client:
            with Engine(root, client) as e:
                assert await e.apply(await e.plan()) == []
            return client.cookies()

    import asyncio
    fake.renew_session, fake.valid_sessions = "s2", {"s1", "s2"}
    assert asyncio.run(sync(Auth(cookies={"canvas_session": "s1"}))) == {"canvas_session": "s2"}  # (JSON after `while(1);`)
    assert (root / "Fall 2026" / "MATH 221" / "Files" / "Lectures" / "notes.pdf").read_bytes() == b"stored:/blob"
    assert fake.seen_cookies["files.test"] is None  # the cookies stay with Canvas

    # Signed out (it expired): the sign-in page is an error, not a page of nothing.
    with pytest.raises(CanvasError) as err:
        asyncio.run(sync(Auth(cookies={"canvas_session": "old"})))
    assert err.value.signed_out

    # Even signed out halfway: a course's files aren't taken for deleted.
    fake.renew_session, fake.valid_sessions = "gone", {"s1"}
    with pytest.raises(CanvasError) as err:
        asyncio.run(sync(Auth(cookies={"canvas_session": "s1"})))
    assert err.value.signed_out
    assert (root / "Fall 2026" / "MATH 221" / "Files" / "Lectures" / "notes.pdf").read_bytes() == b"stored:/blob"


def test_sign_in_with_a_browser(tmp_path, canvas, keychain):
    canvas.valid_sessions = {"s1", "s3"}
    canvas.renew_session = "s2"
    with client(None, tmp_path) as api:
        def setup(cookies):
            return api.post("/api/account/setup", json={"url": "canvas.test", "cookies": cookies, "root": str(tmp_path / "Canvas")})
        assert setup({"canvas_session": "nope"}).json()["detail"] == "sign-in rejected"
        assert setup({}).json()["detail"] == "token rejected"  # (neither given)
        got = setup({"canvas_session": "s1"}).json()
        assert (got["signed_in"], got["auth"], got["user"]) == (True, "session", "Test")
        assert api.get("/api/account/check").json() == {"ok": True, "user": "Test"}

        canvas.valid_sessions.add("s2")
        assert api.put("/api/courses/choice", json={"sync": [1], "skip": []}).json()["running"]
        assert wait_for_sync(api)["phase"] == "done"
        assert keychain[BASE] == '{"cookies": {"canvas_session": "s2"}}'  # renewed on the way

        # It expires: the sync says so, and signing in again picks up from there.
        canvas.valid_sessions = {"s3"}
        api.post("/api/sync", json={})
        state = wait_for_sync(api)
        assert (state["phase"], state["expired"]) == ("failed", True)
        assert "signed out of Canvas" in state["errors"][0]
        assert api.post("/api/account/credentials", json={"cookies": {"canvas_session": "s3"}}).json()["auth"] == "session"
        canvas.renew_session = None
        api.post("/api/sync", json={})
        assert wait_for_sync(api)["phase"] == "done"

        # Or a token, after all.
        assert api.post("/api/account/credentials", json={"token": "t"}).json()["auth"] == "token"
        assert keychain[BASE] == "t"


def test_a_file_that_fails_is_listed_apart(root, tmp_path, canvas, keychain):
    keychain[BASE] = "t"
    canvas.put(2, "locked.pdf", b"x")
    canvas.files[2]["url"] = f"{BASE}/files/2/gone"  # (404)
    with client(Account(BASE, root, "Test"), tmp_path) as api:
        api.post("/api/sync", json={})
        state = wait_for_sync(api)
        assert (state["phase"], state["errors"]) == ("done", [])
        assert [f["path"] for f in state["failed"]] == ["Fall 2026/MATH 221/Files/Lectures/locked.pdf"]
        assert "HTTP 404" in state["failed"][0]["error"]
