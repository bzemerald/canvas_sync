from __future__ import annotations

import os
import shutil
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
def no_real_trash(monkeypatch: pytest.MonkeyPatch) -> list[Path]:
    """What would have gone to the Trash; it's deleted instead."""
    trashed: list[Path] = []

    def fake(p: Path) -> None:
        trashed.append(Path(p))
        if Path(p).is_dir() and not Path(p).is_symlink():
            shutil.rmtree(p)
        else:
            os.unlink(p)

    for mod in ("canvas_sync.engine", "canvas_sync.execute"):
        monkeypatch.setattr(f"{mod}.send2trash", fake)
    return trashed
