"""What courses are called: by the app, by you, and by the parts of their codes people type."""

from __future__ import annotations

import re
from typing import TYPE_CHECKING

from .config import Settings, set_title
from .models import Course

if TYPE_CHECKING:
    from .engine import Engine

# Department names as registrars write them -> what students type.
DEPARTMENTS: dict[str, list[str]] = {
    "compsci": ["cs"], "comsci": ["cs"], "cmpsc": ["cs"], "eleng": ["ee"], "elecengr": ["ee"],
    "eecs": ["cs", "ee"], "mathematics": ["math"], "statistics": ["stat", "stats"], "stat": ["stats"],
    "physics": ["phys"], "chemistry": ["chem"], "chem": ["chemistry"], "economics": ["econ"],
    "psychology": ["psych"], "biology": ["bio"], "integbi": ["ib"], "mcellbi": ["mcb"],
    "mecheng": ["me"], "civeng": ["ce"], "bioeng": ["be"], "neurosc": ["neu"],
}

_NORM = re.compile(r"[\W_]+")


def normalized(text: str) -> str:
    """Letters and digits, lower-cased: how course words are compared."""
    return _NORM.sub("", text.lower())


def course_label(c: Course, settings: Settings) -> str:
    """What the app calls a course: the name you gave it, else its course code."""
    return settings.course_titles.get(c.id) or settings.course_names.get(c.id) or c.code


def term_label(c: Course, settings: Settings) -> str | None:
    """What the app calls a course's term: the name you gave it, else Canvas's."""
    return settings.term_titles.get(c.term or "") or c.term


# A term in a course's code: "Spring", "SP26", "FL25", "2026".
_TERM = re.compile(r"(spring|summer|fall|autumn|winter|sp|su|sm|fa|fl|wi)\d{0,4}|(19|20)\d\d")


def pick_courses(courses: list[Course], wanted: str, settings: Settings | None = None) -> list[Course]:
    """The courses `wanted` says: an id, or part of a code, name or what the app calls it
    (case-insensitive)."""
    w = wanted.strip().lower()
    return [c for c in courses if w == str(c.id) or w in f"{c.code} {c.name}".lower()
            or (settings is not None and w in course_label(c, settings).lower())]


def code_keys(code: str) -> set[str]:
    """The parts of a course code people type: "COMPSCI 70-LEC-001" -> compsci, 70;
    "CS61B SP26" -> cs, 61b, cs61b; "DATA C8" -> data, c8, 8. Only up to the course
    number, so sections ("001"), terms ("SP26") and "LEC" don't count."""
    keys: set[str] = set()
    depts: list[str] = []
    for chunk in re.split(r"[\W_]+", code.lower()):
        if _TERM.fullmatch(chunk):  # "BC INTEGBI (Spring 26)": no course number before the term
            break
        parts = re.findall(r"[^\W\d_]+|\d+[^\W\d_]*", chunk)
        number = next((p for p in parts if p[0].isdigit()), None)
        words = [p for p in parts[: parts.index(number) if number else None] if len(p) > 1]
        depts += words
        keys |= set(words)
        if number:
            keys |= {chunk, number}
            for d in depts:  # COMPSCI 70 -> cs70
                keys |= {alias + number for alias in [d, *DEPARTMENTS.get(d, [])]}
                keys |= set(DEPARTMENTS.get(d, []))
            return keys
    return set()  # no course number: only the full code/name match


def rename_course(e: Engine, course: int, title: str) -> None:
    """What the app calls a course. Its own name, or none: it goes back to that."""
    c = e.state.course(course)
    if c is None:
        raise LookupError(f"no course {course}")
    title = title.strip()
    own = title in ("", e.settings.course_names.get(c.id) or c.code)
    set_title(e.config_file, "course_titles", str(course), None if own else title)


def rename_term(e: Engine, term: str, title: str) -> None:
    """What the app calls a term, by its name on Canvas ("": the courses without one)."""
    if not any((c.term or "") == term for c in e.state.courses()):
        raise LookupError(f"no term {term}")
    title = title.strip()
    set_title(e.config_file, "term_titles", term, None if title in ("", term) else title)
