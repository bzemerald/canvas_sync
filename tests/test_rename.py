"""Renaming folders in the app, and the pinned sidebar list."""

from __future__ import annotations

import os
import shutil
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from canvas_sync import Engine
from canvas_sync.config import Account, Settings, needs_titles, save_pinned
from canvas_sync.things import Entry, Thing
from canvas_sync.plan import Scope
from canvas_sync.server import create_app
from fake_canvas import BASE, COURSE, FakeCanvas, kinds, pull

MOD = f"{COURSE}/Modules"
WEEK1 = f"{MOD}/01 Week 1"
LINK = f"{COURSE}/Files/Lectures/lec1.pdf"


def rename(root: Path, rel: str, name: str) -> str:
    with Engine(root) as e:
        return e.rename_folder(rel, name)


def names(root: Path) -> dict[str, str]:
    return Settings.load(root / ".canvas/config.toml").folder_names


@pytest.mark.links
def test_renamed_folder_syncs_like_before(root, fake: FakeCanvas):
    pull(root, fake)
    assert rename(root, WEEK1, "Week 1 - Vectors") == f"{MOD}/Week 1 - Vectors"
    assert names(root) == {WEEK1: "Week 1 - Vectors"}
    assert (root / MOD / "Week 1 - Vectors/lec1.pdf").read_bytes() == b"v1"
    assert (root / LINK).read_bytes() == b"v1"  # the link from Files/ into it was repointed
    with Engine(root) as e:
        assert e.status() == []  # not "moved": nothing changed as far as syncing goes
    assert pull(root, fake).actions == []

    # What Canvas adds to that module later goes into the renamed folder; updates too.
    fake.put(101, "lec2.pdf", b"w")
    fake.modules[0]["items"].append({"type": "File", "content_id": 101})
    fake.put(100, "lec1.pdf", b"v2", version="2026-09-02T00:00:00Z")
    assert kinds(pull(root, fake)) == [
        ("download", f"{MOD}/Week 1 - Vectors/lec2.pdf"),
        ("link", f"{COURSE}/Files/Lectures/lec2.pdf"),
        ("update", f"{MOD}/Week 1 - Vectors/lec1.pdf"),
    ]
    assert not (root / WEEK1).exists()


@pytest.mark.links
def test_rename_the_folder_links_point_into_and_its_parents(root, fake):
    pull(root, fake)
    rename(root, MOD, "课件")
    rename(root, f"{COURSE}/课件/01 Week 1", "第一周")
    rename(root, COURSE, "线性代数")
    rename(root, "Fall 2026", "2026 秋")
    real = root / "2026 秋/线性代数/课件/第一周/lec1.pdf"
    link = root / "2026 秋/线性代数/Files/Lectures/lec1.pdf"
    assert real.read_bytes() == b"v1" and link.is_symlink() and link.read_bytes() == b"v1"
    assert names(root) == {MOD: "课件", WEEK1: "第一周", COURSE: "线性代数", "Fall 2026": "2026 秋"}
    assert pull(root, fake).actions == []
    with Engine(root) as e:
        # Listed, each says what Canvas calls it; what you didn't rename doesn't.
        was = {x.name: x.renamed_from for x in e.list_dir("2026 秋/线性代数")}
        assert was["课件"] == "Modules" and was["Files"] is None
        assert [x.renamed_from for x in e.list_dir("2026 秋")] == [COURSE.split("/")[-1]]
        assert [c.id for c in e.courses_in(Scope(["2026 秋"]))] == [1]
        e.reindex()
        assert [h.title for h in e.search("线性代数 lec1")] == ["lec1.pdf"]  # the new name is a course alias


def test_a_rename_no_course_goes_through_changes_nothing(root, fake):
    # (Left over: a term folder renamed "fa26" from a name no course has, then back.)
    pull(root, fake)
    cfg = root / ".canvas/config.toml"
    cfg.write_text(cfg.read_text(encoding="utf-8").replace("[folder_names]\n", '[folder_names]\nfa26 = "Fall 2026"\n'), encoding="utf-8")
    assert rename(root, MOD, "课件") == f"{COURSE}/课件"
    assert names(root) == {"fa26": "Fall 2026", MOD: "课件"}  # (not under "fa26/")
    with Engine(root) as e:
        assert {x.name: x.renamed_from for x in e.list_dir(COURSE)}["课件"] == "Modules"
    assert pull(root, fake).actions == []


