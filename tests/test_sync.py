"""End-to-end tests against an in-memory fake Canvas server."""

from __future__ import annotations

import os

import pytest

from canvas_sync import Engine, Kind
from fake_canvas import COURSE, kinds, pull, set_config

MOD = f"{COURSE}/Modules/01 Week 1/lec1.pdf"
FILES = f"{COURSE}/Files/Lectures/lec1.pdf"


@pytest.mark.links
def test_first_pull_stores_once_and_links_other_views(root, fake):
    plan = pull(root, fake)
    assert kinds(plan) == [("download", MOD), ("link", FILES)]
    assert (root / MOD).read_bytes() == b"v1"
    assert (root / FILES).is_symlink() and (root / FILES).read_bytes() == b"v1"
    assert pull(root, fake).actions == []


def test_remote_update_replaces_untouched_file(root, fake):
    pull(root, fake)
    fake.put(100, "lec1.pdf", b"v2", version="2026-09-02T00:00:00Z")
    assert kinds(pull(root, fake)) == [("update", MOD)]
    assert (root / MOD).read_bytes() == b"v2"


def test_conflict_keeps_your_edit_beside_new_version(root, fake):
    pull(root, fake)
    (root / MOD).write_bytes(b"my notes")
    fake.put(100, "lec1.pdf", b"v2", version="2026-09-02T00:00:00Z")
    plan = pull(root, fake)
    assert [a.kind for a in plan.actions] == [Kind.CONFLICT]
    assert (root / MOD).read_bytes() == b"v2"
    assert (root / MOD).with_name("lec1 (mine).pdf").read_bytes() == b"my notes"


@pytest.mark.links
def test_local_delete_is_respected_and_restorable(root, fake):
    pull(root, fake)
    (root / MOD).unlink()
    assert kinds(pull(root, fake)) == [("ignore", MOD), ("unlink", FILES)]
    assert pull(root, fake).actions == []
    with Engine(root) as engine:
        assert [e.states for e in engine.status()] == [["ignored"]]
        engine.restore(root / MOD)
    assert (root / MOD).read_bytes() == b"v1"


@pytest.mark.links
def test_restore_discards_edits(root, fake):
    pull(root, fake)
    (root / MOD).write_bytes(b"oops")
    with Engine(root) as engine:
        assert [e.states for e in engine.status()] == [["modified"]]
        engine.restore(root / FILES)  # via the view link works too
        assert engine.status() == []
    assert (root / MOD).read_bytes() == b"v1"


@pytest.mark.links
def test_moving_a_file_in_finder_is_remembered(root, fake):
    pull(root, fake)
    mine = root / COURSE / "My Slides" / "lec1.pdf"
    mine.parent.mkdir()
    os.rename(root / MOD, mine)
    plan = pull(root, fake)
    # A file you placed yourself is taken out of the generated views.
    assert [a.kind for a in plan.actions] == [Kind.PIN, Kind.UNLINK]
    assert not (root / FILES).exists()
    fake.put(100, "lec1.pdf", b"v2", version="2026-09-02T00:00:00Z")
    assert [a.kind for a in pull(root, fake).actions] == [Kind.UPDATE]
    assert mine.read_bytes() == b"v2"


def test_reupload_with_new_id_counts_as_update(root, fake):
    pull(root, fake)
    (root / MOD).write_bytes(b"my notes")
    del fake.files[100]
    fake.put(101, "lec1.pdf", b"v2")
    fake.modules[0]["items"] = [{"type": "File", "content_id": 101}]
    plan = pull(root, fake)
    conflict = [a for a in plan.actions if a.kind == Kind.CONFLICT]
    assert len(conflict) == 1 and conflict[0].replaces == 100
    assert not any(a.kind == Kind.REMOTE_DELETED for a in plan.actions)
    assert (root / MOD).read_bytes() == b"v2"
    assert pull(root, fake).actions == []


def test_remote_delete_keeps_local_copy(root, fake):
    pull(root, fake)
    del fake.files[100]
    fake.modules.clear()
    assert kinds(pull(root, fake)) == [("remote_deleted", MOD)]
    assert (root / MOD).exists()


def test_hidden_files_tab_still_finds_module_files(root, fake):
    fake.files_tab_hidden = True
    plan = pull(root, fake)
    assert kinds(plan) == [("download", MOD)]


