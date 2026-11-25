import CoreGraphics

/// Where a part dropped on the Parts lane goes; bmapp's `arrivalTarget` works it out.
struct TimelineArrivalTarget: Equatable {
  let step, before: Int
  let x: CGFloat
}
