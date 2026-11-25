import AppKit
import BMApp

@MainActor func selftestPlacement() -> Int32 {
  NSApplication.shared.setActivationPolicy(.prohibited)
  let document = Document()
  do { try document.prepareBlank() } catch {
    print("selftest-placement: \(error.localizedDescription)")
    return 1
  }
  document.makeWindowControllers()
  guard let controller = document.windowControllers.first as? WindowController,
        let window = controller.window, let undo = document.undoManager else { return 1 }
  window.layoutIfNeeded()
  let view = controller.viewportController.viewportView
  guard view.viewport.ok() else { print("selftest-placement: no Metal device"); return 1 }
  let suite = "selftest-placement.\(UUID())"
  let defaults = UserDefaults(suiteName: suite)!
  defer { defaults.removePersistentDomain(forName: suite) }
  view.placement.history = PartsHistory(defaults: defaults)

  func fail(_ why: String) -> Int32 { print("selftest-placement: \(why)"); return 1 }
  guard let part = bmapp.commonParts(bmapp.Session.ldrawDirectory()).map(LibraryPart.init)
    .first(where: { $0.id == "3001.dat" }) else { return fail("no common brick") }
  let at = NSPoint(x: view.bounds.midX, y: view.bounds.midY)
  func key(_ code: UInt16, _ text: String) {
    if let event = NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: [],
                                   timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber,
                                   context: nil, characters: text, charactersIgnoringModifiers: text,
                                   isARepeat: false, keyCode: code) {
      view.keyDown(with: event)
    }
  }
  func waitForPreview(after previous: UInt64 = 0) -> bmapp.PlacementPreview? {
    let deadline = Date().addingTimeInterval(10)
    while Date() < deadline {
      _ = view.viewport.draw(nil)
      let preview = view.viewport.placementPreview()
      view.placement.receive(preview)
      if preview.request > previous { return preview }
      RunLoop.main.run(until: Date().addingTimeInterval(0.01))
    }
    return nil
  }

  let before = document.session.version()
  view.placement.begin(part, colour: 4, turns: 0, mirrored: false, step: 0, at: at)
  guard let first = waitForPreview(), first.state == .Free else { return fail("blank-project ghost never appeared") }
  if document.session.pieceCount() != 0 || document.session.version() != before || document.isDocumentEdited {
    return fail("preview changed the document")
  }
  if view.viewport.pick(at.x, at.y) != UInt32.max { return fail("preview is pickable") }

  key(15, "r")
  guard let turned = waitForPreview(after: first.request), turned.state == .Free else { return fail("R did not update the preview") }
  key(53, "\u{1b}")
  if view.placement.active || document.session.undoDepth() != 0 { return fail("Escape left a gesture or an edit") }

  view.placement.begin(part, colour: 4, turns: 0, mirrored: true, step: 0, at: at)
  guard waitForPreview(after: turned.request)?.state == .Free else { return fail("mirrored preview never appeared") }
  key(36, "\r")
  RunLoop.main.run(until: Date().addingTimeInterval(0.02))
  if document.session.pieceCount() != 1 || document.session.undoDepth() != 1 ||
      String(document.session.undoName()) != "Place Part" { return fail("Return did not create one Place Part edit") }
  if view.placement.history.recent.first?.id != part.id { return fail("committed part is missing from Recent") }
  undo.undo()
  if document.session.pieceCount() != 0 { return fail("undo did not remove the part") }
  undo.redo()
  if document.session.pieceCount() != 1 { return fail("redo did not restore the part") }

  view.select([0], .Replace)
  _ = view.viewport.draw(nil)
  let beforeMove = document.session.snapshot().selected[0].position
  let projected = bmapp.projectPoint(view.viewport.camera(), bmapp.Vec2(x: view.bounds.width, y: view.bounds.height),
                                     view.viewport.selectionCenter())
  let start = NSPoint(x: projected.x, y: view.bounds.height - projected.y)
  let end = NSPoint(x: min(view.bounds.maxX - 10, start.x + 96), y: start.y)
  func mouse(_ type: NSEvent.EventType, _ point: NSPoint) -> NSEvent? {
    NSEvent.mouseEvent(with: type, location: view.convert(point, to: nil), modifierFlags: [.option],
                       timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber,
                       context: nil, eventNumber: 0, clickCount: 1, pressure: 1)
  }
  if let down = mouse(.leftMouseDown, start), let drag = mouse(.leftMouseDragged, end), let up = mouse(.leftMouseUp, end) {
    view.mouseDown(with: down)
    view.mouseDragged(with: drag)
    guard waitForPreview(after: turned.request)?.state == .Free, view.placement.isMoving else {
      return fail("dragging an existing piece did not enter placement")
    }
    view.mouseUp(with: up)
  } else { return fail("could not make pointer events") }
  RunLoop.main.run(until: Date().addingTimeInterval(0.02))
  if document.session.pieceCount() != 1 || String(document.session.undoName()) != "Move Piece" {
    return fail("drag did not create one Move Piece edit")
  }
  if document.session.snapshot().selected[0].position.x == beforeMove.x { return fail("drag left the piece where it was") }

  // Pointing at a stud of the placed brick, by a real mouse move, seats the new brick on it.
  view.select([0], .Replace)
  _ = view.viewport.draw(nil)
  let placed = document.session.snapshot().selected[0].position
  let size = bmapp.Vec2(x: view.bounds.width, y: view.bounds.height)
  view.placement.begin(part, colour: 4, turns: 0, mirrored: false, step: 0, at: NSPoint(x: 8, y: 8))
  guard let away = waitForPreview(after: 0) else { return fail("no preview away from the brick") }
  var studs = 0, seated = 0
  for dx in [-30.0, -10, 10, 30] {
    for dz in [-10.0, 10] {
      let stud = bmapp.projectPoint(view.viewport.camera(), size, bmapp.Vec3(x: placed.x + dx, y: placed.y, z: placed.z + dz))
      let target = NSPoint(x: stud.x, y: view.bounds.height - stud.y)
      guard view.bounds.insetBy(dx: 2, dy: 2).contains(target),
            let move = NSEvent.mouseEvent(with: .mouseMoved, location: view.convert(target, to: nil), modifierFlags: [],
                                          timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber,
                                          context: nil, eventNumber: 0, clickCount: 0, pressure: 0) else { continue }
      studs += 1
      view.mouseMoved(with: move)
      if let preview = waitForPreview(after: away.request), preview.state == .Snapped,
         abs(preview.pose.position.y - (placed.y - 24)) < 0.01 { seated += 1 }
    }
  }
  if studs < 4 || seated != studs { return fail("pointing at studs seated \(seated) of \(studs)") }
  key(53, "\u{1b}")

  view.placement.begin(part, colour: 4, turns: 0, mirrored: false, step: 0, at: at)
  document.perform { document.session.insertStep(0) }
  if view.placement.active { return fail("a document edit left a stale gesture active") }

  print("selftest-placement: ok (preview, keyboard, history, named undo and redo, stud aiming, revision change)")
  return 0
}
