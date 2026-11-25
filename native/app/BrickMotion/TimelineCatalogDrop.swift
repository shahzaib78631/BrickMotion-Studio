import SwiftUI

struct TimelineCatalogDrop: DropDelegate {
  let target: (CGFloat) -> TimelineArrivalTarget?
  let highlight: (TimelineArrivalTarget?) -> Void
  let place: ([NSItemProvider], TimelineArrivalTarget) -> Bool

  func dropEntered(info: DropInfo) { highlight(target(info.location.x)) }

  func dropUpdated(info: DropInfo) -> DropProposal? {
    let insertion = target(info.location.x)
    highlight(insertion)
    return DropProposal(operation: insertion == nil ? .forbidden : .copy)
  }

  func dropExited(info: DropInfo) { highlight(nil) }

  func performDrop(info: DropInfo) -> Bool {
    defer { highlight(nil) }
    guard let insertion = target(info.location.x) else { return false }
    return place(info.itemProviders(for: [PartDragItem.type.rawValue]), insertion)
  }
}
