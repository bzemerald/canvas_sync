"""What a sync does after Canvas (Engine.plan and apply): Ed, then the search index, then
passages for searching by meaning; and keeping a browser sign-in that Canvas renewed. The app's
syncs and `canvas pull` both do all of it."""

from __future__ import annotations

from pathlib import Path

from . import ed, meaning
from .api import Auth, CanvasClient
from .config import Account, AppPrefs
from .engine import Engine
from .meaning import Meaning
from .search import ProgressHandler


def keep_sign_in(account: Account, client: CanvasClient, auth: Auth) -> None:
    """Canvas renews a browser sign-in's cookies as it goes: the new ones are kept, so it lasts
    (unless you signed in again meanwhile). `auth`: what `client` signed in with."""
    if (cookies := client.cookies()) and cookies != auth.cookies and account.token() == auth.secret():
        account.set_auth(Auth(cookies=cookies))


async def other_sources(e: Engine, account: Account, course_ids: list[int]) -> str | None:
    """Ed, when it's connected: what went wrong there (None: nothing; the rest synced anyway)."""
    if account.ed_region and (token := account.ed_token()):
        return await ed.sync(e, token, account.ed_region, course_ids)
    return None


def reindex(e: Engine, prefs_path: Path, on_progress: ProgressHandler | None = None,
            on_meaning: meaning.ProgressHandler | None = None) -> None:
    """The search index, from what was synced; then passages for what changed, when searching
    by meaning is on (`prefs_path`: app.toml, whose folder has the model)."""
    e.reindex(on_progress)
    home = prefs_path.parent
    if AppPrefs.load(prefs_path).meaning and meaning.downloaded(home):
        Meaning(e.index).sync(meaning.embedder(home), on_meaning)
