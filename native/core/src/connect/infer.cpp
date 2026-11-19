#include "bm/connect/infer.h"

#include <algorithm>
#include <array>
#include <cmath>
#include <limits>
#include <map>
#include <optional>
#include "bm/collide/tolerances.h"
#include "bm/connect/tolerances.h"

namespace bm::connect {
namespace {

constexpr double kPi = 3.14159265358979323846;
/// Tier 1: how far off its connector's line a piece may have been placed and still be taken as
/// held by it. A hand-placed accessory is commonly a few degrees and a few LDU off (Deadpool's
/// pistol: 4 degrees, 3.4 LDU off its clip); the next connector over is a stud's 20 away.
const double kRelaxCos = std::cos(12 * kPi / 180);
constexpr double kRelaxOffset = 4.0;
/// ... and how far along it: a tube pushed past the end of its bar.
constexpr double kRelaxAlong = 6.0;
/// Neighbours whose boxes come this close are looked at.
constexpr double kReach = 8.0;

Vec3 anyPerpendicular(Vec3 a) {
  const Vec3 other = std::abs(a.x) < 0.6 ? Vec3{1, 0, 0} : std::abs(a.y) < 0.6 ? Vec3{0, 1, 0} : Vec3{0, 0, 1};
  return normalized(cross(a, other));
}

/// Rotation by `angle` about unit `axis` (row-major, as Mat3).
Mat3 rotation(Vec3 axis, double angle) {
  axis = normalized(axis);
  const double c = std::cos(angle), s = std::sin(angle), t = 1 - c, x = axis.x, y = axis.y, z = axis.z;
  Mat3 r;
  r.m[0] = t * x * x + c, r.m[1] = t * x * y - s * z, r.m[2] = t * x * z + s * y;
  r.m[3] = t * x * y + s * z, r.m[4] = t * y * y + c, r.m[5] = t * y * z - s * x;
  r.m[6] = t * x * z - s * y, r.m[7] = t * y * z + s * x, r.m[8] = t * z * z + c;
  return r;
}

/// The least rotation taking unit `from` onto unit `to`.
Mat3 between(Vec3 from, Vec3 to) {
  const Vec3 c = cross(from, to);
  const double s = length(c), d = dot(from, to);
  if (s < 1e-12) return d > 0 ? Mat3{} : rotation(anyPerpendicular(from), kPi);
  return rotation(c, std::atan2(s, d));
}

Box grown(const Box& b, double by) {
  Box out = b;
  if (out.empty()) return out;
  out.min = out.min - Vec3{by, by, by}, out.max = out.max + Vec3{by, by, by};
  return out;
}

/// The mate's zone, as buildGraph makes it: along the shorter connector, as wide as the wider.
MateZone zoneOf(const Connector& x, const Connector& y, double pad) {
  const Connector& s = x.length <= y.length ? x : y;
  return {s.start, s.start + s.axis * s.length, std::max(x.radius, y.radius) + collide::kZonePad + pad};
}

struct Added {
  Connection connection;
  MateZone zone;
  Release release;
};

}  // namespace

Inferred inferJoints(Graph& g, const Model& model, ConnectorDb& db, const collide::World& world, const std::vector<std::pair<uint32_t, uint32_t>>& settle) {
  Inferred out;
  const std::vector<Piece>& pieces = model.pieces();
  const uint32_t n = static_cast<uint32_t>(pieces.size());
  if (n < 2 || g.isSegment.size() != n) return out;
  std::vector<uint8_t> joined(n, 0);
  for (const Connection& c : g.connections) joined[c.a] = joined[c.b] = 1;
  // Each piece looked at, and the one piece it is set onto (UINT32_MAX: any it is near).
  std::vector<std::pair<uint32_t, uint32_t>> loose;
  for (uint32_t i = 0; i < n; i++)
    if (!joined[i] && !g.isSegment[i] && !world.box(i).empty()) loose.push_back({i, UINT32_MAX});
  for (const auto& s : settle)
    if (s.first < n && s.second < n && !g.isSegment[s.first]) loose.push_back(s);
  if (loose.empty()) return out;

  std::vector<Added> added;
  auto connectorsOf = [&](uint32_t piece) { return db.get(pieces[piece].part, &model.library()); };
  auto keep = [&](uint32_t piece, uint32_t other, Found found, Joint joint, bool friction, double grip, MateZone zone, Release release) {
    // `release` comes as the way `piece` leaves `other`; kept as the way the higher leaves the lower.
    const uint32_t lo = std::min(piece, other), hi = std::max(piece, other);
    if (hi != piece) release.axis = -release.axis;
    Added a;
    a.connection.a = lo, a.connection.b = hi, a.connection.found = found, a.connection.joint = joint, a.connection.friction = friction;
    a.connection.mates = 1, a.connection.grip = grip;
    a.zone = zone, a.release = release;
    added.push_back(a);
  };

  // Tier 1: a connector a little off another's line, set exactly onto it, mates.
  std::vector<uint8_t> done(n, 0);
  std::vector<uint32_t> near;
  for (const auto& [u, only] : loose) {
    if (done[u]) continue;
    const bool settling = only != UINT32_MAX;
    const auto mine = connectorsOf(u);
    if (mine->empty()) continue;
    near.clear();
    world.near(grown(world.box(u), kReach), nullptr, near);
    double bestCost = std::numeric_limits<double>::infinity();
    for (uint32_t q : near) {
      if (q == u || g.isSegment[q] || (settling && q != only)) continue;
      if (pieces[q].part == pieces[u].part && length(pieces[q].world.t - pieces[u].world.t) < 1e-6) continue;  // a duplicate
      struct Best {
        double cost = std::numeric_limits<double>::infinity();
        Mate mate;
        MateZone zone;
        bool maleIsMine = false;
        Xform fix;
        double angle = 0, offset = 0, along = 0;
      } best;
      for (const Connector& rawQ : *connectorsOf(q)) {
        if (rawQ.kind == SnapKind::Generic) continue;
        const Connector cq = transformed(rawQ, pieces[q].world);
        for (const Connector& rawU : *mine) {
          if (rawU.kind == SnapKind::Generic) continue;
          const Connector cu = transformed(rawU, pieces[u].world);
          const double d = dot(cu.axis, cq.axis);
          if (std::abs(d) < kRelaxCos) continue;
          const Vec3 v = cu.start - cq.start;
          const Vec3 foot = cq.start + cq.axis * dot(v, cq.axis);
          const Vec3 shift = foot - cu.start;
          if (length(shift) > kRelaxOffset) continue;
          // The piece turned about its connector's start onto the line, then moved across onto it.
          const Mat3 turn = between(cu.axis, d > 0 ? cq.axis : -cq.axis);
          const double angle = std::acos(std::clamp(std::abs(d), 0.0, 1.0));
          for (int k = 0; k <= 2 * static_cast<int>(kRelaxAlong); k++) {
            const double along = (k % 2 ? -1 : 1) * ((k + 1) / 2);
            Xform fix;
            fix.r = turn;
            fix.t = cu.start + shift + cq.axis * along - turn * cu.start;
            const Connector placed = transformed(rawU, fix * pieces[u].world);
            const std::optional<Mate> m = mate(placed, cq);
            if (!m) continue;
            const double cost = angle * std::max(cu.length, 4.0) + length(shift) + std::abs(along);
            if (cost < best.cost) {
              best.cost = cost, best.mate = *m;
              best.zone = zoneOf(placed, cq, cost);
              // mate(placed, cq): the first connector is the piece's.
              best.maleIsMine = m->release.maleIsFirst;
              best.fix = fix, best.angle = angle * 180 / kPi, best.offset = length(shift), best.along = along;
            }
            break;
          }
        }
      }
      if (!std::isfinite(best.cost)) continue;
      // Settling a piece already joined: only when it is not already exactly in place.
      if (settling && best.angle < 0.25 && best.offset < 0.1 && best.along == 0) continue;
      Release r = best.mate.release;
      if (!best.maleIsMine) r.axis = -r.axis;  // as the way `u` leaves `q`
      Joint joint = combine({best.mate.freedom});
      keep(u, q, Found::Relaxed, joint, true, best.mate.grip, best.zone, r);
      // The cheapest way in place, of all that hold it, is where it belongs.
      if (!done[u] || best.cost < bestCost) {
        bestCost = best.cost;
        Correction c;
        c.piece = u, c.onto = q, c.from = pieces[u].world, c.to = best.fix * pieces[u].world;
        c.offset = best.offset, c.along = best.along, c.angle = best.angle;
        if (done[u]) out.corrections.back() = c;
        else out.corrections.push_back(c);
      }
      done[u] = 1;
    }
    if (done[u]) out.relaxed++;
  }

  if (added.empty()) return out;
  for (Added& a : added) {
    a.connection.firstZone = static_cast<uint32_t>(g.zones.size());
    a.connection.zoneCount = 1;
    g.zones.push_back(a.zone);
    g.releases.push_back(a.release);
    g.connections.push_back(a.connection);
  }
  regroup(g);
  return out;
}

}  // namespace bm::connect
