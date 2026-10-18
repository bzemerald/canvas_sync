"""`python -m canvas_sync`: the `canvas` command (also what the packaged app's backend runs)."""

import multiprocessing

# Packed (PyInstaller), the executable is this command, and multiprocessing starts its helper
# processes with it (with Python's flags, "-B -c ..."): this runs those instead of the command.
multiprocessing.freeze_support()

from canvas_sync.cli import app  # noqa: E402

app()
