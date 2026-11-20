// One open model. Imports (LDraw, Studio, plans) arrive here as new, untitled projects.
import AppKit
import BMApp
import UniformTypeIdentifiers

@objc(BMDocument)
final class Document: NSDocument {
  let session = bmapp.Session.create()!
  private struct Preview {
    let version, generation: UInt64
    let png: String
  }
  private var preview: Preview?
  private var previewLoading: (generation: UInt64, version: UInt64)?
  private var previewTask: Task<Void, Never>?
  /// What opening found but could still load (missing parts, loops, unknown colours).
  private(set) var warnings = ""

  /// Saves as the person works, and keeps the versions Browse All Versions lists.
  nonisolated override class var autosavesInPlace: Bool { true }
  nonisolated override class var preservesVersions: Bool { true }
  /// Only the project is written; imports are never written over.
  nonisolated override class var writableTypes: [String] { [DocumentController.projectType] }
  @MainActor private static var preloaded: [URL: LoadedProject] = [:]

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
    Task { @MainActor [weak self] in self?.refreshPreview() }
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
    Task { @MainActor [weak self] in self?.refreshPreview() }
  }

  @MainActor private func refreshPreview() {
    guard NSApp.activationPolicy() == .regular, !windowControllers.isEmpty, session.pieceCount() > 0 else { return }
    let generation = session.generation(), version = session.version()
    if preview?.generation == generation && preview?.version == version { return }
    if previewLoading?.generation == generation && previewLoading?.version == version { return }
    previewLoading = (generation, version)
    previewTask?.cancel()
    previewTask = Task { [weak self] in
      try? await Task.sleep(for: .milliseconds(650))
      guard !Task.isCancelled, let self,
            session.generation() == generation, session.version() == version else { return }
      let project = Data(String(session.projectBytes()).utf8)
      let png = await ProjectPreviewCache.shared.thumbnailPNG(for: project)
      guard !Task.isCancelled, session.generation() == generation, session.version() == version else { return }
      previewLoading = nil
      preview = png.map { Preview(version: version, generation: generation, png: $0.base64EncodedString()) }
    }
  }

  func prepareBlank() throws {
    let result = session.newBlank()
    guard result.ok else {
      throw NSError(domain: NSCocoaErrorDomain, code: NSFileNoSuchFileError,
                    userInfo: [NSLocalizedDescriptionKey: "A new project could not be created.",
                               NSLocalizedRecoverySuggestionErrorKey: String(result.error)])
    }
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

  /// Only used before AppKit installs this document in the editor.
  @MainActor func loadImport(_ url: URL) async throws {
    let job = ImportLoad(session)
    let result = await Task.detached(priority: .userInitiated) { job.open(url) }.value
    guard result.error.isEmpty else {
      throw NSError(domain: NSCocoaErrorDomain, code: NSFileReadCorruptFileError,
                    userInfo: [NSLocalizedDescriptionKey: "“\(url.lastPathComponent)” could not be opened.",
                               NSLocalizedRecoverySuggestionErrorKey: result.error])
    }
    warnings = result.warnings
  }

  /// Opening, and on a live document Revert, a version from Browse All Versions, or a reload
  /// after the file changed: the session starts afresh (its viewports follow it), so the undo
  /// steps of what was there go too.
  nonisolated override func read(from url: URL, ofType typeName: String) throws {
    if Thread.isMainThread {
      try MainActor.assumeIsolated { try install(url, typeName: typeName) }
    } else {
      try DispatchQueue.main.sync { try install(url, typeName: typeName) }
    }
  }

  private func install(_ url: URL, typeName: String) throws {
    if typeName == DocumentController.projectType {
      let loaded: LoadedProject
      if let prepared = Self.preloaded.removeValue(forKey: url.standardizedFileURL), prepared.isCurrent(at: url) { loaded = prepared }
      else { loaded = try LoadedProject(url) }
      session.adoptLoadedSession(loaded.loader.session)
      warnings = loaded.warnings
    } else {
      try load(url)
    }
    undoManager?.removeAllActions()
    postChange()
  }

  /// Prepares the model while AppKit is free to serve the existing windows. AppKit still
  /// creates and registers the document, assigns its file URL and restores its Versions state.
  @MainActor static func preload(_ url: URL) async throws {
    let loaded = try await Task.detached(priority: .userInitiated) { try LoadedProject(url) }.value
    preloaded[url.standardizedFileURL] = loaded
  }

  @MainActor static func discardPreload(_ url: URL) {
    preloaded.removeValue(forKey: url.standardizedFileURL)
  }

  override func data(ofType typeName: String) throws -> Data {
    guard let preview, preview.generation == session.generation(), preview.version == session.version() else {
      return Data(String(session.projectBytesWithPreview(std.string())).utf8)
    }
    return Data(String(session.projectBytesWithPreview(std.string(preview.png))).utf8)
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

  @objc func exportPlan(_ sender: Any?) {
    let panel = NSSavePanel()
    panel.allowedContentTypes = [.json]
    panel.nameFieldStringValue = String(session.title()) + ".plan.json"
    let complete: (NSApplication.ModalResponse) -> Void = { [weak self] response in
      guard let self, response == .OK, let url = panel.url else { return }
      do { try Data(String(session.planBytes()).utf8).write(to: url, options: .atomic) }
      catch { self.presentError(error) }
    }
    if let window = windowControllers.first?.window { panel.beginSheetModal(for: window, completionHandler: complete) }
    else { complete(panel.runModal()) }
  }
}

/// The new session has no window or other observers until this operation returns.
private final class ImportLoad: @unchecked Sendable {
  let session: bmapp.Session
  init(_ session: bmapp.Session) { self.session = session }

  func open(_ url: URL, project: Bool = false) -> (error: String, warnings: String) {
    do {
      let response: bmapp.OpenResult
      if project {
        let bytes = try Data(contentsOf: url, options: .mappedIfSafe)
        response = session.openBytes(std.string(String(decoding: bytes, as: UTF8.self)), std.string(url.path))
      } else {
        response = session.open(std.string(url.path))
      }
      return (response.ok ? "" : String(response.error), String(response.warnings))
    } catch {
      return (error.localizedDescription, "")
    }
  }
}

private struct LoadedProject: Sendable {
  let loader: ImportLoad
  let warnings: String
  private let modification: Date?
  private let fileSize: Int?

  init(_ url: URL) throws {
    let attributes = try url.resourceValues(forKeys: [.contentModificationDateKey, .fileSizeKey])
    modification = attributes.contentModificationDate
    fileSize = attributes.fileSize
    loader = ImportLoad(bmapp.Session.create()!)
    let result = loader.open(url, project: true)
    guard result.error.isEmpty else {
      throw NSError(domain: NSCocoaErrorDomain, code: NSFileReadCorruptFileError,
                    userInfo: [NSLocalizedDescriptionKey: "“\(url.lastPathComponent)” could not be opened.",
                               NSLocalizedRecoverySuggestionErrorKey: result.error])
    }
    warnings = result.warnings
  }

  func isCurrent(at url: URL) -> Bool {
    // Use a fresh URL value. Foundation caches resource values on the value used for the read.
    let current = try? URL(fileURLWithPath: url.path).resourceValues(forKeys: [.contentModificationDateKey, .fileSizeKey])
    return current != nil && current?.contentModificationDate == modification && current?.fileSize == fileSize
  }
}
