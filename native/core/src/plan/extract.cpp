#include "bm/plan/plan.h"

#include <algorithm>
#include <cmath>
#include "bm/plan/tolerances.h"

namespace bm::plan {
namespace {

using collide::World;
using connect::Connection;
using connect::Release;
using connect::ReleaseKind;

bool has(const Unit& unit, uint32_t piece) { return std::binary_search(unit.pieces.begin(), unit.pieces.end(), piece); }
bool there(const World::Present* present, uint32_t piece) { return !present || (piece < present->size() && (*present)[piece]); }

/// One mate between a unit piece and a present piece outside it, seen from the unit.
struct Held {
  Release release;  ///< axis signed as the way the unit leaves
  connect::MateZone zone;
};

std::vector<Held> heldBy(const Context& ctx, const Unit& unit, const World::Present* present) {
  std::vector<Held> out;
  for (uint32_t p : unit.pieces) {
    if (p >= ctx.connectionsOf.size()) continue;
    for (uint32_t ci : ctx.connectionsOf[p]) {
      const Connection& c = ctx.graph.connections[ci];
      const uint32_t other = c.a == p ? c.b : c.a;
      if (has(unit, other) || !there(present, other)) continue;
      for (uint32_t k = 0; k < c.zoneCount; k++) {
        const size_t at = static_cast<size_t>(c.firstZone) + k;
        if (at >= ctx.graph.releases.size()) break;
        Held h{ctx.graph.releases[at], ctx.graph.zones[at]};
        if (c.a == p) h.release.axis = -h.release.axis;  // stored as how b leaves a
        out.push_back(h);
      }
    }
  }
  return out;
}

bool allows(const Release& r, Vec3 d) {
  const double along = dot(d, r.axis);
  switch (r.kind) {
    case ReleaseKind::Along: return along >= kReleaseAgree;
    case ReleaseKind::Either: return std::abs(along) >= kReleaseAgree;
    case ReleaseKind::Across: return std::abs(along) <= kAcrossAgree || (r.orAlong && std::abs(along) >= kReleaseAgree);
    case ReleaseKind::Any: return true;
  }
  return true;
}

Vec3 anyPerpendicular(Vec3 u) { return normalized(cross(u, std::abs(u.x) < 0.9 ? Vec3{1, 0, 0} : Vec3{0, 1, 0})); }

Box boxOf(const Context& ctx, const Unit& unit) {
  Box box;
  for (uint32_t p : unit.pieces) box.merge(ctx.world.box(p));
  return box;
}

/// How far a box must go along `d` to be `margin` outside `bounds` through some face.
double exitDistance(const Box& box, const Box& bounds, Vec3 d, double margin) {
  double best = std::numeric_limits<double>::infinity();
  const double lo[3] = {box.min.x, box.min.y, box.min.z}, hi[3] = {box.max.x, box.max.y, box.max.z};
  const double blo[3] = {bounds.min.x, bounds.min.y, bounds.min.z}, bhi[3] = {bounds.max.x, bounds.max.y, bounds.max.z};
  const double dir[3] = {d.x, d.y, d.z};
  for (int i = 0; i < 3; i++) {
    if (dir[i] > 1e-6) best = std::min(best, (bhi[i] + margin - lo[i]) / dir[i]);
    if (dir[i] < -1e-6) best = std::min(best, (hi[i] - (blo[i] - margin)) / -dir[i]);
  }
  return std::max(0.0, best);
}

Xform shifted(Vec3 by) {
  Xform x;
  x.t = by;
  return x;
}

}  // namespace

Context::Context(const Model& m, const connect::Graph& g, const collide::World& w, Vec3 d) : model(m), graph(g), world(w), down(length(d) > 0 ? normalized(d) : Vec3{0, 1, 0}) {
  connectionsOf.resize(m.pieces().size());
  for (uint32_t i = 0; i < g.connections.size(); i++) {
    const Connection& c = g.connections[i];
    if (c.a < connectionsOf.size() && c.b < connectionsOf.size()) connectionsOf[c.a].push_back(i), connectionsOf[c.b].push_back(i);
  }
}

std::vector<Leave> leaveDirections(const Context& ctx, const Unit& unit, const World::Present* present) {
  const std::vector<Held> held = heldBy(ctx, unit, present);
  std::vector<Vec3> candidates;
  auto offer = [&](Vec3 d) {
    if (!(length(d) > 0)) return;
    d = normalized(d);
    for (const Vec3& have : candidates)
      if (dot(have, d) >= kReleaseAgree) return;
    candidates.push_back(d);
  };
  const Vec3 up = -ctx.down;
  bool constrained = false;
  // The most telling first: a one-way axis, then two-way, then the sideways ones.
  for (const Held& h : held)
    if (h.release.kind == ReleaseKind::Along) offer(h.release.axis), constrained = true;
  for (const Held& h : held)
    if (h.release.kind == ReleaseKind::Either) {
      constrained = true;
      // The way that points up first: things are set down onto what is built.
      const Vec3 first = dot(h.release.axis, up) >= 0 ? h.release.axis : -h.release.axis;
      offer(first), offer(-first);
    }
  for (const Held& h : held)
    if (h.release.kind == ReleaseKind::Across) {
      constrained = true;
      const Vec3 side = anyPerpendicular(h.release.axis), other = cross(h.release.axis, side);
      offer(up - h.release.axis * dot(up, h.release.axis));
      for (Vec3 d : {side, -side, other, -other}) offer(d);
      if (h.release.orAlong) offer(h.release.axis), offer(-h.release.axis);
    }
  if (!constrained) {
    offer(up);
    for (Vec3 d : {Vec3{1, 0, 0}, Vec3{-1, 0, 0}, Vec3{0, 0, 1}, Vec3{0, 0, -1}, Vec3{0, 1, 0}, Vec3{0, -1, 0}}) offer(d);
  }
  std::vector<Leave> out;
  for (const Vec3& d : candidates) {
    double travel = 0;
    bool ok = true;
    for (const Held& h : held) {
      if (!allows(h.release, d)) {
        ok = false;
        break;
      }
      if (h.release.kind != ReleaseKind::Any) travel = std::max(travel, h.release.travel);
    }
    if (ok) out.push_back({d, travel});
  }
  return out;
}

Extraction extract(const Context& ctx, const Unit& unit, const World::Present* present, const Box& bounds, Vec3 only, bool turns) {
  Extraction best;
  best.why = Flag::NoDirection;
  std::vector<Leave> leaves;
  if (length(only) > 0) {
    double travel = 0;
    for (const Held& h : heldBy(ctx, unit, present))
      if (h.release.kind != ReleaseKind::Any) travel = std::max(travel, h.release.travel);
    leaves.push_back({normalized(only), travel});
  } else {
    leaves = leaveDirections(ctx, unit, present);
  }
  if (leaves.empty()) return best;
  const std::vector<Held> held = heldBy(ctx, unit, present);
  const Box box = boxOf(ctx, unit);
  const Vec3 up = -ctx.down;
  double furthest = -1;
  for (const Leave& leave : leaves) {
    const Vec3 d = leave.direction;
    const double seat = leave.travel + kClearMargin;
    // Its own mates' zones, carried along the way out: a pin grazes its hole all the way.
    std::vector<collide::Zone> corridor;
    for (const Held& h : held) {
      const double stride = std::max(1.0, h.zone.radius);
      for (double s = 0; s <= seat + stride; s += stride) corridor.push_back({h.zone.a + d * s, h.zone.b + d * s, h.zone.radius});
    }
    uint32_t blocker = UINT32_MAX;
    const double got = ctx.world.clearTravel(unit.pieces, d, seat, present, corridor, &blocker);
    if (got < seat - kTravelTol) {
      if (got > furthest) furthest = got, best.why = Flag::Blocked, best.blocker = blocker, best.direction = d, best.seatTravel = leave.travel;
      continue;
    }
    // Out of its seat. Now to open air by straight legs.
    const Xform seated = shifted(d * seat);
    Box at = box;
    at.min = at.min + d * seat, at.max = at.max + d * seat;
    auto leg = [&](const Xform& from, const Box& fromBox, Vec3 way, uint32_t* who) -> double {  // how far it gets, and how far it needs
      const double need = exitDistance(fromBox, bounds, way, kExitMargin);
      if (!std::isfinite(need)) return -1;
      if (need <= 0) return 0;
      const double reached = ctx.world.clearTravel(unit.pieces, way, need, present, {}, who, from);
      return reached >= need - kTravelTol ? need : -1;
    };
    std::vector<Vec3> ways{d, up};
    for (Vec3 w : {Vec3{1, 0, 0}, Vec3{-1, 0, 0}, Vec3{0, 0, 1}, Vec3{0, 0, -1}, Vec3{0, 1, 0}, Vec3{0, -1, 0}}) ways.push_back(w);
    bool out = false;
    uint32_t exitBlocker = UINT32_MAX;
    for (const Vec3& w : ways) {
      const double need = leg(seated, at, w, &exitBlocker);
      if (need < 0) continue;
      best = {};
      best.ok = true, best.direction = d, best.seatTravel = leave.travel;
      best.path = {Xform{}, seated};
      if (need > 0) best.path.push_back(shifted(d * seat + w * need));
      out = true;
      break;
    }
    if (out) return best;
    // One turn: as far as it goes one way, then out another.
    for (const Vec3& first : ways) {
      if (!turns) break;
      const double room = ctx.world.clearTravel(unit.pieces, first, exitDistance(at, bounds, first, kExitMargin), present, {}, nullptr, seated);
      if (room < kMinLeg) continue;
      const Xform turned = shifted(d * seat + first * room);
      Box turnedBox = at;
      turnedBox.min = turnedBox.min + first * room, turnedBox.max = turnedBox.max + first * room;
      for (const Vec3& second : ways) {
        if (std::abs(dot(first, second)) > kReleaseAgree) continue;
        const double need = leg(turned, turnedBox, second, nullptr);
        if (need < 0) continue;
        best = {};
        best.ok = true, best.direction = d, best.seatTravel = leave.travel;
        best.path = {Xform{}, seated, turned};
        if (need > 0) best.path.push_back(shifted(d * seat + first * room + second * need));
        return best;
      }
    }
    if (seat > furthest) furthest = seat, best.why = Flag::NoExit, best.blocker = exitBlocker, best.direction = d, best.seatTravel = leave.travel;
  }
  return best;
}

const char* name(Flag flag) {
  switch (flag) {
    case Flag::None: return "none";
    case Flag::Unjoined: return "unjoined";
    case Flag::NoDirection: return "no-direction";
    case Flag::Blocked: return "blocked";
    case Flag::NoExit: return "no-exit";
    case Flag::AuthoredCrossing: return "authored-crossing";
    case Flag::Budget: return "budget";
  }
  return "none";
}

const char* name(UnitSource source) {
  switch (source) {
    case UnitSource::Piece: return "piece";
    case UnitSource::Authored: return "authored";
    case UnitSource::Body: return "body";
    case UnitSource::Grown: return "grown";
  }
  return "piece";
}

}  // namespace bm::plan
