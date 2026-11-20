// Opens projects as documents, and every other model type as a new, untitled project, the way
// Keynote opens a PowerPoint file: the source file is never written over.
import AppKit
import BMApp

final class DocumentController: NSDocumentController {
  nonisolated static let projectType = "com.brickmotion.project"
  static let importProgress = Notification.Name("BMDocumentImportProgress")
  private(set) var importing: Set<URL> = []
  private typealias OpenCompletion = (NSDocument?, Bool, (any Error)?) -> Void
  private var openWaiters: [URL: [OpenCompletion]] = [:]

  override func makeUntitledDocument(ofType typeName: String) throws -> NSDocument {
    let document = try super.makeUntitledDocument(ofType: typeName)
    if let document = document as? Document { try document.prepareBlank() }
    return document
  }

  override func openDocument(withContentsOf url: URL, display displayDocument: Bool,
                             completionHandler: @escaping (NSDocument?, Bool, (any Error)?) -> Void) {
    let project = bmapp.isProjectExtension(std.string(url.pathExtension))
    if project && document(for: url) != nil {
      super.openDocument(withContentsOf: url, display: displayDocument, completionHandler: completionHandler)
      return
    }
    if !importing.insert(url).inserted {
      openWaiters[url, default: []].append(completionHandler)
      return
    }
    NotificationCenter.default.post(name: Self.importProgress, object: self)
    Task { @MainActor in
      var opened: Document?
      var failure: (any Error)?
      var alreadyOpen = false
      defer {
        if project { Document.discardPreload(url) }
        importing.remove(url)
        let waiters = openWaiters.removeValue(forKey: url) ?? []
        NotificationCenter.default.post(name: Self.importProgress, object: self)
        completionHandler(opened, alreadyOpen, failure)
        for finish in waiters { finish(opened, opened != nil, failure) }
      }
      do {
        if project {
          try await Document.preload(url)
          let (document, existed) = try await openProject(url, display: displayDocument)
          opened = document as? Document
          alreadyOpen = existed
          return
        }
        guard let document = try prepareImportDocument() else { return }
        try await document.loadImport(url)
        document.displayName = String(document.session.title())
        document.updateChangeCount(.changeDone)
        addDocument(document)
        noteNewRecentDocumentURL(url)
        // An import is always visible when Finder or the user asks to open it.
        document.makeWindowControllers()
        document.showWindows()
        opened = document
      } catch {
        failure = error
      }
    }
  }

  private func openProject(_ url: URL, display: Bool) async throws -> (NSDocument?, Bool) {
    try await withCheckedThrowingContinuation { continuation in
      super.openDocument(withContentsOf: url, display: display) { document, existing, error in
        if let error { continuation.resume(throwing: error) }
        else { continuation.resume(returning: (document, existing)) }
      }
    }
  }

  private func prepareImportDocument() throws -> Document? {
    try super.makeUntitledDocument(ofType: Self.projectType) as? Document
  }

  override var defaultType: String? { Self.projectType }

  /// Errors shown to the person also go to stderr, so a run from the command line says why.
  override func willPresentError(_ error: any Error) -> any Error {
    FileHandle.standardError.write("BrickMotion: \(error.localizedDescription) \((error as NSError).localizedRecoverySuggestion ?? "")\n".data(using: .utf8)!)
    return super.willPresentError(error)
  }
}
