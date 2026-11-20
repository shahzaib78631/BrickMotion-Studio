import SwiftUI

struct RecentProjectRow: View {
  let url: URL
  @Environment(\.colorScheme) private var appearance
  @State private var thumbnail: CGImage?

  var body: some View {
    HStack(spacing: 11) {
      Rectangle()
        .fill(.quaternary.opacity(0.6))
        .frame(width: 68, height: 44)
        .overlay {
          if let thumbnail {
            Image(decorative: thumbnail, scale: 2).resizable().scaledToFill()
          } else {
            Image(systemName: "cube").foregroundStyle(.tertiary)
          }
        }
        .clipShape(.rect(cornerRadius: 7))
        .accessibilityHidden(true)
      VStack(alignment: .leading, spacing: 3) {
        Text(url.deletingPathExtension().lastPathComponent)
          .font(.callout.weight(.semibold))
          .lineLimit(1)
        Text(location)
          .font(.caption)
          .foregroundStyle(.secondary)
          .lineLimit(1)
          .truncationMode(.middle)
      }
      Spacer(minLength: 0)
    }
    .padding(.vertical, 3)
    .contentShape(.rect)
    .accessibilityElement(children: .combine)
    .help(url.path)
    .task(id: appearance) {
      let image = await ProjectPreviewCache.shared.image(for: url, dark: appearance == .dark)
      if !Task.isCancelled { thumbnail = image }
    }
  }

  private var location: String {
    url.deletingLastPathComponent().path.replacingOccurrences(of: NSHomeDirectory(), with: "~", options: .anchored)
  }
}
