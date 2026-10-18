//! Desktop shell. The real work happens in the Python backend (`canvas serve`), which
//! this process starts, hands to the web UI (port + token), and stops on exit.

use std::collections::VecDeque;
use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, RunEvent, WindowEvent};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

#[cfg(target_os = "macos")]
mod quicklook;

const LAUNCHER: &str = "launcher";
/// Carries what's being dragged past the main window's edge, where the page can't draw it.
const GHOST: &str = "ghost";
const STARTUP_TIMEOUT: Duration = Duration::from_secs(20);
/// The main window was closed while full screen: hide it once it has left full screen.
static HIDE_AFTER_FULLSCREEN: AtomicBool = AtomicBool::new(false);

#[derive(Clone, Serialize, Deserialize)]
struct Backend {
    port: u16,
    token: String,
}

#[derive(Default)]
struct BackendState {
    child: Mutex<Option<Child>>,
    /// Held open for our lifetime: when this process ends, however it ends, the OS closes
    /// it and the backend (started with --exit-with-stdin) exits too.
    lifeline: Mutex<Option<ChildStdin>>,
    /// None while starting, then the connection details or why it failed.
    ready: Mutex<Option<Result<Backend, String>>>,
    /// Last lines the backend wrote to stderr, for error messages.
    log: Mutex<VecDeque<String>>,
}

/// Where the `canvas` executable is: $CANVAS_BACKEND; in a release build, the one packed
/// inside the app, if it was (`npm run bundle`); else the repo's virtualenv (development).
fn backend_path(app: &AppHandle) -> PathBuf {
    if let Some(p) = std::env::var_os("CANVAS_BACKEND") {
        return PathBuf::from(p);
    }
    if !cfg!(debug_assertions) {
        let exe = if cfg!(windows) { "canvas.exe" } else { "canvas" };
        if let Some(packed) = app.path().resource_dir().ok().map(|d| d.join("backend").join(exe)) {
            if packed.is_file() {
                return packed;
            }
        }
    }
    let repo = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
    if cfg!(windows) {
        repo.join(".venv/Scripts/canvas.exe")
    } else {
        repo.join(".venv/bin/canvas")
    }
}

