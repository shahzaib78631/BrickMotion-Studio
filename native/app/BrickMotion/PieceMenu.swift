// The viewport's context menus: one for a piece (right-click or ⌃-click; a piece outside the
// selection is selected first) and one for empty space. Every item runs a registry command.
import AppKit
import BMApp

@MainActor enum PieceMenu {
  /// The menu for `piece`, or for empty space when nil.
  static func make(piece: UInt32?, context: CommandContext) -> NSMenu {
    guard piece != nil else { return empty(context) }
    let menu = Registry.contextMenu(["view.frameSelection", "object.openSubmodel", nil], context: context)
    add(steps(context), to: menu)
    append(["object.rotateCW", "object.raise", "object.lower", nil, "edit.cut", "edit.copy", "edit.paste", "edit.duplicate", nil], to: menu, context)
    add(colors(context), to: menu)
    menu.addItem(.separator())
    append(["edit.hide", "edit.hideOthers"], to: menu, context)
    add(submenu("Select", ["select.samePart", "select.sameColor", "select.samePartColor", "select.sameStep", nil, "edit.selectAll"], context), to: menu)
    menu.addItem(.separator())
    append(["object.makeSubmodel", "object.extract", "object.makeUnique", nil, "edit.delete"], to: menu, context)
    tidy(menu)
    return menu
  }

  private static func empty(_ context: CommandContext) -> NSMenu {
    let menu = Registry.contextMenu(["edit.paste", "edit.selectAll", "edit.showAll", "view.fitAll", nil], context: context)
    add(submenu("View", ["view.front", "view.back", "view.left", "view.right", "view.top", "view.bottom"], context), to: menu)
    menu.addItem(.separator())
    append(["object.newSubmodel"], to: menu, context)
    tidy(menu)
    return menu
  }

  private static func append(_ ids: [String?], to menu: NSMenu, _ context: CommandContext) {
    for item in Registry.contextMenu(ids, context: context).items { menu.addItem(item.copy() as! NSMenuItem) }
    if ids.last == .some(nil), menu.items.last?.isSeparatorItem == false { menu.addItem(.separator()) }
  }

  private static func submenu(_ title: String, _ ids: [String?], _ context: CommandContext) -> NSMenuItem? {
    let sub = Registry.contextMenu(ids, context: context)
    guard !sub.items.isEmpty else { return nil }
    let item = NSMenuItem(title: title, action: nil, keyEquivalent: "")
    sub.title = title
    item.submenu = sub
    return item
  }

  private static func add(_ item: NSMenuItem?, to menu: NSMenu) {
    if let item { menu.addItem(item) }
  }

  /// Move to Step ▸ every step of the model being edited.
  private static func steps(_ context: CommandContext) -> NSMenuItem? {
    guard let session = context.session, context.hasSelection else { return nil }
    let sub = NSMenu(title: "Move to Step")
    for k in 0..<Int(session.stepCount()) {
      var c = context
      c.argument = k
      let title = String(session.stepFields(k).title)
      for item in Registry.contextMenu(["step.moveToIndex"], context: c).items {
        item.title = title.isEmpty ? "Step \(k + 1)" : "Step \(k + 1) – \(title)"
        if context.step == k { item.state = .on }
        sub.addItem(item)
      }
    }
    guard !sub.items.isEmpty else { return nil }
    let item = NSMenuItem(title: "Move to Step", action: nil, keyEquivalent: "")
    item.submenu = sub
    return item
  }

  /// Colour ▸ the recent colours, then Use This Colour.
  private static func colors(_ context: CommandContext) -> NSMenuItem? {
    guard let session = context.session else { return nil }
    let table = Dictionary(session.colors().map { ($0.code, $0) }, uniquingKeysWith: { a, _ in a })
    let sub = NSMenu(title: "Colour")
    for code in RecentColors.all {
      guard let info = table[code] else { continue }
      var c = context
      c.argument = Int(code)
      for item in Registry.contextMenu(["color.recolor"], context: c).items {
        item.title = String(info.name)
        item.image = swatchImage(info.rgb)
        sub.addItem(item)
      }
    }
    let use = Registry.contextMenu(["color.useThis"], context: context).items
    if !use.isEmpty && !sub.items.isEmpty { sub.addItem(.separator()) }
    for item in use { sub.addItem(item) }
    guard !sub.items.isEmpty else { return nil }
    let item = NSMenuItem(title: "Colour", action: nil, keyEquivalent: "")
    item.submenu = sub
    return item
  }

  static func swatchImage(_ rgb: UInt32) -> NSImage {
    NSImage(size: NSSize(width: 12, height: 12), flipped: false) { rect in
      NSColor(srgbRed: CGFloat(rgb >> 16 & 0xff) / 255, green: CGFloat(rgb >> 8 & 0xff) / 255, blue: CGFloat(rgb & 0xff) / 255, alpha: 1).setFill()
      NSBezierPath(roundedRect: rect.insetBy(dx: 0.5, dy: 0.5), xRadius: 3, yRadius: 3).fill()
      NSColor.separatorColor.setStroke()
      NSBezierPath(roundedRect: rect.insetBy(dx: 0.5, dy: 0.5), xRadius: 3, yRadius: 3).stroke()
      return true
    }
  }

  /// No separator first, last or twice.
  private static func tidy(_ menu: NSMenu) {
    var previousSeparator = true
    for item in menu.items {
      if item.isSeparatorItem {
        if previousSeparator { menu.removeItem(item) }
        previousSeparator = true
      } else {
        previousSeparator = false
      }
    }
    while menu.items.last?.isSeparatorItem == true { menu.removeItem(at: menu.items.count - 1) }
  }
}
