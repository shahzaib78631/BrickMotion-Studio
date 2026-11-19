// One open model. Imports (LDraw, Studio, plans) arrive here as new, untitled projects.
import AppKit
import BMApp
import UniformTypeIdentifiers

@objc(BMDocument)
final class Document: NSDocument {
  let session = bmapp.Session.create()!
  /// What opening found but could still load (missing parts, loops, unknown colours).
  private(set) var warnings = ""

  /// Saves as the person works, and keeps the versions Browse All Versions lists.
  override class var autosavesInPlace: Bool { true }
  override class var preservesVersions: Bool { true }
  /// Only the project is written; imports are never written over.
  override class var writableTypes: [String] { [DocumentController.projectType] }

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

  /// Opening, and on a live document Revert, a version from Browse All Versions, or a reload
  /// after the file changed: the session starts afresh (its viewports follow it), so the undo
  /// steps of what was there go too.
  override func read(from url: URL, ofType typeName: String) throws {
    if typeName == DocumentController.projectType {
      let bytes = try Data(contentsOf: url)
      let r = session.openBytes(std.string(String(decoding: bytes, as: UTF8.self)), std.string(url.path))
      guard r.ok else {
        throw NSError(domain: NSCocoaErrorDomain, code: NSFileReadCorruptFileError,
                      userInfo: [NSLocalizedDescriptionKey: "“\(url.lastPathComponent)” could not be opened.",
                                 NSLocalizedRecoverySuggestionErrorKey: String(r.error)])
      }
      warnings = String(r.warnings)
    } else {
      try load(url)
    }
    undoManager?.removeAllActions()
    postChange()
  }

  override func data(ofType typeName: String) throws -> Data {
    Data(String(session.projectBytes()).utf8)
  }

  /// After a save that makes the file current, the session's edits are its saved state.
  override func updateChangeCount(withToken changeCountToken: Any, for saveOperation: NSDocument.SaveOperationType) {
    super.updateChangeCount(withToken: changeCountToken, for: saveOperation)
    if saveOperation != .autosaveElsewhereOperation && saveOperation != .autosaveAsOperation { session.markSaved() }
  }

  // MARK: Export

  @objc func exportLDraw(_ sender: Any?) {
    let panel = NSSavePanel()
    panel.allowedContentTypes = [UTType(filenameExtension: "mpd") ?? .plainText]
    panel.nameFieldStringValue = (displayName as NSString).deletingPathExtension + ".mpd"
    panel.message = "Export the model as an LDraw MPD, with its submodels and steps."
    let write: (URL) -> Void = { [weak self] url in
      guard let self else { return }
      do {
        try self.exportLDraw(to: url)
      } catch {
        self.presentError(error)
      }
    }
    if let window = windowControllers.first?.window {
      panel.beginSheetModal(for: window) { if $0 == .OK, let url = panel.url { write(url) } }
    } else if panel.runModal() == .OK, let url = panel.url {
      write(url)
    }
  }

  func exportLDraw(to url: URL) throws {
    try Data(String(session.mpdBytes()).utf8).write(to: url, options: .atomic)
  }
}
