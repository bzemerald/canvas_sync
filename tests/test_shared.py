"""What the backend and the app each work out for themselves, and must agree on: the cases in
tests/shared/*.json, which the app's tests run too (app/src/lib/shared.test.ts)."""

import json
from pathlib import Path
from typing import Any

import pytest

from canvas_sync.documents import on_ed
from canvas_sync.places import Place
from canvas_sync.search import STOPWORDS, same_series, series_in, singular
from canvas_sync.things import FIELDS, parse
from canvas_sync.urls import course_url, document_url, file_url

SHARED = Path(__file__).parent / "shared"


def shared(name: str) -> dict[str, Any]:
    return json.loads((SHARED / f"{name}.json").read_text(encoding="utf-8"))


def cases(name: str, of: str = "cases") -> list[Any]:
    return shared(name)[of]


def said(x: Any) -> str:
    return json.dumps(x, ensure_ascii=False)


def _url(case: dict[str, Any]) -> str | None:
    if "file" in case:
        return file_url(case["course"], case["file"])
    t = case["thing"]
    return course_url(t["course"]) if t["type"] == "course" else document_url(t["course"], t["kind"], t["id"])


@pytest.mark.parametrize("case", cases("canvas_urls"), ids=lambda c: said(c.get("thing") or c["file"]))
def test_where_things_are_on_canvas(case):
    assert _url(case) == case["url"]


def test_the_fields_that_say_which_one_a_thing_is():
    assert {k: list(v) for k, v in FIELDS.items()} == shared("things")["fields"]


@pytest.mark.parametrize("case", cases("things", "same"), ids=said)
def test_when_two_are_the_same_thing(case):
    a, b = parse(case["a"]), parse(case["b"])
    assert a is not None and b is not None and (a == b) is case["same"]


@pytest.mark.parametrize("case", cases("things", "holds"), ids=lambda c: said(c["thing"]))
def test_what_a_courses_places_hold(case):
    course, thing = shared("things")["course"], parse(case["thing"])
    assert thing is not None
    for name in ("tabs", "overview", "links"):
        assert Place(name, course["id"], [], [], course["dir"]).holds(thing) is case["holds"]


@pytest.mark.parametrize("case", cases("things", "on_ed"), ids=said)
def test_what_is_from_ed(case):
    assert on_ed(case["kind"], case["id"]) is case["on_ed"]


@pytest.mark.parametrize("word, without", cases("words", "singular"))
def test_a_word_without_its_plural_ending(word, without):
    assert singular(word) == without


@pytest.mark.parametrize("case", cases("words", "series_in"), ids=lambda c: c["name"])
def test_the_numbered_things_a_name_is(case):
    assert [list(s) for s in series_in(case["name"])] == case["series"]


@pytest.mark.parametrize("case", cases("words", "same_series"), ids=lambda c: f"{c['a']} / {c['b']}")
def test_a_series_by_another_name(case):
    assert same_series(case["a"], case["b"], shared("words")["abbreviations"]) is case["same"]


def test_the_words_that_say_little():
    assert sorted(STOPWORDS) == sorted(shared("words")["stopwords"])
