"""Notes typed in the app (a card on a course's overview, or a tab of their own): each a Markdown
file in the sync folder, `.canvas/notes/<course>/<id>.md` (paths.note_file)."""

from __future__ import annotations

from pathlib import Path

from .local import write_whole
from .paths import note_file


def read(root: Path, course: int, note: str) -> str:
    """A note's text ("": nothing typed yet)."""
    f = note_file(root, course, note)
    return f.read_text(encoding="utf-8") if f.exists() else ""


def write(root: Path, course: int, note: str, text: str) -> None:
    f = note_file(root, course, note)
    f.parent.mkdir(parents=True, exist_ok=True)
    write_whole(f, text)


def start(root: Path, course: int, note: str) -> str:
    """A note's first line (what it's about), for finding it by."""
    try:
        text = note_file(root, course, note).read_text(encoding="utf-8")
    except OSError:
        return ""
    return next((line.strip() for line in text.splitlines() if line.strip()), "")[:120]
