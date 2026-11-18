#include "bm/collide/pair.h"

#include <algorithm>
#include <cmath>
#include <limits>

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
/// narrowed. Triangles that cross share points, so are not apart at all: this is only room for
/// the rounding of single precision, with plenty to spare.
constexpr float kSpanSlack = 0.1f;

/// Travel either side of a stretch that still counts as in it: the rounding of single precision.
constexpr float kSpanPad = 1e-3f;

/// A stretch of travel during which triangle `a` of one shape and `b` of the other can touch.
struct Span {
  float from, to;
  uint32_t a, b;
  bool innerOfA;
};

/// How far inside a triangle (as a share of it) a line must pass to count as passing through it.
constexpr double kInsideTriangle = 1e-3;

/// Spacing of the travels looked at along one pair's crossing when part of it is inside a zone.
constexpr double kZoneStep = kSweepStep / 4;

Vec3 d3(const Vec3f& p) { return {p.x, p.y, p.z}; }

/// Narrows [lo, hi] to the travels t at which `value + slope * t` is at least `floor`. False if
/// none are left.
bool atLeast(double value, double slope, double floor, double& lo, double& hi) {
  if (std::abs(slope) < 1e-12) return value >= floor && lo <= hi;
  const double t = (floor - value) / slope;
  if (slope > 0) lo = std::max(lo, t);
  else hi = std::min(hi, t);
  return lo <= hi;
}

