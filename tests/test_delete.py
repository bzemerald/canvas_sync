"""Deleting from the app, and stopping / resuming syncing."""

from __future__ import annotations

import os
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from canvas_sync import Engine
from canvas_sync.config import Account, Settings
from canvas_sync.plan import Scope
from canvas_sync.server import create_app
from fake_canvas import BASE, COURSE, FakeCanvas, kinds, pull

WEEK1 = f"{COURSE}/Modules/01 Week 1"
MOD = f"{WEEK1}/lec1.pdf"
LINK = f"{COURSE}/Files/Lectures/lec1.pdf"


def states(root: Path) -> dict[str, list[str]]:
    with Engine(root) as e:
        return {s.path: s.states for s in e.status()}  # type: ignore[misc]


def listing(root: Path, rel: str) -> dict[str, dict]:
    with Engine(root) as e:
        return {x.name: x.__dict__ for x in e.list_dir(rel)}


def skip_folders(root: Path) -> list[str]:
    return Settings.load(root / ".canvas/config.toml").skip_folders


def new_module_file(fake: FakeCanvas, fid: int, name: str, also_in_files: bool = False) -> None:
    fake.put(fid, name, b"new", listed=also_in_files)  # (listed files are in Files/Lectures)
    fake.modules[0]["items"].append({"type": "File", "content_id": fid})


def test_delete_a_file_keeps_it_deleted_and_restorable(root, fake, no_real_trash):
    pull(root, fake)
    with Engine(root) as e:
        assert e.delete([MOD]) == [MOD]
    assert no_real_trash == [root / MOD]
    assert not (root / MOD).exists() and not os.path.lexists(root / LINK)  # its link went too
    assert states(root) == {MOD: ["ignored"]}
    assert pull(root, fake).actions == []  # not downloaded again, link not recreated
    assert listing(root, WEEK1)["lec1.pdf"]["deleted"]

    with Engine(root) as e:
        e.restore_in(Scope([MOD]))
    assert (root / MOD).read_bytes() == b"v1"
    assert kinds(pull(root, fake)) == [("link", LINK)]


def test_deleting_a_view_link_deletes_its_file(root, fake):
    pull(root, fake)
    with Engine(root) as e:
        e.delete([LINK])
    assert not (root / MOD).exists() and not os.path.lexists(root / LINK)
    assert pull(root, fake).actions == []


def test_delete_a_folder_and_what_canvas_adds_to_it_later(root, fake):
    pull(root, fake)
    with Engine(root) as e:
        assert e.delete_preview([WEEK1]) == {"canvas_files": 1, "own_files": 0, "folders": [WEEK1], "canvas_folders": [WEEK1]}
        e.delete([WEEK1])
    assert not (root / WEEK1).exists() and skip_folders(root) == [WEEK1]
    new_module_file(fake, 101, "only-in-module.pdf")
    new_module_file(fake, 102, "also-in-files.pdf", also_in_files=True)
    # Nothing new in the deleted folder; a file that's also in Files/ goes there instead.
    assert kinds(pull(root, fake)) == [("download", f"{COURSE}/Files/Lectures/also-in-files.pdf")]

    ghost = listing(root, f"{COURSE}/Modules")["01 Week 1"]
    assert ghost["deleted"] and ghost["type"] == "dir" and ghost["skipped"] and ghost["changes"] == ghost["deleted_inside"] == 1

    with Engine(root) as e:  # bring the folder back: its file, and new files again
        assert e.restore_in(Scope([WEEK1])) == [MOD]
    assert skip_folders(root) == []
    assert ("download", f"{WEEK1}/only-in-module.pdf") in kinds(pull(root, fake))


def test_delete_a_folder_but_keep_syncing_it(root, fake):
    pull(root, fake)
    with Engine(root) as e:
        e.delete([WEEK1], stop_syncing_folders=False)
    assert skip_folders(root) == []
    new_module_file(fake, 101, "next.pdf")
    assert kinds(pull(root, fake)) == [("download", f"{WEEK1}/next.pdf")]
    assert not (root / MOD).exists()  # what you deleted stays deleted


