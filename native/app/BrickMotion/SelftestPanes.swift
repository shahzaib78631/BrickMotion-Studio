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

  print("selftest-panes: ok")
  return 0
}
