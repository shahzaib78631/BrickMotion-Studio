import BMApp

struct LibraryPart: Codable, Identifiable, Sendable {
  let id: String
  let name: String
  let category: String

  init(_ part: bmapp.PartMatch) {
    id = String(part.name)
    name = String(part.description)
    category = String(part.category)
  }

  var number: String { String(id.dropLast(4)) }
}