def test_renaming_back_what_you_renamed_in_finder_records_nothing(root, fake):
    pull(root, fake)
    os.rename(root / "Fall 2026", root / "fa26")
    assert rename(root, "fa26", "Fall 2026") == "Fall 2026"
    assert names(root) == {}
    assert pull(root, fake).actions == []


def test_renaming_back_forgets_the_rename(root, fake):
    pull(root, fake)
    rename(root, WEEK1, "W1")
    rename(root, f"{MOD}/W1", "01 Week 1")
    assert names(root) == {}
    assert pull(root, fake).actions == []


def test_rename_refuses_bad_names_and_clashes(root, fake):
    pull(root, fake)
    (root / MOD / "Mine").mkdir()
    with Engine(root) as e:
        with pytest.raises(FileExistsError):
            e.rename_folder(WEEK1, "Mine")
        for bad in ["", "  ", ".hidden"]:
            with pytest.raises(ValueError):
                e.rename_folder(WEEK1, bad)
        with pytest.raises(ValueError):
            e.rename_folder(".canvas", "x")
        with pytest.raises(LookupError):
            e.rename_folder(LINK, "x")  # a file
        assert e.rename_folder(WEEK1, "a/b") == f"{MOD}/a_b"  # one folder, not two
        assert e.rename_folder(f"{MOD}/a_b", "A_B") == f"{MOD}/A_B"  # case-only rename works
    assert pull(root, fake).actions == []


def test_rename_keeps_your_own_moves_and_edits(root, fake):
    pull(root, fake)
    mine = root / COURSE / "Mine"
    mine.mkdir()
    os.rename(root / WEEK1 / "lec1.pdf", mine / "lec1.pdf")
    (mine / "lec1.pdf").write_bytes(b"edited")
    pull(root, fake)  # the move is remembered (pinned)
    rename(root, f"{COURSE}/Mine", "My stuff")
    with Engine(root) as e:
        assert [(s.path, s.states) for s in e.status()] == [(f"{COURSE}/My stuff/lec1.pdf", ["modified"])]
    assert pull(root, fake).actions == []


@pytest.fixture
def api(root, fake):
    pull(root, fake)
    with TestClient(create_app(Account(BASE, root), "s"), headers={"Authorization": "Bearer s"}) as c:
        yield c


def names_in_app(api) -> tuple[str, str, bool]:
    c = api.get("/api/courses").json()[0]
    return c["label"], c["term_label"], c["renamed"]


def test_a_course_and_term_are_renamed_without_touching_their_folders(root, fake, api):
    pull(root, fake)
    before = sorted(p.relative_to(root).as_posix() for p in root.rglob("*") if ".canvas" not in p.parts)
    code = COURSE.split("/")[-1]

    assert api.put("/api/courses/1/title", json={"title": " 线/代 "}).status_code == 200
    assert api.put("/api/terms/title", json={"term": "Fall 2026", "title": "大二上"}).status_code == 200
    assert names_in_app(api) == ("线/代", "大二上", True)
    assert api.get("/api/courses").json()[0]["dir"] == COURSE
    assert sorted(p.relative_to(root).as_posix() for p in root.rglob("*") if ".canvas" not in p.parts) == before
    assert names(root) == {}
    assert pull(root, fake).actions == []
    with Engine(root) as e:
        e.reindex()
        assert [h.title for h in e.search("线/代 lec1")] == ["lec1.pdf"]  # a course's title answers too

    # Its own name, or none: back to that.
    assert api.put("/api/courses/1/title", json={"title": code}).status_code == 200
    assert api.put("/api/terms/title", json={"term": "Fall 2026", "title": ""}).status_code == 200
    assert names_in_app(api) == (code, "Fall 2026", False)
    settings = Settings.load(root / ".canvas/config.toml")
    assert settings.course_titles == {} and settings.term_titles == {}

    assert api.put("/api/courses/99/title", json={"title": "x"}).status_code == 404
    assert api.put("/api/terms/title", json={"term": "Nope", "title": "x"}).status_code == 404


