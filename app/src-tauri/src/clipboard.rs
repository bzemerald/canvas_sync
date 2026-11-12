//! Copying files and folders: on the system's clipboard as the file manager puts them, so
//! pasting in Finder or Explorer copies them there, and a chat's message box attaches them.

use std::path::PathBuf;

/// Puts these files (absolute paths; those that exist) on the clipboard. Returns whether it did.
#[tauri::command]
pub async fn copy_files(app: tauri::AppHandle, paths: Vec<String>) -> bool {
    // (Through its components: the page joins with "/", which Windows' own paths don't use.)
    let paths: Vec<PathBuf> = paths
        .iter()
        .map(|p| PathBuf::from(p).components().collect::<PathBuf>())
        .filter(|p| p.is_absolute() && p.exists())
        .collect();
    if paths.is_empty() {
        return false;
    }
    let (tx, rx) = std::sync::mpsc::channel();
    // (The pasteboard is AppKit's: on the main thread.)
    let sent = app.run_on_main_thread(move || {
        let _ = tx.send(put(&paths));
    });
    sent.is_ok() && rx.recv().unwrap_or(false)
}

#[cfg(target_os = "macos")]
fn put(paths: &[PathBuf]) -> bool {
    use objc2::rc::Retained;
    use objc2::runtime::ProtocolObject;
    use objc2_app_kit::{NSPasteboard, NSPasteboardWriting};
    use objc2_foundation::{NSArray, NSString, NSURL};

    let urls: Vec<Retained<ProtocolObject<dyn NSPasteboardWriting>>> = paths
        .iter()
        .map(|p| ProtocolObject::from_retained(NSURL::fileURLWithPath(&NSString::from_str(&p.to_string_lossy()))))
        .collect();
    let board = NSPasteboard::generalPasteboard();
    board.clearContents();
    board.writeObjects(&NSArray::from_retained_slice(&urls))
}

#[cfg(windows)]
fn put(paths: &[PathBuf]) -> bool {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Foundation::GlobalFree;
    use windows_sys::Win32::System::DataExchange::{CloseClipboard, EmptyClipboard, OpenClipboard, RegisterClipboardFormatW, SetClipboardData};
    use windows_sys::Win32::System::Memory::{GMEM_MOVEABLE, GlobalAlloc, GlobalLock, GlobalUnlock};
    use windows_sys::Win32::System::Ole::{CF_HDROP, DROPEFFECT_COPY};
    use windows_sys::Win32::UI::Shell::DROPFILES;

    /// A clipboard block holding these bytes; null if it couldn't be made.
    unsafe fn block(bytes: &[u8]) -> *mut core::ffi::c_void {
        unsafe {
            let h = GlobalAlloc(GMEM_MOVEABLE, bytes.len());
            if h.is_null() {
                return h;
            }
            let p = GlobalLock(h) as *mut u8;
            if p.is_null() {
                GlobalFree(h);
                return std::ptr::null_mut();
            }
            std::ptr::copy_nonoverlapping(bytes.as_ptr(), p, bytes.len());
            GlobalUnlock(h);
            h
        }
    }

    // CF_HDROP: a DROPFILES header, then the paths in UTF-16, each ending in 0, and one more 0.
    let header = DROPFILES { pFiles: size_of::<DROPFILES>() as u32, fWide: 1, ..Default::default() };
    let mut bytes = unsafe { std::slice::from_raw_parts(&header as *const DROPFILES as *const u8, size_of::<DROPFILES>()) }.to_vec();
    for p in paths {
        for unit in p.as_os_str().encode_wide().chain([0]) {
            bytes.extend_from_slice(&unit.to_le_bytes());
        }
    }
    bytes.extend_from_slice(&[0, 0]);

    unsafe {
        if OpenClipboard(std::ptr::null_mut()) == 0 {
            return false;
        }
        EmptyClipboard();
        let files = block(&bytes);
        let ok = !files.is_null() && !SetClipboardData(CF_HDROP as u32, files).is_null();
        if !ok && !files.is_null() {
            GlobalFree(files);
        }
        // A copy, not a cut: Explorer pastes copies.
        let effect: Vec<u16> = "Preferred DropEffect".encode_utf16().chain([0]).collect();
        let format = RegisterClipboardFormatW(effect.as_ptr());
        let drop = block(&DROPEFFECT_COPY.to_le_bytes());
        if format == 0 || drop.is_null() || SetClipboardData(format, drop).is_null() {
            if !drop.is_null() {
                GlobalFree(drop);
            }
        }
        CloseClipboard();
        ok
    }
}

#[cfg(not(any(target_os = "macos", windows)))]
fn put(_paths: &[PathBuf]) -> bool {
    false
}
