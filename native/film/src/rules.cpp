#include "bmf/rules.h"
#include <algorithm>
#include <cmath>
#include "bmf/tolerances.h"

namespace bm::film {

std::pair<double, double> startAngles(const Shot& s) {
  if (s.move.kind == MoveKind::ArcReveal) return {s.azimuth + s.move.amount, s.elevation};
  return {s.azimuth, s.elevation};
}

std::pair<double, double> endAngles(const Shot& s) {
  switch (s.move.kind) {
    case MoveKind::Orbit: return {s.azimuth + s.move.amount, s.elevation};
    case MoveKind::Crane: return {s.azimuth, s.elevation + s.move.amount};
    default: return {s.azimuth, s.elevation};
  }
}

namespace {
Vec3 viewOf(std::pair<double, double> a) { return {std::cos(a.second) * std::sin(a.first), std::sin(a.second), std::cos(a.second) * std::cos(a.first)}; }
Vec3 middle(const Box& b) { return (b.min + b.max) * 0.5; }
/// Which side of the line from `a` to `b` (seen from above) an eye at azimuth `az` is: -1, 0, 1.
int sideOf(Vec3 a, Vec3 b, double az) {
  const double lx = b.x - a.x, lz = b.z - a.z;
  if (std::hypot(lx, lz) < 1) return 0;
  const double ex = -std::sin(az), ez = -std::cos(az), c = lx * ez - lz * ex;
  return c > 1e-9 ? 1 : c < -1e-9 ? -1 : 0;
}
}  // namespace

std::vector<RuleMiss> checkEditing(const std::vector<Shot>& shots, const Beats& beats, double fps, double front) {
  std::vector<RuleMiss> out;
  const double length = beats.frames / fps;
  const bool short_ = length < 2 * kMinShotSeconds;  // too short for two shots of full length
  std::vector<double> cuts;
  for (size_t i = 0; i < shots.size(); i++) {
    const Shot& s = shots[i];
    if (!short_ && s.end - s.start < kMinShotSeconds - 1e-9) out.push_back({"min-length", s.id, s.start, std::to_string(s.end - s.start) + " s"});
    if (i == 0 || s.enter != EnterKind::Cut) continue;
    cuts.push_back(s.start);
    const Shot& before = shots[i - 1];
    const double turn = std::acos(std::clamp(dot(viewOf(endAngles(before)), viewOf(startAngles(s))), -1.0, 1.0));
    if (turn < kJumpCutRadians && before.size == s.size) out.push_back({"jump-cut", s.id, s.start, std::to_string(turn * 180 / M_PI) + " deg, same size"});
    const double frame = s.start * fps;
    for (const Beat& b : beats.list) {
      if (b.kind != BeatKind::Flight || b.start > frame || frame >= b.end) continue;
      const int was = sideOf(middle(b.from), middle(b.seat), front + endAngles(before).first), is = sideOf(middle(b.from), middle(b.seat), front + startAngles(s).first);
      if (was && is && was != is) {
        out.push_back({"line", s.id, s.start, "crosses flight " + std::to_string(b.flight)});
        break;
      }
    }
  }
  for (double c : cuts) {
    const auto n = std::count_if(cuts.begin(), cuts.end(), [&](double x) { return x >= c && x < c + kCutWindowSeconds; });
    if (n > kCutsPerWindow) out.push_back({"cut-rate", "", c, std::to_string(n) + " cuts in " + std::to_string(kCutWindowSeconds) + " s"});
  }
  return out;
}

}  // namespace bm::film
