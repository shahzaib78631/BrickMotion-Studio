import SwiftUI

struct PlacementHUD: View {
  let controller: PlacementController

  var body: some View {
    if let part = controller.part {
      VStack(alignment: .leading, spacing: 8) {
        HStack(spacing: 10) {
          statusIcon
            .frame(width: 20)
            .accessibilityHidden(true)
          VStack(alignment: .leading, spacing: 2) {
            Text(part.name)
              .font(.callout.weight(.semibold))
              .lineLimit(1)
            Text(status)
              .font(.caption)
              .foregroundStyle(.secondary)
              .lineLimit(2)
          }
          .frame(maxWidth: .infinity, alignment: .leading)
          Button(controller.isMoving ? "Move" : "Place") { controller.accept() }
            .buttonStyle(.borderedProminent)
            .disabled(!controller.canPlace || controller.awaitingCommit)
            .help(controller.isMoving ? "Move selection (Return)" : "Place part (Return)")
          Button { controller.cancel() } label: {
            Image(systemName: "xmark").font(.system(size: 11, weight: .semibold))
          }
          .buttonStyle(.borderless)
          .help("Cancel placement (Escape)")
          .accessibilityLabel("Cancel placement")
        }
        HStack(spacing: 10) {
          if controller.gripCount > 1 { shortcut("⇥", "Grip", "Tab cycles grips") }
          shortcut("R", "Turn", "R turns a quarter turn")
          shortcut("⌥", "Bypass snap", "Option bypasses snapping")
        }
        .foregroundStyle(.secondary)
        .font(.caption2)
        .padding(.leading, 30)
      }
      .padding(.horizontal, 12)
      .padding(.vertical, 10)
      .frame(minWidth: 280, idealWidth: 380, maxWidth: 400)
      .glassEffect(.regular, in: .rect(cornerRadius: 16))
      .overlay {
        RoundedRectangle(cornerRadius: 16)
          .strokeBorder(.primary.opacity(0.12), lineWidth: 0.5)
          .allowsHitTesting(false)
      }
      .fixedSize(horizontal: false, vertical: true)
      .accessibilityHint("Use arrow keys to move the placement preview")
    }
  }

  private var status: String {
    if controller.awaitingCommit { return "Checking placement…" }
    if controller.canPlace && !controller.checksCollisions { return "Collision checks off" }
    switch controller.state {
    case .Preparing: return "Preparing placement…"
    case .Snapped: return "Aligned to connector"
    case .Reference: return "LDraw placement example"
    case .Free: return controller.snap ? "Free placement" : "Snap bypassed"
    case .Blocked, .Unavailable: return controller.reason
    default: return ""
    }
  }

  @ViewBuilder private var statusIcon: some View {
    switch controller.state {
    case .Preparing:
      ProgressView().controlSize(.small)
    case .Snapped:
      Image(systemName: "link").foregroundStyle(Color.accentColor)
    case .Reference:
      Image(systemName: "doc.text.magnifyingglass").foregroundStyle(Color.accentColor)
    case .Blocked, .Unavailable:
      Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.red)
    default:
      Image(systemName: "cube").foregroundStyle(.secondary)
    }
  }

  private func shortcut(_ key: String, _ label: String, _ spoken: String) -> some View {
    HStack(spacing: 4) {
      Text(key).fontWeight(.semibold)
      Text(label)
    }
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(spoken)
  }
}
