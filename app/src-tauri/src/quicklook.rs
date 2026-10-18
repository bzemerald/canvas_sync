//! Quick Look (macOS): the system's preview panel, which zooms out of the file's icon in the
//! window and back into it, as in Finder. The page says which files, and where their icons are.

use std::cell::{OnceCell, RefCell};

use objc2::rc::Retained;
use objc2::runtime::{AnyObject, NSObjectProtocol, ProtocolObject};
use objc2::{DefinedClass, MainThreadMarker, MainThreadOnly, Message, define_class, msg_send};
use objc2_app_kit::{NSEvent, NSEventType, NSResponder, NSView, NSWindow, NSWindowDelegate};
use objc2_foundation::{NSInteger, NSPoint, NSRect, NSSize, NSString, NSURL};
use objc2_quick_look_ui::{QLPreviewItem, QLPreviewPanel, QLPreviewPanelDataSource, QLPreviewPanelDelegate};
use serde::Deserialize;
use tauri::{AppHandle, Manager};

#[derive(Deserialize)]
pub struct Item {
    path: String,
    /// The file's icon in the page (x, y, width, height), if it's on screen.
    icon: Option<[f64; 4]>,
}

struct Shown {
    url: Retained<NSURL>,
    /// Where its icon is on screen; zero: nowhere (the panel fades instead).
    frame: NSRect,
}

#[derive(Default)]
struct Ivars {
    items: RefCell<Vec<Shown>>,
    window: RefCell<Option<Retained<NSWindow>>>,
}

define_class!(
    // In the main window's responder chain (after the window), where the panel looks for
    // whoever controls it.
    #[unsafe(super(NSResponder))]
    #[thread_kind = MainThreadOnly]
    #[ivars = Ivars]
    struct Controller;

    impl Controller {
        #[unsafe(method(acceptsPreviewPanelControl:))]
        fn accepts(&self, _panel: Option<&QLPreviewPanel>) -> bool {
            true
        }

        #[unsafe(method(beginPreviewPanelControl:))]
        fn begin(&self, panel: &QLPreviewPanel) {
            unsafe {
                panel.setDataSource(Some(ProtocolObject::from_ref(self)));
                panel.setDelegate(Some(self));
            }
        }

        #[unsafe(method(endPreviewPanelControl:))]
        fn end(&self, panel: &QLPreviewPanel) {
            unsafe {
                panel.setDataSource(None);
                panel.setDelegate(None);
            }
        }
    }

    unsafe impl NSObjectProtocol for Controller {}

    unsafe impl QLPreviewPanelDataSource for Controller {
        #[unsafe(method(numberOfPreviewItemsInPreviewPanel:))]
        unsafe fn count(&self, _panel: Option<&QLPreviewPanel>) -> NSInteger {
            self.ivars().items.borrow().len() as NSInteger
        }

        #[unsafe(method_id(previewPanel:previewItemAtIndex:))]
        unsafe fn item(
            &self,
            _panel: Option<&QLPreviewPanel>,
            index: NSInteger,
        ) -> Option<Retained<ProtocolObject<dyn QLPreviewItem>>> {
            let items = self.ivars().items.borrow();
            let url = usize::try_from(index).ok().and_then(|i| items.get(i)).map(|s| s.url.clone());
            url.map(ProtocolObject::from_retained)
        }
    }

    unsafe impl NSWindowDelegate for Controller {}

    unsafe impl QLPreviewPanelDelegate for Controller {
        #[unsafe(method(previewPanel:sourceFrameOnScreenForPreviewItem:))]
        unsafe fn source_frame(
            &self,
            _panel: Option<&QLPreviewPanel>,
            item: Option<&ProtocolObject<dyn QLPreviewItem>>,
        ) -> NSRect {
            let Some(item) = item else { return NSRect::ZERO };
            let item = item as *const _ as *const AnyObject;
            self.ivars()
                .items
                .borrow()
                .iter()
                .find(|s| std::ptr::eq(&*s.url as *const NSURL as *const AnyObject, item))
                .map_or(NSRect::ZERO, |s| s.frame)
        }

        // Arrow keys while the panel is in front move the selection in the window, as in Finder.
        #[unsafe(method(previewPanel:handleEvent:))]
        unsafe fn handle_event(&self, _panel: Option<&QLPreviewPanel>, event: Option<&NSEvent>) -> bool {
            let window = self.ivars().window.borrow().clone();
            match (event, window) {
                (Some(event), Some(window)) if event.r#type() == NSEventType::KeyDown && is_arrow(event) => {
                    window.makeKeyWindow();
                    window.sendEvent(event);
                    true
                }
                _ => false,
            }
        }
    }
);

