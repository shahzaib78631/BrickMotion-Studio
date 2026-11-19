// BrickMotion: the native editor. A few flags run without a window, for checks.
import AppKit
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
if args.contains("--save-to") {
  exit(MainActor.assumeIsolated { headlessSave(args) })
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
if args.count >= 3 && args[1] == "--selftest-edit" {
  exit(MainActor.assumeIsolated { selftestEdit(args[2]) })
}
/// The bundle's document types and type declarations must list exactly bmapp::documentTypes().
func checkPlist() -> Int32 {
  let info = Bundle.main.infoDictionary ?? [:]
  let docTypes = (info["CFBundleDocumentTypes"] as? [[String: Any]]) ?? []
  let listed = docTypes.flatMap { ($0["LSItemContentTypes"] as? [String]) ?? [] }
  let declared = (((info["UTExportedTypeDeclarations"] as? [[String: Any]]) ?? []) + ((info["UTImportedTypeDeclarations"] as? [[String: Any]]) ?? []))
  var extensionOf: [String: String] = [:]
  for d in declared {
    let tags = d["UTTypeTagSpecification"] as? [String: Any]
    extensionOf[d["UTTypeIdentifier"] as? String ?? ""] = (tags?["public.filename-extension"] as? [String])?.first
  }
  let roles = docTypes.map { $0["CFBundleTypeRole"] as? String ?? "" }
  var ok = true
  let expected = bmapp.documentTypes()
  if listed.count != expected.size() { print("plist: \(listed.count) document types, expected \(expected.size())"); ok = false }
  for (i, t) in expected.enumerated() {
    let uti = String(t.uti), ext = String(t.extension)
    if i < listed.count && listed[i] != uti { print("plist: type \(i) is \(listed[i]), expected \(uti)"); ok = false }
    if extensionOf[uti] != ext { print("plist: \(uti) has extension \(extensionOf[uti] ?? "none"), expected \(ext)"); ok = false }
    if i < roles.count && roles[i] != (t.project ? "Editor" : "Viewer") { print("plist: \(uti) has role \(roles[i])"); ok = false }
  }
  print(ok ? "plist: ok" : "plist: mismatch")
  return ok ? 0 : 1
}
if args.count >= 2 && args[1] == "--check-plist" {
  exit(checkPlist())
}

if args.contains("--snapshot") {
  guard let request = SnapshotRequest.parse(args) else {
    print("usage: BrickMotion --snapshot out.png --open <file> [--size WxH] [--appearance light|dark] [--play-to s] [--report out.json] [--select n...] [--tool move|rotate]")
    exit(2)
  }
  exit(MainActor.assumeIsolated { Snapshot.run(request) })
}

// The app. The document controller must exist before anything asks for the shared one. Model
// files named on the command line are opened by AppKit itself.
_ = DocumentController()
let delegate = AppDelegate()
NSApplication.shared.delegate = delegate
NSApplication.shared.setActivationPolicy(.regular)
NSApplication.shared.run()
