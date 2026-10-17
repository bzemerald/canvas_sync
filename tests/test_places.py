"""Places in the app (置顶; a course's tabs, overview and 工具与链接), and the things in them."""

from __future__ import annotations

from pathlib import Path

import tomlkit
from fastapi.testclient import TestClient

from canvas_sync.config import Account, AppPrefs, Settings, load_pinned, migrate
from canvas_sync.places import CARD_VIEWS, TAB_VIEWS, Place, usual
from canvas_sync.server import create_app
from canvas_sync.things import Entry, Thing, entries, parse, view
from fake_canvas import BASE, COURSE, FakeCanvas, pull

PAGE = Thing("doc", course=1, kind="page", id="schedule")
TABS = [Entry(view(1, v)) for v in TAB_VIEWS]


def client(root: Path, tmp_path: Path) -> TestClient:
    app = create_app(Account(BASE, root), "s", prefs_path=tmp_path / "prefs.toml")
    return TestClient(app, headers={"Authorization": "Bearer s"})


def test_things_are_written_one_way():
    assert parse({"type": "doc", "course": 1, "kind": "page", "id": "schedule"}) == PAGE
    assert PAGE.to_dict() == {"type": "doc", "course": 1, "kind": "page", "id": "schedule"}
    # In a course's own places, its things leave the course out.
    assert PAGE.to_dict(home=1) == {"type": "doc", "kind": "page", "id": "schedule"}
    assert parse({"type": "doc", "kind": "page", "id": "schedule"}, home=1) == PAGE
    assert parse({"type": "doc", "kind": "page", "id": "schedule"}) is None  # (whose?)
    # A default arrangement's views are every course's.
    assert parse({"type": "view", "view": "files"}) is None
    assert parse({"type": "view", "view": "files"}, template=True) == view(None, "files")
    bad = [{"type": "doc", "course": 1, "kind": "movie", "id": "x"}, {"type": "link", "url": "javascript:alert(1)"},
           {"type": "folder", "path": "../x"}, {"type": "note", "course": 1, "id": "../x"}, {"type": "search", "kinds": ["video"]},
           {"type": "view", "course": 1, "view": "movies"}, {"type": "course", "course": True}, {"path": "x"}, "files"]
    assert [parse(d) for d in bad] == [None] * len(bad)
    search = parse({"type": "search", "query": " mt ", "courses": [2, 1, 2], "kinds": ["page", "file"]})
    assert search == Thing("search", query="mt", courses=(1, 2), kinds=("file", "page"))
    assert Thing("search", query="mt").to_dict(compact=True) == {"type": "search", "query": "mt"}
    # A list has each thing once, whatever it's called; what makes no sense is left out.
    listed = entries([{"type": "course", "course": 1, "title": "A"}, {"type": "course", "course": 1, "title": "B"},
                      {"type": "nothing"}, {"type": "link", "url": "https://x.test", "hidden": True}])
    assert listed == [Entry(Thing("course", course=1), "A"), Entry(Thing("link", url="https://x.test"), hidden=True)]


def test_a_place_follows_the_default_until_arranged():
    tabs = Place("tabs", 1, [], usual("tabs"))
    page = Entry(PAGE, "Syllabus")
    assert tabs.arranged([]) == TABS
    assert tabs.arranged([page]) == [*TABS, page]  # what was added comes after
    mine = [TABS[0], page, *TABS[1:]]
    assert tabs.arranged(mine) == mine and tabs.is_arranged(mine)
    # Kept as the default would have it: just what was added is kept.
    assert tabs.settle([*TABS, page]) == [page] and tabs.settle(mine) == mine
    # Its own things can't go: left out, they're put where the default has them.
    assert tabs.arranged([TABS[2], page]) == [*TABS, page]
    # The default is what you made it: hidden, renamed, in another order.
    default = [Entry(view(None, "files"), "Files"), Entry(view(None, "pages"), hidden=True)]
    tabs = Place("tabs", 1, [], default)
    assert tabs.arranged([]) == [*TABS[:5], Entry(view(1, "files"), "Files"), TABS[6], Entry(view(1, "pages"), hidden=True)]

    overview = Place("overview", 1, [], usual("overview"))
    assert [(e.thing.view, e.hidden) for e in overview.arranged([])][-2:] == [("tools", False), ("syllabus", True)]
    assert len(overview.arranged([])) == len(CARD_VIEWS)


