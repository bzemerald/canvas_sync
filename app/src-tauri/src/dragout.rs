//! Dragging files out of the app, to the desktop, Finder or another app (a chat's message box):
//! the system's own drag, which the page starts (lib/dragOut.ts) once a file it's dragging leaves
//! the window. Always a copy: what's in the sync folder stays there. When it ends, the main window
//! hears `drag-out-ended`.

use std::path::PathBuf;

use tauri::{AppHandle, Manager};

const ENDED: &str = "drag-out-ended";

/// Drags these files (absolute paths; those that exist) out. Returns whether it started.
#[tauri::command]
pub async fn drag_out(app: AppHandle, paths: Vec<String>) -> bool {
    // (Through its components: the page joins with "/", which Windows' own paths don't use.)
    let paths: Vec<PathBuf> = paths
        .iter()
        .map(|p| PathBuf::from(p).components().collect::<PathBuf>())
        .filter(|p| p.is_absolute() && p.exists())
        .collect();
    if paths.is_empty() {
        return false;
    }
    start(app, paths)
}

#[cfg(target_os = "macos")]
fn start(app: AppHandle, paths: Vec<PathBuf>) -> bool {
    let Some(w) = app.get_webview_window("main") else { return false };
    let (tx, rx) = std::sync::mpsc::channel();
    let sent = w.with_webview(move |pv| {
        let window = unsafe { &*(pv.ns_window() as *const objc2_app_kit::NSWindow) };
        let _ = tx.send(mac::start(window, &paths, app));
    });
    sent.is_ok() && rx.recv().unwrap_or(false)
}

#[cfg(windows)]
fn start(app: AppHandle, paths: Vec<PathBuf>) -> bool {
    let Some(w) = app.get_webview_window("main") else { return false };
    let on = w.clone();
    // (No picture of its own: Windows shows the pointer with what dropping it would do.)
    w.run_on_main_thread(move || {
        use tauri::Emitter;
        let ended = move |_, _| {
            let _ = app.emit_to("main", ENDED, ());
        };
        let _ = drag::start_drag(&on, drag::DragItem::Files(paths), drag::Image::Raw(Vec::new()), ended, Default::default());
    })
    .is_ok()
}

#[cfg(not(any(target_os = "macos", windows)))]
fn start(_app: AppHandle, _paths: Vec<PathBuf>) -> bool {
    false
}

#[cfg(target_os = "macos")]
mod mac {
    use std::cell::RefCell;
    use std::path::PathBuf;

    use objc2::rc::Retained;
    use objc2::runtime::{AnyObject, NSObject, NSObjectProtocol, ProtocolObject};
    use objc2::{AnyThread, DefinedClass, MainThreadMarker, MainThreadOnly, Message, define_class, msg_send};
    use objc2_app_kit::{
        NSApplication, NSDragOperation, NSDraggingContext, NSDraggingItem, NSDraggingSession, NSDraggingSource, NSEvent,
        NSEventModifierFlags, NSEventType, NSWindow, NSWorkspace,
    };
    use objc2_foundation::{NSArray, NSPoint, NSRect, NSSize, NSString, NSURL};
    use tauri::{AppHandle, Emitter};

    const ICON: f64 = 64.0; // pt: the file's icon, as Finder drags it

    pub struct Ivars {
        app: AppHandle,
        window: Retained<NSWindow>,
    }

    define_class!(
        #[unsafe(super(NSObject))]
        #[thread_kind = MainThreadOnly]
        #[ivars = Ivars]
        struct Source;

        unsafe impl NSObjectProtocol for Source {}

        unsafe impl NSDraggingSource for Source {
            #[unsafe(method(draggingSession:sourceOperationMaskForDraggingContext:))]
            fn operations(&self, _session: &NSDraggingSession, _context: NSDraggingContext) -> NSDragOperation {
                NSDragOperation::Copy // (Finder would move it, on the same disk)
            }

            #[unsafe(method(draggingSession:endedAtPoint:operation:))]
            fn ended(&self, _session: &NSDraggingSession, _at: NSPoint, _operation: NSDragOperation) {
                // The webview never saw the button go up (the drag took it): until it does, it
                // takes the next press for the end of this one.
                let window = &self.ivars().window;
                if let Some(up) = mouse_event(NSEventType::LeftMouseUp, NSPoint::new(-1.0, -1.0), window) {
                    // (Queued: the drag is still ending. Outside the page: no click.)
                    NSApplication::sharedApplication(MainThreadMarker::from(self)).postEvent_atStart(&up, false);
                }
                let _ = self.ivars().app.emit_to("main", super::ENDED, ());
            }
        }
    );

    thread_local! {
        static SOURCE: RefCell<Option<Retained<Source>>> = const { RefCell::new(None) }; // (kept until the next drag)
    }

    /// Starts the drag from where the pointer is: the files' icons under it, a little fanned out.
    pub fn start(window: &NSWindow, paths: &[PathBuf], app: AppHandle) -> bool {
        let mtm = MainThreadMarker::from(window);
        let Some(view) = window.contentView() else { return false };
        let at = window.mouseLocationOutsideOfEventStream();
        let in_view = view.convertPoint_fromView(at, None);
        let workspace = NSWorkspace::sharedWorkspace();
        let mut items = Vec::new();
        for (i, path) in paths.iter().enumerate() {
            let name = NSString::from_str(&path.to_string_lossy());
            let url = NSURL::fileURLWithPath_isDirectory(&name, path.is_dir());
            let icon = workspace.iconForFile(&name);
            icon.setSize(NSSize::new(ICON, ICON));
            let fan = i.min(3) as f64 * 5.0;
            let frame = NSRect::new(NSPoint::new(in_view.x - ICON / 2.0 + fan, in_view.y - ICON / 2.0 - fan), NSSize::new(ICON, ICON));
            let item = NSDraggingItem::initWithPasteboardWriter(NSDraggingItem::alloc(), &ProtocolObject::from_retained(url));
            unsafe { item.setDraggingFrame_contents(frame, Some(AsRef::<AnyObject>::as_ref(&*icon))) };
            items.push(item);
        }
        // AppKit starts a drag from a mouse event: one where the pointer is now (the button's
        // still down; the page saw the pointer leave the window).
        let Some(event) = mouse_event(NSEventType::LeftMouseDragged, at, window) else { return false };
        let source = mtm.alloc::<Source>().set_ivars(Ivars { app, window: window.retain() });
        let source: Retained<Source> = unsafe { msg_send![super(source), init] };
        view.beginDraggingSessionWithItems_event_source(&NSArray::from_retained_slice(&items), &event, ProtocolObject::from_ref(&*source));
        SOURCE.with(|s| *s.borrow_mut() = Some(source));
        true
    }

    /// A left-button event at `at`, in the window's coordinates.
    fn mouse_event(kind: NSEventType, at: NSPoint, window: &NSWindow) -> Option<Retained<NSEvent>> {
        let time = NSApplication::sharedApplication(MainThreadMarker::from(window)).currentEvent().map_or(0.0, |e| e.timestamp());
        NSEvent::mouseEventWithType_location_modifierFlags_timestamp_windowNumber_context_eventNumber_clickCount_pressure(
            kind,
            at,
            NSEventModifierFlags::empty(),
            time,
            window.windowNumber(),
            None,
            0,
            1,
            1.0,
        )
    }
}
