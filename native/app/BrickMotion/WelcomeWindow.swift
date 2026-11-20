import AppKit
import SwiftUI

@MainActor final class WelcomeWindow: NSWindowController {
  static let shared = WelcomeWindow()
  private let host: NSHostingController<WelcomeView>

  private init() {
    host = NSHostingController(rootView: WelcomeView(recent: [], open: { _ in }))
    let window = NSWindow(contentViewController: host)
    window.styleMask = [.titled, .closable, .resizable, .fullSizeContentView]
    window.title = "Welcome to BrickMotion"
    window.titleVisibility = .hidden
    window.titlebarAppearsTransparent = true
    window.isRestorable = false
    window.isReleasedWhenClosed = false
    window.contentMinSize = NSSize(width: 670, height: 390)
    window.setContentSize(NSSize(width: 720, height: 430))
    super.init(window: window)
    if !window.setFrameUsingName("BrickMotionWelcome") { window.center() }
    window.setFrameAutosaveName("BrickMotionWelcome")
  }

  @available(*, unavailable) required init?(coder: NSCoder) { fatalError("not from a nib") }

  override func showWindow(_ sender: Any?) {
    host.rootView = WelcomeView(recent: NSDocumentController.shared.recentDocumentURLs) { [weak self] url in
      NSDocumentController.shared.openDocument(withContentsOf: url, display: true) { _, _, error in
        if let error {
          Task { @MainActor [weak self] in
            if let window = self?.window { window.presentError(error, modalFor: window, delegate: nil, didPresent: nil, contextInfo: nil) }
          }
        }
      }
    }
    super.showWindow(sender)
    window?.makeKeyAndOrderFront(sender)
  }

  func dismiss() { window?.orderOut(nil) }
}