def test_links_are_the_courses_tools_then_what_you_added():
    tool = lambda n: Thing("tool", course=1, tool=n)  # noqa: E731
    link = Entry(Thing("link", url="https://math.test"), "Course website")
    links = Place("links", 1, [5, 7], [])
    assert [e.thing for e in links.arranged([link])] == [tool(5), tool(7), view(1, "syllabus"), view(1, "canvas"), link.thing]
    # Hidden: still its own (the course's tools), in their place.
    stored = links.settle([Entry(tool(5), hidden=True), link])
    assert stored == [Entry(tool(5), hidden=True), link]
    assert links.arranged(stored)[:2] == [Entry(tool(5), hidden=True), Entry(tool(7))]
    # A tool the course takes away isn't there any more; a new one comes in after the one before it.
    assert [e.thing for e in Place("links", 1, [7, 9], []).arranged(stored)] == [
        tool(7), tool(9), view(1, "syllabus"), view(1, "canvas"), link.thing]
    # Another course's tool is just something you added.
    other = Entry(Thing("tool", course=2, tool=5))
    assert links.settle([*links.arranged([]), other]) == [other]


OLD_CONFIG = """
[course_layouts.1]
tabs = ["overview", "x:t1", "files", "modules", "assignments", "announcements", "grades", "syllabus", "pages"]
hidden_tabs = ["modules", "grades"]
cards = [
    {type = "files"},
    {type = "note", id = "n1"},
    {type = "page", id = "c1", title = "Course Policies", page = "course-policies"},
    {type = "search", id = "c2", query = "mt", content = true},
    {type = "links"},
]
tab_items = [
    {id = "t1", type = "folder", title = "files", path = "Fall 2026/MATH 221/Modules"},
    {id = "t2", type = "doc", kind = "syllabus", doc = "1"},
]
hidden_links = ["tool:5", "syllabus", "link:1"]
links = [
    {title = "Course website", url = "https://math.test"},
    {title = "Old site", url = "https://old.test"},
]

[course_layouts.2]
extra_cards = [{type = "syllabus"}]

[[pinned]]
name = "Midterm"
query = "mt"
courses = [1]
kinds = ["file"]

[[pinned]]
path = "Fall 2026/MATH 221/Modules"

[[pinned]]
course = 1
kind = "page"
id = "schedule"
title = "Schedule (when pinned)"

[[pinned]]
url = "https://math.test"
title = "Course website"

[[smart_folders]]
name = "Old"
query = "hw"
"""

OLD_PREFS = """language = "en"
tab_order = ["overview", "files", "modules"]
hidden_tabs = ["pages"]
overview_order = ["files", "announcements", "links", "upcoming", "modules", "grades"]
overview_hidden = ["upcoming", "modules", "grades"]
"""


def test_older_config_and_prefs_are_rewritten(root, tmp_path, fake: FakeCanvas):
    """config.toml and app.toml from before things had a type: each course's page, 置顶 and the
    default arrangement come out as they were."""
    fake.tabs = [{"id": "context_external_tool_5", "label": "Gradescope", "type": "external", "position": 3}]
    pull(root, fake)
    cfg = root / ".canvas/config.toml"
    cfg.write_text(cfg.read_text() + OLD_CONFIG)
    (tmp_path / "prefs.toml").write_text(OLD_PREFS)
    with client(root, tmp_path) as api:
        r = api.get("/api/courses/1/layout").json()
        pinned = api.get("/api/pinned").json()
        other = api.get("/api/courses/2/layout").json()

    def shown(place: str) -> list[tuple]:
        return [(e["type"], e.get("view") or e.get("path") or e.get("id") or e.get("url") or e.get("tool"), e["title"])
                for e in r[place] if not e["hidden"]]
    assert shown("tabs") == [("view", "overview", ""), ("folder", f"{COURSE}/Modules", "files"), ("view", "files", ""),
                             ("view", "assignments", ""), ("view", "announcements", ""), ("view", "syllabus", ""),
                             ("view", "pages", "")]
    assert shown("overview") == [("view", "files", ""), ("note", "n1", ""), ("doc", "course-policies", "Course Policies"),
                                 ("search", None, ""), ("view", "tools", "")]
    assert [e["courses"] for e in r["overview"] if e["type"] == "search"] == [[1]]  # (it searched this course)
    assert shown("links") == [("view", "canvas", ""), ("link", "https://math.test", "Course website")]
    assert r["own"] == {"tabs": True, "overview": True, "links": True}
    # The syllabus card, added to a course following the default: shown, the rest as the default has them.
    assert [(e["view"], e["hidden"]) for e in other["overview"]] == [
        ("files", False), ("announcements", False), ("tools", False), ("assignments", True), ("modules", True),
        ("grades", True), ("syllabus", False)]
    # 置顶: a pinned page's old title was what it was called then; links' and smart folders' are names.
    assert [(p["type"], p["title"]) for p in pinned] == [
        ("search", "Midterm"), ("folder", ""), ("doc", ""), ("link", "Course website"), ("search", "Old")]

    text = cfg.read_text()
    for old in ("hidden_tabs", "tab_items", "cards =", "hidden_links", "smart_folders", "x:t1", "name = "):
        assert old not in text, old
    assert "# How canvas-sync lays out" in text  # (comments kept)
    assert not migrate(cfg)  # (once)
    prefs = AppPrefs.load(tmp_path / "prefs.toml")
    assert [(e.thing.view, e.hidden) for e in prefs.tabs][:4] == [("overview", False), ("files", False), ("modules", False),
                                                                   ("announcements", False)]
    assert "tab_order" not in (tmp_path / "prefs.toml").read_text() and prefs.language == "en"
    assert other["tabs"][1]["view"] == "files"  # (the default's order)


