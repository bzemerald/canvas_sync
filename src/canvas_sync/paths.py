"""Where canvas-sync keeps its own things in a sync folder, and how paths in it are compared.

Paths in the sync folder are written relative to it, with "/" (as in state.db and config.toml).
"""

from __future__ import annotations

from pathlib import Path

META_DIR = ".canvas"  # in the sync folder: config.toml, the databases, originals, notes, caches


def config_file(root: Path) -> Path:
    """The sync folder's config.toml."""
    return root / META_DIR / "config.toml"


def note_file(root: Path, course: int, note: str) -> Path:
    """Where a note typed in the app is kept."""
    return root / META_DIR / "notes" / str(course) / f"{note}.md"


def under(path: str, folder: str) -> bool:
    """Whether `path` is `folder`, or in it."""
    return path == folder or path.startswith(folder + "/")
