// The main window: sidebar, viewport, inspector, and a unified toolbar.
import AppKit
import SwiftUI

final class WindowController: NSWindowController, NSToolbarDelegate {
  private static let modeItem = NSToolbarItem.Identifier("mode")
  private static let toolItem = NSToolbarItem.Identifier("tool")
  private static let paletteItem = NSToolbarItem.Identifier("palette")
  private static let navigatorDivider = NSToolbarItem.Identifier("navigatorDivider")
  private static let inspectorDivider = NSToolbarItem.Identifier("inspectorDivider")
  private static let defaultTimelineHeight: CGFloat = 268
  private var toolGroup: NSToolbarItemGroup?
  private var modeGroup: NSToolbarItemGroup?
  private let split = NSSplitViewController()
  private let workspaceSplit = NSSplitViewController()
  private var timelineItem: NSSplitViewItem!
  /// What the panes show of the document.
  private(set) var model: DocumentModel!

  convenience init(document: Document) {
    let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1440, height: 900),
                          styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
                          backing: .buffered, defer: false)
    window.titlebarAppearsTransparent = false
    window.toolbarStyle = .unified
    window.contentMinSize = NSSize(width: 900, height: 600)
    self.init(window: window)
    buildSplit(document)
    window.contentViewController = workspaceSplit
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
    let model = DocumentModel(document: document)
    if document.session.pieceCount() == 0 { model.sidebarTab = .parts }
    self.model = model
    let sidebar = NSSplitViewItem(sidebarWithViewController: NSHostingController(rootView: Sidebar(model: model)))
    sidebar.minimumThickness = 220
    sidebar.maximumThickness = 420
    let viewport = ViewportController(session: document.session)
    viewport.viewportView.document = document
    model.viewport = viewport.viewportView
    model.animation.viewport = viewport.viewportView
    viewport.viewportView.animation = model.animation
    viewport.viewportView.installEditorOverlays(model: model)
    let crumb = NSHostingView(rootView: Breadcrumb(model: model))
    crumb.sizingOptions = [.intrinsicContentSize]
    viewport.viewportView.addOverlay(crumb)
    let callout = NSHostingView(rootView: StepCallout(model: model, workspace: model.animation))
    callout.sizingOptions = [.intrinsicContentSize]
    viewport.viewportView.addOverlay(callout, leading: false, top: false)
    let chrome = NSHostingView(rootView: ViewportChrome(camera: viewport.viewportView.presentation, model: model))
    chrome.sizingOptions = [.intrinsicContentSize]
    viewport.viewportView.addOverlay(chrome, leading: false)
    let status = NSHostingView(rootView: ViewportStatus(model: model))
    status.sizingOptions = [.intrinsicContentSize]
    viewport.viewportView.addOverlay(status, top: false)
    viewport.viewportView.onTool = { [weak self] tool in self?.toolGroup?.selectedIndex = tool.rawValue }
    let content = NSSplitViewItem(viewController: viewport)
    let inspector = NSSplitViewItem(inspectorWithViewController: NSHostingController(rootView: Inspector(model: model)))
    inspector.minimumThickness = 260
    inspector.maximumThickness = 420
    split.splitViewItems = [sidebar, content, inspector]
    workspaceSplit.splitView.isVertical = false
    let editor = NSSplitViewItem(viewController: split)
    editor.minimumThickness = 230
    editor.holdingPriority = .defaultLow
    let timeline = NSHostingController(rootView: AnimationTimeline(
      model: model, workspace: model.animation,
      height: { [weak self] in self?.timelineHeight ?? Self.defaultTimelineHeight },
      resize: { [weak self] in self?.resizeTimeline(to: $0) },
      saveHeight: { [weak self] in self?.saveTimelineHeight() },
      resetHeight: { [weak self] in self?.resizeTimeline(to: Self.defaultTimelineHeight); self?.saveTimelineHeight() }))
    timeline.sizingOptions = []
    timelineItem = NSSplitViewItem(viewController: timeline)
    timelineItem.minimumThickness = 168
    timelineItem.preferredThicknessFraction = 0.26
    timelineItem.canCollapse = true
    timelineItem.isCollapsed = true
    workspaceSplit.splitViewItems = [editor, timelineItem]
  }

  /// The panes' views, for --snapshot's report.
  var sidebarView: NSView? { split.splitViewItems.first?.viewController.view }
  var inspectorView: NSView? { split.splitViewItems.last?.viewController.view }

  /// Opens the inspector, if it is collapsed, on `tab`.
  func showInspector(tab: InspectorTab) {
    model.inspectorTab = tab
    if let item = split.splitViewItems.last, item.isCollapsed { item.animator().isCollapsed = false }
  }
  var timelineView: NSView? { timelineItem.isCollapsed ? nil : timelineItem.viewController.view }

  /// The centre pane.
  var viewportController: ViewportController { split.splitViewItems[1].viewController as! ViewportController }

  var isAnimating: Bool { !timelineItem.isCollapsed }

  var timelineHeight: CGFloat { timelineItem.viewController.view.frame.height }
  private var timelineResizeRequest = 0

  func resizeTimeline(to proposed: CGFloat) {
    guard isAnimating else { return }
    timelineResizeRequest &+= 1
    let view = workspaceSplit.splitView
    view.layoutSubtreeIfNeeded()
    let top = workspaceSplit.splitViewItems[0].minimumThickness
    let available = view.bounds.height - view.dividerThickness
    let limit = max(timelineItem.minimumThickness, available - top)
    let height = min(limit, max(timelineItem.minimumThickness, proposed))
    view.setPosition(view.isFlipped ? available - height : height, ofDividerAt: 0)
  }

  private func saveTimelineHeight() {
    if timelineHeight >= timelineItem.minimumThickness {
      UserDefaults.standard.set(Double(timelineHeight), forKey: "BrickMotionTimelineHeight")
    }
  }

  func setAnimateMode(_ animate: Bool, plan: Bool = true) {
    guard animate != isAnimating else { return }
    if !animate { saveTimelineHeight() }
    modeGroup?.selectedIndex = animate ? 1 : 0
    model.animation.visible = animate
    timelineItem.isCollapsed = !animate
    if animate {
      let request = timelineResizeRequest
      Task { @MainActor [weak self] in
        guard let self, self.isAnimating, self.timelineResizeRequest == request else { return }
        let saved = UserDefaults.standard.double(forKey: "BrickMotionTimelineHeight")
        self.resizeTimeline(to: saved > 0 ? CGFloat(saved) : Self.defaultTimelineHeight)
      }
      model.animation.viewport?.viewport.useKeyframes(model.animation.tab == .timeline)
      viewportController.viewportView.placement.cancel()
      if plan, EditorPreferences.shared.autoPlan { model.animation.plan() }
    } else {
      model.animation.viewport?.viewport.useKeyframes(false)
      model.animation.rest()
      if model.inspectorTab == .camera { model.inspectorTab = model.snapshot.selection.count == 1 ? .part : .selection }
    }
  }

  // MARK: Editing when a pane has the keyboard

  /// Forward ordinary editing commands from panes that share the model selection.
  override func supplementalTarget(forAction action: Selector, sender: Any?) -> Any? {
    let viewport = viewportController.viewportView
    let forwarded: [Selector] = [#selector(NSText.cut(_:)), #selector(NSText.copy(_:)), #selector(NSText.paste(_:)),
                                 #selector(NSText.delete(_:)), #selector(NSText.selectAll(_:))]
    if forwarded.contains(action) && viewport.responds(to: action) {
      if model.animation.isKeyEditing, let responder = window?.firstResponder as? NSView,
         let timeline = timelineItem?.viewController.view, responder === timeline || responder.isDescendant(of: timeline) {
        return nil
      }
      return viewport
    }
    return super.supplementalTarget(forAction: action, sender: sender)
  }

  // MARK: Toolbar

  @objc private func chooseTool(_ sender: NSToolbarItemGroup) {
    viewportController.viewportView.tool = ViewportView.Tool(rawValue: sender.selectedIndex) ?? .select
  }

  @objc private func chooseMode(_ sender: NSToolbarItemGroup) { setAnimateMode(sender.selectedIndex == 1) }
  @objc private func openPalette(_ sender: Any?) {
    if let window { CommandPalette.show(over: window) }
  }

  func toolbarDefaultItemIdentifiers(_ toolbar: NSToolbar) -> [NSToolbarItem.Identifier] {
    [.toggleSidebar, Self.navigatorDivider, Self.toolItem, .flexibleSpace, Self.modeItem, .flexibleSpace,
     Self.paletteItem, Self.inspectorDivider, .toggleInspector]
  }

  func toolbarAllowedItemIdentifiers(_ toolbar: NSToolbar) -> [NSToolbarItem.Identifier] {
    toolbarDefaultItemIdentifiers(toolbar)
  }

  func toolbar(_ toolbar: NSToolbar, itemForItemIdentifier id: NSToolbarItem.Identifier,
               willBeInsertedIntoToolbar flag: Bool) -> NSToolbarItem? {
    if id == Self.navigatorDivider || id == Self.inspectorDivider {
      return NSTrackingSeparatorToolbarItem(identifier: id, splitView: split.splitView, dividerIndex: id == Self.navigatorDivider ? 0 : 1)
    }
    if id == Self.paletteItem {
      let item = NSToolbarItem(itemIdentifier: id)
      item.label = "Command Palette"
      item.toolTip = "Command Palette (⌘K)"
      item.image = NSImage(systemSymbolName: "magnifyingglass", accessibilityDescription: "Command Palette")
      item.target = self
      item.action = #selector(openPalette(_:))
      item.visibilityPriority = .low
      return item
    }
    if id == Self.toolItem {
      let images = ["cursorarrow", "arrow.up.and.down.and.arrow.left.and.right", "arrow.trianglehead.2.clockwise.rotate.90", "arrow.up.left.and.down.right.magnifyingglass"].map {
        NSImage(systemSymbolName: $0, accessibilityDescription: nil)
          ?? NSImage(systemSymbolName: "arrow.up.left.and.arrow.down.right", accessibilityDescription: nil)!
      }
      let group = NSToolbarItemGroup(itemIdentifier: id, images: images, selectionMode: .selectOne,
                                     labels: ["Select", "Move", "Rotate", "Scale"], target: self, action: #selector(chooseTool(_:)))
      group.selectedIndex = viewportController.viewportView.tool.rawValue
      group.label = "Tool"
      group.toolTip = "Select (V), Move (M), Rotate or Scale. L switches world and local axes."
      toolGroup = group
      return group
    }
    guard id == Self.modeItem else { return nil }
    let group = NSToolbarItemGroup(itemIdentifier: id, titles: ["Build", "Animate"], selectionMode: .selectOne,
                                   labels: ["Build", "Animate"], target: self, action: #selector(chooseMode(_:)))
    group.selectedIndex = 0
    group.label = "Mode"
    group.toolTip = "Build edits the model; Animate plans and plays its build"
    modeGroup = group
    return group
  }
}

