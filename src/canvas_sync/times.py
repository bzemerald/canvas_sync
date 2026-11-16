"""Times as Canvas and Ed write them: ISO 8601, with "Z" for UTC."""

from __future__ import annotations

from datetime import datetime


def time_of(iso: object) -> datetime | None:
    """The time an ISO string says; None when it says none (nothing there, or not a time)."""
    if not iso:
        return None
    try:
        return datetime.fromisoformat(str(iso).replace("Z", "+00:00"))
    except ValueError:
        return None
