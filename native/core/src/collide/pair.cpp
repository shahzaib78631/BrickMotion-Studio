#include "bm/collide/pair.h"

#include <cmath>

namespace bm::collide {
namespace {

bool finite(const Xform& x) {
  for (double v : x.r.m)
    if (!std::isfinite(v)) return false;
  return std::isfinite(x.t.x) && std::isfinite(x.t.y) && std::isfinite(x.t.z);
}

struct Walk {
  const Shape& a;
  const Shape& b;
  bool innerOfA;     // a's inner surface against b's true one, or the other way round
  bool innerOfB;
  const Xform& rel;  // b's space -> a's space
  const Xform& xa;   // a's space -> model space
  const std::vector<Zone>& zones;
  Hit* hit;
  float r[9], absR[9], t[3];

  Walk(const Shape& a_, const Shape& b_, bool innerOfA_, bool innerOfB_, const Xform& rel_, const Xform& xa_, const std::vector<Zone>& zones_, Hit* hit_)
      : a(a_), b(b_), innerOfA(innerOfA_), innerOfB(innerOfB_), rel(rel_), xa(xa_), zones(zones_), hit(hit_) {
    for (int i = 0; i < 9; i++) {
      r[i] = static_cast<float>(rel.r.m[i]);
      absR[i] = std::abs(r[i]) + 1e-6f;  // a little wider, so rounding never hides a box
    }
    t[0] = static_cast<float>(rel.t.x);
    t[1] = static_cast<float>(rel.t.y);
    t[2] = static_cast<float>(rel.t.z);
  }

  /// Corner `c` of triangle `tri` of `s`, on its inner or its true surface.
  static const Vec3f& corner(const Shape& s, uint32_t tri, uint32_t c, bool inner) { return inner ? s.inner[tri * 3 + c] : s.outer[s.triangles[tri * 3 + c]]; }

  /// Whether a's node box and b's node box (carried into a's space as a box) overlap.
  bool boxes(const Node& na, const Node& nb) const {
    for (int i = 0; i < 3; i++) {
      float centre = t[i], extent = 0;
      for (int k = 0; k < 3; k++) {
        centre += r[i * 3 + k] * (nb.min[k] + nb.max[k]) * 0.5f;
        extent += absR[i * 3 + k] * (nb.max[k] - nb.min[k]) * 0.5f;
      }
      if (centre - extent > na.max[i] || centre + extent < na.min[i]) return false;
    }
    return true;
  }

  Vec3f carry(const Vec3f& p) const {
    return {r[0] * p.x + r[1] * p.y + r[2] * p.z + t[0], r[3] * p.x + r[4] * p.y + r[5] * p.z + t[1], r[6] * p.x + r[7] * p.y + r[8] * p.z + t[2]};
  }

  bool leaves(const Node& na, const Node& nb) const {
    for (uint32_t i = na.left; i < na.left + na.count; i++) {
      const Vec3f ta[3] = {corner(a, i, 0, innerOfA), corner(a, i, 1, innerOfA), corner(a, i, 2, innerOfA)};
      for (uint32_t j = nb.left; j < nb.left + nb.count; j++) {
        const Vec3f tb[3] = {carry(corner(b, j, 0, innerOfB)), carry(corner(b, j, 1, innerOfB)), carry(corner(b, j, 2, innerOfB))};
        Vec3f where;
        if (!trianglesCross(ta, tb, &where)) continue;
        const Vec3 world = xa.apply({where.x, where.y, where.z});
        bool exempt = false;
        for (const Zone& z : zones) exempt = exempt || inside(z, world);
        if (exempt) continue;
        if (hit) {
          hit->point = world;
          hit->triangleA = i;
          hit->triangleB = j;
          hit->innerOfA = innerOfA;
        }
        return true;
      }
    }
    return false;
  }

  bool run() const {
    // An explicit stack: part trees are shallow, but recursion depth should not depend on data.
    std::vector<std::pair<uint32_t, uint32_t>> stack{{0, 0}};
    while (!stack.empty()) {
      const auto [ia, ib] = stack.back();
      stack.pop_back();
      const Node& na = a.nodes[ia];
      const Node& nb = b.nodes[ib];
      if (!boxes(na, nb)) continue;
      if (na.count && nb.count) {
        if (leaves(na, nb)) return true;
      } else if (na.count || (!nb.count && (nb.max[0] - nb.min[0]) + (nb.max[1] - nb.min[1]) + (nb.max[2] - nb.min[2]) > (na.max[0] - na.min[0]) + (na.max[1] - na.min[1]) + (na.max[2] - na.min[2]))) {
        stack.emplace_back(ia, nb.left);
        stack.emplace_back(ia, nb.left + 1);
      } else {
        stack.emplace_back(na.left, ib);
        stack.emplace_back(na.left + 1, ib);
      }
    }
    return false;
  }
};

}  // namespace

bool inside(const Zone& zone, Vec3 p) {
  const Vec3 ab = zone.b - zone.a;
  const double len2 = dot(ab, ab);
  const double u = len2 > 0 ? std::min(1.0, std::max(0.0, dot(p - zone.a, ab) / len2)) : 0;
  return length(p - (zone.a + ab * u)) <= zone.radius;
}

bool overlap(const Shape& a, const Xform& xa, const Shape& b, const Xform& xb, const std::vector<Zone>& zones, Hit* hit, Depth depth) {
  if (a.nodes.empty() || b.nodes.empty() || !finite(xa) || !finite(xb)) return false;
  if (std::abs(determinant(xa.r)) < 1e-12 || std::abs(determinant(xb.r)) < 1e-12) return false;
  const Xform rel = xa.inverse() * xb;
  if (!finite(rel)) return false;
  if (depth == Depth::Joined) return Walk(a, b, true, true, rel, xa, zones, hit).run();
  return Walk(a, b, true, false, rel, xa, zones, hit).run() || Walk(a, b, false, true, rel, xa, zones, hit).run();
}

}  // namespace bm::collide
