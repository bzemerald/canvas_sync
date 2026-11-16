"""A sync folder, and this computer's app.toml, as older versions left them, made the way this
one keeps them. Done once, when something starts.

The app's backend does all of it (`update`): folders older versions renamed on disk go back to
their names, config.toml written the old ways is rewritten (the old ways are still read: `old_*`
in things.py, config.py), titles that renamed folders stood for become titles of their own, old
thumbnails are forgotten, and app.toml's old defaults are rewritten.

The command line and `canvas mcp` do only the first (`migrate_folder_names`): a file isn't where
its record says until its folder is back, so that can't wait for the app; the rest they read as
it is.
"""

from __future__ import annotations

from pathlib import Path

from . import content
from .config import AppPrefs, add_titles, migrate, needs_migration, needs_titles, old_folder_names
from .engine import Engine
from .layout import titles_of_folders
from .paths import config_file
from .thumbs import forget_old_thumbnails


def migrate_folder_names(root: Path) -> None:
    """A sync folder from when renaming a folder renamed it on disk, as it is now. Once, where the
    app, the command line and `canvas mcp` start (not when an Engine opens: most only read)."""
    cfg = config_file(root.expanduser())
    if cfg.exists() and (names := old_folder_names(cfg)) is not None:
        with Engine(root) as e:
            e.undo_folder_names(names)


def update(root: Path | None, prefs_path: Path) -> None:
    """Everything, for the sync folder at `root` (None: not set up yet) and app.toml. A config.toml
    that can't be read is left as it is: what reads it next says so."""
    try:
        if root is not None:
            migrate_folder_names(root)
            forget_old_thumbnails(root)
        if root is not None and needs_migration(cfg := config_file(root)):
            with Engine(root) as e:
                migrate(cfg, lambda course: [t["id"] for t in content.tools(e.state, course)])
        if root is not None and needs_titles(cfg := config_file(root)):
            with Engine(root) as e:
                add_titles(cfg, *titles_of_folders(e.settings, e.state.courses()))
        AppPrefs.migrate(prefs_path)
    except Exception:  # (a broken config.toml: every request says so)
        pass
