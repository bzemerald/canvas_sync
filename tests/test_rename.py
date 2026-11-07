"""Renaming folders in the app, and the pinned sidebar list."""

from __future__ import annotations

import os
import shutil
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from canvas_sync import Engine, agent
from canvas_sync.config import (
    Account, ConfigError, Settings, change_things, needs_titles, old_folder_names, save_pinned, update_skip_folders,
)
from canvas_sync.engine import migrate_folder_names
from canvas_sync.plan import Scope
from canvas_sync.things import Entry, Thing
from canvas_sync.catalog import catalog
from canvas_sync.server import create_app
from fake_canvas import BASE, COURSE, FakeCanvas, kinds, pull

MOD = f"{COURSE}/Modules"
WEEK1 = f"{MOD}/01 Week 1"
LINK = f"{COURSE}/Files/Lectures/lec1.pdf"


def rename(root: Path, rel: str, name: str) -> str:
    with Engine(root) as e:
        e.rename_folder(rel, name)
    return rel


def names(root: Path) -> dict[str, str]:
    return Settings.load(root / ".canvas/config.toml").folder_titles


def tree(root: Path) -> list[str]:
    return sorted(p.relative_to(root).as_posix() for p in root.rglob("*") if ".canvas" not in p.parts)


@pytest.mark.links
def test_renaming_a_folder_changes_only_what_the_app_calls_it(root, fake: FakeCanvas):
    pull(root, fake)
    before = tree(root)
    assert rename(root, WEEK1, " Week 1 - Vectors ") == WEEK1
    assert names(root) == {WEEK1: "Week 1 - Vectors"}
    assert tree(root) == before
    with Engine(root) as e:
        assert e.status() == []
        [week] = e.list_dir(MOD)
    assert (week.name, week.path, week.renamed_from) == ("Week 1 - Vectors", WEEK1, "01 Week 1")
    assert pull(root, fake).actions == []

    # What Canvas adds to it later goes into it; updates too.
    fake.put(101, "lec2.pdf", b"w")
    fake.modules[0]["items"].append({"type": "File", "content_id": 101})
    fake.put(100, "lec1.pdf", b"v2", version="2026-09-02T00:00:00Z")
    assert kinds(pull(root, fake)) == [
        ("download", f"{WEEK1}/lec2.pdf"),
        ("link", f"{COURSE}/Files/Lectures/lec2.pdf"),
        ("update", f"{WEEK1}/lec1.pdf"),
    ]


def test_a_folder_gets_its_own_name_back(root, fake):
    pull(root, fake)
    for back_to in ("", "  ", "01 Week 1"):
        rename(root, WEEK1, "W1")
        assert names(root) == {WEEK1: "W1"}
        rename(root, WEEK1, back_to)
        assert names(root) == {}
    with Engine(root) as e:
        [week] = e.list_dir(MOD)
    assert (week.name, week.renamed_from) == ("01 Week 1", None)


def test_folders_inside_one_another_and_your_own_can_be_renamed(root, fake):
    pull(root, fake)
    (root / COURSE / "Mine").mkdir()
    rename(root, MOD, "课件")
    rename(root, WEEK1, "第一周")
    rename(root, f"{COURSE}/Mine", "我的")
    with Engine(root) as e:
        assert {x.path: x.name for x in e.list_dir(COURSE)}[MOD] == "课件"
        assert {x.path: x.name for x in e.list_dir(COURSE)}[f"{COURSE}/Mine"] == "我的"
        assert [x.name for x in e.list_dir(MOD)] == ["第一周"]
    assert pull(root, fake).actions == []


def test_rename_refuses_what_is_not_a_folder(root, fake):
    pull(root, fake)
    for rel, error in (("", ValueError), (".canvas", ValueError), ("nope", LookupError), (f"{WEEK1}/lec1.pdf", LookupError)):
        with pytest.raises(error):
            rename(root, rel, "x")


def test_syncing_and_restoring_in_a_renamed_folder(root, fake):
    pull(root, fake)
    rename(root, WEEK1, "W1")
    (root / WEEK1 / "lec1.pdf").write_bytes(b"edited")
    with Engine(root) as e:
        assert [(s.path, s.states) for s in e.status()] == [(f"{WEEK1}/lec1.pdf", ["modified"])]
        assert e.restore(root / WEEK1) == [f"{WEEK1}/lec1.pdf"]
    assert (root / WEEK1 / "lec1.pdf").read_bytes() == b"v1"


# -- folders renamed on disk by older versions -------------------------------------


