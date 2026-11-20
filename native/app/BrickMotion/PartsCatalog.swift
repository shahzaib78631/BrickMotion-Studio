import BMApp

actor PartsCatalog {
  static let shared = PartsCatalog()

  struct Library: Sendable {
    let directory: String
    let common: [LibraryPart]
  }

  private var loaded: Library?
  private var categoryCache: [String: [String]] = [:]

  func library() -> Library {
    if let loaded { return loaded }
    let directory = bmapp.Session.ldrawDirectory()
    let common = bmapp.commonParts(directory).map(LibraryPart.init)
    let library = Library(directory: String(directory), common: common)
    if !library.directory.isEmpty { loaded = library }
    return library
  }

  func categories(in directory: String) -> [String] {
    if let cached = categoryCache[directory] { return cached }
    let categories = bmapp.partCategories(std.string(directory)).map { String($0) }
    if !categories.isEmpty { categoryCache[directory] = categories }
    return categories
  }

  func search(in directory: String, query: String, category: String?, limit: Int) -> [LibraryPart] {
    guard !Task.isCancelled else { return [] }
    return bmapp.libraryParts(std.string(directory), std.string(query), std.string(category ?? ""), limit)
      .map(LibraryPart.init)
  }
}
