import CoreGraphics

struct TimelineArrivalTarget: Equatable {
  let step, before: Int
  let x: CGFloat

  static func inRun(_ run: AnimationWorkspace.Run, at time: Double, scale: TimelineScale,
                    flights: [AnimationWorkspace.Flight], excluding: Set<UInt32>, itemCount: Int,
                    itemIndex: (UInt32) -> Int?) -> TimelineArrivalTarget {
    var lastInRun: Int?
    for flight in flights where flight.start >= run.start && flight.start <= run.end {
      guard !excluding.contains(flight.id), let item = itemIndex(flight.id) else { continue }
      if flight.start >= time {
        return TimelineArrivalTarget(step: run.step, before: item, x: scale.x(flight.start))
      }
      lastInRun = item
    }
    let before = lastInRun.map { min(itemCount, $0 + 1) } ?? itemCount
    return TimelineArrivalTarget(step: run.step, before: before, x: scale.x(run.end))
  }
}
