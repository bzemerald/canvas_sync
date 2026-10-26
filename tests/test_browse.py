"""Partial pulls, restoring, folder listings, smart folders, thumbnails: what the app's file
browser is built on."""

from __future__ import annotations

import io
import os
import time
from pathlib import Path

import httpx
import pytest
from fastapi.testclient import TestClient
from PIL import Image

from canvas_sync import CanvasClient, Engine
from canvas_sync.config import Account, load_pinned, save_pinned
from canvas_sync.things import Entry, Thing
from canvas_sync.plan import Scope
from canvas_sync.server import create_app
from canvas_sync.thumbs import thumbnail
from fake_canvas import BASE, COURSE, FakeCanvas, kinds, make_pdf, pull, wait_for_sync

MOD1 = f"{COURSE}/Modules/01 Week 1/lec1.pdf"
MOD2 = f"{COURSE}/Modules/02 Week 2/lec2.pdf"
LINK1 = f"{COURSE}/Files/Lectures/lec1.pdf"
LINK2 = f"{COURSE}/Files/Lectures/lec2.pdf"
NOTES = f"{COURSE}/Files/notes.txt"


def add_week2(fake: FakeCanvas) -> None:
    fake.put(101, "lec2.pdf", b"w2")
    fake.module(2, "Week 2", [{"type": "File", "content_id": 101}])
    fake.put(102, "notes.txt", b"n", folder=10)


def entries(root: Path, rel: str) -> dict[str, dict]:
    with Engine(root) as e:
        return {x.name: x.__dict__ for x in e.list_dir(rel)}


# -- partial pulls ----------------------------------------------------------------


@pytest.mark.links
def test_pull_one_folder(root, fake):
    pull(root, fake)
    add_week2(fake)
    plan = pull(root, fake, Scope([f"{COURSE}/Modules/02 Week 2"]))
    assert kinds(plan) == [("download", MOD2), ("link", LINK2)]  # its link in Files/ too
    assert not (root / NOTES).exists()
    assert kinds(pull(root, fake)) == [("download", NOTES)]  # the rest comes with a full pull


@pytest.mark.links
def test_pull_a_view_fetches_the_real_file(root, fake):
    pull(root, fake)
    add_week2(fake)
    plan = pull(root, fake, Scope([f"{COURSE}/Files/Lectures"]))
    assert kinds(plan) == [("download", MOD2), ("link", LINK2)]
    assert (root / LINK2).read_bytes() == b"w2"


def test_pull_one_file_by_id(root, fake):
    pull(root, fake)
    add_week2(fake)
    fake.put(100, "lec1.pdf", b"v2", version="2026-09-02T00:00:00Z")
    assert kinds(pull(root, fake, Scope(file_ids={100}))) == [("update", MOD1)]
    assert (root / MOD1).read_bytes() == b"v2" and not (root / MOD2).exists()


def test_scope_finds_courses_by_term_or_course_folder(root, fake):
    pull(root, fake)
    with Engine(root) as e:
        assert [c.id for c in e.courses_in(Scope(["Fall 2026"]))] == [1]
        assert [c.id for c in e.courses_in(Scope([f"{COURSE}/Modules"]))] == [1]
        assert e.courses_in(Scope(["Spring 2020"])) == []


# -- restore --------------------------------------------------------------------


def test_restore_only_what_is_in_scope(root, fake):
    add_week2(fake)
    pull(root, fake)
    (root / MOD1).write_bytes(b"mine 1")
    (root / MOD2).write_bytes(b"mine 2")
    with Engine(root) as e:
        todo = e.restorable(Scope([f"{COURSE}/Modules/01 Week 1"]))
        assert [(s.path, s.states) for s in todo] == [(MOD1, ["modified"])]
        assert e.restore_files([s.file_id for s in todo]) == [MOD1]
        assert [s.path for s in e.restorable(Scope([COURSE]))] == [MOD2]
    assert (root / MOD1).read_bytes() == b"v1" and (root / MOD2).read_bytes() == b"mine 2"


def test_restore_folder_brings_back_deleted_and_fixes_moved_in_place(root, fake):
    add_week2(fake)
    pull(root, fake)
    (root / MOD1).unlink()
    pull(root, fake)  # now recorded as deleted by you
    mine = root / COURSE / "Mine/lec2.pdf"
    mine.parent.mkdir()
    os.rename(root / MOD2, mine)
    mine.write_bytes(b"edited after moving")
    with Engine(root) as e:
        assert sorted(e.restore(root / COURSE)) == sorted([MOD1, f"{COURSE}/Mine/lec2.pdf"])
    assert (root / MOD1).read_bytes() == b"v1"
    assert mine.read_bytes() == b"w2" and not (root / MOD2).exists()  # stays where you put it
    assert pull(root, fake).actions[0].kind == "pin"