def test_delete_your_own_files_and_folders(root, fake, no_real_trash):
    pull(root, fake)
    (root / COURSE / "notes.md").write_text("mine")
    (root / COURSE / "Mine").mkdir()
    (root / COURSE / "Mine/a.txt").write_text("a")
    with Engine(root) as e:
        assert e.delete_preview([f"{COURSE}/notes.md", f"{COURSE}/Mine"])["own_files"] == 2
        e.delete([f"{COURSE}/notes.md", f"{COURSE}/Mine"])
    assert len(no_real_trash) == 2 and skip_folders(root) == []  # nothing from Canvas there
    with Engine(root) as e, pytest.raises(ValueError):
        e.delete([".canvas"])


def test_untrack_a_file_keeps_it_as_yours(root, fake):
    pull(root, fake)
    with Engine(root) as e:
        assert e.untrack([LINK]) == 1  # via its link: the file itself
    assert (root / MOD).read_bytes() == b"v1" and not os.path.lexists(root / LINK)
    assert states(root) == {MOD: ["untracked"]}
    assert listing(root, WEEK1)["lec1.pdf"]["states"] == ["untracked"]
    fake.put(100, "lec1.pdf", b"v2", version="2026-09-02T00:00:00Z")
    assert pull(root, fake).actions == []  # Canvas's update doesn't touch your copy
    with Engine(root) as e:
        assert e.restorable(Scope([COURSE])) == []  # nothing to "restore": you chose this

    with Engine(root) as e:
        assert e.track([MOD]) == 1
    assert kinds(pull(root, fake)) == [("link", LINK), ("update", MOD)]
    assert (root / MOD).read_bytes() == b"v2"


def test_untrack_a_folder_stops_new_files_too(root, fake):
    pull(root, fake)
    with Engine(root) as e:
        e.untrack([WEEK1])
    assert skip_folders(root) == [WEEK1] and (root / MOD).exists()
    assert listing(root, f"{COURSE}/Modules")["01 Week 1"]["skipped"]
    new_module_file(fake, 101, "next.pdf")
    assert pull(root, fake).actions == []
    with Engine(root) as e:
        assert e.track([WEEK1]) == 1
    assert skip_folders(root) == []
    assert ("download", f"{WEEK1}/next.pdf") in kinds(pull(root, fake))


def test_deleting_a_moved_file_records_where_it_was(root, fake):
    pull(root, fake)
    (root / COURSE / "Mine").mkdir()
    os.rename(root / MOD, root / COURSE / "Mine/lec1.pdf")
    with Engine(root) as e:
        e.delete([f"{COURSE}/Mine/lec1.pdf"])
    assert listing(root, f"{COURSE}/Mine")["lec1.pdf"]["deleted"]
    with Engine(root) as e:
        e.restore_in(Scope([f"{COURSE}/Mine"]))
    assert (root / COURSE / "Mine/lec1.pdf").read_bytes() == b"v1"
    assert pull(root, fake).actions == []  # stays where you had it


def test_api(root, fake):
    pull(root, fake)
    with TestClient(create_app(Account(BASE, root), "s"), headers={"Authorization": "Bearer s"}) as c:
        preview = c.post("/api/delete", json={"paths": [WEEK1], "dry_run": True}).json()
        assert preview["canvas_files"] == 1 and (root / MOD).exists()
        assert c.post("/api/delete", json={"paths": [WEEK1]}).json() == {"deleted": [WEEK1]}
        assert c.post("/api/restore", json={"paths": [WEEK1]}).json() == {"restored": [MOD]}
        assert c.post("/api/untrack", json={"paths": [MOD]}).json() == {"files": 1}
        assert c.post("/api/track", json={"paths": [MOD]}).json() == {"files": 1}
        assert c.post("/api/delete", json={"paths": [".canvas/config.toml"]}).status_code == 400
        assert c.post("/api/delete", json={"paths": []}).status_code == 400
        assert c.post("/api/untrack", json={"paths": ["nope"]}).status_code == 404


def test_search_keeps_untracked_files_and_drops_deleted_ones(root, fake):
    pull(root, fake)
    with Engine(root) as e:
        e.reindex()
        e.untrack([MOD])
        e.reindex()
        assert [h.title for h in e.search("lec1")] == ["lec1.pdf"]
        e.delete([MOD])
        e.reindex()
        assert e.search("lec1") == []


