# Canvas Sync desktop app

Tauri shell + React UI over the Python backend (`canvas serve`).

```sh
# once: Rust (https://rustup.rs), then
npm install
npm run tauri dev      # starts Vite, builds the shell, which starts `../.venv/bin/canvas serve`
```

Set `CANVAS_BACKEND=/path/to/canvas` to use a different backend executable.

| | |
|---|---|
| `src-tauri/src/lib.rs` | starts/stops the backend, global shortcut (⌘⇧Space / Ctrl+Shift+Space), windows |
| `src/Launcher.tsx` | the quick-search window |
| `src/MainWindow.tsx` | sidebar (courses, smart folders), navigation, menus for sync / restore |
| `src/components/FileBrowser.tsx` | folder contents: expandable list or icon grid, keyboard navigation |
| `src/components/RestoreDialog.tsx`, `SmartFolderDialog.tsx` | the two dialogs |
| `src/lib/api.ts` | client for the backend's HTTP API |

The backend is started with `--exit-with-stdin` and the shell holds its stdin open, so it
exits with the app however the app ends (including `tauri dev` restarts).
