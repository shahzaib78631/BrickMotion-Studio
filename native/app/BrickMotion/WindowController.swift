// The main window: sidebar, viewport, inspector, and a unified toolbar.
import AppKit
import SwiftUI

final class WindowController: NSWindowController, NSToolbarDelegate {
  private static let modeItem = NSToolbarItem.Identifier("mode")
  private let split = NSSplitViewController()

  convenience init(document: Document) {
    let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1440, height: 900),
                          styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
                          backing: .buffered, defer: false)
    window.titlebarAppearsTransparent = false
    window.toolbarStyle = .unified
    window.contentMinSize = NSSize(width: 900, height: 600)
    self.init(window: window)
    buildSplit(document)
    window.contentViewController = split
    // An untitled import has nothing on disk to come back from until autosave can write it
    // (phase 8 Task 12), so only saved projects reopen their windows after a relaunch.
    window.isRestorable = document.fileURL != nil
    // Setting the content controller sizes the window to the panes' minimum; start larger.
    window.setContentSize(NSSize(width: 1440, height: 900))
    let toolbar = NSToolbar(identifier: "BrickMotionDocument")
    toolbar.delegate = self
    toolbar.displayMode = .iconOnly
    window.toolbar = toolbar
    if !window.setFrameUsingName("BrickMotionDocument") { window.center() }
    window.setFrameAutosaveName("BrickMotionDocument")
  }



  private func buildSplit(_ document: Document) {
    let sidebar = NSSplitViewItem(sidebarWithViewController: NSHostingController(
      rootView: SidebarPlaceholder(title: String(document.session.title()), pieces: Int(document.session.pieceCount()))))
    sidebar.minimumThickness = 220
    sidebar.maximumThickness = 420
    let content = NSSplitViewItem(viewController: NSViewController.blank())
    let inspector = NSSplitViewItem(inspectorWithViewController: NSHostingController(rootView: InspectorPlaceholder()))
    inspector.minimumThickness = 260
    inspector.maximumThickness = 420
    split.splitViewItems = [sidebar, content, inspector]
  }

  /// The centre pane; the viewport takes it in Task 3.
  var contentItem: NSSplitViewItem { split.splitViewItems[1] }

  // MARK: Toolbar

  func toolbarDefaultItemIdentifiers(_ toolbar: NSToolbar) -> [NSToolbarItem.Identifier] {
    [.toggleSidebar, .sidebarTrackingSeparator, .flexibleSpace, Self.modeItem, .flexibleSpace, .inspectorTrackingSeparator, .toggleInspector]
  }

  func toolbarAllowedItemIdentifiers(_ toolbar: NSToolbar) -> [NSToolbarItem.Identifier] {
    toolbarDefaultItemIdentifiers(toolbar)
  }

  func toolbar(_ toolbar: NSToolbar, itemForItemIdentifier id: NSToolbarItem.Identifier,
               willBeInsertedIntoToolbar flag: Bool) -> NSToolbarItem? {
    guard id == Self.modeItem else { return nil }
    let group = NSToolbarItemGroup(itemIdentifier: id, titles: ["Build", "Animate"], selectionMode: .selectOne,
                                   labels: ["Build", "Animate"], target: nil, action: nil)
    group.selectedIndex = 0
    group.label = "Mode"
    group.toolTip = "Build edits the model; Animate plans and plays its build"
    return group
  }
}

extension NSViewController {
  /// An empty pane.
  static func blank() -> NSViewController {
    let vc = NSViewController()
    vc.view = NSView()
    return vc
  }
}
