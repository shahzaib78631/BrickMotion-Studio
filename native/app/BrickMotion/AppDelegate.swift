// The application: its menu bar, and opening files from Finder and the Dock.
import AppKit

@MainActor final class AppDelegate: NSObject, NSApplicationDelegate {
  private var showedWelcome = false

  func applicationWillFinishLaunching(_ notification: Notification) {
    NSApp.mainMenu = MainMenu.make()
    EditorPreferences.shared.applyAppearance()
    NotificationCenter.default.addObserver(self, selector: #selector(windowBecameMain(_:)),
                                           name: NSWindow.didBecomeMainNotification, object: nil)
  }

  func applicationDidFinishLaunching(_ notification: Notification) {
    if NSDocumentController.shared.documents.isEmpty { showWelcome() }
  }

  func applicationWillTerminate(_ notification: Notification) {
    RenderQueue.shared.stopForQuit()
  }

  func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
    guard !flag, NSDocumentController.shared.documents.isEmpty else { return true }
    showWelcome()
    return false
  }

  func showWelcome() {
    showedWelcome = true
    WelcomeWindow.shared.showWindow(nil)
  }

  @objc private func windowBecameMain(_ note: Notification) {
    if showedWelcome, let window = note.object as? NSWindow, window.windowController is WindowController {
      WelcomeWindow.shared.dismiss()
      showedWelcome = false
    }
  }

  func applicationShouldOpenUntitledFile(_ sender: NSApplication) -> Bool { false }

  func applicationSupportsSecureRestorableState(_ app: NSApplication) -> Bool { true }
}

@MainActor enum MainMenu {
  /// Items AppKit owns outright, outside the registry.
  static let systemItems: Set<String> = ["Services", "Hide BrickMotion", "Hide Others", "Show All", "Quit BrickMotion",
                                         "Clear Menu", "Minimize", "Zoom"]

  static func make() -> NSMenu {
    let main = NSMenu()
    let appName = "BrickMotion"

    let app = Registry.menu(.app, title: appName)
    app.addItem(.separator())
    let services = NSMenu(title: "Services")
    app.addItem(withTitle: "Services", action: nil, keyEquivalent: "").submenu = services
    NSApp.servicesMenu = services
    app.addItem(.separator())
    app.addItem(withTitle: "Hide \(appName)", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
    let others = app.addItem(withTitle: "Hide Others", action: #selector(NSApplication.hideOtherApplications(_:)), keyEquivalent: "h")
    others.keyEquivalentModifierMask = [.command, .option]
    app.addItem(withTitle: "Show All", action: #selector(NSApplication.unhideAllApplications(_:)), keyEquivalent: "")
    app.addItem(.separator())
    app.addItem(withTitle: "Quit \(appName)", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
    main.addItem(withTitle: appName, action: nil, keyEquivalent: "").submenu = app

    let file = Registry.menu(.file, title: "File")
    // Open Recent is AppKit's own: it fills it.
    let recent = NSMenu(title: "Open Recent")
    recent.addItem(withTitle: "Clear Menu", action: #selector(NSDocumentController.clearRecentDocuments(_:)), keyEquivalent: "")
    let recentItem = NSMenuItem(title: "Open Recent", action: nil, keyEquivalent: "")
    recentItem.submenu = recent
    if let open = file.items.firstIndex(where: { ($0.representedObject as? String) == "file.open" }) { file.insertItem(recentItem, at: open + 1) }
    main.addItem(withTitle: "File", action: nil, keyEquivalent: "").submenu = file

    let edit = Registry.menu(.edit, title: "Edit")
    let selectItem = NSMenuItem(title: "Select", action: nil, keyEquivalent: "")
    selectItem.submenu = Registry.menu(.select, title: "Select")
    if let none = edit.items.firstIndex(where: { ($0.representedObject as? String) == "edit.selectNone" }) { edit.insertItem(selectItem, at: none + 1) }
    main.addItem(withTitle: "Edit", action: nil, keyEquivalent: "").submenu = edit
    main.addItem(withTitle: "Object", action: nil, keyEquivalent: "").submenu = Registry.menu(.object, title: "Object")
    main.addItem(withTitle: "Step", action: nil, keyEquivalent: "").submenu = Registry.menu(.step, title: "Step")
    main.addItem(withTitle: "View", action: nil, keyEquivalent: "").submenu = Registry.menu(.view, title: "View")

    let window = NSMenu(title: "Window")
    window.addItem(withTitle: "Minimize", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
    window.addItem(withTitle: "Zoom", action: #selector(NSWindow.performZoom(_:)), keyEquivalent: "")
    if let welcome = Registry.command("window.welcome") {
      window.addItem(.separator())
      window.addItem(Registry.item(welcome))
    }
    if let queue = Registry.command("window.renderQueue") { window.addItem(Registry.item(queue)) }
    main.addItem(withTitle: "Window", action: nil, keyEquivalent: "").submenu = window
    NSApp.windowsMenu = window

    let help = NSMenu(title: "Help")
    main.addItem(withTitle: "Help", action: nil, keyEquivalent: "").submenu = help
    NSApp.helpMenu = help
    return main
  }
}
