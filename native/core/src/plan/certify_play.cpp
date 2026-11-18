#include <algorithm>
#include <cmath>
#include <limits>
#include "bm/plan/certify.h"
#include "bm/plan/timeline.h"
#include "bm/plan/tolerances.h"

namespace bm::plan {
namespace {

using collide::World;
using connect::Connection;

/// The far side of a box along `d`.
double farAlong(const Box& b, Vec3 d) {
  double hi = -std::numeric_limits<double>::infinity();
  for (int c = 0; c < 8; c++) hi = std::max(hi, dot(d, Vec3{c & 1 ? b.max.x : b.min.x, c & 2 ? b.max.y : b.min.y, c & 4 ? b.max.z : b.min.z}));
  return hi;
}

Box boxOf(const World& world, uint32_t p, const Xform& motion) {
  return world.shape(p).nodes.empty() ? Box{} : world.shape(p).bounds.transformed(motion * world.pose(p));
}

bool meets(const Box& a, const Box& b) {
  return !a.empty() && !b.empty() && a.min.x <= b.max.x && b.min.x <= a.max.x && a.min.y <= b.max.y && b.min.y <= a.max.y && a.min.z <= b.max.z && b.min.z <= a.max.z;
}

/// How far anything on a body of `radius` moves between two motions: the way, and the turn.
double travelled(const Xform& a, const Xform& b, double radius) {
  double turn = 0;
  for (int i = 0; i < 9; i++) turn += (a.r.m[i] - b.r.m[i]) * (a.r.m[i] - b.r.m[i]);
  return length(a.t - b.t) + radius * std::sqrt(turn);  // the Frobenius distance bounds the angle (radians) from above, near enough
}

/// The strict check, from the timeline alone: every flight as shown, against every other piece
/// shown where the timeline has it then (built, on the floor, in a unit on its spot). Flights
/// do not overlap in time, so while one flies everything else stands still.
void strictCheck(PlayCheck& out, const Model& model, const connect::Graph& graph, const World& world, const Plan& plan, const Timeline& timeline,
                 const std::vector<std::vector<uint32_t>>& connectionsOf, const std::vector<std::vector<uint32_t>>& atRest) {
  const auto& flights = timeline.flights;
  const size_t n = model.pieces().size();
  const std::vector<int> owner = owners(timeline, plan, n);
  // Each flight's state, two-valued between flights: where it waits, then its seat.
  std::vector<uint8_t> landed(flights.size(), 0);
  auto still = [&](size_t fi) {
    Xform x = landed[fi] || flights[fi].frames <= 0 ? (flights[fi].waypoints.empty() ? Xform{} : flights[fi].waypoints.back()) : (flights[fi].waypoints.empty() ? Xform{} : flights[fi].waypoints.front());
    for (int up = flights[fi].parent, guard = 0; up >= 0 && guard < 64; up = flights[static_cast<size_t>(up)].parent, guard++) {
      const Flight& u = flights[static_cast<size_t>(up)];
      x = (u.waypoints.empty() ? Xform{} : landed[static_cast<size_t>(up)] || u.frames <= 0 ? u.waypoints.back() : u.waypoints.front()) * x;
    }
    return x;
  };
  std::vector<std::vector<uint32_t>> inFlight(flights.size());
  for (uint32_t p = 0; p < n; p++)
    if (owner[p] >= 0) inFlight[static_cast<size_t>(owner[p])].push_back(p);
  // A piece's flight and every flight that carries it.
  auto carriedBy = [&](uint32_t p, size_t fi) {
    for (int g = owner[p], guard = 0; g >= 0 && guard < 64; g = flights[static_cast<size_t>(g)].parent, guard++)
      if (static_cast<size_t>(g) == fi) return true;
    return false;
  };
  std::vector<uint8_t> moving(n, 0);
  for (size_t fi = 0; fi < flights.size(); fi++) {
    const Flight& f = flights[fi];
    const std::vector<uint32_t>& unit = piecesOf(f, plan);
    if (f.frames > 0 && f.flag == Flag::None && !unit.empty() && !f.waypoints.empty()) {
      for (uint32_t p : unit) moving[p] = carriedBy(p, fi);
      // What carries it (the unit it helps build, on its spot), fixed while it flies.
      Xform carry;
      for (int up = f.parent, guard = 0; up >= 0 && guard < 64; up = flights[static_cast<size_t>(up)].parent, guard++)
        carry = (flights[static_cast<size_t>(up)].waypoints.empty() ? Xform{} : flights[static_cast<size_t>(up)].waypoints.front()) * carry;
      // The swept box of the flight, to keep only obstacles it can reach.
      Box unitBox;
      for (uint32_t p : unit) unitBox.merge(world.box(p));
      const double radius = unitBox.empty() ? 0 : 0.5 * length(unitBox.max - unitBox.min);
      std::vector<double> times;
      times.push_back(f.startFrame);
      for (int k = f.startFrame; k < f.startFrame + f.frames; k++) {
        const int pieces = std::max(1, static_cast<int>(std::ceil(travelled(poseAt(f, k), poseAt(f, k + 1), radius) / collide::kSweepStep)));
        for (int i = 1; i <= pieces; i++) times.push_back(k + static_cast<double>(i) / pieces);
      }
      Box swept;
      for (size_t i = 0; i < times.size(); i += std::max<size_t>(1, times.size() / 400)) swept.merge(unitBox.transformed(carry * poseAt(f, times[i])));
      swept.merge(unitBox.transformed(carry * poseAt(f, times.back())));
      swept.min = swept.min - Vec3{radius, radius, radius}, swept.max = swept.max + Vec3{radius, radius, radius};
      struct Obstacle {
        uint32_t piece;
        Xform pose;
        Box box;
        const Flight* flight;
      };
      std::vector<Obstacle> obstacles;
      for (uint32_t q = 0; q < n; q++) {
        if (moving[q] || world.shape(q).nodes.empty()) continue;
        const Xform m = owner[q] >= 0 ? still(static_cast<size_t>(owner[q])) : Xform{};
        const Box b = boxOf(world, q, m);
        if (meets(b, swept)) obstacles.push_back({q, m * world.pose(q), b, owner[q] >= 0 ? &flights[static_cast<size_t>(owner[q])] : nullptr});
      }
      // Each piece's own mates, carried to where it seats: it may cross them there.
      std::vector<std::vector<collide::Zone>> mates(unit.size());
      for (size_t ui = 0; ui < unit.size(); ui++)
        for (uint32_t ci : connectionsOf[unit[ui]]) {
          const Connection& c = graph.connections[ci];
          const uint32_t other = c.a == unit[ui] ? c.b : c.a;
          for (uint32_t k = 0; k < c.zoneCount; k++) {
            const size_t at = static_cast<size_t>(c.firstZone) + k;
            if (at >= graph.zones.size()) break;
            const connect::MateZone& z = graph.zones[at];
            mates[ui].push_back({carry.apply(z.a), carry.apply(z.b), z.radius, other, collide::kAnyPiece});
          }
        }
      bool hit = false;
      for (size_t ti = 0; ti < times.size() && !hit; ti++) {
        const double at = times[ti];
        const Xform own = poseAt(f, at), motion = carry * own;
        double turned = 0;
        for (int i = 0; i < 9; i++) turned = std::max(turned, std::abs(own.r.m[i] - Mat3::identity().m[i]));
        const bool seating = length(own.t) <= f.seatTravel + kClearMargin && turned < 1e-6;
        for (size_t ui = 0; ui < unit.size() && !hit; ui++) {
          const uint32_t p = unit[ui];
          if (world.shape(p).nodes.empty()) continue;
          const Xform pose = motion * world.pose(p);
          const Box box = world.shape(p).bounds.transformed(pose);
          for (const Obstacle& o : obstacles) {
            if (!meets(box, o.box) || (o.flight && !shownAt(*o.flight, at))) continue;
            if (std::find(atRest[p].begin(), atRest[p].end(), o.piece) != atRest[p].end()) continue;
            std::vector<collide::Zone> zones;
            if (seating)
              for (const collide::Zone& z : mates[ui])
                if (z.first == o.piece) zones.push_back(z);
            if (!collide::overlap(world.shape(p), pose, world.shape(o.piece), o.pose, zones)) continue;
            hit = true;
            const PlayCheck::Leg leg = seating || at >= f.startFrame + f.seatAt ? PlayCheck::Leg::Seat : at >= f.startFrame + f.pathAt ? PlayCheck::Leg::Path : PlayCheck::Leg::Transit;
            out.strict.push_back({static_cast<uint32_t>(fi), p, o.piece, static_cast<int>(std::floor(at)), at, leg});
            break;
          }
        }
      }
      if (hit) out.strictCrossings++;
      for (uint32_t p : unit) moving[p] = 0;
    }
    landed[fi] = 1;
  }
}

}  // namespace

PlayCheck certifyPlay(const Model& model, const connect::Graph& graph, ldraw::PartCache& parts, collide::ShapeCache& shapes, const Plan& plan, const Timeline& timeline, Vec3 down) {
  PlayCheck out;
  down = length(down) > 0 ? normalized(down) : Vec3{0, 1, 0};
  const World world(model, parts, shapes);
  const size_t n = model.pieces().size();
  std::vector<std::vector<uint32_t>> connectionsOf(n);
  for (uint32_t i = 0; i < graph.connections.size(); i++) {
    const Connection& c = graph.connections[i];
    if (c.a < n && c.b < n) connectionsOf[c.a].push_back(i), connectionsOf[c.b].push_back(i);
  }
  auto floorOf = [&](const std::vector<uint32_t>& set) {
    double floor = -std::numeric_limits<double>::infinity();
    for (uint32_t p : set)
      if (!world.box(p).empty()) floor = std::max(floor, farAlong(world.box(p), down));
    return floor;
  };
  std::vector<uint32_t> everything(n);
  for (uint32_t p = 0; p < n; p++) everything[p] = p;
  const double modelFloor = floorOf(everything);
  const auto& flights = timeline.flights;
  std::vector<uint8_t> hasChild(flights.size(), 0);
  for (const Flight& f : flights)
    if (f.parent >= 0 && static_cast<size_t>(f.parent) < flights.size()) hasChild[static_cast<size_t>(f.parent)] = 1;

  // The order against the file's steps, and what goes in from below: every piece once, where it
  // is first put in place (a unit's own build counts, not the unit flying in whole).
  std::vector<std::vector<int>> lowest, highest;
  for (size_t fi = 0; fi < flights.size(); fi++) {
    const Flight& f = flights[fi];
    if (f.flag == Flag::None && f.frames > 0 && dot(f.insertion, down) < -0.5) out.upward++;
    if (hasChild[fi]) continue;
    std::vector<int> lo, hi;
    for (uint32_t p : piecesOf(f, plan)) {
      const std::vector<int> s = stepsOf(model.pieces()[p]);
      if (lo.empty() || laterSteps(lo, s)) lo = s;
      if (hi.empty() || laterSteps(s, hi)) hi = s;
    }
    if (lo.empty()) continue;
    for (size_t j = 0; j < lowest.size(); j++)
      if (laterSteps(lowest[j], hi)) out.inversions++;
    lowest.push_back(lo), highest.push_back(hi);
  }

  // Where each piece already crosses another at its seat: not a flight's doing.
  std::vector<std::vector<uint32_t>> atRest(n);
  for (uint32_t p = 0; p < n; p++) {
    std::vector<uint32_t> ignore{p};
    for (int k = 0; k < 16; k++) {
      const std::optional<uint32_t> hit = world.hits(world.shape(p), world.pose(p), ignore);
      if (!hit) break;
      ignore.push_back(*hit), atRest[p].push_back(*hit);
    }
  }

  // Each flight against what is built where it lands: the model for a top-level flight, the
  // unit's own pieces for a flight of a unit's build.
  std::vector<World::Present> placedIn(flights.size() + 1);
  for (size_t fi = 0; fi < flights.size(); fi++) {
    const Flight& f = flights[fi];
    const std::vector<uint32_t>& unit = piecesOf(f, plan);
    const size_t context = f.parent >= 0 ? static_cast<size_t>(f.parent) + 1 : 0;
    World::Present& placed = placedIn[context];
    if (placed.empty()) placed.assign(n, 0);
    const double floor = context == 0 ? modelFloor : floorOf(piecesOf(flights[context - 1], plan));
    if (f.frames > 0 && f.flag == Flag::None && !unit.empty()) {
      out.flights++;
      const std::vector<Vec3> points = playedPath(f, 2.0);
      // The seat leg: its mates with placed pieces may cross where they mate.
      std::vector<collide::Zone> zones;
      const Vec3 last = points.size() >= 2 ? points.back() - points[points.size() - 2] : Vec3{};
      const double seatLength = length(last);
      const Vec3 in = seatLength > 0 ? last * (1 / seatLength) : Vec3{};
      for (uint32_t p : unit) {
        for (uint32_t ci : connectionsOf[p]) {
          const Connection& c = graph.connections[ci];
          const uint32_t other = c.a == p ? c.b : c.a;
          if (!placed[other] || std::find(unit.begin(), unit.end(), other) != unit.end()) continue;
          for (uint32_t k = 0; k < c.zoneCount; k++) {
            const size_t at = static_cast<size_t>(c.firstZone) + k;
            if (at >= graph.zones.size()) break;
            const connect::MateZone& z = graph.zones[at];
            if (points.size() < 2) continue;
            const double stride = std::max(1.0, z.radius);
            const double carried = at < graph.releases.size() && carriesZone(graph.releases[at], in) ? seatLength + stride : 0;
            for (double s = 0; s <= carried; s += stride) zones.push_back({z.a - in * s, z.b - in * s, z.radius, p, other});
          }
        }
      }
      Box unitBox;
      for (uint32_t p : unit) unitBox.merge(world.box(p));
      const double unitFar = unitBox.empty() ? 0 : farAlong(unitBox, down);
      bool crossed = false, under = false;
      for (size_t k = 0; k < points.size(); k++) {
        if (!unitBox.empty() && unitFar + dot(down, points[k]) > floor + f.seatTravel + kClearMargin) under = true;
        if (k + 1 >= points.size() || crossed) continue;
        const Vec3 step = points[k + 1] - points[k];
        const double len = length(step);
        if (!(len > 0)) continue;
        Xform from;
        from.t = points[k];
        uint32_t hit = UINT32_MAX;
        const bool seatLeg = k + 2 == points.size();
        const double got = world.clearTravel(unit, step * (1 / len), len, &placed, seatLeg ? zones : std::vector<collide::Zone>{}, &hit, from);
        if (got < len - kTravelTol) crossed = true;
      }
      if (crossed) out.crossings++, out.crossed.push_back(static_cast<uint32_t>(fi));
      if (under) out.underFloor++, out.under.push_back(static_cast<uint32_t>(fi));
    }
    for (uint32_t p : unit) placed[p] = 1;
  }
  strictCheck(out, model, graph, world, plan, timeline, connectionsOf, atRest);
  return out;
}

}  // namespace bm::plan
