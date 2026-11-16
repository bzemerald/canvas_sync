"""The app's search of what things say (`GET /find`, `canvas search`, the assistant's `search`):
the index's (search.py), with words nothing has taken for the nearest that are there, and what's
near in meaning too when that's on (meaning.py). By name, things are found in the catalog."""

from __future__ import annotations

from pathlib import Path
from typing import TYPE_CHECKING

from . import meaning
from .catalog import abbreviations
from .config import AppPrefs
from .courses import course_label
from .meaning import Meaning
from .search import CourseMatcher, Hit, parse

if TYPE_CHECKING:
    from .engine import Engine


def find(e: Engine, query: str, limit: int = 40, course_ids: list[int] | None = None, kinds: list[str] | None = None,
         since: str | None = None, until: str | None = None, source: str | None = None, under: str | None = None,
         literal: bool = True, prefs_path: Path | None = None) -> tuple[list[Hit], dict[str, str]]:
    """Search as the app does: words nothing has taken for the nearest that are ("midtrem":
    midterm; returned too), and by meaning as well when it's on (`prefs_path`: app.toml, whose
    folder has the model), for what's said in a few words. `literal`: the query is only words;
    otherwise courses in it count too ("221 mt")."""
    named = not literal and not course_ids and parse(query, CourseMatcher(e.state.courses(), e.settings),
                                                     abbreviations(e)).course_ids
    if not named:
        course_ids = e.visible(course_ids)
    if course_ids == []:
        return [], {}
    folder, also = e.folder_scope(under)
    corrected = e.index.corrections(query, abbreviations(e))
    query = e.index.corrected(query, corrected)
    hits = e.index.search(query, e.state.courses(), e.settings, limit, course_ids, kinds,
                          under=folder, also=also, literal=literal, since=since, until=until, source=source)
    home = prefs_path.parent if prefs_path else None
    if (len(query.split()) >= 2 and under is None and home and AppPrefs.load(prefs_path).meaning
            and meaning.downloaded(home)):
        codes = {c.id: course_label(c, e.settings) for c in e.state.courses()}
        had = {h.key for h in hits}
        hits += [h for h in Meaning(e.index).search(query, meaning.embedder(home), codes, course_ids, kinds,
                                                    since, until, source=source)
                 if h.key not in had]
    return hits, corrected