def test_putting_things_in_places(root, tmp_path, fake: FakeCanvas):
    fake.pages["schedule"] = {"url": "schedule", "title": "Schedule", "body": "<p>x</p>"}
    fake.tabs = [{"id": "context_external_tool_5", "label": "Gradescope", "type": "external", "position": 3}]
    pull(root, fake)
    page = {"type": "doc", "course": 1, "kind": "page", "id": "schedule"}
    with client(root, tmp_path) as api:
        usual_ = api.get("/api/courses/1/layout").json()
        assert usual_["own"] == {"tabs": False, "overview": False, "links": False}
        assert usual_["tabs"][0] == {"type": "view", "course": 1, "view": "overview", "title": "", "hidden": False,
                                     "name": None, "exists": True, "in_course": 1}
        assert [(e.get("view") or e["tool"], e["name"]) for e in usual_["links"]] == [(5, "Gradescope"), ("syllabus", None),
                                                                                       ("canvas", None)]
        # Added after the default ones: it still follows the default.
        r = api.put("/api/courses/1/layout/tabs", json={"entries": [*usual_["tabs"], {**page, "title": "Syllabus"}]}).json()
        assert not r["own"]["tabs"] and (r["tabs"][-1]["name"], r["tabs"][-1]["title"]) == ("Schedule", "Syllabus")
        # Put among them, renamed, hidden: arranged for this course.
        tabs = r["tabs"]
        moved = [tabs[0], tabs[-1], {**tabs[1], "title": "Weeks"}, {**tabs[2], "hidden": True}, *tabs[3:-1]]
        r = api.put("/api/courses/1/layout/tabs", json={"entries": moved}).json()
        assert r["own"]["tabs"] and [(e.get("view") or e["id"], e["title"], e["hidden"]) for e in r["tabs"]][:4] == [
            ("overview", "", False), ("schedule", "Syllabus", False), ("modules", "Weeks", False), ("announcements", "", True)]
        assert api.get("/api/courses/2/layout").json()["own"]["tabs"] is False  # (another course)
        # The course's own tabs can't be taken away: left out, they're back.
        r = api.put("/api/courses/1/layout/tabs", json={"entries": [moved[1], moved[0]]}).json()
        assert len(r["tabs"]) == len(TAB_VIEWS) + 1
        assert api.put("/api/courses/1/layout/tabs", json={"entries": [{"type": "doc", "kind": "movie"}]}).status_code == 400
        assert api.put("/api/courses/1/layout/drawer", json={"entries": []}).status_code == 404

        # Every course's default: what this one has of its own (not what it added).
        api.put("/api/courses/1/layout/tabs", json={"entries": moved})
        r = api.post("/api/courses/1/layout/tabs/default").json()
        assert r["own"]["tabs"] and r["tabs"][1]["id"] == "schedule"  # (where what it added is is its own)
        other = api.get("/api/courses/2/layout").json()["tabs"]
        assert [(e["view"], e["title"], e["hidden"]) for e in other[:3]] == [
            ("overview", "", False), ("modules", "Weeks", False), ("announcements", "", True)]
        # Back to the default: what was added stays, after the rest.
        api.put("/api/courses/1/layout/tabs", json={"entries": [moved[1], *moved[2:], moved[0]]})
        r = api.post("/api/courses/1/layout/tabs/reset").json()
        assert not r["own"]["tabs"] and r["tabs"][0]["view"] == "overview" and r["tabs"][-1]["id"] == "schedule"

        # The overview and 工具与链接 are places too.
        note, link = {"type": "note", "id": "n1"}, {"type": "link", "url": "https://math.test", "title": "Site"}
        r = api.put("/api/courses/1/layout/overview", json={"entries": [*r["overview"], note, page]}).json()
        assert [e["type"] for e in r["overview"]][-2:] == ["note", "doc"] and not r["own"]["overview"]
        links = [{**r["links"][0], "hidden": True}, *r["links"][1:], link]
        r = api.put("/api/courses/1/layout/links", json={"entries": links}).json()
        assert r["own"]["links"] and [e["hidden"] for e in r["links"]] == [True, False, False, False]
        r = api.post("/api/courses/1/layout/links/reset").json()
        assert not r["own"]["links"] and [e["hidden"] for e in r["links"]] == [False] * 4
        assert api.post("/api/courses/1/layout/links/default").status_code == 404

    stored = Settings.load(root / ".canvas/config.toml").course_layouts[1]
    assert stored.tabs == [Entry(PAGE, "Syllabus")] and stored.links == [Entry(Thing("link", url="https://math.test"), "Site")]


