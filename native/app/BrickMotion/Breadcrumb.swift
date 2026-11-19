// Where the editing is: `Main ▸ Rotor ▸ Blade`, a glass capsule over the viewport's top left.
// Each part focuses there. Hidden while the whole model is shown.
import BMApp
import SwiftUI

struct Breadcrumb: View {
  let model: DocumentModel

  var body: some View {
    let path = model.focusPath
    if !path.isEmpty {
      HStack(spacing: 6) {
        crumb(String(model.document.session.title()), depth: 0, current: false)
        ForEach(Array(path.enumerated()), id: \.offset) { i, name in
          Image(systemName: "chevron.forward")
            .font(.caption2.weight(.semibold))
            .foregroundStyle(.tertiary)
          crumb(displayName(name), depth: i + 1, current: i == path.count - 1)
        }
      }
      .padding(.horizontal, 14)
      .padding(.vertical, 7)
      .glassEffect(.regular, in: .capsule)
      .accessibilityElement(children: .contain)
      .accessibilityLabel("Editing path")
    }
  }

  private func crumb(_ name: String, depth: Int, current: Bool) -> some View {
    Button(name) { model.focus(depth: depth) }
      .buttonStyle(.plain)
      .font(.callout.weight(current ? .semibold : .regular))
      .foregroundStyle(current ? .primary : .secondary)
      .disabled(current)
      .help(current ? "Editing \(name)" : depth == 0 ? "Back to the whole model" : "Edit \(name)")
  }
}
