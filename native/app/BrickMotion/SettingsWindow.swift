import AppKit
import SwiftUI

@MainActor final class SettingsWindow: NSWindowController {
  static let shared = SettingsWindow()

  private init() {
    let content = NSHostingController(rootView: EditorSettingsView(preferences: .shared))
    let window = NSWindow(contentViewController: content)
    window.title = "BrickMotion Settings"
    window.styleMask = [.titled, .closable]
    window.isRestorable = false
    window.isReleasedWhenClosed = false
    window.setContentSize(NSSize(width: 490, height: 290))
    super.init(window: window)
    if !window.setFrameUsingName("BrickMotionSettings") { window.center() }
    window.setFrameAutosaveName("BrickMotionSettings")
  }

  @available(*, unavailable) required init?(coder: NSCoder) { fatalError("not from a nib") }
}
