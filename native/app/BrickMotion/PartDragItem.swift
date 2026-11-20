import AppKit

struct PartDragItem: Codable, Sendable {
  static let type = NSPasteboard.PasteboardType("com.brickmotion.library-part")
  let part: LibraryPart
  let colour: Int32
  let turns: Int
  let mirrored: Bool
  let reference: Bool

  @MainActor func provider() -> NSItemProvider {
    let provider = NSItemProvider()
    provider.suggestedName = part.name
    let data = try? JSONEncoder().encode(self)
    provider.registerDataRepresentation(forTypeIdentifier: Self.type.rawValue, visibility: .ownProcess) { done in
      done(data, nil)
      return nil
    }
    return provider
  }

  @MainActor static func read(_ pasteboard: NSPasteboard) -> PartDragItem? {
    guard let data = pasteboard.data(forType: type), data.count <= 16_384 else { return nil }
    return try? JSONDecoder().decode(Self.self, from: data)
  }
}
