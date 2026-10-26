from __future__ import annotations

import os
import shutil
import tempfile
from pathlib import Path

import pytest

# Never the real ~/.config/canvas-sync (the account, the app's preferences): set before
# canvas_sync is imported, which is when it reads where they are.
os.environ["CANVAS_SYNC_HOME"] = tempfile.mkdtemp(prefix="canvas-sync-home-")

from canvas_sync import Engine  # noqa: E402
from canvas_sync.local import can_symlink  # noqa: E402
from fake_canvas import FakeCanvas  # noqa: E402


def pytest_collection_modifyitems(items: list[pytest.Item]) -> None:
    """Tests of the links in other views need symlinks (on Windows: Developer Mode)."""
    if not can_symlink(Path(tempfile.gettempdir())):
        skip = pytest.mark.skip(reason="symlinks aren't allowed here")
        for item in items:
            if "links" in item.keywords:
                item.add_marker(skip)


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
