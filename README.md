# canvas-sync

Everything a Canvas course has, on your own computer.

- **`canvas`**, a command-line tool, mirrors Canvas course files into a normal folder that
  Finder, Spotlight and your own apps can use. `canvas pull` works like `git pull`: it fetches
  what changed, never overwrites your edits, and keeps the original of every file so you can
  restore it.
- **Canvas Sync**, a desktop app built on it, is a hub for each course: files, announcements,
  assignments, pages, modules, tools, grades and the course's posts on Ed, in one window, so
  you rarely need the Canvas website or Finder. Every course can be arranged to look alike, however
  its instructor organized it.


## The desktop app

```sh
python3 -m venv .venv && .venv/bin/pip install -e '.[dev]'
cd app && npm install        # and Rust, from https://rustup.rs
npm run tauri dev            # the app starts .venv/bin/canvas serve itself
```

The first launch asks for your Canvas address, an access token and the sync folder. The app
then syncs on launch and every hour (you can change both in Settings). Its interface is in
Chinese or English. See [app/README.md](app/README.md) for how the shell and backend fit together.

To build the app as a standalone `Canvas Sync.app` (and a `.dmg`), in `app/`:

```sh
npm run bundle    # -> src-tauri/target/release/bundle/macos/, and dmg/
```

This packs the Python backend with PyInstaller into the app (`npm run build:backend` does that
part alone), so the app doesn't need this repo or its `.venv`. `npm run tauri build` makes
one without it, which starts the repo's `.venv/bin/canvas`. It isn't signed with a developer
ID: on another Mac, open it the first time with right-click → Open. The packed backend is a new
program to the Keychain, so macOS may ask before it reads the Canvas token (Always Allow), and
again after a rebuild.

- **A course's page** has tabs (overview, modules, announcements, discussion, assignments,
  grades, files, syllabus, pages) and an overview of cards (upcoming deadlines, latest
  announcements, current modules, new files, grades, tools and links, notes you type).
  Anything of the course can be put anywhere on its page by dragging it, a page, a module, a
  folder, a file, a search, as a tab, a card or a link. Most things can be renamed or hidden
  there. Arrange the tabs and overview once as the default for every course, or per course.
- **Pinned**, at the top of the sidebar, holds anything from any course: a course, a folder,
  a file, a document, a tab, a tool, a web link, a smart folder (a search, pinned).
- **Files** shows the course's folder with what's new to you, what you changed or deleted
  (with *Show modifications*), and what isn't synced. You can restore originals, stop or resume
  syncing, rename folders, and delete to the Trash, all from right-click menus.
- **Search** (⌘⇧Space anywhere, or the search box) finds things by name as you type, and by
  the text inside them. It reads what a query says: a course, a kind, a time, a status, numbered
  things: `cs70 due this week not submitted` is CS 70's assignments due this week that aren't handed in; `hw3` also
  finds "Homework 3" and "Problem Set 3"; a misspelled word ("midtrem") is taken for the one
  meant.
- **New** things (announcements, assignments, pages, files, Ed posts) get a blue dot until you
  open them, and the sidebar counts them per course.

## Ed

Connect Ed (edstem.org) in Settings with a token made in Ed's own settings (API Tokens). The
token is kept in the keychain. Each Ed course is matched to its Canvas course by course code and
term, and you can change the match in Settings. On each sync:

- Ed's announcements appear among the course's announcements, marked *Ed*. One posted on both
  Canvas and Ed (same title, within two days) shows once.
- The course gets a **Discussion** tab of its Ed posts (filter by pinned, staff, unread,
  watched, category) and a card of what's pinned and what staff posted.
- Replies to pinned, staff and megathread posts are downloaded for reading offline. Other posts'
  replies are fetched when you open them.
- Search finds pinned and staff posts by name, and every post by its text (staff answers
  included). Students' questions come after other matches that fit as well.

It's read-only: nothing is posted, and nothing is marked read on Ed. Ed has no documented
API; this uses the one its website uses, so a change on Ed's side can break it (the app then
says "Ed changed"). Ed is fetched by the app's syncs, not by `canvas pull`.

## The command line

```sh
python3 -m venv .venv && .venv/bin/pip install -e '.[dev]'
.venv/bin/canvas init        # Canvas URL, access token (stored in the keychain), sync folder
.venv/bin/canvas courses     # which courses will sync; --sync ID / --skip ID to change
.venv/bin/canvas pull -n     # dry run
.venv/bin/canvas pull
```

| command | |
|---|---|
| `pull [PATH…] [-c COURSE] [-n] [-v] [--json]` | fetch new/changed files; with paths, only in those folders/files |
| `status [--json]` | your local edits / moves / deletions since the last pull (offline) |
| `restore PATH…` | put back the Canvas original of a file, or of everything you changed in a folder (your versions go to the Trash) |
| `search QUERY… [-n N] [-o N] [--json]` | search every course (offline), see below |
| `index` | update the search index (runs after every `pull`) |
| `open [COURSE]` | open in Finder |
| `serve [--port N]` | the local API the desktop app uses |

## Search

`canvas search 221 mt` searches file names, folder names, the text inside PDFs, Office files
and notebooks, and every page, assignment, announcement and syllabus (and Ed post).

