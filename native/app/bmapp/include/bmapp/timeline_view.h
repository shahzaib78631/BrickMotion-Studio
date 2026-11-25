#pragma once
// Zoom and scroll maths of a timeline track area. The shell keeps the scroll plumbing
// (when to scroll its view, scrubbing, following the playhead); this keeps the numbers.

namespace bmapp {

struct TimelineView {
  static constexpr double kMaximumZoom = 64;
  static double maximumZoom() { return kMaximumZoom; }

  double zoom = 1, offset = 0, viewportWidth = 1;
  double leadInset = 12, trailInset = 12;

  /// The width the timeline's duration spans at this zoom.
  double logicalWidth() const;
  /// The scrollable width: the logical width plus both insets.
  double contentWidth() const;
  double maximumOffset() const;
  /// The visible part of the timeline, 0…1.
  double visibleStart() const;
  double visibleEnd() const;

  /// A time's x along the logical width (before the lead inset).
  double x(double time, double duration) const;
  /// The time under a point of the visible area (0…viewportWidth).
  double timeAt(double screenX, double duration) const;

  /// Each mutator returns true when the zoom or the offset changed.
  bool magnify(double factor, double screenX);
  /// Zooms around the playhead when it is visible, else around the middle.
  bool zoomBy(double factor, double playhead, double duration);
  bool fit();
  /// Scrolls so `time` is in view: centred, or only once it passes a margin near an edge.
  bool reveal(double time, double duration, bool centred);
  /// Scrolls when a drag is near an edge, faster nearer it (2…28 a call).
  bool panAtEdge(double screenX);

 private:
  double clamp(double offset) const;
  bool scrollTo(double requested);
};

/// The ruler's tick interval (1, 2 or 5 × a power of ten) keeping labels 76 px apart.
double tickInterval(double duration, double width);

}  // namespace bmapp