# -- folder listing ---------------------------------------------------------------


@pytest.mark.links
def test_list_dir_marks_canvas_files_links_changes_and_deletions(root, fake):
    add_week2(fake)
    pull(root, fake)
    (root / MOD1).write_bytes(b"mine")
    (root / COURSE / "Files/Lectures/my notes.md").write_text("hi")
    (root / LINK2).unlink()  # a link you removed is not a deleted file
    (root / NOTES).unlink()

    lectures = entries(root, f"{COURSE}/Files/Lectures")
    assert lectures["lec1.pdf"]["link"] == MOD1 and lectures["lec1.pdf"]["file_id"] == 100
    assert lectures["lec1.pdf"]["states"] == ["modified"]
    assert lectures["my notes.md"]["file_id"] is None
    assert "lec2.pdf" not in lectures

    files = entries(root, f"{COURSE}/Files")
    assert files["notes.txt"]["deleted"] and files["notes.txt"]["states"] == ["missing"]
    assert files["Lectures"]["type"] == "dir"
    assert list(files) == ["Lectures", "notes.txt"]  # folders first

    course = entries(root, COURSE)
    assert course["Modules"]["changes"] == 1 and course["Files"]["changes"] == 1
    assert (course["Modules"]["modified_inside"], course["Modules"]["deleted_inside"]) == (1, 0)
    assert (course["Files"]["modified_inside"], course["Files"]["deleted_inside"]) == (0, 1)
    assert entries(root, "Fall 2026")["MATH 221"]["course_id"] == 1

    week1 = entries(root, f"{COURSE}/Modules/01 Week 1")["lec1.pdf"]
    assert week1["url"] == "/courses/1/files/100" and week1["link"] is None


def test_list_dir_sorts_naturally_and_hides_internal_files(root, fake):
    pull(root, fake)
    for name in ["Week 10", "Week 2", ".hidden"]:
        (root / COURSE / name).mkdir()
    assert [n for n in entries(root, COURSE) if n.startswith("Week")] == ["Week 2", "Week 10"]
    assert ".canvas" not in entries(root, "") and ".hidden" not in entries(root, COURSE)
    with Engine(root) as e, pytest.raises(LookupError):
        e.list_dir("../..")


# -- smart folders, kinds, thumbnails ----------------------------------------------


def test_smart_folders_are_saved_in_config_keeping_comments(root):
    """A smart folder is a search, pinned, with a name of your own."""
    cfg = root / ".canvas/config.toml"
    mt1 = Entry(Thing("search", query="mt1 OR midterm1", courses=(1,), kinds=("file",), content=True), "Midterm 1")
    syllabi = Entry(Thing("search", query="", kinds=("syllabus",)), "Syllabi")
    save_pinned(cfg, [mt1, syllabi])
    assert load_pinned(cfg) == [mt1, syllabi]
    assert "# How canvas-sync lays out" in cfg.read_text(encoding="utf-8")


def test_search_by_kind_alone(root, fake):
    fake.announcements.append({"id": 7, "title": "Welcome", "message": "<p>hi</p>", "posted_at": "2026-09-01T00:00:00Z"})
    pull(root, fake)
    with Engine(root) as e:
        e.reindex()
        assert [h.title for h in e.search("", kinds=["announcement"])] == ["Welcome"]
        assert [h.kind for h in e.search("", course_ids=[1], kinds=["file"])] == ["file"]


def test_thumbnails(root):
    (root / "slides.pdf").write_bytes(make_pdf("Hello"))
    Image.new("RGBA", (800, 400), (255, 0, 0, 128)).save(root / "photo.png")
    (root / "notes.txt").write_text("no preview")
    pdf = thumbnail(root, "slides.pdf", 128)
    assert pdf and max(Image.open(pdf).size) == 128
    png = thumbnail(root, "photo.png", 200)
    assert png and Image.open(png).size == (200, 100)
    assert thumbnail(root, "photo.png", 200) == png  # cached
    time.sleep(0.01)
    Image.new("RGB", (100, 100)).save(root / "photo.png")
    assert thumbnail(root, "photo.png", 200) != png  # changed file, new thumbnail
    assert thumbnail(root, "notes.txt") is None


# -- the API the app uses ---------------------------------------------------------


@pytest.fixture
def api(root, fake, monkeypatch):
    add_week2(fake)
    pull(root, fake)
    opened = []
    monkeypatch.setattr("canvas_sync.server.open_path", lambda p, **kw: opened.append((p, kw)))
    monkeypatch.setattr(
        "canvas_sync.server.CanvasClient",
        lambda url, token: CanvasClient(url, token, transport=httpx.MockTransport(fake.handle)),
    )
    monkeypatch.setattr(Account, "token", lambda self: "t")
    with TestClient(create_app(Account(BASE, root), "s"), headers={"Authorization": "Bearer s"}) as c:
        c.opened = opened  # type: ignore[attr-defined]
        yield c


