//! The search window as a panel (macOS), as Spotlight's: it takes the keys without bringing the
//! app forward, so it comes up over what you're in, on its Space, an app full screen too. A
//! window can't: taking the keys, it brings the app forward, and macOS leaves that Space for one
//! with the app's windows.

use objc2::runtime::AnyClass;
use objc2::{ClassType, MainThreadOnly, define_class};
use objc2_app_kit::{NSPanel, NSWindow, NSWindowCollectionBehavior, NSWindowStyleMask};

define_class!(
    // Tao's window class does the same (as its windows are focusable), and nothing else the
    // search window needs.
    #[unsafe(super(NSPanel))]
    #[thread_kind = MainThreadOnly]
    #[name = "CanvasSearchPanel"]
    struct SearchPanel;

    impl SearchPanel {
        #[unsafe(method(canBecomeKeyWindow))]
        fn can_become_key(&self) -> bool {
            true
        }

        #[unsafe(method(canBecomeMainWindow))]
        fn can_become_main(&self) -> bool {
            false
        }
    }
);

fn ns_window(w: &tauri::WebviewWindow) -> Option<&NSWindow> {
    w.ns_window().ok().map(|p| unsafe { &*(p as *const NSWindow) })
}

/// Makes the window a panel that doesn't bring the app forward, on whatever Space is showing.
pub fn make_panel(w: &tauri::WebviewWindow) {
    let Some(window) = ns_window(w) else { return };
    unsafe {
        let class: &AnyClass = SearchPanel::class();
        objc2::ffi::object_setClass(window as *const NSWindow as *mut _, class);
    }
    window.setStyleMask(window.styleMask() | NSWindowStyleMask::NonactivatingPanel);
    window.setCollectionBehavior(
        NSWindowCollectionBehavior::CanJoinAllSpaces | NSWindowCollectionBehavior::FullScreenAuxiliary,
    );
}

/// Brings it up in front, taking the keys (the app stays where it is).
pub fn show(w: &tauri::WebviewWindow) {
    if let Some(window) = ns_window(w) {
        window.makeKeyAndOrderFront(None);
    }
}