MODULES = f"{COURSE}/Modules"
WEEK2 = f"{MODULES}/02 Week 2"
LECTURES = f"{COURSE}/Files/Lectures"


def two_weeks(fake: FakeCanvas) -> None:
    fake.put(200, "lec2.pdf", b"w2", listed=False)
    fake.module(2, "Week 2", [{"type": "File", "content_id": 200}])


def test_resuming_a_folder_in_one_not_synced_resumes_the_way_to_it(root, fake):
    two_weeks(fake)
    pull(root, fake)
    with Engine(root) as e:
        e.untrack([MODULES])
        assert e.track([WEEK1]) == 1
    # Modules and Week 1 sync again; Week 2, beside them, still doesn't.
    assert skip_folders(root) == [WEEK2]
    assert states(root) == {f"{WEEK2}/lec2.pdf": ["untracked"]}
    new_module_file(fake, 101, "next.pdf")  # (in Week 1)
    fake.put(200, "lec2.pdf", b"w2 v2", listed=False, version="2026-09-02T00:00:00Z")
    fake.put(100, "lec1.pdf", b"v2", version="2026-09-02T00:00:00Z")
    assert kinds(pull(root, fake)) == [("download", f"{WEEK1}/next.pdf"), ("link", LINK), ("update", MOD)]


def test_resuming_one_file_in_a_folder_not_synced(root, fake):
    pull(root, fake)
    with Engine(root) as e:
        e.untrack([WEEK1])
        assert e.track([MOD]) == 1
    assert skip_folders(root) == []
    fake.put(100, "lec1.pdf", b"v2", version="2026-09-02T00:00:00Z")
    assert kinds(pull(root, fake)) == [("link", LINK), ("update", MOD)]


def test_links_in_a_folder_not_synced_stay(root, fake):
    pull(root, fake)
    with Engine(root) as e:
        e.untrack([LECTURES])
    assert pull(root, fake).actions == [] and os.path.islink(root / LINK)
    assert listing(root, LECTURES)["lec1.pdf"]["skipped"]
    with Engine(root) as e:
        e.untrack([COURSE])  # its links stay too, now pointing at a file of yours
    assert os.path.islink(root / LINK) and (root / LINK).read_bytes() == b"v1"
    assert pull(root, fake).actions == []
    assert listing(root, LECTURES)["lec1.pdf"]["states"] == ["untracked"]
    with Engine(root) as e:
        e.track([COURSE])
    fake.put(100, "lec1.pdf", b"v2", version="2026-09-02T00:00:00Z")
    assert kinds(pull(root, fake)) == [("update", MOD)] and (root / LINK).read_bytes() == b"v2"


def test_a_deleted_folder_can_stop_and_resume_syncing(root, fake):
    pull(root, fake)
    with Engine(root) as e:
        e.delete([WEEK1], stop_syncing_folders=False)
        e.untrack([WEEK1])
    assert skip_folders(root) == [WEEK1]
    new_module_file(fake, 101, "next.pdf")
    assert pull(root, fake).actions == []
    with Engine(root) as e:
        e.track([WEEK1])
    assert skip_folders(root) == []
    assert kinds(pull(root, fake)) == [("download", f"{WEEK1}/next.pdf")]  # (lec1.pdf stays deleted)


def test_restoring_a_file_in_a_deleted_folder_syncs_it_again(root, fake):
    pull(root, fake)
    with Engine(root) as e:
        e.delete([MODULES])
        e.restore_files([100])
    assert skip_folders(root) == []
    fake.put(100, "lec1.pdf", b"v2", version="2026-09-02T00:00:00Z")
    assert ("update", MOD) in kinds(pull(root, fake))


def test_resuming_in_a_renamed_folder(root, fake):
    two_weeks(fake)
    pull(root, fake)
    with Engine(root) as e:
        renamed = e.rename_folder(MODULES, "Weeks")
        e.untrack([renamed])
        e.track([f"{renamed}/01 Week 1"])
    assert skip_folders(root) == [WEEK2]  # (Canvas's names)
    new_module_file(fake, 101, "next.pdf")
    assert kinds(pull(root, fake)) == [("download", f"{renamed}/01 Week 1/next.pdf"), ("link", LINK)]
