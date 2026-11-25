import BMApp
import SwiftUI

/// The trailing handle edits a sequence segment. The same handle can sit on the
/// leading edge of its neighbour when that side is easier to reach.
struct TimelineSequenceTrim: View {
  let title: String
  let value: Double
  let leading: Bool
  let width: CGFloat
  let change: (CGFloat) -> Void
  let commit: () -> Void
  let adjust: (Double) -> Void

  var body: some View {
    Color.clear
      .overlay(alignment: leading ? .leading : .trailing) {
        Capsule()
          .fill(.secondary.opacity(0.72))
          .frame(width: 2, height: 12)
          .padding(.horizontal, min(3, max(0, width - 2)))
      }
      .frame(width: width, height: 20)
      .contentShape(.rect)
      .gesture(DragGesture(minimumDistance: 2, coordinateSpace: .global)
        .onChanged { change($0.translation.width) }
        .onEnded { _ in commit() })
      .help("Drag to resize \(title)")
      .accessibilityElement(children: .ignore)
      .accessibilityLabel("\(title) Duration")
      .accessibilityValue("\(value.formatted(.number.precision(.fractionLength(1)))) seconds")
      .accessibilityAdjustableAction { direction in
        if direction == .increment { adjust(0.1) }
        if direction == .decrement { adjust(-0.1) }
      }
      .focusable()
      .onKeyPress(.leftArrow) { adjust(-0.1); return .handled }
      .onKeyPress(.rightArrow) { adjust(0.1); return .handled }
  }
}