fn start_backend(app: &AppHandle) {
    let state = app.state::<BackendState>();
    let path = backend_path(app);
    let spawned = Command::new(&path)
        .args(["serve", "--exit-with-stdin"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn();
    let mut child = match spawned {
        Ok(c) => c,
        Err(e) => {
            *state.ready.lock().unwrap() = Some(Err(format!("could not start {}: {e}", path.display())));
            return;
        }
    };
    let stdout = child.stdout.take().unwrap();
    let stderr = child.stderr.take().unwrap();
    *state.lifeline.lock().unwrap() = child.stdin.take();
    *state.child.lock().unwrap() = Some(child);

    // Keep draining stderr so the backend never blocks on a full pipe.
    let handle = app.clone();
    std::thread::spawn(move || {
        for line in BufReader::new(stderr).lines().map_while(Result::ok) {
            eprintln!("[backend] {line}");
            let state = handle.state::<BackendState>();
            let mut log = state.log.lock().unwrap();
            log.push_back(line);
            if log.len() > 30 {
                log.pop_front();
            }
        }
    });

    let handle = app.clone();
    std::thread::spawn(move || {
        let mut first = String::new();
        let read = BufReader::new(stdout).read_line(&mut first);
        let state = handle.state::<BackendState>();
        let result = match read {
            Ok(n) if n > 0 => serde_json::from_str::<Backend>(&first)
                .map_err(|e| format!("unexpected backend output {first:?}: {e}")),
            _ => {
                std::thread::sleep(Duration::from_millis(200)); // let the stderr thread catch up
                let log = state.log.lock().unwrap();
                Err(log.iter().cloned().collect::<Vec<_>>().join("\n"))
            }
        };
        *state.ready.lock().unwrap() = Some(result);
    });
}

fn stop_backend(app: &AppHandle) {
    if let Some(mut child) = app.state::<BackendState>().child.lock().unwrap().take() {
        let _ = child.kill();
        let _ = child.wait();
    }
}

/// The UI calls this once on load; it waits until the backend is listening.
#[tauri::command]
async fn backend(state: tauri::State<'_, BackendState>) -> Result<Backend, String> {
    let started = Instant::now();
    loop {
        if let Some(result) = state.ready.lock().unwrap().clone() {
            return result;
        }
        if started.elapsed() > STARTUP_TIMEOUT {
            return Err("the backend did not start in time".into());
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

#[tauri::command]
fn hide_launcher(app: AppHandle) {
    if let Some(w) = app.get_webview_window(LAUNCHER) {
        let _ = w.hide();
    }
}

#[tauri::command]
fn show_main(app: AppHandle) {
    hide_launcher(app.clone());
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

fn toggle_launcher(app: &AppHandle) {
    let Some(w) = app.get_webview_window(LAUNCHER) else { return };
    if w.is_visible().unwrap_or(false) {
        let _ = w.hide();
    } else {
        let _ = w.center();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

/// Hides the main window when it has finished leaving full screen, if it was closed while
/// full screen. (Its Resized events come as leaving starts, when hiding is too early: AppKit
/// brings the window back when the animation ends.)
#[cfg(target_os = "macos")]
fn hide_after_full_screen(app: &AppHandle) {
    use objc2_app_kit::NSWindowDidExitFullScreenNotification;
    use objc2_foundation::NSNotificationCenter;
    let Some(w) = app.get_webview_window("main") else { return };
    let Ok(ns_window) = w.ns_window() else { return };
    let app = app.clone();
    let block = block2::RcBlock::new(move |_| {
        if HIDE_AFTER_FULLSCREEN.swap(false, Ordering::Relaxed) {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.hide();
            }
        }
    });
    let observer = unsafe {
        NSNotificationCenter::defaultCenter().addObserverForName_object_queue_usingBlock(
            Some(NSWindowDidExitFullScreenNotification),
            Some(&*(ns_window as *const objc2::runtime::AnyObject)),
            None,
            &block,
        )
    };
    std::mem::forget(observer); // observes for the app's lifetime
}

fn launcher_shortcut() -> Shortcut {
    let modifier = if cfg!(target_os = "macos") { Modifiers::SUPER } else { Modifiers::CONTROL };
    Shortcut::new(Some(modifier | Modifiers::SHIFT), Code::Space)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(BackendState::default())
        .plugin(tauri_plugin_dialog::init()) // choosing the sync folder
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    if shortcut == &launcher_shortcut() && event.state() == ShortcutState::Pressed {
                        toggle_launcher(app);
                    }
                })
                .build(),
        )
        .setup(|app| {
            start_backend(app.handle());
            #[cfg(target_os = "macos")]
            hide_after_full_screen(app.handle());
            if let Some(w) = app.get_webview_window(GHOST) {
                let _ = w.set_ignore_cursor_events(true); // the pointer goes through, to the drag
            }
            if let Err(e) = app.global_shortcut().register(launcher_shortcut()) {
                eprintln!("could not register the search shortcut: {e}");
            }
            Ok(())
        })
        .on_window_event(|window, event| match (window.label(), event) {
            // Like Spotlight: clicking elsewhere dismisses the search window.
            (LAUNCHER, WindowEvent::Focused(false)) => {
                let _ = window.hide();
            }
            // On macOS closing the window leaves the app (and its search shortcut) running, as
            // Mac apps do; the Dock icon brings the window back. Elsewhere there's no tray icon
            // yet to get back to a hidden app, so closing the window quits.
            ("main", WindowEvent::CloseRequested { api, .. }) => {
                if cfg!(target_os = "macos") {
                    api.prevent_close();
                    // Hiding a full-screen window leaves its Space behind, black: leave full
                    // screen first, and hide when that's done (hide_after_full_screen).
                    if window.is_fullscreen().unwrap_or(false) {
                        HIDE_AFTER_FULLSCREEN.store(true, Ordering::Relaxed);
                        let _ = window.set_fullscreen(false);
                    } else {
                        let _ = window.hide();
                    }
                } else {
                    window.app_handle().exit(0);
                }
            }
            _ => {}
        })
        .invoke_handler(tauri::generate_handler![
            backend,
            hide_launcher,
            show_main,
            #[cfg(target_os = "macos")]
            quicklook::quick_look
        ])
        .build(tauri::generate_context!())
        .expect("error while building the app")
        .run(|app, event| match event {
            RunEvent::Exit => stop_backend(app),
            #[cfg(target_os = "macos")]
            RunEvent::Reopen { .. } => show_main(app.clone()), // the Dock icon was clicked
            _ => {}
        });
}
