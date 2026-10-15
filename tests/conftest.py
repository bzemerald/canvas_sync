from __future__ import annotations

import os
from pathlib import Path

import pytest

from canvas_sync import Engine
from fake_canvas import FakeCanvas


@pytest.fixture
def root(tmp_path: Path) -> Path:
    return Engine.init_root(tmp_path / "Canvas")


@pytest.fixture
def fake() -> FakeCanvas:
    f = FakeCanvas()
    f.put(100, "lec1.pdf", b"v1")
    f.module(1, "Week 1", [{"type": "File", "content_id": 100}])
    return f


@pytest.fixture(autouse=True)
def no_real_trash(monkeypatch: pytest.MonkeyPatch) -> None:
    for mod in ("canvas_sync.engine", "canvas_sync.execute"):
        monkeypatch.setattr(f"{mod}.send2trash", lambda p: os.unlink(p))