def renamed_on_disk(root: Path, folders: dict[str, str]) -> None:
    """As older versions left things: the folders renamed, [folder_names], `on_local_move`.
    `folders`: the path Canvas names would give each -> its name, shallowest first."""
    cfg = root / ".canvas/config.toml"
    with Engine(root) as e:
        for key, name in folders.items():
            parts = key.split("/")
            now = "/".join(folders.get("/".join(parts[: i + 1]), p) for i, p in enumerate(parts[:-1]))
            old = f"{now}/{parts[-1]}" if now else parts[-1]
            new = f"{now}/{name}" if now else name
            os.rename(root / old, root / new)
            e._repath(old, new)
            change_things(cfg, lambda t: t.moved(old, new))
        e._relink()
        e.state.commit()
    text = cfg.read_text(encoding="utf-8").replace("[sync]\n", '[sync]\non_local_move = "follow"\n')
    table = "\n".join(f'"{k}" = "{v}"' for k, v in folders.items())
    cfg.write_text(f"{text}\n[folder_names]\n{table}\n", encoding="utf-8")


@pytest.mark.links
def test_folders_renamed_on_disk_go_back_and_keep_their_names_in_the_app(root, fake):
    pull(root, fake)
    before = tree(root)
    cfg = root / ".canvas/config.toml"
    save_pinned(cfg, [Entry(Thing("folder", path=WEEK1)), Entry(Thing("file", path=f"{WEEK1}/lec1.pdf"))])
    with Engine(root) as e:
        e.reindex()
    renamed_on_disk(root, {MOD: "课件", WEEK1: "第一周"})
    assert (root / COURSE / "课件/第一周/lec1.pdf").exists() and not (root / WEEK1).exists()

    migrate_folder_names(root)

    assert tree(root) == before
    assert (root / LINK).read_bytes() == b"v1" and not (root / COURSE / "课件").exists()
    assert names(root) == {MOD: "课件", WEEK1: "第一周"}
    assert old_folder_names(cfg) is None and "on_local_move" not in cfg.read_text(encoding="utf-8")
    assert [e.thing.path for e in Settings.load(cfg).pinned] == [WEEK1, f"{WEEK1}/lec1.pdf"]
    with Engine(root) as e:
        assert e.status() == []
        assert [h.path for h in e.search("lec1")] == [f"{WEEK1}/lec1.pdf"]
    assert pull(root, fake).actions == []

    migrate_folder_names(root)  # (once)
    assert tree(root) == before and names(root) == {MOD: "课件", WEEK1: "第一周"}


def test_a_folder_that_cannot_go_back_is_moved_by_the_next_sync(root, fake):
    pull(root, fake)
    renamed_on_disk(root, {WEEK1: "第一周"})
    (root / WEEK1).mkdir()
    (root / WEEK1 / "in the way.txt").write_text("mine")

    migrate_folder_names(root)

    assert (root / MOD / "第一周/lec1.pdf").exists()
    with Engine(root) as e:  # not lost, and not taken for deleted
        assert [s for s in e.status() if "missing" in s.states] == []
    pull(root, fake)
    assert (root / WEEK1 / "lec1.pdf").read_bytes() == b"v1"
    assert (root / WEEK1 / "in the way.txt").read_text() == "mine"
    with Engine(root) as e:
        assert e.status() == []


def test_going_back_after_an_interruption(root, fake):
    pull(root, fake)
    before = tree(root)
    renamed_on_disk(root, {MOD: "课件", WEEK1: "第一周"})
    # It stopped after the deepest went back: [folder_names] is still there.
    with Engine(root) as e:
        os.rename(root / COURSE / "课件/第一周", root / COURSE / "课件/01 Week 1")
        e._repath(f"{COURSE}/课件/第一周", f"{COURSE}/课件/01 Week 1")
        e._relink()
        e.state.commit()

    migrate_folder_names(root)

    assert tree(root) == before and names(root) == {MOD: "课件", WEEK1: "第一周"}
    with Engine(root) as e:
        assert e.status() == []


def test_an_old_name_for_a_folder_that_is_gone_is_dropped(root, fake):
    pull(root, fake)
    cfg = root / ".canvas/config.toml"
    cfg.write_text(cfg.read_text(encoding="utf-8") + '\n[folder_names]\n"Old/Folder" = "x"\n', encoding="utf-8")
    migrate_folder_names(root)
    assert names(root) == {} and old_folder_names(cfg) is None


def test_an_interrupted_going_back_runs_again(root, fake, monkeypatch):
    pull(root, fake)
    before = tree(root)
    cfg = root / ".canvas/config.toml"
    renamed_on_disk(root, {WEEK1: "第一周"})
    os.rename(root / MOD / "第一周", root / WEEK1)  # renamed, and stopped before that was recorded

    def stops(self, *args):
        raise RuntimeError("stopped")

    monkeypatch.setattr(Engine, "reindex", stops)
    with pytest.raises(RuntimeError):
        migrate_folder_names(root)
    assert old_folder_names(cfg) is not None  # (so it isn't done yet)
    monkeypatch.undo()

    migrate_folder_names(root)

    assert tree(root) == before and old_folder_names(cfg) is None
    with Engine(root) as e:
        assert e.status() == []
        assert [h.path for h in e.search("lec1")] == [f"{WEEK1}/lec1.pdf"]