fn is_arrow(event: &NSEvent) -> bool {
    // NSUpArrowFunctionKey ... NSRightArrowFunctionKey
    let Some(chars) = event.charactersIgnoringModifiers() else { return false };
    chars.to_string().chars().next().is_some_and(|c| ('\u{F700}'..='\u{F703}').contains(&c))
}

thread_local! {
    static CONTROLLER: OnceCell<Retained<Controller>> = const { OnceCell::new() };
}

fn controller(mtm: MainThreadMarker, window: &NSWindow) -> Retained<Controller> {
    CONTROLLER.with(|c| {
        c.get_or_init(|| {
            let this = mtm.alloc::<Controller>().set_ivars(Ivars::default());
            let this: Retained<Controller> = unsafe { msg_send![super(this), init] };
            unsafe {
                this.setNextResponder(window.nextResponder().as_deref());
                window.setNextResponder(Some(&this));
            }
            *this.ivars().window.borrow_mut() = Some(window.retain());
            this
        })
        .clone()
    })
}

/// Shows `items` (the one at `index` first). `open`: open the panel if it isn't (or, `toggle`,
/// close it if it is); else only follow along if it's already open (the selection changed).
/// Returns whether it's showing them.
fn show(webview: &NSView, window: &NSWindow, items: Vec<Item>, index: usize, open: bool, toggle: bool) -> bool {
    let mtm = MainThreadMarker::from(webview);
    let visible = unsafe { QLPreviewPanel::sharedPreviewPanelExists(mtm) }
        && unsafe { QLPreviewPanel::sharedPreviewPanel(mtm) }.is_some_and(|p| p.isVisible());
    if !visible && !open {
        return false;
    }
    let Some(panel) = (unsafe { QLPreviewPanel::sharedPreviewPanel(mtm) }) else { return false };
    if (visible && toggle) || items.is_empty() {
        if visible {
            panel.orderOut(None);
        }
        return false;
    }
    let this = controller(mtm, window);
    // The page's coordinates start at the webview's top left; AppKit's at the bottom left.
    let page = webview.convertRect_toView(webview.bounds(), None);
    *this.ivars().items.borrow_mut() = items
        .into_iter()
        .map(|it| Shown {
            url: NSURL::fileURLWithPath(&NSString::from_str(&it.path)),
            frame: it.icon.map_or(NSRect::ZERO, |[x, y, w, h]| {
                let r = NSRect::new(NSPoint::new(page.origin.x + x, page.origin.y + page.size.height - y - h), NSSize::new(w, h));
                window.convertRectToScreen(r)
            }),
        })
        .collect();
    unsafe {
        panel.updateController(); // (takes control, from the window's responder chain)
        panel.reloadData();
        panel.setCurrentPreviewItemIndex(index as NSInteger);
    }
    if !visible {
        panel.makeKeyAndOrderFront(None);
        window.makeKeyWindow(); // keys stay with the window: space closes, arrows move on
    }
    true
}

/// Quick Look these files (see `show`).
#[tauri::command]
pub async fn quick_look(app: AppHandle, items: Vec<Item>, index: usize, open: bool, toggle: bool) -> bool {
    let Some(w) = app.get_webview_window("main") else { return false };
    let (tx, rx) = std::sync::mpsc::channel();
    let sent = w.with_webview(move |pv| {
        let webview = unsafe { &*(pv.inner() as *const NSView) };
        let window = unsafe { &*(pv.ns_window() as *const NSWindow) };
        let _ = tx.send(show(webview, window, items, index, open, toggle));
    });
    sent.is_ok() && rx.recv().unwrap_or(false)
}
