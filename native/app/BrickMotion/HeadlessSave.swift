// --open <file> [--edit-move piece dx dy dz] --save-to <out.brickmotion>: opens as the app does
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
  if let m = value("--edit-move", 4), let piece = UInt32(m[0]), let dx = Double(m[1]), let dy = Double(m[2]), let dz = Double(m[3]) {
    var pieces = bmapp.PieceList()
    pieces.push_back(piece)
    document.perform { document.session.move(pieces, bmapp.Vec3(x: dx, y: dy, z: dz), false) }
  }
  var finished = false, failure: (any Error)?
  document.save(to: URL(fileURLWithPath: out), ofType: DocumentController.projectType, for: .saveAsOperation) { error in
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