def test_api_tree_and_restore(api, root):
    names = [e["name"] for e in api.get("/api/tree", params={"path": f"{COURSE}/Modules"}).json()]
    assert names == ["01 Week 1", "02 Week 2"]
    assert api.get("/api/tree", params={"path": ".canvas"}).status_code == 400
    assert api.get("/api/tree", params={"path": "nope"}).status_code == 404

    (root / MOD1).write_bytes(b"mine")
    req = {"paths": [COURSE]}
    preview = api.post("/api/restore", json={**req, "dry_run": True}).json()
    assert [f["path"] for f in preview["files"]] == [MOD1]
    assert (root / MOD1).read_bytes() == b"mine"  # dry run changed nothing
    assert api.post("/api/restore", json=req).json() == {"restored": [MOD1]}
    assert (root / MOD1).read_bytes() == b"v1"
    assert api.post("/api/restore", json={}).status_code == 400


def test_api_scoped_sync(api, root, fake):
    fake.put(101, "lec2.pdf", b"w2 v2", version="2026-09-03T00:00:00Z")
    fake.put(102, "notes.txt", b"n v2", version="2026-09-03T00:00:00Z", folder=10)
    assert api.post("/api/sync", json={"paths": [f"{COURSE}/Modules/02 Week 2"]}).status_code == 202
    state = wait_for_sync(api)
    assert state["phase"] == "done" and state["changes"] == {"update": 1}
    assert state["scope"] == [f"{COURSE}/Modules/02 Week 2"]
    assert (root / MOD2).read_bytes() == b"w2 v2" and (root / NOTES).read_bytes() == b"n"
    assert api.post("/api/sync", json={"paths": ["../elsewhere"]}).status_code == 400


def test_api_sync_with_no_files_to_fetch_still_stores_the_rest(api, fake):
    fake.module(3, "Week 3", [{"type": "SubHeader", "title": "Reading"}])
    fake.announcements.append({"id": 7, "title": "No class Friday", "message": "<p>Enjoy</p>",
                               "posted_at": "2026-09-04T00:00:00Z"})
    assert api.post("/api/sync", json={}).status_code == 202
    state = wait_for_sync(api)
    assert state["phase"] == "done" and state["changes"] == {}
    assert [m["name"] for m in api.get("/api/courses/1/modules").json()] == ["Week 1", "Week 2", "Week 3"]
    assert [a["title"] for a in api.get("/api/courses/1/items", params={"kind": "announcement"}).json()] == ["No class Friday"]


def test_api_smart_folders_thumbs_and_preview(api, root):
    folder = {"type": "search", "query": "lec2", "courses": [1], "kinds": ["file"], "content": False}
    [got] = api.put("/api/pinned", json={"entries": [{**folder, "title": "Week 2"}]}).json()
    assert got == {**folder, "title": "Week 2", "hidden": False, "name": None, "exists": True, "in_course": None}
    assert api.put("/api/pinned", json={"entries": [{**folder, "kinds": ["movie"]}]}).status_code == 400
    assert api.put("/api/pinned", json={"entries": []}).json() == []

    (root / COURSE / "slides.pdf").write_bytes(make_pdf("Hi"))
    r = api.get("/api/thumb", params={"path": f"{COURSE}/slides.pdf", "size": 64})
    assert r.status_code == 200 and Image.open(io.BytesIO(r.content)).format == "JPEG"
    assert api.get("/api/thumb", params={"path": NOTES}).status_code == 404

    assert api.post("/api/open", json={"path": MOD1, "preview": True}).status_code == 200
    assert api.opened[-1][1] == {"reveal": False, "preview": True}  # type: ignore[attr-defined]
    assert api.post("/api/open", json={"path": ".canvas/config.toml"}).status_code == 400


def test_server_exits_when_the_app_goes_away(root, tmp_path):
    """The app holds the server's stdin; if the app dies without cleaning up, the pipe
    closes and the server must not linger."""
    import json
    import subprocess
    import sys

    env = {**os.environ, "CANVAS_URL": BASE, "CANVAS_ROOT": str(root), "CANVAS_SYNC_HOME": str(tmp_path / "home")}
    proc = subprocess.Popen(
        [sys.executable, "-m", "canvas_sync.cli", "serve", "--exit-with-stdin"],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env,
    )
    try:
        assert json.loads(proc.stdout.readline())["port"] > 0
        assert proc.poll() is None
        proc.stdin.close()
        assert proc.wait(timeout=10) == 0
    finally:
        proc.kill()
