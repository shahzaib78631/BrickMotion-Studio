#include "bm/collide/pair.h"

#include <algorithm>
#include <cmath>

namespace bm::collide {
namespace {

bool finite(const Xform& x) {
  for (double v : x.r.m)
    if (!std::isfinite(v)) return false;
  return std::isfinite(x.t.x) && std::isfinite(x.t.y) && std::isfinite(x.t.z);
}

/// The most triangles of a leaf carried at once; a leaf never holds more (shape.cpp's kLeafSize).
constexpr uint32_t kMaxLeaf = 4;

/// LDU by which two triangles may be apart and still count as able to touch when a sweep is
/// narrowed: twice kTouch, the most trianglesCross rounds a corner onto a plane.
constexpr float kSpanSlack = 0.1f;

/// Travel either side of a stretch that still counts as in it: the rounding of single precision.
constexpr float kSpanPad = 1e-3f;

/// A stretch of travel during which triangle `a` of one shape and `b` of the other can touch.
struct Span {
  float from, to;
  uint32_t a, b;
  bool innerOfA;
};

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
  float sweepHalf[3] = {0, 0, 0}, sweepReach[3] = {0, 0, 0};  // half of b's travel in a's space, and its size
  float velocity[3] = {0, 0, 0}, travel = 0;                    // b's velocity in a's space per unit of travel, and how far
  std::vector<Span>* spans = nullptr;  // set: collect when triangles can meet instead of testing a pose

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

  /// Whether a's node box and b's node box (carried into a's space as a box) overlap, each box
  /// being that of the surface in play. With a sweep, b's box is stretched along it.
  bool boxes(const Node& na, const Node& nb) const {
    const float* amin = innerOfA ? na.imin : na.min;
    const float* amax = innerOfA ? na.imax : na.max;
    const float* bmin = innerOfB ? nb.imin : nb.min;
    const float* bmax = innerOfB ? nb.imax : nb.max;
    if (bmin[0] > bmax[0] || amin[0] > amax[0]) return false;  // nothing of that surface under the node
    for (int i = 0; i < 3; i++) {
      float centre = t[i] + sweepHalf[i], extent = sweepReach[i];
      for (int k = 0; k < 3; k++) {
        centre += r[i * 3 + k] * (bmin[k] + bmax[k]) * 0.5f;
        extent += absR[i * 3 + k] * (bmax[k] - bmin[k]) * 0.5f;
      }
      if (centre - extent > amax[i] || centre + extent < amin[i]) return false;
    }
    return true;
  }

  Vec3f carry(const Vec3f& p) const {
    return {r[0] * p.x + r[1] * p.y + r[2] * p.z + t[0], r[3] * p.x + r[4] * p.y + r[5] * p.z + t[1], r[6] * p.x + r[7] * p.y + r[8] * p.z + t[2]};
  }

