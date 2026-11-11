//! Signing in to Canvas in a window of its own, for schools that don't let students make
//! access tokens: the school's own sign-in page (SSO, two-factor and all), then the cookies
//! Canvas set, for the backend to use instead of a token.
//!
//! The window shows someone else's site, so it isn't in any capability: its pages can't call
//! the app. Its cookies are kept apart from the app's own pages, and kept between launches,
//! so that signing in again is often just loading a page (the school remembers you).

use std::collections::HashMap;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tauri::webview::PageLoadEvent;
use tauri::{AppHandle, Manager, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent};
use tokio::sync::oneshot;

/// Each window a label of its own: one being closed keeps its label for a moment.
const LABEL: &str = "canvas-login";
static NEXT: AtomicU32 = AtomicU32::new(0);
/// Without you: if a page or two doesn't land on Canvas signed in, you're needed.
const SILENT_TIMEOUT: Duration = Duration::from_secs(20);
/// Where the window keeps its cookies (macOS 14+; before that, with the app's own pages).
#[cfg(target_os = "macos")]
const STORE: [u8; 16] = *b"canvas-sync-lgin";

/// Whether the window's cookies are kept apart (`STORE`), not with the app's own pages.
fn store_apart() -> bool {
    #[cfg(target_os = "macos")]
    {
        use objc2_foundation::{NSOperatingSystemVersion, NSProcessInfo};
        let v14 = NSOperatingSystemVersion { majorVersion: 14, minorVersion: 0, patchVersion: 0 };
        NSProcessInfo::processInfo().isOperatingSystemAtLeastVersion(v14)
    }
    #[cfg(not(target_os = "macos"))]
    true
}

type Reply = Arc<Mutex<Option<oneshot::Sender<Result<HashMap<String, String>, String>>>>>;

fn window<'a>(app: &'a AppHandle, url: Url, title: &str, visible: bool) -> tauri::WebviewWindowBuilder<'a, tauri::Wry, AppHandle> {
    let label = format!("{LABEL}-{}", NEXT.fetch_add(1, Ordering::Relaxed));
    let builder = WebviewWindowBuilder::new(app, label, WebviewUrl::External(url))
        .title(title)
        .inner_size(520.0, 720.0)
        .center()
        .visible(visible)
        .focused(visible);
    #[cfg(target_os = "macos")]
    let builder = builder.data_store_identifier(STORE);
    #[cfg(windows)]
    let builder = match app.path().app_local_data_dir() {
        Ok(dir) => builder.data_directory(dir.join("canvas-login")),
        Err(_) => builder,
    };
    builder
}

/// One sign-in at a time: a new one (say, you click while a quiet one runs) ends the old.
fn close_old(app: &AppHandle) {
    for (label, w) in app.webview_windows() {
        if label.starts_with(LABEL) {
            let _ = w.destroy();
        }
    }
}

/// Signed in to Canvas: on its site, past its sign-in pages.
fn on_canvas(url: &Url, site: &Url) -> bool {
    url.scheme() == site.scheme() && url.host_str() == site.host_str() && url.port() == site.port()
        && !url.path().starts_with("/login")
}

fn canvas_cookies(w: &WebviewWindow, site: &Url) -> Option<HashMap<String, String>> {
    let cookies = w.cookies_for_url(site.clone()).ok()?;
    let out: HashMap<String, String> = cookies.iter().map(|c| (c.name().to_string(), c.value().to_string())).collect();
    out.contains_key("canvas_session").then_some(out)
}

/// Sign in at `site` (a Canvas site's address) and return its cookies. `silent`: in a hidden
/// window, only if no one has to type anything; else Err("needs sign-in"). Closing the
/// window: Err("cancelled").
#[tauri::command]
pub async fn canvas_login(app: AppHandle, site: String, title: String, silent: bool) -> Result<HashMap<String, String>, String> {
    let site = Url::parse(&site).map_err(|e| e.to_string())?;
    let start = site.join("/login").map_err(|e| e.to_string())?;
    close_old(&app);

    let (tx, rx) = oneshot::channel();
    let reply: Reply = Arc::new(Mutex::new(Some(tx)));
    let send = |reply: &Reply, result| {
        if let Some(tx) = reply.lock().unwrap().take() {
            let _ = tx.send(result);
        }
    };

    let (on_load, page_site) = (reply.clone(), site.clone());
    let w = window(&app, start, &title, !silent)
        .on_page_load(move |w, payload| {
            if payload.event() != PageLoadEvent::Finished || !on_canvas(payload.url(), &page_site) {
                return;
            }
            // Not here: on Windows reading cookies in an event handler deadlocks.
            let (reply, site) = (on_load.clone(), page_site.clone());
            tauri::async_runtime::spawn_blocking(move || {
                if let Some(cookies) = canvas_cookies(&w, &site) {
                    if let Some(tx) = reply.lock().unwrap().take() {
                        let _ = tx.send(Ok(cookies));
                    }
                }
            });
        })
        .build()
        .map_err(|e| e.to_string())?;
    let on_close = reply.clone();
    w.on_window_event(move |event| {
        if let WindowEvent::Destroyed = event {
            if let Some(tx) = on_close.lock().unwrap().take() {
                let _ = tx.send(Err("cancelled".into()));
            }
        }
    });

    let result = if silent {
        match tokio::time::timeout(SILENT_TIMEOUT, rx).await {
            Ok(got) => got.unwrap_or_else(|_| Err("cancelled".into())),
            Err(_) => Err("needs sign-in".into()),
        }
    } else {
        rx.await.unwrap_or_else(|_| Err("cancelled".into()))
    };
    send(&reply, Err("cancelled".into())); // (nothing waits any more)
    let _ = w.destroy();
    result
}

/// Signing out: forget what the sign-in window kept (so the next one asks who you are).
#[tauri::command]
pub async fn canvas_logout(app: AppHandle) -> Result<(), String> {
    close_old(&app);
    let blank = Url::parse("about:blank").unwrap();
    let w = window(&app, blank, "", false).build().map_err(|e| e.to_string())?;
    let cleared = if store_apart() {
        w.clear_all_browsing_data().map_err(|e| e.to_string())
    } else {
        // With the app's own pages: only the cookies, not what the app keeps (localStorage).
        w.cookies().map_err(|e| e.to_string()).map(|all| all.into_iter().for_each(|c| {
            let _ = w.delete_cookie(c);
        }))
    };
    let _ = w.destroy();
    cleared
}
