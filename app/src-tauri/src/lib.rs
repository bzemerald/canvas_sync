//! Desktop shell. The real work happens in the Python backend (`canvas serve`), which
//! this process starts, hands to the web UI (port + token), and stops on exit.

use std::collections::VecDeque;
use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, RunEvent, WindowEvent};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

const LAUNCHER: &str = "launcher";
const STARTUP_TIMEOUT: Duration = Duration::from_secs(20);

#[derive(Clone, Serialize, Deserialize)]
struct Backend {
    port: u16,
    token: String,
}

#[derive(Default)]
struct BackendState {
    child: Mutex<Option<Child>>,
    /// None while starting, then the connection details or why it failed.
    ready: Mutex<Option<Result<Backend, String>>>,
    /// Last lines the backend wrote to stderr, for error messages.
    log: Mutex<VecDeque<String>>,
}

/// Where the `canvas` executable is: $CANVAS_BACKEND, else the repo's virtualenv
/// (development). Packaged builds will ship it as a sidecar next to the app binary.
fn backend_path() -> PathBuf {
    if let Some(p) = std::env::var_os("CANVAS_BACKEND") {
        return PathBuf::from(p);
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
    let path = backend_path();
    let spawned = Command::new(&path)
        .arg("serve")
        .stdin(Stdio::null())
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

fn launcher_shortcut() -> Shortcut {
    let modifier = if cfg!(target_os = "macos") { Modifiers::SUPER } else { Modifiers::CONTROL };
    Shortcut::new(Some(modifier | Modifiers::SHIFT), Code::Space)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(BackendState::default())
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
            if let Err(e) = app.global_shortcut().register(launcher_shortcut()) {
                eprintln!("could not register the search shortcut: {e}");
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            // Like Spotlight: clicking elsewhere dismisses the search window.
            if window.label() == LAUNCHER {
                if let WindowEvent::Focused(false) = event {
                    let _ = window.hide();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![backend, hide_launcher, show_main])
        .build(tauri::generate_context!())
        .expect("error while building the app")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                stop_backend(app);
            }
        });
}
