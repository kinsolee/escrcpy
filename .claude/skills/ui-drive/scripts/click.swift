import CoreGraphics
import Foundation

// Synthetic click that survives Electron/Chromium hit-testing:
// move first (updates hover + window focus), then down, pause, up.
// Usage: swift click.swift <x> <y>   (screen coordinates in points)
let x = Double(CommandLine.arguments[1])!, y = Double(CommandLine.arguments[2])!
let p = CGPoint(x: x, y: y)
let move = CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: p, mouseButton: .left)!
move.post(tap: .cghidEventTap)
usleep(80_000)
let down = CGEvent(mouseEventSource: nil, mouseType: .leftMouseDown, mouseCursorPosition: p, mouseButton: .left)!
down.post(tap: .cghidEventTap)
usleep(50_000)
let up = CGEvent(mouseEventSource: nil, mouseType: .leftMouseUp, mouseCursorPosition: p, mouseButton: .left)!
up.post(tap: .cghidEventTap)
print("clicked \(x),\(y)")
