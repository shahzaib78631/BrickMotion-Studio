// Every command the app offers, in one list. The menu bar, the context menus and the ⌘K palette
// are all made from it, so a command has one title, one shortcut and one rule for when it works.
//
// Commands a text field must also get (cut, copy, paste, delete, select all, undo) travel the
// responder chain by selector; the window controller hands them to the viewport when no text
// field takes them. Every other command runs here, against the frontmost document.
import AppKit
import BMApp

enum MenuPlace { case file, edit, select, object, step, view, none }

@MainActor struct CommandContext {
  var document: Document?
  var viewport: ViewportView?
  var clickedPiece: UInt32?
  /// Asks for a line of text (a name, a step number); calls `done` only when given one.
  var prompt: @MainActor (_ title: String, _ initial: String, _ done: @escaping (String) -> Void) -> Void
  /// Picks one of `options`; calls `done` with its index.
  var choose: @MainActor (_ title: String, _ options: [String], _ done: @escaping (Int) -> Void) -> Void
  /// Says why an edit was refused.
  var refuse: @MainActor (String) -> Void

  init(document: Document?, viewport: ViewportView?, clickedPiece: UInt32?,
       prompt: (@MainActor (_ title: String, _ initial: String, _ done: @escaping (String) -> Void) -> Void)? = nil,
       choose: (@MainActor (_ title: String, _ options: [String], _ done: @escaping (Int) -> Void) -> Void)? = nil,
       refuse: (@MainActor (String) -> Void)? = nil) {
    self.document = document
    self.viewport = viewport
    self.clickedPiece = clickedPiece
    self.prompt = prompt ?? { CommandContext.askInSheet($0, $1, $2) }
    self.choose = choose ?? { CommandContext.chooseInSheet($0, $1, $2) }
    self.refuse = refuse ?? { CommandContext.explainInSheet($0) }
  }

  /// The frontmost document window's.
  static func current(clickedPiece: UInt32? = nil) -> CommandContext {
    let controller = (NSApp.mainWindow ?? NSApp.keyWindow)?.windowController as? WindowController
    return CommandContext(document: controller?.document as? Document, viewport: controller?.viewportController.viewportView,
                          clickedPiece: clickedPiece)
  }

  var session: bmapp.Session? { document?.session }
  var selection: [UInt32] { session.map { Array($0.selection()) } ?? [] }
  var hasSelection: Bool { !(session?.selection().isEmpty ?? true) }

  /// The step the selection is in, when it is all in one, in the model being edited.
  var step: Int? {
    guard let session, !session.selection().isEmpty else { return nil }
    let snap = session.snapshot()
    let steps = Set(snap.selected.map { Int($0.step) })
    return steps.count == 1 ? steps.first : nil
  }

  /// Runs an edit through the document's undo; a refusal is explained and changes nothing.
  @discardableResult func perform(_ edit: (bmapp.Session) -> bmapp.Changed) -> Bool {
    guard let document else { return false }
    let changed = document.perform { edit(document.session) }
    if !changed.refused.empty() {
      refuse(String(changed.refused))
      return false
    }
    viewport?.viewStateChanged()
    return true
  }

  /// After a focus change: the viewport frames what is now shown.
  func refocus(_ path: [String]) {
    guard let document else { return }
    var list = bmapp.StringList()
    for p in path { list.push_back(std.string(p)) }
    _ = document.session.focus(list)
    document.postChange()
    viewport?.viewStateChanged()
    viewport?.fitAll(nil)
  }

  var window: NSWindow? { viewport?.window ?? document?.windowControllers.first?.window }

  static func askInSheet(_ title: String, _ initial: String, _ done: @escaping (String) -> Void) {
    let alert = NSAlert()
    alert.messageText = title
    let field = NSTextField(string: initial)
    field.frame = NSRect(x: 0, y: 0, width: 260, height: 24)
    alert.accessoryView = field
    alert.addButton(withTitle: "OK")
    alert.addButton(withTitle: "Cancel")
    alert.window.initialFirstResponder = field
    let finish: (NSApplication.ModalResponse) -> Void = { r in
      let text = field.stringValue.trimmingCharacters(in: .whitespaces)
      if r == .alertFirstButtonReturn && !text.isEmpty { done(text) }
    }
    if let window = CommandContext.current().window { alert.beginSheetModal(for: window, completionHandler: finish) } else { finish(alert.runModal()) }
  }

