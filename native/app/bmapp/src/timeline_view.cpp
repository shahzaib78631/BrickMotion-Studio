#include "bmapp/timeline_view.h"

#include <algorithm>
#include <cmath>

namespace bmapp {

double TimelineView::logicalWidth() const { return std::max(1.0, viewportWidth - leadInset - trailInset) * zoom; }
double TimelineView::contentWidth() const { return logicalWidth() + leadInset + trailInset; }
double TimelineView::maximumOffset() const { return std::max(0.0, contentWidth() - viewportWidth); }
double TimelineView::visibleStart() const { return std::max(0.0, (offset - leadInset) / logicalWidth()); }
double TimelineView::visibleEnd() const { return std::min(1.0, (offset + viewportWidth - leadInset) / logicalWidth()); }

double TimelineView::x(double time, double duration) const {
  return logicalWidth() * time / std::max(duration, 0.001);
}

double TimelineView::timeAt(double screenX, double duration) const {
  const double screen = std::min(viewportWidth, std::max(0.0, screenX));
  const double along = screen + offset - leadInset;
  return duration * std::min(1.0, std::max(0.0, along / std::max(1.0, logicalWidth())));
}

double TimelineView::clamp(double requested) const { return std::min(maximumOffset(), std::max(0.0, requested)); }

bool TimelineView::scrollTo(double requested) {
  const double next = clamp(requested);
  if (std::abs(next - offset) <= 0.25) return false;
  offset = next;
  return true;
}

bool TimelineView::magnify(double factor, double screenX) {
  if (!std::isfinite(factor) || factor <= 0) return false;
  const double target = std::min(kMaximumZoom, std::max(1.0, zoom * factor));
  if (std::abs(target - zoom) <= 0.0001) return false;
  const double anchor = std::min(1.0, std::max(0.0, (screenX + offset - leadInset) / logicalWidth()));
  zoom = target;
  offset = clamp(anchor * logicalWidth() + leadInset - screenX);
  return true;
}

bool TimelineView::zoomBy(double factor, double playhead, double duration) {
  const double at = x(playhead, duration) + leadInset - offset;
  return magnify(factor, at >= 0 && at <= viewportWidth ? at : viewportWidth / 2);
}

bool TimelineView::fit() {
  if (zoom > 1) {
    zoom = 1;
    offset = 0;
    return true;
  }
  return scrollTo(0);
}

bool TimelineView::reveal(double time, double duration, bool centred) {
  const double at = x(time, duration) + leadInset;
  const double margin = std::min(72.0, viewportWidth * 0.16);
  const double screenX = at - offset;
  if (centred) return scrollTo(at - viewportWidth * 0.5);
  if (screenX > viewportWidth - margin) return scrollTo(at - viewportWidth * 0.72);
  if (screenX < margin) return scrollTo(at - viewportWidth * 0.28);
  return false;
}

bool TimelineView::panAtEdge(double screenX) {
  const double edge = std::min(52.0, viewportWidth / 4);
  double velocity;
  if (screenX < edge) {
    velocity = -std::min(28.0, std::max(2.0, (edge - screenX) / 2));
  } else if (screenX > viewportWidth - edge) {
    velocity = std::min(28.0, std::max(2.0, (screenX - viewportWidth + edge) / 2));
  } else {
    return false;
  }
  const double previous = offset;
  scrollTo(offset + velocity);
  return std::abs(previous - offset) > 0.1;
}

double tickInterval(double duration, double width) {
  const double minimum = duration * 76 / std::max(1.0, width);
  const double power = std::pow(10.0, std::floor(std::log10(std::max(0.01, minimum))));
  for (double candidate : {power, 2 * power, 5 * power, 10 * power}) {
    if (candidate >= minimum) return candidate;
  }
  return 10 * power;
}

}  // namespace bmapp