  bool leaves(const Node& na, const Node& nb) const {
    Vec3f carried[kMaxLeaf][3];
    const uint32_t nbCount = std::min<uint32_t>(nb.count, kMaxLeaf);
    for (uint32_t j = 0; j < nbCount; j++)
      for (uint32_t c = 0; c < 3; c++) carried[j][c] = carry(corner(b, nb.left + j, c, innerOfB));
    for (uint32_t i = na.left; i < na.left + na.count; i++) {
      const Vec3f ta[3] = {corner(a, i, 0, innerOfA), corner(a, i, 1, innerOfA), corner(a, i, 2, innerOfA)};
      for (uint32_t j = nb.left; j < nb.left + nb.count; j++) {
        Vec3f own[3];
        const Vec3f* tb = carried[j - nb.left];
        if (j - nb.left >= kMaxLeaf) {
          for (uint32_t c = 0; c < 3; c++) own[c] = carry(corner(b, j, c, innerOfB));
          tb = own;
        }
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

  /// While triangle `tb` moves by `velocity` per unit of travel, the stretch of travel during
  /// which no direction separates it from the still triangle `ta` by more than kSpanSlack:
  /// the two can only touch within it. The directions are the three axes, the two normals and
  /// the nine edge pairs, which are all there are for two triangles.
  bool meeting(const Vec3f ta[3], const Vec3f tb[3], float& from, float& to) const {
    from = 0, to = travel;
    auto sub = [](const Vec3f& p, const Vec3f& q) { return Vec3f{p.x - q.x, p.y - q.y, p.z - q.z}; };
    auto crossOf = [](const Vec3f& p, const Vec3f& q) { return Vec3f{p.y * q.z - p.z * q.y, p.z * q.x - p.x * q.z, p.x * q.y - p.y * q.x}; };
    auto along = [&](const Vec3f& n) {
      const float len2 = n.x * n.x + n.y * n.y + n.z * n.z;
      if (!(len2 > 1e-10f)) return true;  // no direction: says nothing
      const float slack = kSpanSlack * std::sqrt(len2);
      float amin = 1e30f, amax = -1e30f, bmin = 1e30f, bmax = -1e30f;
      for (int c = 0; c < 3; c++) {
        const float pa = n.x * ta[c].x + n.y * ta[c].y + n.z * ta[c].z, pb = n.x * tb[c].x + n.y * tb[c].y + n.z * tb[c].z;
        amin = std::min(amin, pa), amax = std::max(amax, pa), bmin = std::min(bmin, pb), bmax = std::max(bmax, pb);
      }
      const float speed = n.x * velocity[0] + n.y * velocity[1] + n.z * velocity[2];
      const float lo = amin - slack - bmax, hi = amax + slack - bmin;  // they meet while lo <= speed * t <= hi
      if (std::abs(speed) < 1e-7f * std::sqrt(len2)) return lo <= 0 && hi >= 0;
      float t0 = lo / speed, t1 = hi / speed;
      if (t0 > t1) std::swap(t0, t1);
      from = std::max(from, t0), to = std::min(to, t1);
      return from <= to;
    };
    if (!along({1, 0, 0}) || !along({0, 1, 0}) || !along({0, 0, 1})) return false;
    const Vec3f ea[3] = {sub(ta[1], ta[0]), sub(ta[2], ta[1]), sub(ta[0], ta[2])}, eb[3] = {sub(tb[1], tb[0]), sub(tb[2], tb[1]), sub(tb[0], tb[2])};
    if (!along(crossOf(ea[0], ea[1])) || !along(crossOf(eb[0], eb[1]))) return false;
    for (const Vec3f& p : ea)
      for (const Vec3f& q : eb)
        if (!along(crossOf(p, q))) return false;
    return true;
  }

  void leafSpans(const Node& na, const Node& nb) const {
    for (uint32_t j = nb.left; j < nb.left + nb.count; j++) {
      const Vec3f tb[3] = {carry(corner(b, j, 0, innerOfB)), carry(corner(b, j, 1, innerOfB)), carry(corner(b, j, 2, innerOfB))};
      if (innerOfB && tb[0].x == tb[1].x && tb[0].y == tb[1].y && tb[0].z == tb[1].z) continue;  // no area
      for (uint32_t i = na.left; i < na.left + na.count; i++) {
        const Vec3f ta[3] = {corner(a, i, 0, innerOfA), corner(a, i, 1, innerOfA), corner(a, i, 2, innerOfA)};
        if (innerOfA && ta[0].x == ta[1].x && ta[0].y == ta[1].y && ta[0].z == ta[1].z) continue;
        float from, to;
        if (meeting(ta, tb, from, to)) spans->push_back({from, to, i, j, innerOfA});
      }
    }
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
        if (spans) leafSpans(na, nb);
        else if (leaves(na, nb)) return true;
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

size_t firstOverlap(const Shape& a, const Xform& xa, Vec3 direction, const double* at, size_t count, const Shape& b, const Xform& xb, const std::vector<Zone>& zones) {
  if (count == 0 || a.nodes.empty() || b.nodes.empty() || !finite(xa) || !finite(xb)) return count;
  if (std::abs(determinant(xa.r)) < 1e-12 || std::abs(determinant(xb.r)) < 1e-12) return count;
  Xform start = xa;
  start.t = start.t + direction * at[0];
  const double distance = at[count - 1] - at[0];
  const Xform inv = start.inverse();
  const Xform rel = inv * xb;
  if (!finite(rel) || !(distance >= 0)) return count;
  // a moving along `direction` is b moving the other way, seen from a.
  const Vec3 seen = inv.r * (direction * -1.0);
  static const std::vector<Zone> none;
  std::vector<Span> spans;
  Walk walks[2] = {Walk(a, b, true, false, rel, start, none, nullptr), Walk(a, b, false, true, rel, start, none, nullptr)};
  for (Walk& w : walks) {
    const double v[3] = {seen.x, seen.y, seen.z};
    for (int i = 0; i < 3; i++) {
      w.velocity[i] = static_cast<float>(v[i]);
      w.sweepHalf[i] = static_cast<float>(v[i] * distance * 0.5);
      w.sweepReach[i] = static_cast<float>(std::abs(v[i]) * distance * 0.5) + kSpanSlack;
    }
    w.travel = static_cast<float>(distance);
    w.spans = &spans;
    w.run();
  }
  if (spans.empty()) return count;
  // Travel by travel, the pairs of triangles within reach then, each looked at as overlap() would.
  std::sort(spans.begin(), spans.end(), [](const Span& x, const Span& y) { return x.from < y.from; });
  std::vector<uint32_t> live;
  size_t next = 0;
  for (size_t k = 0; k < count; k++) {
    const float t = static_cast<float>(at[k] - at[0]);
    while (next < spans.size() && spans[next].from <= t + kSpanPad) live.push_back(static_cast<uint32_t>(next++));
    for (size_t l = 0; l < live.size();) {
      const Span& span = spans[live[l]];
      if (span.to < t - kSpanPad) {
        live[l] = live.back();
        live.pop_back();
        continue;
      }
      l++;
      const Walk& w = walks[span.innerOfA ? 0 : 1];
      const Vec3f ta[3] = {Walk::corner(a, span.a, 0, w.innerOfA), Walk::corner(a, span.a, 1, w.innerOfA), Walk::corner(a, span.a, 2, w.innerOfA)};
      Vec3f tb[3];
      for (uint32_t c = 0; c < 3; c++) {
        tb[c] = w.carry(Walk::corner(b, span.b, c, w.innerOfB));
        tb[c].x += w.velocity[0] * t, tb[c].y += w.velocity[1] * t, tb[c].z += w.velocity[2] * t;
      }
      Vec3f where;
      if (!trianglesCross(ta, tb, &where)) continue;
      const Vec3 world = start.apply({where.x, where.y, where.z}) + direction * (at[k] - at[0]);
      bool exempt = false;
      for (const Zone& z : zones) exempt = exempt || inside(z, world);
      if (!exempt) return k;
    }
  }
  return count;
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
