// BrickMotion: the native editor. A few flags run without a window, for checks.
import BMApp
import Foundation

/// Holds a session for its whole life, as a document will.
final class BridgeHolder {
  let session = bmapp.Session.create()!
}

/// Proves the shapes the app relies on: a Swift class holds a Session; a Viewport is made against
/// that same session; vectors go in and a struct of vectors and strings comes back.
func selftestBridge(_ path: String) -> Int32 {
  let holder = BridgeHolder()
  let opened = holder.session.open(std.string(path))
  guard opened.ok else {
    print("selftest: open failed: \(String(opened.error))")
    return 1
  }
  let viewport = bmapp.Viewport.create(holder.session)!
  guard viewport.sessionAddress() == holder.session.address() else {
    print("selftest: the viewport was made against a copy of the session")
    return 1
  }
  var pieces = bmapp.PieceList()
  pieces.push_back(0)
  pieces.push_back(1)
  pieces.push_back(0)
  let summary = holder.session.summarize(pieces)
  guard summary.count == 2, !summary.parts.isEmpty else {
    print("selftest: summarize gave \(summary.count) pieces, \(summary.parts.size()) parts")
    return 1
  }
  let first = String(summary.parts[0])
  guard !first.isEmpty, holder.session.pieceCount() > 0 else {
    print("selftest: empty part name or no pieces")
    return 1
  }
  print("selftest: ok (\(holder.session.pieceCount()) pieces, viewport ok \(viewport.ok()), first part \(first))")
  return 0
}

let args = CommandLine.arguments
if args.count >= 2 && args[1] == "--version" {
  print("BrickMotion \(String(bmapp.Session.engineVersion()))")
  exit(0)
}
if args.count >= 3 && args[1] == "--open" {
  let session = bmapp.Session.create()!
  let r = session.open(std.string(args[2]))
  if !r.ok {
    FileHandle.standardError.write((String(r.error) + "\n").data(using: .utf8)!)
    exit(1)
  }
  print("pieces \(session.pieceCount())")
  exit(0)
}
if args.count >= 3 && args[1] == "--selftest-bridge" {
  exit(selftestBridge(args[2]))
}
print("usage: BrickMotion --version | --open <file> | --selftest-bridge <file>")
exit(2)
