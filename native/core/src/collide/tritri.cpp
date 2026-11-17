#include <cmath>
#include <limits>
#include "bm/collide/shape.h"

namespace bm::collide {
namespace {

Vec3 d3(const Vec3f& p) { return {p.x, p.y, p.z}; }

/// Where a triangle with signed plane distances `d` crosses that plane: the two ends of the
/// crossing segment. Requires distances of both signs.
void crossing(const Vec3 v[3], const double d[3], Vec3& p0, Vec3& p1) {
  Vec3 pts[4];
  int n = 0;
  for (int i = 0; i < 3 && n < 4; i++) {
    const int j = (i + 1) % 3;
    if (d[i] == 0) pts[n++] = v[i];
    else if ((d[i] > 0) != (d[j] > 0) && d[j] != 0) pts[n++] = v[i] + (v[j] - v[i]) * (d[i] / (d[i] - d[j]));
  }
  p0 = pts[0];
  p1 = n > 1 ? pts[1] : pts[0];
}

}  // namespace

double crossLength(const Vec3 a[3], const Vec3 b[3], Vec3* where) {
  constexpr double none = -std::numeric_limits<double>::infinity();
  const Vec3 na = cross(a[1] - a[0], a[2] - a[0]), nb = cross(b[1] - b[0], b[2] - b[0]);
  const double la = length(na), lb = length(nb);
  if (!(la > 1e-12) || !(lb > 1e-12)) return none;  // no area (or not finite)
  const Vec3 ua = na * (1 / la), ub = nb * (1 / lb);

  // Each triangle must have corners strictly on both sides of the other's plane.
  double da[3], db[3];
  bool posA = false, negA = false, posB = false, negB = false;
  for (int i = 0; i < 3; i++) {
    da[i] = dot(ub, a[i] - b[0]);
    if (std::abs(da[i]) < kTouch) da[i] = 0;
    posA = posA || da[i] > 0;
    negA = negA || da[i] < 0;
    db[i] = dot(ua, b[i] - a[0]);
    if (std::abs(db[i]) < kTouch) db[i] = 0;
    posB = posB || db[i] > 0;
    negB = negB || db[i] < 0;
  }
  if (!(posA && negA && posB && negB)) return none;

  // Both cross the line where the planes meet; they cross each other if those stretches overlap.
  const Vec3 line = cross(ua, ub);
  const double ll = length(line);
  if (!(ll > 1e-9)) return none;
  const Vec3 dir = line * (1 / ll);
  Vec3 a0, a1, b0, b1;
  crossing(a, da, a0, a1);
  crossing(b, db, b0, b1);
  double ta0 = dot(dir, a0), ta1 = dot(dir, a1), tb0 = dot(dir, b0), tb1 = dot(dir, b1);
  if (ta0 > ta1) {
    std::swap(ta0, ta1);
    std::swap(a0, a1);
  }
  if (tb0 > tb1) std::swap(tb0, tb1);
  const double lo = std::max(ta0, tb0), hi = std::min(ta1, tb1);
  if (where && hi > lo) {
    const double span = ta1 - ta0, t = span > 0 ? ((lo + hi) / 2 - ta0) / span : 0;
    *where = a0 + (a1 - a0) * t;
  }
  return hi - lo;
}

bool trianglesCross(const Vec3f af[3], const Vec3f bf[3], Vec3f* where) {
  const Vec3 a[3] = {d3(af[0]), d3(af[1]), d3(af[2])}, b[3] = {d3(bf[0]), d3(bf[1]), d3(bf[2])};
  Vec3 p;
  if (!(crossLength(a, b, where ? &p : nullptr) > kTouch)) return false;
  if (where) *where = {static_cast<float>(p.x), static_cast<float>(p.y), static_cast<float>(p.z)};
  return true;
}

}  // namespace bm::collide