def test_a_course_without_a_folder_can_be_renamed(root, fake, api):
    pull(root, fake)
    shutil.rmtree(root / COURSE)
    assert api.put("/api/courses/1/title", json={"title": "线代"}).status_code == 200
    assert names_in_app(api)[0] == "线代"


def test_renaming_a_course_folder_leaves_what_the_app_calls_it(root, fake, api):
    pull(root, fake)
    assert api.post("/api/rename", json={"path": COURSE, "name": "Folder"}).status_code == 200
    assert names_in_app(api) == (COURSE.split("/")[-1], "Fall 2026", False)
    assert api.get("/api/courses").json()[0]["dir"] == "Fall 2026/Folder"


def test_names_from_folders_become_titles_once(root, fake):
    pull(root, fake)
    rename(root, COURSE, "线性代数")
    rename(root, "Fall 2026", "2026 秋")
    cfg = root / ".canvas/config.toml"
    text = cfg.read_text(encoding="utf-8")
    start, end = text.index("[course_titles]"), text.index("[course_aliases]")
    cfg.write_text(text[:start] + text[end:], encoding="utf-8")  # (as an older version wrote it)
    assert needs_titles(cfg)

    with TestClient(create_app(Account(BASE, root), "s"), headers={"Authorization": "Bearer s"}) as client:
        assert not needs_titles(cfg)
        assert names_in_app(client) == ("线性代数", "2026 秋", True)
        assert (root / "2026 秋/线性代数").is_dir()
        assert names(root) == {COURSE: "线性代数", "Fall 2026": "2026 秋"}  # (the folders keep their names)

        # Once: going back to its own name doesn't bring it back.
        client.put("/api/courses/1/title", json={"title": ""})
    create_app(Account(BASE, root), "s")
    assert Settings.load(cfg).course_titles == {}


def test_api_rename_and_pin(api, root):
    assert api.put("/api/pinned", json={"entries": [{"type": "folder", "path": WEEK1}]}).json() == [
        {"type": "folder", "path": WEEK1, "title": "", "hidden": False, "name": "01 Week 1", "exists": True, "in_course": 1}
    ]
    r = api.post("/api/rename", json={"path": WEEK1, "name": "Week One"})
    assert r.json() == {"path": f"{MOD}/Week One"}
    assert api.get("/api/pinned").json()[0]["path"] == f"{MOD}/Week One"  # the pin followed
    assert [h["path"] for h in api.get("/api/search", params={"q": "lec1"}).json()] == [f"{MOD}/Week One/lec1.pdf"]
    assert api.post("/api/rename", json={"path": f"{MOD}/Week One", "name": ""}).status_code == 400
    assert api.post("/api/rename", json={"path": "../x", "name": "y"}).status_code == 400

    api.post("/api/rename", json={"path": COURSE, "name": "Linear Algebra"})
    [course] = api.get("/api/courses").json()
    assert course["dir"] == "Fall 2026/Linear Algebra" and course["label"] == "MATH 221" and not course["renamed"]
    assert course["term_label"] == "Fall 2026"
    assert course["source_dirs"]["modules"] == "Fall 2026/Linear Algebra/Modules"
    assert api.get("/api/pinned").json()[0]["path"] == "Fall 2026/Linear Algebra/Modules/Week One"
    # Search results call the course by its new name too.
    assert {h["course"] for h in api.get("/api/search", params={"q": "lec1"}).json()} == {"MATH 221"}


def test_pinned_courses(api, root):
    cfg = root / ".canvas/config.toml"
    # A course's own folder pinned is the course.
    save_pinned(cfg, [Entry(Thing("folder", path=COURSE))])
    course = {"type": "course", "course": 1, "title": "", "hidden": False, "name": "MATH 221", "exists": True, "in_course": 1}
    assert api.get("/api/pinned").json() == [course]
    assert 'type = "course"' in cfg.read_text(encoding="utf-8")
    api.put("/api/courses/1/title", json={"title": "Linear Algebra"})
    assert api.get("/api/pinned").json()[0]["name"] == "Linear Algebra"  # by id: renaming doesn't matter
    api.put("/api/terms/title", json={"term": "Fall 2026", "title": "2026 秋"})
    assert api.get("/api/courses").json()[0]["term_label"] == "2026 秋"
