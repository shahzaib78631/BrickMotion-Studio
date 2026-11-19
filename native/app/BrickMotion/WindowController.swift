// The main window: sidebar, viewport, inspector, and a unified toolbar.
import AppKit
import SwiftUI

final class WindowController: NSWindowController, NSToolbarDelegate {
  private static let modeItem = NSToolbarItem.Identifier("mode")
  private static let planningItem = NSToolbarItem.Identifier("planning")
  private static let toolItem = NSToolbarItem.Identifier("tool")
  private var toolGroup: NSToolbarItemGroup?
  private let split = NSSplitViewController()
  private let progress = NSProgressIndicator()

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
    // Autosave keeps untitled imports too, so every window comes back after a relaunch.
    window.isRestorable = true
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
    let viewport = ViewportController(session: document.session)
    viewport.viewportView.document = document
    viewport.viewportView.onTool = { [weak self] tool in self?.toolGroup?.selectedIndex = tool.rawValue }
    viewport.viewportView.onPlanState = { [weak self] state in self?.showPlanning(state == .Planning) }
    let content = NSSplitViewItem(viewController: viewport)
    let inspector = NSSplitViewItem(inspectorWithViewController: NSHostingController(rootView: InspectorPlaceholder()))
    inspector.minimumThickness = 260
    inspector.maximumThickness = 420
    split.splitViewItems = [sidebar, content, inspector]
  }

  /// The panes' views, for --snapshot's report.
  var sidebarView: NSView? { split.splitViewItems.first?.viewController.view }
  var inspectorView: NSView? { split.splitViewItems.last?.viewController.view }

  /// The centre pane.
  var viewportController: ViewportController { split.splitViewItems[1].viewController as! ViewportController }

  private func showPlanning(_ on: Bool) {
    progress.isHidden = !on
    if on { progress.startAnimation(nil) } else { progress.stopAnimation(nil) }
  }

  // MARK: Editing when a pane has the keyboard

  /// Cut, copy, paste, delete and select all reach the viewport when no text field takes them,
  /// whichever pane has the keyboard.
  override func supplementalTarget(forAction action: Selector, sender: Any?) -> Any? {
    let viewport = viewportController.viewportView
    let forwarded: [Selector] = [#selector(NSText.cut(_:)), #selector(NSText.copy(_:)), #selector(NSText.paste(_:)),
                                 #selector(NSText.delete(_:)), #selector(NSText.selectAll(_:))]
    if forwarded.contains(action) && viewport.responds(to: action) { return viewport }
    return super.supplementalTarget(forAction: action, sender: sender)
  }

  // MARK: Toolbar

  @objc private func chooseTool(_ sender: NSToolbarItemGroup) {
    viewportController.viewportView.tool = ViewportView.Tool(rawValue: sender.selectedIndex) ?? .select
  }

  func toolbarDefaultItemIdentifiers(_ toolbar: NSToolbar) -> [NSToolbarItem.Identifier] {
    [.toggleSidebar, .sidebarTrackingSeparator, Self.toolItem, .flexibleSpace, Self.modeItem, .flexibleSpace, Self.planningItem, .inspectorTrackingSeparator, .toggleInspector]
  }

  func toolbarAllowedItemIdentifiers(_ toolbar: NSToolbar) -> [NSToolbarItem.Identifier] {
    toolbarDefaultItemIdentifiers(toolbar)
  }

  func toolbar(_ toolbar: NSToolbar, itemForItemIdentifier id: NSToolbarItem.Identifier,
               willBeInsertedIntoToolbar flag: Bool) -> NSToolbarItem? {
    if id == Self.planningItem {
      progress.style = .spinning
      progress.controlSize = .small
      progress.isDisplayedWhenStopped = false
      progress.isHidden = true
      progress.toolTip = "Planning the build"
      progress.setAccessibilityLabel("Planning the build")
      let item = NSToolbarItem(itemIdentifier: id)
      item.view = progress
      item.label = "Planning"
      return item
    }
    if id == Self.toolItem {
      let images = ["cursorarrow", "arrow.up.and.down.and.arrow.left.and.right", "arrow.trianglehead.2.clockwise.rotate.90"].map {
        NSImage(systemSymbolName: $0, accessibilityDescription: nil)!
      }
      let group = NSToolbarItemGroup(itemIdentifier: id, images: images, selectionMode: .selectOne,
                                     labels: ["Select", "Move", "Rotate"], target: self, action: #selector(chooseTool(_:)))
      group.selectedIndex = viewportController.viewportView.tool.rawValue
      group.label = "Tool"
      group.toolTip = "Select (V), Move (M) or Rotate; L switches world and local axes"
      toolGroup = group
      return group
    }
    guard id == Self.modeItem else { return nil }
    let group = NSToolbarItemGroup(itemIdentifier: id, titles: ["Build", "Animate"], selectionMode: .selectOne,
                                   labels: ["Build", "Animate"], target: nil, action: nil)
    group.selectedIndex = 0
    group.label = "Mode"
    group.toolTip = "Build edits the model; Animate plans and plays its build"
    return group
  }
}
