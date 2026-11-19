// The application: its menu bar, and opening files from Finder and the Dock.
import AppKit

final class AppDelegate: NSObject, NSApplicationDelegate {
  func applicationWillFinishLaunching(_ notification: Notification) {
    NSApp.mainMenu = MainMenu.make()
  }

  func applicationShouldOpenUntitledFile(_ sender: NSApplication) -> Bool { false }

  func applicationSupportsSecureRestorableState(_ app: NSApplication) -> Bool { true }
}

enum MainMenu {
  static func make() -> NSMenu {
    let main = NSMenu()
    let appName = "BrickMotion"

    let app = NSMenu(title: appName)
    app.addItem(withTitle: "About \(appName)", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
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

    let file = NSMenu(title: "File")
    file.addItem(withTitle: "New", action: #selector(NSDocumentController.newDocument(_:)), keyEquivalent: "n")
    file.addItem(withTitle: "Open…", action: #selector(NSDocumentController.openDocument(_:)), keyEquivalent: "o")
    let recent = NSMenu(title: "Open Recent")
    recent.addItem(withTitle: "Clear Menu", action: #selector(NSDocumentController.clearRecentDocuments(_:)), keyEquivalent: "")
    file.addItem(withTitle: "Open Recent", action: nil, keyEquivalent: "").submenu = recent
    file.addItem(.separator())
    file.addItem(withTitle: "Close", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
    file.addItem(withTitle: "Save…", action: #selector(NSDocument.save(_:)), keyEquivalent: "s")
    file.addItem(withTitle: "Duplicate", action: #selector(NSDocument.duplicate(_:)), keyEquivalent: "S").keyEquivalentModifierMask = [.command, .shift]
    file.addItem(withTitle: "Rename…", action: #selector(NSDocument.rename(_:)), keyEquivalent: "")
    file.addItem(withTitle: "Revert To", action: #selector(NSDocument.revertToSaved(_:)), keyEquivalent: "")
    main.addItem(withTitle: "File", action: nil, keyEquivalent: "").submenu = file

    let edit = NSMenu(title: "Edit")
    edit.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
    edit.addItem(withTitle: "Redo", action: Selector(("redo:")), keyEquivalent: "Z").keyEquivalentModifierMask = [.command, .shift]
    main.addItem(withTitle: "Edit", action: nil, keyEquivalent: "").submenu = edit

    let view = NSMenu(title: "View")
    view.addItem(withTitle: "Show Sidebar", action: #selector(NSSplitViewController.toggleSidebar(_:)), keyEquivalent: "s").keyEquivalentModifierMask = [.command, .control]
    view.addItem(withTitle: "Show Inspector", action: #selector(NSSplitViewController.toggleInspector(_:)), keyEquivalent: "i").keyEquivalentModifierMask = [.command, .option]
    view.addItem(.separator())
    view.addItem(withTitle: "Enter Full Screen", action: #selector(NSWindow.toggleFullScreen(_:)), keyEquivalent: "f").keyEquivalentModifierMask = [.command, .control]
    main.addItem(withTitle: "View", action: nil, keyEquivalent: "").submenu = view

    let window = NSMenu(title: "Window")
    window.addItem(withTitle: "Minimize", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
    window.addItem(withTitle: "Zoom", action: #selector(NSWindow.performZoom(_:)), keyEquivalent: "")
    main.addItem(withTitle: "Window", action: nil, keyEquivalent: "").submenu = window
    NSApp.windowsMenu = window

    let help = NSMenu(title: "Help")
    main.addItem(withTitle: "Help", action: nil, keyEquivalent: "").submenu = help
    NSApp.helpMenu = help
    return main
  }
}
