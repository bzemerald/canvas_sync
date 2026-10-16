import CoreGraphics
import Foundation
// winid [owner]: prints "<id> <onscreen> <w>x<h> <name>" for each window of the app (default:
// canvas-desktop, the dev build). The main window is "Canvas Sync"; "1" = on screen.
let owner = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "canvas-desktop"
let list = CGWindowListCopyWindowInfo([.optionAll], kCGNullWindowID) as! [[String: Any]]
for w in list where (w[kCGWindowOwnerName as String] as? String) == owner {
    let b = w[kCGWindowBounds as String] as? [String: Any] ?? [:]
    print(w[kCGWindowNumber as String] ?? "?", w[kCGWindowIsOnscreen as String] ?? false, "\(b["Width"] ?? 0)x\(b["Height"] ?? 0)", w[kCGWindowName as String] ?? "")
}
