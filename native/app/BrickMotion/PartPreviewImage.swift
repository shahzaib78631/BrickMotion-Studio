import SwiftUI

struct PartPreviewImage: View {
  let part: String?
  var color: Int32 = 71

  @Environment(\.colorScheme) private var scheme
  @State private var loaded: (request: PartPreviewCache.Request, image: CGImage?)?

  private var request: PartPreviewCache.Request? {
    part.map { .init(part: $0, color: color, dark: scheme == .dark) }
  }

  var body: some View {
    Rectangle()
      .fill(.quaternary.opacity(0.5))
      .aspectRatio(1, contentMode: .fit)
      .overlay {
        if let request, request == loaded?.request, let preview = loaded?.image {
          Image(decorative: preview, scale: 1).resizable().scaledToFit()
        } else if request == nil || loaded?.request == request {
          Image(systemName: "cube").foregroundStyle(.tertiary)
        }
      }
      .accessibilityHidden(true)
      .task(id: request) {
        guard let requested = request else { return }
        let image = await PartPreviewCache.shared.image(for: requested)
        guard !Task.isCancelled else { return }
        loaded = (requested, image)
      }
  }
}
