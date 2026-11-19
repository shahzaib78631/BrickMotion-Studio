// The colour picker: the library's colours as swatches, grouped Solid, Transparent and Metallic,
// with a search by name or code and the last eight used on top. A click recolours the selection.
import AppKit
import BMApp
import Observation
import SwiftUI

@MainActor @Observable final class ColorSwatchesModel {
  @ObservationIgnored let model: DocumentModel
  @ObservationIgnored private let defaults: UserDefaults
  static let recentKey = "recentColors"
  private(set) var recent: [Int32]
  var query = ""
  @ObservationIgnored let all: [bmapp.ColorInfo]

  init(model: DocumentModel, defaults: UserDefaults = .standard) {
    self.model = model
    self.defaults = defaults
    all = Array(model.document.session.colors())
    recent = (defaults.array(forKey: Self.recentKey) as? [Int] ?? []).map(Int32.init)
  }

  /// Recolours the selection and puts the colour first in Recent.
  func choose(_ code: Int32) {
    let pieces = Array(model.snapshot.selection)
    guard !pieces.isEmpty else { return NSSound.beep() }
    model.context.perform { $0.recolor(ViewportView.list(pieces), code) }
    recent = Array(([code] + recent.filter { $0 != code }).prefix(8))
    defaults.set(recent.map(Int.init), forKey: Self.recentKey)
  }

  func info(_ code: Int32) -> bmapp.ColorInfo? { model.colors[code] }

  /// The colours matching the search, by group: (title, colours).
  var groups: [(String, [bmapp.ColorInfo])] {
    let q = query.trimmingCharacters(in: .whitespaces).lowercased()
    let shown = q.isEmpty ? all : all.filter { String($0.name).lowercased().contains(q) || String($0.code) == q }
    let titles = ["Solid", "Transparent", "Metallic", "Other"]
    return titles.indices.compactMap { g in
      let colors = shown.filter { Int($0.group) == g }
      return colors.isEmpty ? nil : (titles[g], colors)
    }
  }

  /// The colour every selected piece shares, if they share one.
  var current: Int32? {
    let colors = Set(model.snapshot.selected.map { $0.color })
    return colors.count == 1 ? colors.first : nil
  }
}

/// One colour as a small rounded square: a checkerboard behind a transparent one, a sheen on a
/// metallic one.
struct Swatch: View {
  let info: bmapp.ColorInfo
  var size: CGFloat = 22
  var selected = false

  var body: some View {
    let rgb = info.rgb
    let color = Color(.sRGB, red: Double(rgb >> 16 & 0xff) / 255, green: Double(rgb >> 8 & 0xff) / 255,
                      blue: Double(rgb & 0xff) / 255, opacity: Double(info.alpha))
    let shape = RoundedRectangle(cornerRadius: size * 0.22, style: .continuous)
    ZStack {
      if info.group == 1 { Checkerboard().clipShape(shape) }
      shape.fill(color)
      if info.group == 2 {
        shape.fill(LinearGradient(colors: [.white.opacity(0.55), .clear, .white.opacity(0.25)],
                                  startPoint: .topLeading, endPoint: .bottomTrailing))
      }
      shape.strokeBorder(.primary.opacity(0.18), lineWidth: 0.5)
    }
    .frame(width: size, height: size)
    .overlay {
      if selected { shape.inset(by: -3).strokeBorder(Color.accentColor, lineWidth: 2) }
    }
    .help("\(String(info.name)) (\(info.code))")
    .accessibilityElement()
    .accessibilityLabel(String(info.name))
    .accessibilityAddTraits(selected ? [.isButton, .isSelected] : .isButton)
  }
}

private struct Checkerboard: View {
  var body: some View {
    Canvas { context, size in
      let cell: CGFloat = 4
      for row in 0..<Int(size.height / cell + 1) {
        for col in 0..<Int(size.width / cell + 1) where (row + col) % 2 == 0 {
          context.fill(Path(CGRect(x: CGFloat(col) * cell, y: CGFloat(row) * cell, width: cell, height: cell)), with: .color(.gray.opacity(0.35)))
        }
      }
    }
    .background(.white)
  }
}

/// The whole picker, for a popover.
struct ColorSwatches: View {
  @State var swatches: ColorSwatchesModel
  private let columns = [GridItem(.adaptive(minimum: 24, maximum: 24), spacing: 6)]

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      TextField("Search colours", text: $swatches.query, prompt: Text("Name or code"))
        .textFieldStyle(.roundedBorder)
      ScrollView {
        VStack(alignment: .leading, spacing: 12) {
          let recent = swatches.recent.compactMap { swatches.info($0) }
          if !recent.isEmpty && swatches.query.isEmpty { group("Recent", recent) }
          ForEach(swatches.groups, id: \.0) { title, colors in group(title, colors) }
          if swatches.groups.isEmpty {
            Text("No colour matches “\(swatches.query)”.").foregroundStyle(.secondary).frame(maxWidth: .infinity)
          }
        }
        .padding(.bottom, 4)
      }
    }
    .padding(12)
    .frame(width: 300, height: 380)
  }

  private func group(_ title: String, _ colors: [bmapp.ColorInfo]) -> some View {
    VStack(alignment: .leading, spacing: 6) {
      Text(title).font(.caption.weight(.semibold)).foregroundStyle(.secondary)
      LazyVGrid(columns: columns, alignment: .leading, spacing: 6) {
        ForEach(colors, id: \.code) { c in
          Button { swatches.choose(c.code) } label: { Swatch(info: c, selected: swatches.current == c.code) }
            .buttonStyle(.plain)
        }
      }
    }
  }
}