/// The least travel in [lo, hi] at which the still triangle `ta` and triangle `tb`, carried by
/// `velocity` per unit of travel, cross as trianglesCross() decides, to within
/// kCrossingResolution; infinity if they never do.
/// Every corner's distance from the other triangle's plane changes in step with the travel, so
/// the travels at which each triangle passes through the other's plane by more than kTouch on
/// both sides are found exactly. Over those, how far the two crossings overlap (crossLength)
/// first grows and then shrinks: the ends of each crossing are where a plane cuts the sides of
/// a triangle, the near end convex in the travel and the far end concave, so their overlap is
/// concave. A golden-section search for its most tells whether it ever exceeds kTouch, and
/// halving from there finds where it first does.
double firstCross(const Vec3 ta[3], const Vec3 tb[3], Vec3 velocity, double lo, double hi) {
  constexpr double never = std::numeric_limits<double>::infinity();
  const Vec3 na = cross(ta[1] - ta[0], ta[2] - ta[0]), nb = cross(tb[1] - tb[0], tb[2] - tb[0]);
  const double la = length(na), lb = length(nb);
  if (!(la > 1e-12) || !(lb > 1e-12) || !(lo <= hi)) return never;
  const Vec3 ua = na * (1 / la), ub = nb * (1 / lb);
  double maxA = -never, minA = never, maxB = -never, minB = never;
  for (int i = 0; i < 3; i++) {
    const double da = dot(ub, ta[i] - tb[0]), db = dot(ua, tb[i] - ta[0]);
    maxA = std::max(maxA, da), minA = std::min(minA, da), maxB = std::max(maxB, db), minB = std::min(minB, db);
  }
  // As tb travels, ta's corners fall back from tb's plane at this rate, and tb's rise from ta's.
  const double fall = dot(ub, velocity), rise = dot(ua, velocity);
  if (!atLeast(maxA, -fall, kTouch, lo, hi) || !atLeast(-minA, fall, kTouch, lo, hi) || !atLeast(maxB, rise, kTouch, lo, hi) || !atLeast(-minB, -rise, kTouch, lo, hi)) return never;
  auto overlapAt = [&](double t) {
    const Vec3 moved[3] = {tb[0] + velocity * t, tb[1] + velocity * t, tb[2] + velocity * t};
    return crossLength(ta, moved);
  };
  double found = never;
  constexpr double g = 0.6180339887498949;
  double a = lo, b = hi, x1 = b - g * (b - a), x2 = a + g * (b - a), f1 = overlapAt(x1), f2 = overlapAt(x2);
  for (int i = 0; i < 64; i++) {
    if (f1 > kTouch || f2 > kTouch) {
      found = f1 > kTouch ? x1 : x2;
      break;
    }
    if (b - a <= kCrossingResolution) break;
    if (f1 < f2) {  // the most is beyond x1
      a = x1, x1 = x2, f1 = f2, x2 = a + g * (b - a), f2 = overlapAt(x2);
    } else {
      b = x2, x2 = x1, f2 = f1, x1 = b - g * (b - a), f1 = overlapAt(x1);
    }
  }
  if (found == never) return never;
  if (overlapAt(lo) > kTouch) return lo;
  double clear = lo, crossing = found;
  while (crossing - clear > kCrossingResolution) {
    const double mid = (clear + crossing) / 2;
    (overlapAt(mid) > kTouch ? crossing : clear) = mid;
  }
  return crossing;
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

double firstCrossing(const Shape& a, const Xform& xa, Vec3 direction, double distance, const Shape& b, const Xform& xb, const std::vector<Zone>& zones) {
  constexpr double never = std::numeric_limits<double>::infinity();
  if (a.nodes.empty() || b.nodes.empty() || !finite(xa) || !finite(xb) || !(distance >= 0)) return never;
  if (std::abs(determinant(xa.r)) < 1e-12 || std::abs(determinant(xb.r)) < 1e-12) return never;
  const Xform inv = xa.inverse();
  const Xform rel = inv * xb;
  if (!finite(rel)) return never;
  // a moving along `direction` is b moving the other way, seen from a.
  const Vec3 seen = inv.r * (direction * -1.0);
  static const std::vector<Zone> none;
  std::vector<Span> spans;
  Walk walks[2] = {Walk(a, b, true, false, rel, xa, none, nullptr), Walk(a, b, false, true, rel, xa, none, nullptr)};
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
  // Pair by pair, in the order they can first meet, until none can meet before the first crossing found.
  std::sort(spans.begin(), spans.end(), [](const Span& x, const Span& y) { return x.from < y.from; });
  double best = never;
  for (const Span& span : spans) {
    if (span.from - kSpanPad > best) break;
    const Walk& w = walks[span.innerOfA ? 0 : 1];
    Vec3 ta[3], tb[3];
    for (uint32_t c = 0; c < 3; c++) {
      ta[c] = d3(Walk::corner(a, span.a, c, w.innerOfA));
      tb[c] = d3(w.carry(Walk::corner(b, span.b, c, w.innerOfB)));
    }
    const double lo = std::max(0.0, static_cast<double>(span.from) - kSpanPad), hi = std::min({distance, static_cast<double>(span.to) + kSpanPad, best});
    double t = firstCross(ta, tb, seen, lo, hi);
    if (!(t < best)) continue;
    if (!zones.empty()) {
      // Inside a mate's zone a crossing does not count. b stays where it is, and a's triangle sweeps
      // the hull of where it starts and ends; if either lies inside one zone, so does every
      // crossing of the two. Otherwise look along the crossing for a place outside every zone.
      auto within = [&](const Zone& z, const Vec3* points, size_t count) {
        for (size_t k = 0; k < count; k++)
          if (!inside(z, points[k])) return false;
        return true;
      };
      Vec3 still[3], swept[6];
      for (uint32_t c = 0; c < 3; c++) {
        still[c] = xa.apply(tb[c]);
        swept[c] = xa.apply(ta[c]) + direction * t, swept[c + 3] = xa.apply(ta[c]) + direction * hi;
      }
      bool covered = false;
      for (const Zone& z : zones) covered = covered || within(z, still, 3) || within(z, swept, 6);
      if (covered) continue;
      enum { Apart, Forgiven, Counts };
      auto state = [&](double at) {
        const Vec3 moved[3] = {tb[0] + seen * at, tb[1] + seen * at, tb[2] + seen * at};
        Vec3 where;
        if (!(crossLength(ta, moved, &where) > kTouch)) return Apart;
        const Vec3 there = xa.apply(where) + direction * at;
        for (const Zone& z : zones)
          if (inside(z, there)) return Forgiven;
        return Counts;
      };
      double counted = -1;
      for (double at = t; at <= hi; at += kZoneStep) {
        const auto now = state(at);
        if (now == Apart && at > t) break;  // past the end of their crossing
        if (now != Counts) continue;
        // Back to where it leaves the zone, halving the last step.
        double before = std::max(t, at - kZoneStep), after = at;
        while (at > t && after - before > kCrossingResolution) {
          const double mid = (before + after) / 2;
          (state(mid) == Counts ? after : before) = mid;
        }
        counted = after;
        break;
      }
      if (counted < 0) continue;
      t = counted;
    }
    best = t;
  }
  return best;
}

double throughSurface(const Shape& b, const Xform& xb, Vec3 from, Vec3 to, Vec3* where) {
  if (b.nodes.empty() || !finite(xb) || std::abs(determinant(xb.r)) < 1e-12) return 2;
  const Xform inv = xb.inverse();
  const Vec3 o = inv.apply(from), e = inv.apply(to), d = e - o;
  if (!(length(d) > 1e-9)) return 2;
  const double od[3] = {o.x, o.y, o.z}, dd[3] = {d.x, d.y, d.z};
  double best = 2;
  std::vector<uint32_t> stack{0};
  while (!stack.empty()) {
    const Node& n = b.nodes[stack.back()];
    stack.pop_back();
    // Where along the way the line is inside the node's box.
    double enter = 0, leave = std::min(1.0, best);
    for (int i = 0; i < 3 && enter <= leave; i++) {
      if (std::abs(dd[i]) < 1e-12) {
        if (od[i] < n.min[i] || od[i] > n.max[i]) enter = 3;
        continue;
      }
      double t0 = (n.min[i] - od[i]) / dd[i], t1 = (n.max[i] - od[i]) / dd[i];
      if (t0 > t1) std::swap(t0, t1);
      enter = std::max(enter, t0), leave = std::min(leave, t1);
    }
    if (enter > leave) continue;
    if (!n.count) {
      stack.push_back(n.left);
      stack.push_back(n.left + 1);
      continue;
    }
    for (uint32_t t = n.left; t < n.left + n.count; t++) {
      const Vec3f &p0 = b.outer[b.triangles[t * 3]], &p1 = b.outer[b.triangles[t * 3 + 1]], &p2 = b.outer[b.triangles[t * 3 + 2]];
      const Vec3 v0{p0.x, p0.y, p0.z}, e1 = Vec3{p1.x, p1.y, p1.z} - v0, e2 = Vec3{p2.x, p2.y, p2.z} - v0;
      const Vec3 h = cross(d, e2);
      const double det = dot(e1, h);
      if (std::abs(det) < 1e-9 * length(e1) * length(e2) * length(d)) continue;  // along the triangle: no clean passage
      const Vec3 s = o - v0;
      const double u = dot(s, h) / det;
      const Vec3 q = cross(s, e1);
      const double v = dot(d, q) / det, along = dot(e2, q) / det;
      // Well inside the triangle and the way: a passage through an edge or an end is not counted.
      if (u < kInsideTriangle || v < kInsideTriangle || u + v > 1 - kInsideTriangle || along <= 1e-9 || along >= best) continue;
      best = along;
    }
  }
  if (best <= 1 && where) *where = from + (to - from) * best;
  return best;
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
