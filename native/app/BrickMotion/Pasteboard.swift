// Pieces on the general pasteboard: LDraw text (type-1 lines, world placements), which other
// LDraw tools and text editors read too.
import AppKit

enum Pasteboard {
  static func write(_ ldraw: String) {
    let board = NSPasteboard.general
    board.clearContents()
    board.setString(ldraw, forType: .string)  // public.utf8-plain-text
  }

  /// The pasteboard's text, when it holds at least one LDraw part line.
  static func read() -> String? {
    guard let text = NSPasteboard.general.string(forType: .string), holdsParts(text) else { return nil }
    return text
  }

  static var canPaste: Bool { read() != nil }

  /// True when some line is a type-1 line: "1 <colour> x y z a b c d e f g h i <file>".
  static func holdsParts(_ text: String) -> Bool {
    text.split(whereSeparator: \.isNewline).contains { line in
      let fields = line.split(whereSeparator: \.isWhitespace)
      return fields.count >= 15 && fields[0] == "1"
    }
  }
}
