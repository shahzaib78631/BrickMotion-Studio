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