  static func chooseInSheet(_ title: String, _ options: [String], _ done: @escaping (Int) -> Void) {
    guard !options.isEmpty else { return NSSound.beep() }
    let alert = NSAlert()
    alert.messageText = title
    let popup = NSPopUpButton(frame: NSRect(x: 0, y: 0, width: 260, height: 26), pullsDown: false)
    popup.addItems(withTitles: options)
    alert.accessoryView = popup
    alert.addButton(withTitle: "OK")
    alert.addButton(withTitle: "Cancel")
    let finish: (NSApplication.ModalResponse) -> Void = { r in if r == .alertFirstButtonReturn { done(popup.indexOfSelectedItem) } }
    if let window = CommandContext.current().window { alert.beginSheetModal(for: window, completionHandler: finish) } else { finish(alert.runModal()) }
  }

  static func explainInSheet(_ why: String) {
    let alert = NSAlert()
    alert.messageText = "This can't be done."
    alert.informativeText = why
    if let window = CommandContext.current().window { alert.beginSheetModal(for: window) } else { alert.runModal() }
  }
}

@MainActor struct AppCommand: Identifiable {
  let id: String
  let title: String
  let symbol: String?
  let key: String
  let modifiers: NSEvent.ModifierFlags
  let menu: MenuPlace
  let group: Int
  /// Sent along the responder chain instead of `run`, for commands text fields also answer.
  let selector: Selector?
  let titleFor: ((CommandContext) -> String)?
  let checked: ((CommandContext) -> Bool)?
  let enabled: (CommandContext) -> Bool
  let run: (CommandContext) -> Void

  /// "⇧⌘S", as menus show it.
  var shortcut: String {
    guard !key.isEmpty else { return "" }
    var out = ""
    if modifiers.contains(.control) { out += "⌃" }
    if modifiers.contains(.option) { out += "⌥" }
    if modifiers.contains(.shift) { out += "⇧" }
    if modifiers.contains(.command) { out += "⌘" }
    switch key {
    case String(UnicodeScalar(NSUpArrowFunctionKey)!): out += "↑"
    case String(UnicodeScalar(NSDownArrowFunctionKey)!): out += "↓"
    default: out += key.uppercased()
    }
    return out
  }
}

@MainActor private func makeCommand(_ id: String, _ title: String, symbol: String? = nil, key: String = "", modifiers: NSEvent.ModifierFlags = [.command],
                     menu: MenuPlace, group: Int, selector: Selector? = nil, titleFor: ((CommandContext) -> String)? = nil,
                     checked: ((CommandContext) -> Bool)? = nil, enabled: ((CommandContext) -> Bool)? = nil,
                     run: ((CommandContext) -> Void)? = nil) -> AppCommand {
  AppCommand(id: id, title: title, symbol: symbol, key: key, modifiers: key.isEmpty ? [] : modifiers, menu: menu, group: group,
             selector: selector, titleFor: titleFor, checked: checked,
             enabled: enabled ?? { _ in selector.map(Registry.selectorEnabled) ?? true },
             run: run ?? { _ in if let selector { NSApp.sendAction(selector, to: nil, from: nil) } })
}

/// Runs a viewport method and asks the viewport whether it would.
@MainActor private func viewportCommand(_ id: String, _ title: String, symbol: String? = nil, key: String = "", modifiers: NSEvent.ModifierFlags = [.command],
                             menu: MenuPlace, group: Int, _ action: Selector) -> AppCommand {
  makeCommand(id, title, symbol: symbol, key: key, modifiers: modifiers, menu: menu, group: group,
          enabled: { c in
            guard let v = c.viewport else { return false }
            return v.validateMenuItem(NSMenuItem(title: "", action: action, keyEquivalent: ""))
          },
          run: { c in _ = c.viewport?.perform(action, with: nil) })
}

