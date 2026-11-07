//! The tray icon (Windows). Closing the main window only hides it, as on macOS, so syncing and the
//! search shortcut go on; the icon brings it back (a click, or its menu), and its menu quits.

use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, Wry};

pub const ID: &str = "main";

struct Items {
    open: MenuItem<Wry>,
    quit: MenuItem<Wry>,
}

pub fn start(app: &AppHandle) -> tauri::Result<()> {
    // (In the app's language once the main window has said it: set_tray_labels.)
    let open = MenuItem::with_id(app, "open", "Open the main window", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let mut tray = TrayIconBuilder::with_id(ID)
        .tooltip("Canvas Sync")
        .menu(&Menu::with_items(app, &[&open, &quit])?)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "open" => super::show_main(app.clone()),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                super::show_main(tray.app_handle().clone());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;
    app.manage(Items { open, quit });
    Ok(())
}

/// The menu's words, in the language the main window shows.
#[tauri::command]
pub fn set_tray_labels(app: AppHandle, open: String, quit: String) -> Result<(), String> {
    let items = app.try_state::<Items>().ok_or("no tray icon")?;
    items.open.set_text(open).map_err(|e| e.to_string())?;
    items.quit.set_text(quit).map_err(|e| e.to_string())
}
