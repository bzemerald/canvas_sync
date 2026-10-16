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
| `pull [PATH…] [-c COURSE] [-n] [-v] [--json]` | fetch new/changed files; with paths, only in those folders/files |
| `status [--json]` | your local edits / moves / deletions since the last pull (offline) |
| `restore PATH…` | put back the Canvas original of a file, or of everything you changed in a folder (your versions go to the Trash) |
| `search QUERY… [-o N] [--json]` | search every course (offline), see below |
| `index` | update the search index (runs after every `pull`) |
| `open [COURSE]` | open in Finder |
| `serve` | local API for the desktop app |

## Search

`canvas search 221 mt` searches file names, folder names, the text inside PDFs /
Office files / notebooks, and every page, assignment, announcement and syllabus.

- Words that name a course become a filter: `221`, `math221`, `cs70` (for COMPSCI 70),
  the start of the course name, or your own `[course_aliases]`.
- Abbreviations expand both ways: `mt` ↔ midterm, `hw` ↔ homework / problem set,
  `sol` ↔ solution, `期中` → midterm, … Add your own under `[search.abbreviations]`.
- `mt1` finds "MT1.pdf", "Midterm 1 Solutions" and "midterm1.pdf" alike.
- `--open N` opens result N (the file, or the Canvas page).
- Results whose name or folder matches come first; files that only mention it inside follow.
- `[[pinned]]` in `config.toml` is the app's sidebar: pinned folders, and smart folders
  (saved searches; names only unless `content = true`).

The index is `.canvas/index.db`, a cache: delete it and `canvas index` rebuilds it.

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
| rename a folder in the app | remembered in `[folder_names]`; what Canvas adds to it later still goes there, links into it are updated (renaming in Finder only counts as moving the files) |
| delete in the app | to the Trash; files from Canvas aren't downloaded again (restorable). A deleted folder can also stop what Canvas adds to it later (`skip_folders`) |
| stop syncing in the app | the file stays as your own; Canvas updates no longer touch it (and new files in a folder aren't downloaded) until you resume |

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
engine.py    the public API: courses(), plan(scope), apply(), status(), restore(), list_dir(), search()
state.py     SQLite schema and access
text.py      text out of PDFs, Office files, notebooks, HTML
search.py    the search index (SQLite FTS5) and query parsing
browse.py    a folder as the app shows it: disk + Canvas status, links, deleted files
thumbs.py    preview images for the app's icon view
server.py    local HTTP API for the desktop app (`canvas serve`)
cli.py       `canvas` command
```

Tests run against a fake Canvas server: `.venv/bin/pytest`.
