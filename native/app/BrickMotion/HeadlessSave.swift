// --open <file> [--edit-move piece dx dy dz] [--edit-structure] --save-to <out.brickmotion>: opens as the app does
// (an import becomes an untitled project), edits, and saves through NSDocument's own Save As, the
// path ⌘S takes on an untitled document. For tests; shows nothing.
import AppKit
import BMApp

@MainActor func headlessSave(_ args: [String]) -> Int32 {
  func value(_ flag: String, _ count: Int = 1) -> [String]? {
    guard let i = args.firstIndex(of: flag), i + count < args.count else { return nil }
    return Array(args[(i + 1)...(i + count)])
  }
  guard let open = value("--open")?.first, let out = value("--save-to")?.first else {
    print("usage: BrickMotion --open <file> [--edit-move piece dx dy dz] --save-to <out.brickmotion>")
    return 2
  }
  NSApplication.shared.setActivationPolicy(.prohibited)
  let url = URL(fileURLWithPath: open)
  let document = Document()
  do {
    if bmapp.isProjectExtension(std.string(url.pathExtension)) {
      try document.read(from: url, ofType: DocumentController.projectType)
    } else {
      try document.load(url)
    }
  } catch {
    print("save-to: \(error.localizedDescription)")
    return 1
  }
  document.fileType = DocumentController.projectType
  let destination = URL(fileURLWithPath: out)
  let inPlace = url.standardizedFileURL == destination.standardizedFileURL &&
                bmapp.isProjectExtension(std.string(url.pathExtension))
  if inPlace { document.fileURL = url }
  if let m = value("--edit-move", 4), let piece = UInt32(m[0]), let dx = Double(m[1]), let dy = Double(m[2]), let dz = Double(m[3]) {
    var pieces = bmapp.PieceList()
    pieces.push_back(piece)
    document.perform { document.session.move(pieces, bmapp.Vec3(x: dx, y: dy, z: dz), false) }
  }
  if args.contains("--edit-structure") {
    if let why = editStructure(document) {
      print("save-to: \(why)")
      return 1
    }
  }
  var finished = false, failure: (any Error)?
  document.save(to: destination, ofType: DocumentController.projectType, for: inPlace ? .saveOperation : .saveAsOperation) { error in
    failure = error
    finished = true
  }
  let deadline = Date().addingTimeInterval(60)
  while !finished && Date() < deadline { RunLoop.main.run(until: Date().addingTimeInterval(0.02)) }
  if let failure {
    print("save-to: \(failure.localizedDescription)")
    return 1
  }
  guard finished, !document.session.dirty() else {
    print("save-to: the save did not finish, or left the document unsaved")
    return 1
  }
  print("save-to: ok (\(document.session.pieceCount()) pieces)")
  return 0
}

/// The structure edits import_check saves and reads back: three loose pieces made into "Sub", a
/// first step "Base" with a 1.5 s pause, a loose piece moved into it, "Sub" renamed "Sub A".
/// Returns why one was refused, or nil.
@MainActor private func editStructure(_ document: Document) -> String? {
  let s = document.session
  /// The first `n` pieces of the root model itself (not inside a submodel).
  func loose(_ n: Int) -> [UInt32] {
    s.selectAll()
    let found = s.snapshot().selected.filter { $0.submodelPath.empty() }.prefix(n).map { $0.piece }
    s.selectNone()
    return Array(found)
  }
  var fields = bmapp.StepFields()
  fields.title = "Base"
  fields.pauseAfter = 1.5
  let edits: [(String, () -> bmapp.Changed)] = [
    ("make submodel", { s.makeSubmodel(ViewportView.list(loose(3)), "Sub") }),
    ("insert step", { s.insertStep(0) }),
    ("step fields", { s.setStepFields(0, fields, false) }),
    ("move to step", { s.moveToStep(ViewportView.list(loose(1)), 0) }),
    ("rename", { s.renameSubmodel("Sub", "Sub A") }),
  ]
  for (name, edit) in edits {
    let changed = document.perform(edit)
    if !changed.refused.empty() { return "\(name) refused: \(String(changed.refused))" }
  }
  return nil
}