def test_pinning_anything(root, tmp_path, fake: FakeCanvas):
    """置顶 holds anything: each listed as it's called now, and whether it's still there."""
    fake.pages["schedule"] = {"url": "schedule", "title": "Schedule", "body": "<p>x</p>"}
    fake.tabs = [{"id": "context_external_tool_5", "label": "Gradescope", "type": "external", "position": 3}]
    pull(root, fake)
    week1 = f"{COURSE}/Modules/01 Week 1"
    things = [
        {"type": "file", "path": f"{week1}/lec1.pdf"}, {"type": "doc", "course": 1, "kind": "page", "id": "schedule"},
        {"type": "module", "course": 1, "module": 1}, {"type": "tool", "course": 1, "tool": 5},
        {"type": "doc", "course": 1, "kind": "page", "id": "gone", "title": "Old page"},
        {"type": "link", "url": "https://math.test", "title": "Site"}, {"type": "view", "course": 1, "view": "assignments"},
        {"type": "note", "course": 1, "id": "n1"}, {"type": "search", "query": "lec", "title": "Lectures"},
        {"type": "folder", "path": week1}, {"type": "folder", "path": COURSE},
    ]
    with client(root, tmp_path) as api:
        got = api.put("/api/pinned", json={"entries": things}).json()
        assert [(p["type"], p["name"], p["exists"], p["in_course"]) for p in got] == [
            ("file", "lec1.pdf", True, 1), ("doc", "Schedule", True, 1), ("module", "Week 1", True, 1),
            ("tool", "Gradescope", True, 1), ("doc", None, False, 1), ("link", None, True, None),
            ("view", None, True, 1), ("note", None, True, 1), ("search", None, True, None),
            ("folder", "01 Week 1", True, 1), ("course", "MATH 221", True, 1),  # (a course's own folder: the course)
        ]
        assert api.put("/api/pinned", json={"entries": [{"type": "link", "url": "javascript:1"}]}).status_code == 400
        # Things in a renamed folder follow it, wherever they are.
        api.put("/api/courses/1/layout/tabs", json={"entries": [{"type": "folder", "path": week1, "title": "Week"}]})
        api.post("/api/rename", json={"path": week1, "name": "Week One"})
        assert [p["path"] for p in api.get("/api/pinned").json() if p["type"] in ("file", "folder")] == [
            f"{COURSE}/Modules/Week One/lec1.pdf", f"{COURSE}/Modules/Week One"]
        assert api.get("/api/courses/1/layout").json()["tabs"][-1]["path"] == f"{COURSE}/Modules/Week One"
        # Hiding the course unpins all that's in it.
        api.post("/api/courses/1/hide", json={"hidden": True})
        assert [p["type"] for p in api.get("/api/pinned").json()] == ["link", "search"]
    assert [e.thing.type for e in load_pinned(root / ".canvas/config.toml")] == ["link", "search"]
    assert tomlkit.parse((root / ".canvas/config.toml").read_text())["pinned"][0]["title"] == "Site"
