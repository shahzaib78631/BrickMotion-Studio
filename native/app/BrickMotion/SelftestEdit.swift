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
  print("selftest-edit: ok (\(steps) steps undone, \(count) pieces)")
  return 0
}
