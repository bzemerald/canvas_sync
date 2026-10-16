# canvas-sync

A CLI that mirrors Canvas course files into a local folder (README.md covers it), and
**Canvas Sync**, a desktop app built on it: a course hub where students can do what they need
without the Canvas website or Finder.

## Working with the user

- The user writes in Chinese: reply in Chinese. Code, comments and commit messages are English.
- Direction: everything a course has (files, announcements, assignments, pages, modules, tools,
  grades) in one app. Mac first, but keep the Windows paths working (the code has them).
  Instructors put things in different places, so prefer flexible and customizable over fixed.
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
  - `cli.py`: the `canvas` command.
  - `engine.py`, `plan.py`, `execute.py`: sync.
  - `discover.py`: finding files through modules and pages.
  - `state.py`: `.canvas/state.db` (SQLite).
  - `search.py`: `.canvas/index.db` (FTS5).
  - `content.py`: what the app shows (overview, items, modules, tools).
  - `server.py`: the app's HTTP API (`canvas serve`).
  - `config.py`: config.toml and app.toml, written with tomlkit so comments survive.
- `app/`: Tauri v2, React 19, TypeScript, Vite, Tailwind v4.
  - `src/MainWindow.tsx`: sidebar, navigation (`View`), menus, pinning.
  - `src/components/CourseView.tsx`: tabs, readers, modules, grades.
  - `src/components/Overview.tsx`: the overview's cards.
  - `src/components/FileBrowser.tsx`, `HitBrowser.tsx` (search results).
  - `src/Launcher.tsx`: the search window.
  - `src/lib/api.ts`: every backend call and its types.
  - `src-tauri/` starts `.venv/bin/canvas serve --exit-with-stdin`.
- `tests/`: pytest against `tests/fake_canvas.py`, a fake Canvas served over httpx.

## Commands

- Python tests: `.venv/bin/python -m pytest -q tests`
- Frontend checks, in `app/`: `npx tsc --noEmit -p .`, `npm run build`, `npm run check:i18n`
  (it must report nothing missing and nothing unused).
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
- **Dragging uses pointer events, not HTML5 drag and drop:**
  - `lib/drag.ts` (`trackDrag`): threshold, the copy that follows the pointer, auto-scroll, the
    swallowed click.
  - `lib/reorder.tsx` (`useReorder`): rows, columns, cards.
  - `lib/pinZone.ts`: 置顶 as a drop target.
  - `lib/pinnable.ts`: `usePinnable()(target)` makes any row draggable to 置顶 and adds
    置顶 / 取消置顶 to its right-click menu.
- **Where settings live:**
  - `<sync folder>/.canvas/config.toml`: sync rules, and app things tied to courses:
    - `[[pinned]]`: courses, folders, files, docs, modules, tools, links, smart folders.
    - `[course_layouts.<id>]`: tabs and overview arranged per course. A part left out follows
      the default; one equal to the default is dropped (`settle()` in server.py).
    - `[course_icons]`, `[sidebar]` order, hidden courses.
  - Notes typed on an overview: `<sync folder>/.canvas/notes/<course>/<id>.md`.
  - `~/.config/canvas-sync/app.toml`: app prefs (language, auto sync, the default tabs and
    overview).
  - The Canvas token is in the keychain.

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
- **Let the sidebar settle.** Its sync status changes height while syncing, which shifts
  everything below it.
- **Don't type Latin text with synthetic keystrokes.** The Chinese input method garbles it.
- **Ask before any Canvas calls of your own** (API scripts, opening tools). The app's own
  syncing is fine.
- **Leave the user's own customizations alone.** An odd setting the user made isn't a test
  leftover.