- Words that name a course become a filter: `221`, `math221`, `cs70` (for COMPSCI 70),
  the start of the course name, or your own `[course_aliases]`.
- Abbreviations expand both ways: `mt` ↔ midterm, `hw` ↔ homework / problem set,
  `sol` ↔ solution, … Add your own under `[search.abbreviations]`.
- `mt1` finds "MT1.pdf", "Midterm 1 Solutions" and "midterm1.pdf" alike.
- Results whose name or folder matches come first; files that only mention it inside follow.
- `--open N` opens result N (the file, or the Canvas page).

**By meaning** (in the app, off unless turned on in Settings): "can I get an extension" finds
the announcement about Flextensions. A small English model (~125 MB) is downloaded to the app's
folder; English only, and Chinese queries are matched by their words.

The index is `.canvas/index.db`, a cache: delete it and `canvas index` rebuilds it.

## What ends up on disk

```
~/Canvas/
  Fall 2026/MATH 221/
    Modules/01 Week 1/lec1.pdf      ← the real file
    Files/Lectures/lec1.pdf         ← symlink to it (same file, other view)
  .canvas/
    config.toml                     ← layout, sync policies, the app's arrangement; edit freely
    notes/                          ← notes typed on a course's overview in the app
    state.db                        ← what we know (SQLite)
    index.db                        ← the search index
    originals/                      ← pristine copies (APFS clones: ~no extra space)
~/.config/canvas-sync/
  config.toml                       ← which Canvas, which sync folder; your Ed region
  app.toml                          ← the app's preferences, the default tabs and overview
```

Files are found through the Files tab, modules, and links inside pages, assignments,
announcements and the syllabus, so a hidden Files tab doesn't hide anything. Canvas and Ed
tokens are in the keychain.

In `.canvas/config.toml`, besides the sync settings:

- `[[pinned]]` is the sidebar's Pinned, each entry a thing of any kind.
- `[course_layouts.<id>]` is a course's page as you arranged it: its `tabs`, `overview` and
  `links`, each a list of the course's own things (and web links), with your name for each
  and whether it's hidden.
- `[ed.courses]` says which Ed course each course is (0: none).

## How your changes are treated

| you… | next `pull` |
|---|---|
| edit a file | kept. If Canvas also changed it: your copy becomes `name (mine).pdf`, the new version takes its place (`sync.on_conflict`) |
| delete a file | not downloaded again (`sync.on_local_delete`); `canvas restore` brings it back |
| move/rename a file in Finder | remembered; future updates go to the new spot (`sync.on_local_move`) |
| rename a folder in the app | remembered in `[folder_names]`; what Canvas adds to it later still goes there, links into it are updated (renaming in Finder only counts as moving the files) |
| delete in the app | to the Trash; files from Canvas aren't downloaded again (restorable). A deleted folder can also stop what Canvas adds to it later (`skip_folders`) |
| stop syncing in the app | the file or folder stays as your own; Canvas updates no longer touch it, new files in a folder aren't downloaded, and the shortcuts in it stay, until you resume (resuming a folder inside one that isn't synced resumes the way to it) |

Files removed from Canvas are kept locally (`sync.on_remote_delete`). An instructor
re-uploading a file (Canvas gives it a new id) is treated as an update, not a new file.

`[[rules]]` in `config.toml` put matching files somewhere else, e.g. every
`files/Lecture Slides/*.pdf` into `Slides/`, or skip them.

## Code map

The CLI is a thin shell; everything goes through `Engine`, which the app's backend
(`server.py`) uses too. In `src/canvas_sync/`:

```
api.py       Canvas REST client: pagination, rate-limit backoff, downloads
discover.py  course → every file + where it appears (CourseSnapshot)
layout.py    file → local path(s). Pure: pins > rules > views
plan.py      remote vs. original vs. disk → list of Actions (nothing is changed)
execute.py   carries out a Plan
engine.py    the public API: courses(), plan(scope), apply(), status(), restore(), list_dir(), search()
state.py     .canvas/state.db: schema and access
config.py    config.toml and app.toml (written with tomlkit, so comments survive)
text.py      text out of PDFs, Office files, notebooks, HTML
search.py    .canvas/index.db (SQLite FTS5): the text inside, and finding it
meaning.py   search by meaning (an English embedding model, optional)
catalog.py   everything search can go to by name
ed.py        Ed: its API (read-only), matching Ed courses to Canvas courses, posts as documents
things.py    what can be put somewhere (a thing), and how it's written down
places.py    the places (Pinned; a course's tabs, overview, tools and links) and their rules
content.py   what the app shows: overview, items, modules, tools
browse.py    a folder as the app shows it: disk + Canvas status, links, deleted files
thumbs.py    preview images for the app's icon view
server.py    local HTTP API for the desktop app (`canvas serve`)
cli.py       `canvas` command
```

The app (Tauri v2, React, TypeScript) is in `app/`.

## Tests

```sh
.venv/bin/python -m pytest -q tests     # against a fake Canvas (tests/fake_canvas.py) and a fake Ed
cd app && npx tsc --noEmit -p . && npm test && npm run check:i18n
```
