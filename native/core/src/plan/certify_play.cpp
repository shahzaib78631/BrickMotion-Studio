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
      std::vector<std::vector<collide::Zone>> mates(unit.size());  // for the strict check: each piece's own
      const Vec3 last = points.size() >= 2 ? points.back() - points[points.size() - 2] : Vec3{};
      const double seatLength = length(last);
      const Vec3 in = seatLength > 0 ? last * (1 / seatLength) : Vec3{};
      for (size_t ui = 0; ui < unit.size(); ui++) {
        const uint32_t p = unit[ui];
        for (uint32_t ci : connectionsOf[p]) {
          const Connection& c = graph.connections[ci];
          const uint32_t other = c.a == p ? c.b : c.a;
          if (!placed[other] || std::find(unit.begin(), unit.end(), other) != unit.end()) continue;
          for (uint32_t k = 0; k < c.zoneCount; k++) {
            const size_t at = static_cast<size_t>(c.firstZone) + k;
            if (at >= graph.zones.size()) break;
            const connect::MateZone& z = graph.zones[at];
            mates[ui].push_back({z.a, z.b, z.radius, other, collide::kAnyPiece});
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
      // Strict: every frame shown, turning included, each piece against every placed piece with
      // nothing let off but its own mates' zones once it is within its seat travel of the seat.
      std::vector<uint32_t> ignore;
      for (uint32_t q = 0; q < n; q++)
        if (!placed[q]) ignore.push_back(q);
      bool strict = false;
      for (int frame = f.startFrame; frame <= f.startFrame + f.frames && !strict; frame++) {
        const Xform motion = poseAt(f, frame);
        double turned = 0;
        for (int i = 0; i < 9; i++) turned = std::max(turned, std::abs(motion.r.m[i] - Mat3::identity().m[i]));
        const bool seating = length(motion.t) <= f.seatTravel + kClearMargin && turned < 1e-6;
        for (size_t ui = 0; ui < unit.size() && !strict; ui++) {
          const uint32_t p = unit[ui];
          std::vector<uint32_t> skip = ignore;
          skip.insert(skip.end(), atRest[p].begin(), atRest[p].end());
          const std::optional<uint32_t> hit = world.hits(world.shape(p), motion * world.pose(p), skip, seating ? mates[ui] : std::vector<collide::Zone>{});
          if (hit) {
            strict = true;
            out.strict.push_back({static_cast<uint32_t>(fi), p, *hit, frame});
          }
        }
      }
      if (strict) out.strictCrossings++;
    }
    for (uint32_t p : unit) placed[p] = 1;
  }
  return out;
}

}  // namespace bm::plan
