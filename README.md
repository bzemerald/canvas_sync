# canvas-sync

Mirror Canvas course files into a normal folder so Finder, Spotlight and your own
apps can use them. `canvas pull` works like `git pull`: it fetches what changed,
never overwrites your edits, and keeps the original of every file so you can restore it.

## Setup

```sh
python3 -m venv .venv && .venv/bin/pip install -e '.[dev]'
.venv/bin/canvas init        # Canvas URL, access token (stored in Keychain), sync folder
.venv/bin/canvas courses     # which courses will sync; --sync ID / --skip ID to change
.venv/bin/canvas pull -n     # dry run
.venv/bin/canvas pull
```

| command | |
|---|---|
| `pull [-c COURSE] [-n] [-v] [--json]` | fetch new/changed files |
| `status [--json]` | your local edits / moves / deletions since the last pull (offline) |
| `restore PATH…` | put back the Canvas original (your version goes to the Trash) |
| `open [COURSE]` | open in Finder |

## What ends up on disk

```
~/Canvas/
  Fall 2026/MATH 221/
    Modules/01 Week 1/lec1.pdf      ← the real file
    Files/Lectures/lec1.pdf         ← symlink to it (same file, other view)
  .canvas/
    config.toml                     ← layout + sync policies, edit freely
    state.db                        ← what we know (SQLite)
    originals/                      ← pristine copies (APFS clones: ~no extra space)
```

Files are found through the Files tab, modules, and links inside pages, assignments,
announcements and the syllabus, so a hidden Files tab doesn't hide anything.

## How your changes are treated

| you… | next `pull` |
|---|---|
| edit a file | kept. If Canvas also changed it: your copy becomes `name (mine).pdf`, the new version takes its place (`sync.on_conflict`) |
| delete a file | not downloaded again (`sync.on_local_delete`); `canvas restore` brings it back |
| move/rename a file in Finder | remembered; future updates go to the new spot (`sync.on_local_move`) |

Files removed from Canvas are kept locally (`sync.on_remote_delete`). An instructor
re-uploading a file (Canvas gives it a new id) is treated as an update, not a new file.

`[[rules]]` in `config.toml` put matching files somewhere else, e.g. every
`files/Lecture Slides/*.pdf` into `Slides/`, or skip them.

## Code map

The CLI is a thin shell; everything goes through `Engine`, so a GUI can reuse it.

```
api.py       Canvas REST client: pagination, rate-limit backoff, downloads
discover.py  course → every file + where it appears (CourseSnapshot)
layout.py    file → local path(s). Pure: pins > rules > views
plan.py      remote vs. original vs. disk → list of Actions (nothing is changed)
execute.py   carries out a Plan
engine.py    the public API: courses(), plan(), apply(), status(), restore()
state.py     SQLite schema and access
cli.py       `canvas` command
```

Tests run against a fake Canvas server: `.venv/bin/pytest`.