@pytest.mark.links
def test_files_linked_from_a_module_page_land_in_that_module(root, fake):
    fake.put(102, "paper.pdf", b"p", folder=10)
    fake.pages["readings"] = {"url": "readings", "title": "Readings", "body": '<a href="/courses/1/files/102/download">paper</a>'}
    fake.modules[0]["items"].append({"type": "Page", "page_url": "readings"})
    pull(root, fake)
    assert (root / COURSE / "Modules/01 Week 1/paper.pdf").read_bytes() == b"p"
    assert (root / COURSE / "Files/paper.pdf").is_symlink()


def test_rules_relocate_files(root, fake):
    set_config(root, "# [[rules]]\n# match", '[[rules]]\nmatch = "files/lectures/*.pdf"\nto = "Slides"\n# match')
    assert kinds(pull(root, fake)) == [("download", f"{COURSE}/Slides/lec1.pdf")]


@pytest.mark.links
def test_layout_change_moves_files_and_relinks(root, fake):
    pull(root, fake)
    set_config(root, 'views = ["modules", "files"]', 'views = ["files", "modules"]')
    plan = pull(root, fake)
    assert kinds(plan) == [("link", MOD), ("move", FILES), ("unlink", FILES)]
    assert (root / FILES).is_file() and not (root / FILES).is_symlink()
    assert (root / MOD).is_symlink() and (root / MOD).read_bytes() == b"v1"
    assert pull(root, fake).actions == []


def test_name_clash_gets_suffix(root, fake):
    fake.put(103, "LEC1.pdf", b"other")
    fake.modules[0]["items"].append({"type": "File", "content_id": 103})
    pull(root, fake)
    assert (root / MOD).read_bytes() == b"v1"
    assert (root / COURSE / "Modules/01 Week 1/LEC1 (2).pdf").read_bytes() == b"other"


def test_name_without_extension_gets_its_type(root, fake):
    fake.put(104, "Week 10 Answers", b"%PDF-1.4")
    fake.files[104] |= {"filename": "Week+10-answers.pdf", "content-type": "application/pdf"}
    pull(root, fake)
    path = root / COURSE / "Files/Lectures/Week 10 Answers.pdf"
    assert path.read_bytes() == b"%PDF-1.4"
    assert pull(root, fake).actions == []


def test_files_named_without_extension_are_moved_to_one(root, fake):
    fake.put(104, "Week 10 Answers", b"%PDF-1.4")
    pull(root, fake)  # no type known yet (as before): the name stays
    old = root / COURSE / "Files/Lectures/Week 10 Answers"
    assert old.is_file()
    fake.files[104] |= {"content-type": "application/pdf"}
    assert kinds(pull(root, fake)) == [("move", f"{COURSE}/Files/Lectures/Week 10 Answers.pdf")]
    assert not old.exists() and old.with_name("Week 10 Answers.pdf").read_bytes() == b"%PDF-1.4"


@pytest.mark.parametrize("name, filename, ctype, out", [
    ("Week 10 Answers", "Week+10-answers.pdf", "application/pdf", "Week 10 Answers.pdf"),
    ("Syllabus", "Syllabus.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "Syllabus.docx"),
    ("Lecture 1.5", "lec1.5.pdf", "application/pdf", "Lecture 1.5.pdf"),
    ("Notes.PDF", "notes.pdf", "application/pdf", "Notes.PDF"),
    ("photo.jpeg", "photo.jpg", "image/jpeg", "photo.jpeg"),
    ("Logo.jfif", "Logo.jfif", "image/jpeg", "Logo.jfif"),
    ("Quiz", "Quiz V2.docx-2.pdf", "application/pdf", "Quiz.pdf"),
    ("Slides", "slides.pdf", None, "Slides.pdf"),
    ("Mystery", "mystery", "unknown/unknown", "Mystery"),
])
def test_file_name_adds_the_extension_canvas_would(name, filename, ctype, out):
    from canvas_sync.layout import file_name
    from canvas_sync.models import RemoteFile

    f = RemoteFile.from_api({"id": 1, "display_name": name, "filename": filename, "content-type": ctype}, 1)
    assert file_name(f) == out
