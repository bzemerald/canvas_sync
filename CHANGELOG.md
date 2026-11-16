# Changelog

What changed for people using Canvas Sync, by version. Each version's part is its release's notes
on GitHub, and what Check for updates shows. `npm run release` (in `app/`) dates Unreleased as the
new version.

## Unreleased

## 0.4.0 — 2026-11-15

- Copy files and folders with ⌘C (Ctrl+C on Windows), or Copy in their right-click menu, to paste
  them in Finder or Explorer, or attach them in a chat.
- Right-click menus on macOS are the system's own.
- Right-click the course's name at the top for the course's menu.
- Right-clicking where there's no menu shows nothing, instead of Reload.
- A change to config.toml or the app's preferences is written whole or not at all: a crash or a
  full disk part way leaves the old file.
- `canvas pull` keeps a browser sign-in that Canvas renewed, as the app does, so it stays signed in
  longer.
- Windows: one installer (-setup.exe), not two, so Canvas Sync can't be installed twice.

## 0.3.0 — 2026-11-10

- Sign in with a browser, for schools that don't allow access tokens.
- Signing in goes a step at a time, with a way back, and asks where to keep the sync folder.
- When a sign-in expires, sign in again from the sidebar; what failed syncs again.
- Switching account or school signs out first, then starts over.
- The sign-in and course pages show the version, and can check for updates.
- Sync problems are said plainly in the sidebar.
- A sync folder that goes missing while the app runs is asked about right away.
- Clicking outside a dialog no longer closes it.
