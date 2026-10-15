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
| `src/MainWindow.tsx` | courses, search, sync |
| `src/lib/api.ts` | client for the backend's HTTP API |
