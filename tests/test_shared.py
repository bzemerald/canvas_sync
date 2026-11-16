"""What the backend and the app each work out for themselves, and must agree on: the cases in
tests/shared/*.json, which the app's tests run too (app/src/lib/shared.test.ts)."""

import json
from pathlib import Path
from typing import Any

import pytest

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
