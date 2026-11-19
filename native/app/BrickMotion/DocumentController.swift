// Opens projects as documents, and every other model type as a new, untitled project, the way
// Keynote opens a PowerPoint file: the source file is never written over.
import AppKit
import BMApp

final class DocumentController: NSDocumentController {
  static let projectType = "com.brickmotion.project"

  override func openDocument(withContentsOf url: URL, display displayDocument: Bool,
                             completionHandler: @escaping (NSDocument?, Bool, (any Error)?) -> Void) {
    if bmapp.isProjectExtension(std.string(url.pathExtension)) {
      super.openDocument(withContentsOf: url, display: displayDocument, completionHandler: completionHandler)
      return
    }
    do {
      guard let document = try makeUntitledDocument(ofType: Self.projectType) as? Document else {
        completionHandler(nil, false, nil)
        return
      }
      try document.load(url)
      document.displayName = String(document.session.title())
      document.updateChangeCount(.changeDone)
      addDocument(document)
      noteNewRecentDocumentURL(url)
      // An import is always something the person asked to see; AppKit may pass display = false
      // while launching, expecting the document to show itself.
      document.makeWindowControllers()
      document.showWindows()
      completionHandler(document, false, nil)
    } catch {
      completionHandler(nil, false, error)
    }
  }

  override var defaultType: String? { Self.projectType }

  /// Errors shown to the person also go to stderr, so a run from the command line says why.
  override func willPresentError(_ error: any Error) -> any Error {
    FileHandle.standardError.write("BrickMotion: \(error.localizedDescription) \((error as NSError).localizedRecoverySuggestion ?? "")\n".data(using: .utf8)!)
    return super.willPresentError(error)
  }
}
