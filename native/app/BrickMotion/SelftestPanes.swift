// --selftest-panes <file>: checks the command registry, the panes' view models and the palette
// through a document's real window, as a person would reach them. Prints the first failure.
import AppKit
import BMApp

@MainActor func selftestPanes(_ path: String) -> Int32 {
  NSApplication.shared.setActivationPolicy(.prohibited)
  NSApp.mainMenu = MainMenu.make()
  let document = Document()
  do { try document.load(URL(fileURLWithPath: path)) } catch {
    print("selftest-panes: \(error.localizedDescription)")
    return 1
  }
  document.makeWindowControllers()
  guard let controller = document.windowControllers.first as? WindowController else { return 1 }
  let view = controller.viewportController.viewportView
  func fail(_ why: String) -> Int32 { print("selftest-panes: \(why)"); return 1 }
  func turn() { RunLoop.main.run(until: Date().addingTimeInterval(0.02)) }
  /// A context that answers every prompt with what it offers, and keeps refusals.
  var refusals: [String] = []
  let context = CommandContext(document: document, viewport: view, clickedPiece: nil,
                               prompt: { _, initial, done in done(initial) },
                               refuse: { refusals.append($0) })

  // 1. Every menu item runs a registry command or is a system item.
  var unknown: [String] = []
  func walk(_ menu: NSMenu) {
    for item in menu.items {
      if let sub = item.submenu { walk(sub); continue }
      if item.isSeparatorItem { continue }
      if Registry.owns(item) || MainMenu.systemItems.contains(item.title) { continue }
      unknown.append(item.title)
    }
  }
  walk(NSApp.mainMenu!)
  if !unknown.isEmpty { return fail("menu items outside the registry: \(unknown)") }

  // 2. No two commands share a shortcut.
  var keys: [String: String] = [:]
  for c in Registry.all where !c.key.isEmpty {
    let k = "\(c.modifiers.rawValue)-\(c.key)"
    if let other = keys[k] { return fail("\(c.id) and \(other) share a shortcut") }
    keys[k] = c.id
  }

  // 3. Make Submodel from three selected pieces is one named undo step.
  view.selectAll(nil)
  let loose = document.session.snapshot().selected.filter { $0.submodelPath.empty() }.prefix(3).map { $0.piece }
  if loose.count < 3 { return fail("the model has fewer than three loose pieces") }
  view.select(Array(loose), .Replace)
  guard let make = Registry.command("object.makeSubmodel") else { return fail("no object.makeSubmodel") }
  if !make.enabled(context) { return fail("Make Submodel is disabled with three pieces selected") }
  make.run(context)
  turn()
  if let r = refusals.first { return fail("Make Submodel refused: \(r)") }
  if String(document.session.undoName()) != "Make Submodel" { return fail("undo is \(document.session.undoName())") }
  document.undoManager?.undo()
  turn()

  // 4. The Models pane's tree has one node per outline row.
  let model: DocumentModel = controller.model
  func count(_ nodes: [OutlineNode]) -> Int { nodes.reduce(0) { $0 + 1 + count($1.children ?? []) } }
  if count(model.outline) != document.session.outline().count {
    return fail("the tree has \(count(model.outline)) rows, the outline \(document.session.outline().count)")
  }

  // 5. Opening a use row edits its submodel alone; Back returns to the whole model.
  guard let use = model.outline.first?.children?.first(where: { !$0.row.def.empty() }) else {
    return fail("the model has no submodel use")
  }
  model.open(row: use)
  turn()
  if String(model.snapshot.focus) != String(use.row.def) { return fail("open gave focus \(model.snapshot.focus)") }
  model.back()
  turn()
  if !model.snapshot.focus.empty() { return fail("back left focus \(model.snapshot.focus)") }

  // 6. A query keeps the rows that match and their ancestors, nothing else.
  let word = String(String(use.row.name).prefix(4)).lowercased()
  model.outlineQuery = word
  func kept(_ nodes: [OutlineNode]) -> Bool {
    nodes.allSatisfy { n in
      let matches = String(n.row.name).lowercased().contains(word)
      let below = n.children ?? []
      return (matches || !below.isEmpty) && kept(below)
    }
  }
  if model.outline.isEmpty || !kept(model.outline) { return fail("the query \"\(word)\" kept rows that do not match") }
  if count(model.outline) >= document.session.outline().count && document.session.outline().count > 2 {
    return fail("the query \"\(word)\" kept every row")
  }
  model.outlineQuery = ""

  // 7. A move leaves the structure alone, so the tree is not built again.
  let builds = model.outlineBuilds
  document.perform { document.session.move(ViewportView.list([0]), bmapp.Vec3(x: 20, y: 0, z: 0), false) }
  turn()
  if model.outlineBuilds != builds { return fail("a move rebuilt the outline") }
  document.undoManager?.undo()
  turn()

  // 8. Typing a title in the step editor is one undo step, closed when the editor closes.
  let oldTitle = String(document.session.stepFields(0).title)
  let editor = StepEditorModel(model: model, step: 0)
  for t in ["A", "Ab", "Abc"] {
    editor.title = t
    editor.commit()
  }
  editor.close()
  turn()
  if String(document.session.undoName()) != "Edit Step" { return fail("typing gave undo \(document.session.undoName())") }
  if String(document.session.stepFields(0).title) != "Abc" { return fail("the title is \(document.session.stepFields(0).title)") }
  document.undoManager?.undo()
  turn()
  if String(document.session.stepFields(0).title) != oldTitle { return fail("one undo left the title \(document.session.stepFields(0).title)") }

  // 9. Dragging step 1 below step 2 in the list moves it, as one named step.
  if model.steps.count < 2 { return fail("the model has fewer than two steps") }
  model.moveSteps(from: IndexSet([0]), to: 2)
  turn()
  if String(document.session.undoName()) != "Move Step" { return fail("dragging a step gave undo \(document.session.undoName())") }
  document.undoManager?.undo()
  turn()

  // 10. A swatch recolours the selection as one named step and goes first in Recent.
  let suite = "selftest-panes"
  let defaults = UserDefaults(suiteName: suite)!
  defer { defaults.removePersistentDomain(forName: suite) }
  view.select(Array(loose.prefix(2)), .Replace)
  let swatches = ColorSwatchesModel(model: model, defaults: defaults)
  swatches.choose(4)
  turn()
  if String(document.session.undoName()) != "Recolour 2 Pieces" { return fail("a swatch gave undo \(document.session.undoName())") }
  if swatches.recent.first != 4 { return fail("recent colours are \(swatches.recent)") }
  document.undoManager?.undo()
  turn()

  // 11. X + 20 in the Part tab moves the piece 20 LDU, as one undo step.
  view.select([loose[0]], .Replace)
  let part = PartInspectorModel(model: model)
  guard let x0 = part.position?.x else { return fail("the Part tab has no position for one piece") }
  let depth = document.session.undoDepth()
  part.set(axis: 0, to: x0 + 20)
  turn()
  guard let x1 = model.snapshot.selected.first?.position.x, abs(x1 - (x0 + 20)) < 1e-6 else {
    return fail("X + 20 left the piece at \(String(describing: model.snapshot.selected.first?.position.x)), from \(x0)")
  }
  if document.session.undoDepth() != depth + 1 { return fail("X + 20 made \(document.session.undoDepth() - depth) undo steps") }
  document.undoManager?.undo()
  turn()

  // 12. The palette ranks by fuzzy match over what can run now.
  view.select(Array(loose), .Replace)
  let items = paletteItems(context)
  if paletteMatches("msub", in: items).first?.title != "Make Submodel from Selection…" {
    return fail("\"msub\" ranks \(paletteMatches("msub", in: items).prefix(3).map(\.title)) first")
  }
  if paletteMatches("dup", in: items).first?.title != "Duplicate" {
    return fail("\"dup\" ranks \(paletteMatches("dup", in: items).prefix(3).map(\.title)) first")
  }

  // 13. A palette row shows the shortcut its menu item has.
  var menuItems: [String: NSMenuItem] = [:]
  func gather(_ menu: NSMenu) {
    for item in menu.items {
      if let sub = item.submenu { gather(sub) }
      if let id = item.representedObject as? String { menuItems[id] = item }
    }
  }
  gather(NSApp.mainMenu!)
  for item in items {
    guard let id = item.command, let c = Registry.command(id) else { continue }
    if item.shortcut != c.shortcut { return fail("\(id) shows \(item.shortcut) in the palette, \(c.shortcut) in the registry") }
    guard let m = menuItems[id] else { continue }
    if m.keyEquivalent != c.key || m.keyEquivalentModifierMask != c.modifiers { return fail("\(id)'s menu item has another shortcut") }
  }

  // 14. Every item of the piece menu and the empty-space menu runs a registry command.
  func strays(_ menu: NSMenu) -> [String] {
    menu.items.flatMap { item -> [String] in
      if let sub = item.submenu { return strays(sub) }
      return item.isSeparatorItem || Registry.owns(item) ? [] : [item.title]
    }
  }
  let pieceMenu = PieceMenu.make(piece: loose[0], context: CommandContext(document: document, viewport: view, clickedPiece: loose[0]))
  if pieceMenu.items.count < 8 { return fail("the piece menu has only \(pieceMenu.items.count) items") }
  if !strays(pieceMenu).isEmpty { return fail("piece menu items outside the registry: \(strays(pieceMenu))") }
  let emptyMenu = PieceMenu.make(piece: nil, context: CommandContext(document: document, viewport: view, clickedPiece: nil))
  if !strays(emptyMenu).isEmpty { return fail("empty-space menu items outside the registry: \(strays(emptyMenu))") }

  print("selftest-panes: ok")
  return 0
}
