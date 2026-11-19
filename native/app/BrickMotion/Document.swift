// One open model. Imports (LDraw, Studio, plans) arrive here as new, untitled projects.
import AppKit
import BMApp

@objc(BMDocument)
final class Document: NSDocument {
  let session = bmapp.Session.create()!
  /// What opening found but could still load (missing parts, loops, unknown colours).
  private(set) var warnings = ""

  /// Off until the project writer lands (phase 8 Task 12): autosaving needs data(ofType:).
  override class var autosavesInPlace: Bool { false }

  /// Posted after an edit, an undo or redo, or a change of selection or hiding.
  static let didChange = Notification.Name("BMDocumentDidChange")

  /// Runs one edit on the session. An edit that made a new undo step registers it with the
  /// document's undo manager under the session's name for it; a drag that grew its step does not.
  @discardableResult
  func perform(_ edit: () -> bmapp.Changed) -> bmapp.Changed {
    let depth = session.undoDepth(), version = session.version()
    let changed = edit()
    if session.version() != version {
      if session.undoDepth() > depth { registerUndo(redo: false) }
      postChange()
    }
    return changed
  }

  /// Selection or hiding changed: the panes and the viewport follow.
  func postChange() {
    NotificationCenter.default.post(name: Self.didChange, object: self)
  }

  /// Registers the way back from the session's latest step (or forward again, after an undo).
  private func registerUndo(redo: Bool) {
    guard let manager = undoManager else { return }
    manager.registerUndo(withTarget: self) { document in
      MainActor.assumeIsolated { redo ? document.redoStep() : document.undoStep() }
    }
    manager.setActionName(String(redo ? session.redoName() : session.undoName()))
  }

  private func undoStep() {
    session.endGesture()
    _ = session.undo()
    registerUndo(redo: true)
    postChange()
  }

  private func redoStep() {
    _ = session.redo()
    registerUndo(redo: false)
    postChange()
  }

  override func makeWindowControllers() {
    addWindowController(WindowController(document: self))
  }

  /// Loads `url` into this document. Throws a sentence fit to show.
  func load(_ url: URL) throws {
    let r = session.open(std.string(url.path))
    guard r.ok else {
      throw NSError(domain: NSCocoaErrorDomain, code: NSFileReadCorruptFileError,
                    userInfo: [NSLocalizedDescriptionKey: "“\(url.lastPathComponent)” could not be opened.",
                               NSLocalizedRecoverySuggestionErrorKey: String(r.error)])
    }
    warnings = String(r.warnings)
  }

  override func read(from url: URL, ofType typeName: String) throws {
    try load(url)
  }

  override func data(ofType typeName: String) throws -> Data {
    // Saving arrives with the project writer (phase 8, Task 12).
    throw NSError(domain: NSCocoaErrorDomain, code: NSFeatureUnsupportedError,
                  userInfo: [NSLocalizedDescriptionKey: "This version cannot save projects yet."])
  }
}
