#include "bmf/lens.h"
#include <algorithm>
#include <cmath>

namespace bm::film {

namespace {
/// The way the eye looks (from it to the target), and screen right and up, unrolled.
struct Basis {
  Vec3 forward, right, up;
};
Basis basis(double azimuth, double elevation, double roll = 0) {
  const double ce = std::cos(elevation);
  const Vec3 f{ce * std::sin(azimuth), std::sin(elevation), ce * std::cos(azimuth)};
  // Straight up or down has no right of its own: take the one azimuth gives.
  Vec3 r = cross(f, Vec3{0, -1, 0});
  r = length(r) > 1e-12 ? normalized(r) : Vec3{std::cos(azimuth), 0, -std::sin(azimuth)};
  Vec3 u = cross(r, f);
  if (roll != 0) {
    const double c = std::cos(roll), s = std::sin(roll);
    const Vec3 r2 = r * c + u * s, u2 = u * c - r * s;
    r = r2, u = u2;
  }
  return {f, r, u};
}
}  // namespace

double fovY(double lensMm, double sensorMm) { return 2 * std::atan(std::max(1.0, sensorMm) / (2 * std::max(1.0, lensMm))); }

Vec3 eyeOf(const Rig& rig) { return rig.target - basis(rig.azimuth, rig.elevation).forward * rig.distance; }

Vec3 upOf(const Rig& rig) { return basis(rig.azimuth, rig.elevation, rig.roll).up; }

Vec3 project(const Rig& rig, const FrameShape& shape, Vec3 p) {
  const Basis b = basis(rig.azimuth, rig.elevation, rig.roll);
  const Vec3 q = p - eyeOf(rig);
  const double depth = dot(q, b.forward), t = std::tan(fovY(rig.lensMm, shape.sensorMm) / 2);
  if (!(depth > 0)) return {0, 0, depth};
  return {dot(q, b.right) / (depth * t * shape.aspect), dot(q, b.up) / (depth * t), depth};
}

double fitDistance(const std::vector<Vec3>& points, Vec3 target, double azimuth, double elevation, double lensMm, const FrameShape& shape, double fill) {
  const Basis b = basis(azimuth, elevation);
  const double t = std::tan(fovY(lensMm, shape.sensorMm) / 2), limitY = shape.safe * fill * t, limitX = limitY * shape.aspect;
  double d = kMinDistance;
  // A point a along the way the eye looks and h across it is in view once h <= limit * (a + d).
  for (Vec3 p : points) {
    const Vec3 q = p - target;
    const double a = dot(q, b.forward);
    d = std::max({d, std::abs(dot(q, b.right)) / limitX - a, std::abs(dot(q, b.up)) / limitY - a});
  }
  return d;
}

Vec3 composedTarget(const std::vector<Vec3>& points, double azimuth, double elevation, Vec3 lead, double distance, double lensMm, const FrameShape& shape) {
  if (points.empty()) return {};
  const Basis b = basis(azimuth, elevation);
  double lo[3] = {1e300, 1e300, 1e300}, hi[3] = {-1e300, -1e300, -1e300};
  for (Vec3 p : points) {
    const double c[3] = {dot(p, b.right), dot(p, b.up), dot(p, b.forward)};
    for (int k = 0; k < 3; k++) lo[k] = std::min(lo[k], c[k]), hi[k] = std::max(hi[k], c[k]);
  }
  double across = (lo[0] + hi[0]) / 2, up = (lo[1] + hi[1]) / 2;
  const double lr = dot(lead, b.right), lu = dot(lead, b.up), ln = std::hypot(lr, lu);
  if (ln > 1e-12) {
    // Aim ahead of it: at `distance`, one normalised screen unit across is d·tan(fov/2)·aspect.
    const double t = std::tan(fovY(lensMm, shape.sensorMm) / 2) * distance;
    across += kLeadShare * (lr / ln) * t * shape.aspect;
    up += kLeadShare * (lu / ln) * t;
  }
  return b.right * across + b.up * up + b.forward * ((lo[2] + hi[2]) / 2);
}

}  // namespace bm::film