private let up = String(UnicodeScalar(NSUpArrowFunctionKey)!)
private let down = String(UnicodeScalar(NSDownArrowFunctionKey)!)

@MainActor enum Registry {
  static let all: [AppCommand] = [
    // File
    makeCommand("file.new", "New", key: "n", menu: .file, group: 0, selector: #selector(NSDocumentController.newDocument(_:))),
    makeCommand("file.open", "Open…", symbol: "folder", key: "o", menu: .file, group: 0, selector: #selector(NSDocumentController.openDocument(_:))),
    makeCommand("file.close", "Close", key: "w", menu: .file, group: 1, selector: #selector(NSWindow.performClose(_:))),
    makeCommand("file.save", "Save…", key: "s", menu: .file, group: 1, selector: #selector(NSDocument.save(_:))),
    makeCommand("file.duplicate", "Duplicate", key: "s", modifiers: [.command, .shift], menu: .file, group: 1, selector: #selector(NSDocument.duplicate(_:))),
    makeCommand("file.rename", "Rename…", menu: .file, group: 1, selector: #selector(NSDocument.rename(_:))),
    makeCommand("file.revert", "Revert To", menu: .file, group: 1, selector: #selector(NSDocument.revertToSaved(_:))),
    makeCommand("file.versions", "Browse All Versions…", menu: .file, group: 1, selector: #selector(NSDocument.browseVersions(_:))),
    makeCommand("file.exportLDraw", "Export LDraw…", symbol: "square.and.arrow.up", key: "e", modifiers: [.command, .shift], menu: .file, group: 2,
            selector: #selector(Document.exportLDraw(_:))),

    // Edit
    makeCommand("edit.undo", "Undo", symbol: "arrow.uturn.backward", key: "z", menu: .edit, group: 0, selector: Selector(("undo:"))),
    makeCommand("edit.redo", "Redo", symbol: "arrow.uturn.forward", key: "z", modifiers: [.command, .shift], menu: .edit, group: 0, selector: Selector(("redo:"))),
    makeCommand("edit.cut", "Cut", symbol: "scissors", key: "x", menu: .edit, group: 1, selector: #selector(NSText.cut(_:))),
    makeCommand("edit.copy", "Copy", symbol: "doc.on.doc", key: "c", menu: .edit, group: 1, selector: #selector(NSText.copy(_:))),
    makeCommand("edit.paste", "Paste", symbol: "doc.on.clipboard", key: "v", menu: .edit, group: 1, selector: #selector(NSText.paste(_:))),
    viewportCommand("edit.duplicate", "Duplicate", symbol: "plus.square.on.square", key: "d", menu: .edit, group: 1, #selector(ViewportView.duplicatePieces(_:))),
    makeCommand("edit.delete", "Delete", symbol: "trash", menu: .edit, group: 1, selector: #selector(NSText.delete(_:))),
    makeCommand("edit.selectAll", "Select All", key: "a", menu: .edit, group: 2, selector: #selector(NSText.selectAll(_:))),
    viewportCommand("edit.selectNone", "Select None", menu: .edit, group: 2, #selector(ViewportView.selectNone(_:))),
    viewportCommand("edit.hide", "Hide", symbol: "eye.slash", menu: .edit, group: 3, #selector(ViewportView.hidePieces(_:))),
    viewportCommand("edit.hideOthers", "Hide Others", menu: .edit, group: 3, #selector(ViewportView.hideOtherPieces(_:))),
    viewportCommand("edit.showAll", "Show All", symbol: "eye", menu: .edit, group: 3, #selector(ViewportView.showAllPieces(_:))),

    // Edit ▸ Select
    similar("select.samePart", "Same Part", .Part),
    similar("select.sameColor", "Same Colour", .Color),
    similar("select.samePartColor", "Same Part and Colour", .PartAndColor),
    similar("select.sameStep", "Same Step", .Step),

    // Object
    viewportCommand("object.rotateCW", "Rotate 90° Clockwise", symbol: "rotate.right", menu: .object, group: 0, #selector(ViewportView.rotatePieces(_:))),
    viewportCommand("object.rotateCCW", "Rotate 90° Counterclockwise", symbol: "rotate.left", menu: .object, group: 0, #selector(ViewportView.rotatePiecesBack(_:))),
    viewportCommand("object.raise", "Raise", symbol: "arrow.up.to.line", menu: .object, group: 1, #selector(ViewportView.raisePieces(_:))),
    viewportCommand("object.lower", "Lower", symbol: "arrow.down.to.line", menu: .object, group: 1, #selector(ViewportView.lowerPieces(_:))),
    makeCommand("object.newSubmodel", "New Submodel…", symbol: "cube", menu: .object, group: 2,
            enabled: { $0.document != nil },
            run: { c in
              guard let s = c.session else { return }
              c.prompt("Name the new submodel", String(s.freeSubmodelName("Submodel"))) { name in
                c.perform { $0.newSubmodel(std.string(name)) }
              }
            }),
    makeCommand("object.makeSubmodel", "Make Submodel from Selection…", symbol: "shippingbox", key: "g", modifiers: [.command, .option], menu: .object, group: 2,
            enabled: { $0.selection.count >= 2 },
            run: { c in
              guard let s = c.session else { return }
              let pieces = c.selection
              c.prompt("Name the new submodel", String(s.freeSubmodelName("Submodel"))) { name in
                c.perform { $0.makeSubmodel(ViewportView.list(pieces), std.string(name)) }
              }
            }),
    makeCommand("object.extract", "Extract", symbol: "shippingbox.and.arrow.backward", menu: .object, group: 2,
            enabled: { c in c.session?.snapshot().selected.first.map { !$0.submodelPath.empty() } ?? false },
            run: { c in
              guard let piece = c.clickedPiece ?? c.selection.first else { return }
              c.perform { $0.extract(piece) }
            }),
    makeCommand("object.moveToModel", "Move to Model…", symbol: "arrow.right.square", menu: .object, group: 2,
            enabled: { c in c.hasSelection && !Registry.modelNames(c).isEmpty },
            run: { c in
              let names = Registry.modelNames(c), pieces = c.selection
              c.choose("Move the selection to", names) { i in
                c.perform { $0.moveToModel(ViewportView.list(pieces), std.string(names[i])) }
              }
            }),
    makeCommand("object.openSubmodel", "Open Submodel", symbol: "arrow.down.right.square", key: down, menu: .object, group: 3,
            enabled: { Registry.submodelToOpen($0) != nil },
            run: { c in
              guard let name = Registry.submodelToOpen(c), let s = c.session else { return }
              c.refocus(s.focusPath().map { String($0) } + [name])
            }),
    makeCommand("object.back", "Back to Parent Model", symbol: "arrow.up.left.square", key: up, menu: .object, group: 3,
            enabled: { !($0.session?.focusPath().isEmpty ?? true) },
            run: { c in
              guard let s = c.session else { return }
              c.refocus(Array(s.focusPath().map { String($0) }.dropLast()))
            }),
    viewportCommand("object.makeUnique", "Make Unique", menu: .object, group: 4, #selector(ViewportView.makeUnique(_:))),
    viewportCommand("object.replacePart", "Replace Part…", symbol: "arrow.triangle.2.circlepath", menu: .object, group: 4, #selector(ViewportView.replacePart(_:))),

    // Step
    makeCommand("step.insertBefore", "Insert Step Before", symbol: "text.insert", menu: .step, group: 0,
            enabled: { $0.step != nil }, run: { c in if let k = c.step { c.perform { $0.insertStep(k) } } }),
    makeCommand("step.insertAfter", "Insert Step After", menu: .step, group: 0,
            enabled: { $0.step != nil }, run: { c in if let k = c.step { c.perform { $0.insertStep(k + 1) } } }),
    makeCommand("step.split", "Split Step at Selection", symbol: "scissors", menu: .step, group: 1,
            enabled: { $0.step != nil }, run: { c in
              if let k = c.step { let p = c.selection; c.perform { $0.splitStep(k, ViewportView.list(p)) } }
            }),
    makeCommand("step.mergeNext", "Merge with Next Step", symbol: "arrow.down.and.line.horizontal.and.arrow.up", menu: .step, group: 1,
            enabled: { c in c.step.map { $0 + 1 < (c.session?.stepCount() ?? 0) } ?? false },
            run: { c in if let k = c.step { c.perform { $0.mergeSteps(k) } } }),
    makeCommand("step.moveTo", "Move to Step…", symbol: "arrow.right.to.line", menu: .step, group: 1,
            enabled: { $0.hasSelection },
            run: { c in
              guard let s = c.session else { return }
              let count = s.stepCount(), pieces = c.selection
              c.choose("Move the selection to", (0..<count).map { "Step \($0 + 1)" } + ["A New Last Step"]) { i in
                c.perform { $0.moveToStep(ViewportView.list(pieces), i) }
              }
            }),
    makeCommand("step.pinOrder", "Pin Order", symbol: "pin", menu: .step, group: 2,
            checked: { c in c.step.map { c.session?.stepFields($0).pinOrder ?? false } ?? false },
            enabled: { $0.step != nil },
            run: { c in
              guard let k = c.step, let s = c.session else { return }
              var f = s.stepFields(k)
              f.pinOrder.toggle()
              c.perform { $0.setStepFields(k, f, false) }
            }),
    makeCommand("step.delete", "Delete Step", symbol: "trash", menu: .step, group: 3,
            enabled: { $0.step != nil }, run: { c in if let k = c.step { c.perform { $0.deleteStep(k) } } }),

    // View
    makeCommand("view.sidebar", "Show Sidebar", key: "s", modifiers: [.command, .control], menu: .view, group: 0,
            selector: #selector(NSSplitViewController.toggleSidebar(_:))),
    makeCommand("view.inspector", "Show Inspector", key: "i", modifiers: [.command, .option], menu: .view, group: 0,
            selector: #selector(NSSplitViewController.toggleInspector(_:))),
    viewportCommand("view.fitAll", "Fit All", symbol: "arrow.up.left.and.arrow.down.right", menu: .view, group: 1, #selector(ViewportView.fitAll(_:))),
    viewportCommand("view.frameSelection", "Frame Selection", symbol: "viewfinder", key: "f", menu: .view, group: 1, #selector(ViewportView.frameSelection(_:))),
    preset("view.front", "Front", .Front), preset("view.back", "Back", .Back), preset("view.left", "Left", .Left),
    preset("view.right", "Right", .Right), preset("view.top", "Top", .Top), preset("view.bottom", "Bottom", .Bottom),
    makeCommand("view.fullScreen", "Enter Full Screen", key: "f", modifiers: [.command, .control], menu: .view, group: 3,
            selector: #selector(NSWindow.toggleFullScreen(_:))),
  ]

  private static func similar(_ id: String, _ title: String, _ kind: bmapp.Similar) -> AppCommand {
    makeCommand(id, title, menu: .select, group: 0, enabled: { $0.hasSelection },
            run: { c in
              c.session?.selectSimilar(kind)
              c.viewport?.viewStateChanged()
            })
  }

  private static func preset(_ id: String, _ title: String, _ p: bmapp.ViewPreset) -> AppCommand {
    makeCommand(id, title, symbol: "cube.transparent", menu: .view, group: 2, enabled: { $0.viewport != nil },
            run: { c in
              c.viewport?.viewport.view(p)
              c.viewport?.changed()
            })
  }

  private static let byId: [String: AppCommand] = Dictionary(uniqueKeysWithValues: all.map { ($0.id, $0) })

  static func command(_ id: String) -> AppCommand? { byId[id] }

  /// The submodels the selection could move into: every one but those it is in.
  static func modelNames(_ c: CommandContext) -> [String] {
    guard let s = c.session else { return [] }
    let here = String(s.focused())
    var out: [String] = []
    var seen = Set<String>()
    for row in s.outline() where !row.def.empty() {
      let name = String(row.def)
      if name != here && !row.unused && seen.insert(name).inserted { out.append(name) }
    }
    return out
  }

  /// The submodel holding the selection (or the clicked piece), one level below the model shown.
  static func submodelToOpen(_ c: CommandContext) -> String? {
    guard let s = c.session else { return nil }
    let snap = s.snapshot()
    let infos: [bmapp.PieceInfo]
    if let piece = c.clickedPiece {
      infos = Array(snap.selected).filter { $0.piece == piece }
    } else {
      infos = Array(snap.selected)
    }
    let firsts = Set(infos.map { String($0.submodelPath).split(separator: "/").first.map(String.init) ?? "" })
    guard firsts.count == 1, let name = firsts.first, !name.isEmpty else { return nil }
    return name
  }

  /// Is a responder-chain command answered, and would its target do it?
  static func selectorEnabled(_ selector: Selector) -> Bool {
    guard let target = NSApp.target(forAction: selector, to: nil, from: nil) else { return false }
    if let v = target as? NSMenuItemValidation { return v.validateMenuItem(NSMenuItem(title: "", action: selector, keyEquivalent: "")) }
    return true
  }

  // MARK: Menus

  static func item(_ c: AppCommand) -> NSMenuItem {
    let item = NSMenuItem(title: c.title, action: c.selector ?? #selector(CommandRunner.runCommand(_:)), keyEquivalent: c.key)
    item.keyEquivalentModifierMask = c.modifiers
    item.representedObject = c.id
    if c.selector == nil { item.target = CommandRunner.shared }
    if let symbol = c.symbol { item.image = NSImage(systemSymbolName: symbol, accessibilityDescription: nil) }
    return item
  }

  /// The commands of one menu, in their order, with separators between groups.
  static func menu(_ place: MenuPlace, title: String) -> NSMenu {
    let menu = NSMenu(title: title)
    var group: Int?
    for c in all where c.menu == place {
      if let g = group, g != c.group { menu.addItem(.separator()) }
      group = c.group
      menu.addItem(item(c))
    }
    return menu
  }

  /// A context menu of these commands; nil is a separator. Disabled commands are left out.
  static func contextMenu(_ ids: [String?], context: CommandContext) -> NSMenu {
    let menu = NSMenu()
    for id in ids {
      guard let id else {
        if let last = menu.items.last, !last.isSeparatorItem { menu.addItem(.separator()) }
        continue
      }
      guard let c = command(id), c.enabled(context) else { continue }
      let item = NSMenuItem(title: c.titleFor?(context) ?? c.title, action: #selector(CommandRunner.runContext(_:)), keyEquivalent: "")
      item.target = CommandRunner.shared
      item.representedObject = ContextCall(id: id, piece: context.clickedPiece)
      item.state = c.checked?(context) == true ? .on : .off
      menu.addItem(item)
    }
    if menu.items.last?.isSeparatorItem == true { menu.removeItem(at: menu.items.count - 1) }
    return menu
  }

  /// A menu item made from a registry command.
  static func owns(_ item: NSMenuItem) -> Bool {
    if let id = item.representedObject as? String { return byId[id] != nil }
    return item.representedObject is ContextCall
  }
}

final class ContextCall: NSObject {
  let id: String
  let piece: UInt32?
  init(id: String, piece: UInt32?) {
    self.id = id
    self.piece = piece
  }
}

/// The target of every registry menu item that is not a responder-chain command.
@MainActor final class CommandRunner: NSObject, NSMenuItemValidation {
  static let shared = CommandRunner()

  @objc func runCommand(_ sender: NSMenuItem) {
    guard let id = sender.representedObject as? String, let c = Registry.command(id) else { return }
    let context = CommandContext.current()
    guard c.enabled(context) else { return NSSound.beep() }
    c.run(context)
  }

  @objc func runContext(_ sender: NSMenuItem) {
    guard let call = sender.representedObject as? ContextCall, let c = Registry.command(call.id) else { return }
    if let selector = c.selector {
      NSApp.sendAction(selector, to: nil, from: sender)
      return
    }
    c.run(.current(clickedPiece: call.piece))
  }

  func validateMenuItem(_ item: NSMenuItem) -> Bool {
    guard let id = (item.representedObject as? String) ?? (item.representedObject as? ContextCall)?.id, let c = Registry.command(id) else { return false }
    let context = CommandContext.current()
    if let t = c.titleFor { item.title = t(context) }
    if let k = c.checked { item.state = k(context) ? .on : .off }
    return c.enabled(context)
  }
}
