import SwiftUI

/// Keeps a clip’s name visible while its leading edge is scrolled offscreen.
struct TimelineClipLabel<Content: View>: View {
  let navigation: TimelineNavigation
  let start, width: CGFloat
  var centered = false
  @ViewBuilder let content: () -> Content

  var body: some View {
    let leading = navigation.offset - TimelineNavigation.inset
    let trailing = leading + navigation.viewportWidth
    let first = min(width, max(0, leading - start))
    let last = min(width, max(0, trailing - start))
    let visible = max(0, last - first)
    content()
      .frame(width: visible, alignment: centered && first == 0 && last == width ? .center : .leading)
      .lineLimit(1)
      .clipped()
      .offset(x: first)
      .frame(width: width, alignment: .leading)
      .allowsHitTesting(false)
  }
}
