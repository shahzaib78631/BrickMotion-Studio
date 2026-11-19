// --selftest-edit <file>: drives a document's edits through its window's real views and undo
// manager, as the keys and menus do, and checks the edited dot comes and goes.
import AppKit
import BMApp

@MainActor func selftestEdit(_ path: String) -> Int32 {
  NSApplication.shared.setActivationPolicy(.prohibited)
  let document = Document()
  do { try document.load(URL(fileURLWithPath: path)) } catch {
    print("selftest-edit: \(error.localizedDescription)")
    return 1
  }
  document.makeWindowControllers()
  guard let controller = document.windowControllers.first as? WindowController, let undo = document.undoManager else { return 1 }
  let view = controller.viewportController.viewportView
  func fail(_ why: String) -> Int32 { print("selftest-edit: \(why)"); return 1 }
  let count = document.session.pieceCount()
  /// One event's worth: the undo manager closes its group as the run loop turns.
  func turn() { RunLoop.main.run(until: Date().addingTimeInterval(0.02)) }

  view.selectNone(nil)
  view.deletePieces(nil)  // nothing selected: beeps, changes nothing
  turn()
  if document.isDocumentEdited || undo.canUndo { return fail("an edit with nothing selected changed the document") }

  view.select([0], .Replace)
  view.nudge(bmapp.Vec3(x: 20, y: 0, z: 0))
  turn()
  view.rotatePieces(nil)
  turn()
  view.duplicatePieces(nil)
  turn()
  if document.session.pieceCount() != count + 1 { return fail("duplicate gave \(document.session.pieceCount()) pieces") }
  view.copy(nil)
  view.paste(nil)
  turn()
  view.deletePieces(nil)
  turn()
  if !document.isDocumentEdited { return fail("edits did not mark the document edited") }
  if undo.undoMenuItemTitle != "Undo Delete Piece" { return fail("undo is named \(undo.undoMenuItemTitle)") }
  var steps = 0
  while undo.canUndo && steps < 20 {
    undo.undo()
    turn()
    steps += 1
  }
  if steps != 5 { return fail("\(steps) undo steps, expected 5") }
  if document.isDocumentEdited { return fail("undoing everything left the document edited") }
  if document.session.dirty() || document.session.pieceCount() != count { return fail("the session did not come back") }
  undo.redo()
  turn()
  if !document.isDocumentEdited || undo.redoMenuItemTitle != "Redo Rotate Piece" { return fail("redo: \(undo.redoMenuItemTitle)") }
  // A gizmo drag along X, over several moves of the mouse, is one undo step.
  guard let window = controller.window else { return fail("no window") }
  window.setContentSize(NSSize(width: 1200, height: 800))
  window.layoutIfNeeded()
  _ = view.viewport.draw(nil)
  view.select([0], .Replace)
  view.tool = .move
  view.updateGizmo()
  guard let shape = view.gizmo, shape.lines.size() == 3 else { return fail("no move gizmo") }
  let x = shape.lines[0]
  func event(_ type: NSEvent.EventType, _ t: Double) -> NSEvent {
    let p = NSPoint(x: x.a.x + (x.b.x - x.a.x) * t, y: view.bounds.height - (x.a.y + (x.b.y - x.a.y) * t))
    return NSEvent.mouseEvent(with: type, location: view.convert(p, to: nil), modifierFlags: [], timestamp: 0,
                              windowNumber: window.windowNumber, context: nil, eventNumber: 0, clickCount: 1, pressure: 1)!
  }
  let before = document.session.undoDepth(), was = document.session.snapshot().selected[0].position
  view.mouseDown(with: event(.leftMouseDown, 1))
  for t in [1.5, 2.5, 3.5, 4.0] {
    view.mouseDragged(with: event(.leftMouseDragged, t))
    turn()
  }
  view.mouseUp(with: event(.leftMouseUp, 4.0))
  turn()
  let now = document.session.snapshot().selected[0].position
  if document.session.undoDepth() != before + 1 { return fail("a gizmo drag made \(document.session.undoDepth() - before) undo steps") }
  if now.x == was.x || now.y != was.y || now.z != was.z || (now.x - was.x).truncatingRemainder(dividingBy: 20) != 0 {
    return fail("the X handle moved (\(was.x),\(was.y),\(was.z)) to (\(now.x),\(now.y),\(now.z))")
  }
  if undo.undoMenuItemTitle != "Undo Move Piece" { return fail("the drag's undo is \(undo.undoMenuItemTitle)") }
  // Save, edit, Revert: the live document reads its file again, its undo goes, and the viewport
  // follows the session into the reopened document.
  let saved = FileManager.default.temporaryDirectory.appendingPathComponent("selftest-revert.brickmotion")
  var finished = false, failure: (any Error)?
  document.fileType = DocumentController.projectType
  document.save(to: saved, ofType: DocumentController.projectType, for: .saveAsOperation) { failure = $0; finished = true }
  while !finished { turn() }
  if let failure { return fail("save: \(failure.localizedDescription)") }
  if document.isDocumentEdited || document.session.dirty() { return fail("a save left the document edited") }
  let savedCount = document.session.pieceCount()
  view.select([0], .Replace)
  view.deletePieces(nil)
  turn()
  do { try document.revert(toContentsOf: saved, ofType: DocumentController.projectType) } catch { return fail("revert: \(error.localizedDescription)") }
  turn()
  if document.session.pieceCount() != savedCount || undo.canUndo || !document.session.selection().isEmpty {
    return fail("revert left \(document.session.pieceCount()) pieces, undo \(undo.canUndo)")
  }
  _ = view.viewport.draw(nil)
  view.viewport.fitAll()
  _ = view.viewport.draw(nil)
  let p = view.viewport.pick(view.bounds.width / 2, view.bounds.height / 2)
  if p != UInt32.max && p >= UInt32(savedCount) { return fail("the viewport picked piece \(p) of \(savedCount)") }
  try? FileManager.default.removeItem(at: saved)
  print("selftest-edit: ok (\(steps) steps undone, \(count) pieces, gizmo drag one step, revert)")
  return 0
}
