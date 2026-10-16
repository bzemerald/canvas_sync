import CoreGraphics
import Foundation
// Synthetic mouse input for the app's main window ("Canvas Sync"). Coordinates are points from
// the window's top-left (a screenshot is 2x: halve its pixels). Refuses a window that's off
// screen or mid-animation (Stage Manager), where a click would land somewhere else.
//   mouse click X Y | dclick X Y | rclick X Y | move X Y | scroll X Y DY (negative: down)
//   mouse drag X1 Y1 X2 Y2            press, move there in steps, release
//   mouse press X Y; mouse dragto X Y; ...; mouse release    (to screenshot mid-drag)
func windowOrigin() -> CGPoint {
    let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as! [[String: Any]]
    for w in list where (w[kCGWindowOwnerName as String] as? String) == "canvas-desktop" && (w[kCGWindowName as String] as? String) == "Canvas Sync" {
        let b = w[kCGWindowBounds as String] as! [String: Any]
        // A window mid-animation (Stage Manager, a restart) reports odd bounds: don't click blind.
        guard (b["Width"] as! Double) >= 600, (b["Height"] as! Double) >= 400 else { continue }
        return CGPoint(x: b["X"] as! Double, y: b["Y"] as! Double)
    }
    FileHandle.standardError.write("no settled Canvas Sync window\n".data(using: .utf8)!)
    exit(1)
}
let o = windowOrigin()
let a = CommandLine.arguments
func pt(_ i: Int) -> CGPoint { CGPoint(x: o.x + Double(a[i])!, y: o.y + Double(a[i + 1])!) }
func post(_ type: CGEventType, _ p: CGPoint, _ button: CGMouseButton = .left) {
    CGEvent(mouseEventSource: nil, mouseType: type, mouseCursorPosition: p, mouseButton: button)!.post(tap: .cghidEventTap)
    usleep(16_000)
}
switch a[1] {
case "move": post(.mouseMoved, pt(2))
case "click": post(.mouseMoved, pt(2)); post(.leftMouseDown, pt(2)); post(.leftMouseUp, pt(2))
case "dclick":
    let p = pt(2)
    post(.mouseMoved, p)
    for n in 1...2 {
        for type in [CGEventType.leftMouseDown, .leftMouseUp] {
            let e = CGEvent(mouseEventSource: nil, mouseType: type, mouseCursorPosition: p, mouseButton: .left)!
            e.setIntegerValueField(.mouseEventClickState, value: Int64(n))
            e.post(tap: .cghidEventTap)
            usleep(16_000)
        }
    }
case "rclick": post(.mouseMoved, pt(2)); post(.rightMouseDown, pt(2), .right); post(.rightMouseUp, pt(2), .right)
case "drag":
    let p1 = pt(2), p2 = pt(4)
    post(.mouseMoved, p1); post(.leftMouseDown, p1)
    for i in 1...20 {
        let f = Double(i) / 20
        post(.leftMouseDragged, CGPoint(x: p1.x + (p2.x - p1.x) * f, y: p1.y + (p2.y - p1.y) * f))
    }
    usleep(100_000)
    post(.leftMouseUp, p2)
case "press":  // press and hold at X Y
    post(.mouseMoved, pt(2)); post(.leftMouseDown, pt(2))
case "dragto":  // while held: move to X Y in steps
    let to = pt(2)
    let from = CGEvent(source: nil)!.location
    for i in 1...15 {
        let f = Double(i) / 15
        post(.leftMouseDragged, CGPoint(x: from.x + (to.x - from.x) * f, y: from.y + (to.y - from.y) * f))
    }
case "release":
    post(.leftMouseUp, CGEvent(source: nil)!.location)
case "scroll":
    post(.mouseMoved, pt(2))
    let e = CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 1, wheel1: Int32(a[4])!, wheel2: 0, wheel3: 0)!
    e.post(tap: .cghidEventTap)
default: print("?")
}