def test_a_folder_you_deleted_goes_back_in_the_records(root, fake):
    pull(root, fake)
    renamed_on_disk(root, {WEEK1: "第一周"})
    shutil.rmtree(root / MOD / "第一周")
    with Engine(root) as e:
        for r in e.state.all_files():
            e.state.update(r.id, ignored=1)
        e.state.commit()
    update_skip_folders(root / ".canvas/config.toml", add=[WEEK1])

    migrate_folder_names(root)

    assert names(root) == {WEEK1: "第一周"}
    with Engine(root) as e:
        assert {r.path for r in e.state.all_files()} == {f"{WEEK1}/lec1.pdf"}
        e.restore_in(Scope(paths=[WEEK1]))
        assert e.settings.skip_folders == []
    assert (root / WEEK1 / "lec1.pdf").read_bytes() == b"v1"


def test_a_name_no_course_goes_through_renames_nothing(root, fake):
    pull(root, fake)
    (root / "Mine/My Notes").mkdir(parents=True)
    cfg = root / ".canvas/config.toml"
    cfg.write_text(cfg.read_text(encoding="utf-8") + '\n[folder_names]\n"Mine/Notes" = "My Notes"\n', encoding="utf-8")
    migrate_folder_names(root)
    assert (root / "Mine/My Notes").is_dir() and not (root / "Mine/Notes").exists()
    assert names(root) == {} and old_folder_names(cfg) is None


def test_a_broken_config_is_said_as_such(root):
    cfg = root / ".canvas/config.toml"
    cfg.write_text("[broken", encoding="utf-8")
    with pytest.raises(ConfigError):
        migrate_folder_names(root)


def test_the_assistant_starting_goes_back_too(root, fake, monkeypatch):
    pull(root, fake)
    renamed_on_disk(root, {WEEK1: "第一周"})
    monkeypatch.setattr(agent.Account, "load", classmethod(lambda cls: Account(BASE, root)))
    monkeypatch.setattr(agent, "create_server", lambda account: SimpleNamespace(run=lambda: None))
    agent.serve()
    assert (root / WEEK1 / "lec1.pdf").exists()


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
    assert api.get("/api/courses").json()[0]["dir"] == COURSE
    assert api.get("/api/folder-titles").json() == {COURSE: "Folder"}


def test_names_from_folders_become_titles_once(root, fake):
    pull(root, fake)
    renamed_on_disk(root, {"Fall 2026": "2026 秋", COURSE: "线性代数"})
    cfg = root / ".canvas/config.toml"
    text = cfg.read_text(encoding="utf-8")
    start, end = text.index("[course_titles]"), text.index("[course_aliases]")
    cfg.write_text(text[:start] + text[end:], encoding="utf-8")  # (as an older version wrote it)
    assert needs_titles(cfg)

    with TestClient(create_app(Account(BASE, root), "s"), headers={"Authorization": "Bearer s"}) as client:
        assert not needs_titles(cfg)
        assert names_in_app(client) == ("线性代数", "2026 秋", True)
        assert (root / COURSE).is_dir() and not (root / "2026 秋").exists()
        assert names(root) == {COURSE: "线性代数", "Fall 2026": "2026 秋"}

        # Once: going back to its own name doesn't bring it back.
        client.put("/api/courses/1/title", json={"title": ""})
    create_app(Account(BASE, root), "s")
    assert Settings.load(cfg).course_titles == {}


def test_api_rename_and_pin(api, root):
    assert api.put("/api/pinned", json={"entries": [{"type": "folder", "path": WEEK1}]}).json() == [
        {"type": "folder", "path": WEEK1, "title": "", "hidden": False, "name": "01 Week 1", "exists": True, "in_course": 1}
    ]
    assert api.post("/api/rename", json={"path": WEEK1, "name": "Week One"}).status_code == 200
    assert api.get("/api/pinned").json()[0]["path"] == WEEK1
    assert api.get("/api/folder-titles").json() == {WEEK1: "Week One"}
    assert api.post("/api/rename", json={"path": ".canvas", "name": "y"}).status_code == 400
    assert api.post("/api/rename", json={"path": "../x", "name": "y"}).status_code == 400
    assert api.post("/api/rename", json={"path": "nope", "name": "y"}).status_code == 404

    # Search finds it by both its names.
    with Engine(root) as e:
        found = {x["path"]: x for x in catalog(e) if x["type"] == "folder"}[WEEK1]
    assert found["name"] == "Week One" and "01 Week 1" in found["aliases"]


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
