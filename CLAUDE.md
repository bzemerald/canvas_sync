# canvas-sync

A CLI that mirrors Canvas course files into a local folder (README.md covers it), and
**Canvas Sync**, a desktop app built on it: a course hub where students can do what they need
without the Canvas website or Finder.

## Working with the user

- The user writes in Chinese: reply in Chinese. Code, comments and commit messages are English.
- Direction: everything a course has (files, announcements, assignments, pages, modules, tools,
  grades) in one app. Mac first, but keep the Windows paths working (the code has them).
- The design goal is flexibility. Instructors put updates, the syllabus and assignments in
  different places (announcements, a page, a module, Ed, Gradescope, a website), and students
  should be able to make every course look alike. Within a course, be extremely flexible:
  anything of it can be put anywhere in it, and most things can be renamed or hidden. Between
  courses, keep a clear border: a course's places hold only its own things (and web links);
  置顶 is the one place where courses meet. Build new features on the one model below (things
  in places), not beside it; a special case for one kind of thing or one place is a smell.
- Frontend and UX decisions are Claude's: make them, say what was decided in the report, and
  don't ask the user to choose.
- Requests come as numbered batches. Do them all, check each one in the running app, then
  report per item in Chinese, with the commit for each.

## Git

- Work on a feature branch, never on main. One commit per requested item, once it's checked.
- Merge into main (fast-forward) only when asked; never push unless asked.
- Commit messages: the subject says what changed for the user, as a plain sentence ("Pin almost
  anything, by dragging it to 置顶"); the body explains the behavior; end with the
  Co-Authored-By line.

## Layout

- `src/canvas_sync/`: the Python package.
  - `things.py`: what can be put somewhere (a thing), and how it's written down; the old formats.
  - `places.py`: the places (置顶; a course's tabs, overview, 工具与链接), their rules.
  - `cli.py`: the `canvas` command.
  - `engine.py`, `plan.py`, `execute.py`: sync.
  - `discover.py`: finding files through modules and pages.
  - `ed.py`: Ed (edstem.org): its unofficial API (read-only, a token from Ed's settings), which
    Canvas course each Ed course is.
  - `state.py`: `.canvas/state.db` (SQLite).
  - `search.py`: `.canvas/index.db` (FTS5): the text inside.
  - `catalog.py`: everything search can go to by name (`GET /catalog`); `state.py` keeps what
    you open (`POST /opened`).
  - `meaning.py`: search by meaning (English; off unless turned on in 设置: a small model is
    downloaded to the app's folder, `models/`; passages and their vectors go in index.db).
  - `content.py`: what the app shows (overview, items, modules, tools).
  - `server.py`: the app's HTTP API (`canvas serve`).
  - `config.py`: config.toml and app.toml, written with tomlkit so comments survive.
- `app/`: Tauri v2, React 19, TypeScript, Vite, Tailwind v4.
  - `src/MainWindow.tsx`: sidebar, navigation (`View`), menus, pinning.
  - `src/components/CourseView.tsx`: tabs, readers, modules, grades.
  - `src/components/Overview.tsx`: the overview's cards.
  - `src/components/FileBrowser.tsx`, `HitBrowser.tsx` (search results).
  - `src/Launcher.tsx`: the search window (⌘⇧Space).
  - `src/lib/query.ts`: what a query says: a course, a kind, a time, a status ("cs70 作业 本周
    未交"), numbered things ("hw3" = Homework 3 = Problem Set 3), words; `src/lib/find.ts`: what
    that finds as you type, by name (match-sorter) and from the index (`GET /find`), weighted in
    one place (`W`); `src/lib/queries.test.ts`: what should come first for what students type
    (run it after changing a weight);
    `src/components/Found.tsx`: how it's shown (the query's parts as chips), in the search
    window and on 搜索.
  - `src/lib/api.ts`: every backend call and its types.
  - `src/lib/things.ts`: things (as in things.py), their keys, changing a place's list.
  - `src/components/Things.tsx`: a thing's name, icon, menu; dragging it (`useThing`).
  - `src-tauri/` starts `.venv/bin/canvas serve --exit-with-stdin`.
- `tests/`: pytest against `tests/fake_canvas.py`, a fake Canvas served over httpx.

## Commands

- Python tests: `.venv/bin/python -m pytest -q tests`
- Frontend checks, in `app/`: `npx tsc --noEmit -p .`, `npm test` (vitest), `npm run build`,
  `npm run check:i18n` (it must report nothing missing and nothing unused).
- Running the app: `npm run tauri dev` in `app/`. It's usually already running in the user's
  terminal (check `ps`). Frontend edits hot-reload. The Python server keeps running old code
  until the app restarts: `touch app/src-tauri/src/lib.rs`, and tauri dev rebuilds and
  relaunches it.

## Conventions

- **UI strings are Chinese, translated:**
  - Write `t("中文")`, or `tx()` when the string holds elements. The English goes in
    `app/src/lib/en.ts`, as `[singular, plural]` when the string counts `{n}`.
  - The same Chinese needing different English gets a context suffix: `t("置顶@@heading")`
    (the part after `@@` only tells them apart).
  - `i18n-ignore` on a line exempts it from the check.
- **Comments are short and plain:** what something is, or why. Match the file's density.
- **Things and places** (the model everything is built on):
  - A *thing* is `{type, ...}`: course, folder, file, doc (announcement / assignment / page; post,
    on Ed; Ed's ids are `ed-<id>`), module, tool, link, search (a smart folder is a search pinned),
    note, view (one of a course's views: overview, modules, announcements, discussion = 讨论 (its
    Ed posts), assignments, grades, files, syllabus, pages, tools = 工具与链接, canvas). Same
    fields in config.toml, the API and the app.
  - A *place* is a list of entries: a thing, `title` (your name for it there; "" = its own),
    `hidden`. Places: `pinned` (anything), and per course `tabs`, `overview`, `links`, which
    hold only the course's things (`Place.holds`, `ofCourse` in the app): its views, documents,
    modules, tools, notes, folders and files in its folder, searches of just it; web links.
  - A course's places have *own* things (its views; in links its tools, syllabus, Canvas):
    hidden, never taken away. The rest were put there, and can be taken away (with 撤销).
  - A course's tabs and overview follow the default (app.toml) until arranged: then what's
    stored has own things in it. `Place.arranged/settle/added` in places.py; the app sends
    whole lists (`PUT /pinned`, `PUT /courses/<id>/layout/<place>`), the backend settles them.
  - In the app: `open(thing)` opens anything where it opens; `ways(thing)` is what its menu
    offers; each place renders a thing its own way (a tab shows it, a card sums it up).
  - Old config formats (pinned without `type`, `tab_items`, `cards`, `hidden_links`, app.toml's
    `tab_order`...) are read by `old_*` in things.py and rewritten once, when the server starts.
- **Dragging uses pointer events, not HTML5 drag and drop:**
  - `lib/drag.ts` (`trackDrag`): threshold, the copy that follows the pointer, auto-scroll, the
    swallowed click.
  - `lib/reorder.tsx` (`useReorder`): rows, columns, cards. Options: `thing` (what an item is,
    to drop in another place), `zone` (its own place), `remove` (dragged off the list: take it
    away).
  - `lib/dropZones.ts` (`useDropZone`): places that take drops. The innermost under the pointer
    takes it; places inside one another don't take each other's items.
  - `useThing()(entry)` (components/Things.tsx) makes anything on screen draggable to a place,
    with `ways` + 置顶 in its right-click menu.
- **Where settings live:**
  - `<sync folder>/.canvas/config.toml`: sync rules, and app things tied to courses:
    - `[[pinned]]`: 置顶, entries of any thing.
    - `[course_layouts.<id>]`: `tabs`, `overview`, `links`, each a list of entries (the
      course's own things leave out `course`).
    - `[course_icons]`, `[sidebar]` order, hidden courses.
    - `[ed.courses]`: each course's Ed course (0: none, as chosen).
  - Notes typed on an overview: `<sync folder>/.canvas/notes/<course>/<id>.md`.
  - `~/.config/canvas-sync/app.toml`: app prefs (language, auto sync, the default `tabs` and
    `overview`: views of no course). Tests must never touch the real one (conftest.py points
    `CANVAS_SYNC_HOME` elsewhere).
  - The Canvas token is in the keychain; so is Ed's (`edstem:<region>`), its region and your name
    there in `~/.config/canvas-sync/config.toml`.

## Checking the app's UI (macOS)

The tools are in `.claude/ui-test/`. Build them once with `.claude/ui-test/build.sh`.

- `idle.sh [seconds]`: the user may be at the Mac, and their clicks mix with yours.
  - Drive the UI only after 3 idle minutes; wait for that in the background.
  - Between steps, check that `canvas-desktop` is still in front, and stop if it isn't. (Your
    own clicks reset the idle time.)
- `front.sh`: brings the app forward and waits until the window has settled (Stage Manager).
- `shot.sh out.png`, then `python3 halve.py out.png small.png [x y w h]`: screenshots are 2x,
  halved they're in window points.
- `bin/mouse click|rclick|dclick|move|scroll|drag|press|dragto|release ...`: input in window
  points. Use `press`/`dragto`/`release` to screenshot mid-drag.

Rules, learned the hard way:

- **Back up first.** `~/Canvas` is the user's real sync folder. Copy
  `~/Canvas/.canvas/config.toml` and `~/.config/canvas-sync/app.toml` aside before testing.
  Afterwards restore them, delete leftovers (test notes), and restart the app so the UI
  matches.
- **Look before clicking a menu item.** Screenshot after a menu opens and click from that
  (menus differ by context; a mis-click once deleted a card).
- **Wait a second after a screenshot before clicking.** For about a second after a capture,
  macOS's screenshot process takes clicks, and the app never sees them. (This once looked like
  a broken Undo button.)
- **Let the sidebar settle.** Its sync status changes height while syncing, which shifts
  everything below it.
- **Don't type Latin text with synthetic keystrokes.** The Chinese input method garbles it.
  Paste instead: save the clipboard (`pbpaste`), `pbcopy` the text, ⌘V with `osascript -e 'tell
  application "System Events" to keystroke "v" using command down'`, restore it after. Keys
  (`key code 36` enter, `53` esc, ⌘⇧Space for the search window) are fine.
- **The search window is a window of its own.** `shot.sh` and `bin/mouse` work on the main one;
  capture it with `screencapture -x -o -l <id>` (its id: `bin/winid canvas-desktop`, "Canvas
  Search"). Opening things from search records them in state.db (`opened`, `picks`): clear what
  testing added.
- **Ask before any Canvas calls of your own** (API scripts, opening tools). The app's own
  syncing is fine.
- **Leave the user's own customizations alone.** An odd setting the user made isn't a test
  leftover.
- **Check the screen before driving it.** After a while idle the Mac shows its screen saver, or
  locks: window captures come back black. `CGSSessionScreenIsLocked` (Quartz's
  `CGSessionCopyCurrentDictionary()`) tells which: locked, stop (keystrokes would go to the
  password field); not locked, moving the mouse a pixel wakes the screen.
