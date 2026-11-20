import Foundation
import Observation

@MainActor @Observable final class PartsHistory {
  static let shared = PartsHistory()

  private struct Entry: Codable {
    let part: LibraryPart
    var count: Int
  }

  @ObservationIgnored private let defaults: UserDefaults
  private let key = "placedParts"
  private var entries: [Entry]

  init(defaults: UserDefaults = .standard) {
    self.defaults = defaults
    entries = defaults.data(forKey: key).flatMap { try? JSONDecoder().decode([Entry].self, from: $0) } ?? []
  }

  var recent: [LibraryPart] { entries.prefix(8).map(\.part) }
  var frequent: [LibraryPart] {
    entries.enumerated().filter { $0.element.count > 1 }.sorted {
      if $0.element.count != $1.element.count { return $0.element.count > $1.element.count }
      return $0.offset < $1.offset
    }.prefix(8).map(\.element.part)
  }

  func record(_ part: LibraryPart) {
    let previous = entries.first(where: { $0.part.id == part.id })?.count ?? 0
    entries.removeAll { $0.part.id == part.id }
    entries.insert(Entry(part: part, count: min(previous, 10_000) + 1), at: 0)
    if entries.count > 96 { entries.removeLast(entries.count - 96) }
    defaults.set(try? JSONEncoder().encode(entries), forKey: key)
  }
}
