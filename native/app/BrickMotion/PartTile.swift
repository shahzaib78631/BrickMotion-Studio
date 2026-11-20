import SwiftUI

struct PartTile: View {
  let part: LibraryPart
  let selected: Bool
  let colour: Int32
  let choose: () -> Void

  @FocusState private var focused: Bool
  @State private var hovered = false

  var body: some View {
    Button(action: choose) {
      VStack(alignment: .leading, spacing: 0) {
        PartPreviewImage(part: part.id, color: colour)
        VStack(alignment: .leading, spacing: 1) {
          Text(part.name)
            .font(.caption.weight(.medium))
            .lineLimit(1)
          Text(part.number)
            .font(.caption2.monospacedDigit())
            .foregroundStyle(.secondary)
            .lineLimit(1)
        }
        .padding(.horizontal, 7)
        .padding(.vertical, 6)
        .frame(maxWidth: .infinity, alignment: .leading)
      }
      .background(selected ? Color.accentColor.opacity(0.16) : Color.primary.opacity(hovered ? 0.08 : 0.045))
      .clipShape(.rect(cornerRadius: 9))
      .overlay {
        RoundedRectangle(cornerRadius: 9)
          .strokeBorder(selected || focused ? Color.accentColor : Color.primary.opacity(hovered ? 0.24 : 0.10),
                        lineWidth: selected || focused ? 2 : 1)
          .allowsHitTesting(false)
      }
      .contentShape(.rect(cornerRadius: 9))
    }
    .buttonStyle(.plain)
    .focused($focused)
    .onHover { hovered = $0 }
    .help("\(part.name) · \(part.number)")
    .accessibilityLabel("\(part.name), part \(part.number)")
    .accessibilityHint("Begins placing this part")
    .accessibilityAddTraits(selected ? .isSelected : [])
  }
}
