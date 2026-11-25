// --selftest-panes <file>: checks the command registry, the panes' view models and the palette
// through a document's real window, as a person would reach them. Prints the first failure.
import AVFoundation
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

  // 5b. A clicked row stays selected in the tree, and ⇧-click adds rows.
  guard let root = model.outline.first else { return fail("no root row") }
  model.select(row: use, extend: false)
  turn()
  if model.selectedRows != [use.id] { return fail("a clicked row left the tree selection \(model.selectedRows)") }
  model.select(row: root, extend: true)
  turn()
  if model.selectedRows != [use.id, root.id] { return fail("⇧-click left the tree selection \(model.selectedRows)") }
  view.select([], .Replace)
  turn()
  if !model.selectedRows.isEmpty { return fail("a viewport selection kept the tree's rows \(model.selectedRows)") }

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
  if paletteMatches("dup", in: items).first?.command != "edit.duplicate" {
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

  // The same AppKit resize path as the timeline grip, at the editor's minimum window size.
  guard let window = controller.window else { return fail("no document window for the timeline") }
  window.setContentSize(NSSize(width: 900, height: 600))
  controller.setAnimateMode(true, plan: false)
  turn()
  controller.resizeTimeline(to: 192)
  turn()
  let compactHeight = controller.timelineHeight
  controller.resizeTimeline(to: 286)
  turn()
  let tallHeight = controller.timelineHeight
  if tallHeight < compactHeight + 60 || abs(compactHeight - 192) > 2 {
    return fail("timeline resize left heights \(compactHeight) and \(tallHeight)")
  }

  let navigation = TimelineNavigation()
  navigation.measure(viewport: 600, content: 600, offset: 0)
  let anchor = navigation.time(at: 220, duration: 100)
  navigation.magnify(3, around: 220)
  navigation.measure(viewport: 600, content: navigation.contentWidth, offset: 0)
  if abs(navigation.time(at: 220, duration: 100) - anchor) > 0.01 { return fail("zoom moved the time under the pointer") }
  navigation.reveal(85, duration: 100)
  if !(navigation.visibleStart...navigation.visibleEnd).contains(0.85) { return fail("a distant seek left the playhead offscreen") }
  let beforePan = navigation.offset
  if !navigation.panAtEdge(595) || navigation.offset <= beforePan { return fail("dragging across the right edge did not scroll") }
  navigation.fit()
  if navigation.zoom != 1 || navigation.offset != 0 { return fail("Fit did not restore the full timeline") }

  let scale = TimelineScale(width: 420, duration: 60)
  let flights = [(1.0, "3001.dat"), (1.4, "3024.dat"), (28.0, "6141.dat"), (40.0, "4276b.dat"),
                 (59.8, "3022.dat")].enumerated().map { index, part in
    AnimationWorkspace.Flight(id: UInt32(index), step: 0, depth: 0, colour: 4,
                             start: part.0, end: min(60, part.0 + 0.5), part: part.1, flag: "", blocker: "")
  }
  let lane = PartLaneLayout(flights, scale: scale)
  // The arrival-drop target is bmapp's; build_lanes_test.cpp covers it.
  guard lane.rows.count == 2, let first = lane.rows.first?.first,
        lane.rows[0].map(\.code) == ["3001", "6141", "4276b", "3022"], lane.rows[1].map(\.code) == ["3024"],
        first.x == scale.x(flights[0].start), first.rect.height == 17, PartLaneLayout.font.pointSize == 10,
        first.rect.width - 22 >= (first.code as NSString).size(withAttributes: [.font: PartLaneLayout.font]).width,
        lane.clip(at: CGPoint(x: first.rect.midX, y: first.rect.midY))?.id == first.id else {
    return fail("the Parts lane did not keep labelled clips at their times without overlaps")
  }
  var visible = [UInt32]()
  lane.forEachVisible(in: first.rect) { visible.append($0.id) }
  guard visible == [first.id],
        lane.clip(at: CGPoint(x: first.rect.midX, y: first.rect.maxY + 1)) == nil else {
    return fail("the Parts lane hit test included an out-of-bounds clip")
  }
  let zoomed = PartLaneLayout(Array(flights.dropLast()), scale: TimelineScale(width: 12_600, duration: 60))
  guard zoomed.rows.count == 2, zoomed.rows[0].dropFirst().map(\.code) == ["6141", "4276b"],
        let last = lane.rows[0].last, last.rect.maxX <= scale.width, last.x < last.timeX,
        last.timeX == scale.x(flights.last!.start) else {
    return fail("the Parts lane left a gap after the last tick or lost the final clip's true time")
  }
  let fit = TimelineNavigation(trailingInset: 6)
  fit.measure(viewport: 500, content: 500, offset: 0)
  if fit.maximumOffset != 0 || fit.logicalWidth != 482 {
    return fail("Fit reserved extra space after the last tick")
  }

  // Use a real piece so the on-demand menu can resolve its actual step and item.
  guard let id = loose.first, let step = model.steps.first(where: { row in
    document.session.stepItems(Int(row.index)).contains { $0.pieces.contains(id) }
  }) else { return fail("no local piece to test the timeline menu") }
  let match = document.session.partAt(id)
  let flight = AnimationWorkspace.Flight(id: id, step: Int(step.index), depth: 0, colour: 4,
                                         start: 1, end: 2, part: String(match.name), flag: "", blocker: "")
  var framed = false
  var edited = false
  let menu = TimelinePartMenu.make(flight: flight, model: model, reveal: { framed = true }, editMotion: { edited = true })
  guard let frame = menu.items.firstIndex(where: { $0.title == "Frame in View" }),
        let motion = menu.items.firstIndex(where: { $0.title == "Motion for This Part…" }),
        menu.item(withTitle: "Move to a New Step")?.submenu?.items.count == 5,
        menu.item(withTitle: "Delete Part") != nil else { return fail("missing timeline part actions") }
  menu.performActionForItem(at: frame)
  menu.performActionForItem(at: motion)
  guard framed, edited else { return fail("the timeline part menu did not dispatch its commands") }

  guard model.partsStepIsExpanded(0), !model.partsStepIsExpanded(1) else {
    return fail("the model parts browser did not open with just the first step expanded")
  }
  model.togglePartsStep(1)
  model.togglePartsStep(0)
  model.open(row: use)
  turn()
  if !model.partsStepIsExpanded(0) { return fail("a new submodel inherited the root's collapsed first step") }
  model.back()
  turn()
  if model.partsStepIsExpanded(0) || !model.partsStepIsExpanded(1) {
    return fail("returning to the root lost its step disclosure state")
  }
  model.setPartsStepsExpanded(false)
  if model.steps.indices.contains(where: model.partsStepIsExpanded) {
    return fail("Collapse All did not collapse every step")
  }
  model.setPartsStepsExpanded(true)
  if !model.steps.indices.allSatisfy(model.partsStepIsExpanded) {
    return fail("Expand All did not expand every step")
  }
  guard let submodel = model.steps.indices.lazy.compactMap({ index in
    model.items(of: index).first { $0.submodel && !$0.pieces.isEmpty }
  }).first else { return fail("no submodel row to extract") }
  let oldPartCount = model.snapshot.pieces
  let extractedCount = submodel.pieces.count
  let undoDepth = document.session.undoDepth()
  guard model.extractParts(of: submodel), document.session.undoDepth() == undoDepth + 1,
        model.snapshot.pieces == oldPartCount, model.partsSelection.count == extractedCount,
        !model.items(of: Int(submodel.step)).contains(where: { $0.item == submodel.item }) else {
    return fail("the Parts browser did not extract the clicked submodel use in one undo step")
  }
  document.undoManager?.undo()
  turn()
  if !model.items(of: Int(submodel.step)).contains(where: { $0.item == submodel.item }) {
    return fail("undo did not restore the extracted use")
  }

  let animation = model.animation
  animation.plan()
  let planDeadline = Date().addingTimeInterval(20)
  while !animation.ready, Date() < planDeadline {
    _ = view.viewport.draw(nil)
    animation.update()
    turn()
  }
  guard animation.ready, animation.duration > 1 else { return fail("the helicopter timeline did not plan") }
  animation.seek(animation.duration * 0.4)
  let playhead = animation.time
  guard let activeRun = animation.playheadRun, animation.run(at: playhead)?.id == activeRun else {
    return fail("the playhead did not select its visible step run")
  }
  let length = animation.duration
  guard context.perform({ $0.move(ViewportView.list([id]), bmapp.Vec3(x: 2, y: 0, z: 0), false) }) else {
    return fail("the test part could not move before replanning")
  }
  _ = view.viewport.draw(nil)
  animation.update()
  guard animation.state.stale, animation.time == playhead, animation.duration == length, animation.playheadRun == activeRun else {
    return fail("the timeline jumped during replanning")
  }
  document.undoManager?.undo()

  guard let panels = window.contentViewController as? NSSplitViewController,
        let timeline = panels.splitViewItems.last?.viewController.view else {
    return fail("no timeline view for keyboard routing")
  }
  animation.tab = .timeline
  let focusProbe = NSTextView(frame: NSRect(x: 0, y: 0, width: 24, height: 20))
  timeline.addSubview(focusProbe)
  let delete = #selector(NSText.delete(_:))
  guard window.makeFirstResponder(focusProbe), controller.supplementalTarget(forAction: delete, sender: nil) == nil else {
    return fail("Delete escaped from the keyframe timeline to the model")
  }
  focusProbe.removeFromSuperview()
  guard window.makeFirstResponder(view),
        controller.supplementalTarget(forAction: delete, sender: nil) as? ViewportView === view else {
    return fail("Delete did not route to the focused viewport")
  }

  var staging = document.session.stagingSettings()
  staging.layout = std.string("gallery")
  guard context.perform({ $0.setStagingSettings(staging) }) else { return fail("the staging layout could not change") }
  animation.previewStaging()
  let stagingDeadline = Date().addingTimeInterval(20)
  while view.viewport.plannedVersion() != document.session.version(), Date() < stagingDeadline {
    _ = view.viewport.draw(nil)
    animation.update()
    turn()
  }
  guard animation.ready, animation.tab == .build, !animation.state.atRest, animation.time == 0 else {
    return fail("applying staging did not show the start of the new Build")
  }

  let captureBoard = NSPasteboard.withUniqueName()
  defer { captureBoard.releaseGlobally() }
  view.viewport.resize(480, 320, 1)
  guard StillExport.copyViewport(view, to: captureBoard),
        let png = captureBoard.data(forType: .png), let bitmap = NSBitmapImageRep(data: png),
        bitmap.pixelsWide == 480, bitmap.pixelsHigh == 320, view.viewport.needsDraw() else {
    return fail("the viewport PNG did not preserve dimensions or the pending onscreen redraw")
  }

  // View → Record Viewport: about a second of the view, 30 frames a second, at its pixel size.
  let movie = FileManager.default.temporaryDirectory.appendingPathComponent("selftest-viewport-\(UUID().uuidString).mp4")
  defer { try? FileManager.default.removeItem(at: movie) }
  let recorder = model.recorder
  var finished: Bool?
  recorder.testDestination = movie
  recorder.saved = { finished = $0 }
  guard recorder.start(view), recorder.recording else { return fail("viewport recording did not start") }
  let recordingStarted = Date()
  while Date().timeIntervalSince(recordingStarted) < 1.0 { turn() }
  recorder.stop(in: nil, name: "Selftest")
  let stopDeadline = Date().addingTimeInterval(10)
  while finished == nil && Date() < stopDeadline { turn() }
  guard finished == true, !recorder.recording, recorder.frames >= 15 else {
    return fail("the viewport recording was not written (\(recorder.frames) frames)")
  }
  let recorded = AVURLAsset(url: movie)
  var recordedSize = CGSize.zero, recordedSeconds = 0.0, loaded = false
  Task {
    let track = try? await recorded.loadTracks(withMediaType: .video).first
    recordedSize = (try? await track?.load(.naturalSize)) ?? .zero
    recordedSeconds = (try? await recorded.load(.duration))?.seconds ?? 0
    loaded = true
  }
  let loadDeadline = Date().addingTimeInterval(10)
  while !loaded && Date() < loadDeadline { turn() }
  guard recordedSize == CGSize(width: 480, height: 320), recordedSeconds > 0.8, recordedSeconds < 1.5 else {
    return fail("the viewport recording is \(recordedSize) for \(recordedSeconds) s, not 480 x 320 for about a second")
  }

  print("selftest-panes: ok")
  return 0
}
