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
  double floor = -std::numeric_limits<double>::infinity();
  for (uint32_t p = 0; p < n; p++)
    if (!world.box(p).empty()) floor = std::max(floor, farAlong(world.box(p), down));

  // The order against the file's steps, and what goes in from below.
  std::vector<int> lowest(plan.moves.size(), 0), highest(plan.moves.size(), 0);
  for (size_t i = 0; i < plan.moves.size(); i++) {
    const Move& m = plan.moves[i];
    lowest[i] = std::numeric_limits<int>::max(), highest[i] = std::numeric_limits<int>::min();
    for (uint32_t p : m.unit.pieces) lowest[i] = std::min(lowest[i], model.pieces()[p].step), highest[i] = std::max(highest[i], model.pieces()[p].step);
    for (size_t j = 0; j < i; j++)
      if (lowest[j] > highest[i]) out.inversions++;
    if (m.flag == Flag::None && dot(m.insertion, down) < -0.5) out.upward++;
  }

  World::Present placed(n, 0);
  for (const Flight& f : timeline.flights) {
    if (f.move >= plan.moves.size()) continue;
    const Move& m = plan.moves[f.move];
    if (f.frames > 0 && m.flag == Flag::None) {
      out.flights++;
      const std::vector<Vec3> points = playedPath(f, 2.0);
      // The seat leg: its mates with placed pieces may cross where they mate.
      std::vector<collide::Zone> zones;
      if (points.size() >= 2) {
        const Vec3 last = points.back() - points[points.size() - 2];
        const double seatLength = length(last);
        const Vec3 in = seatLength > 0 ? last * (1 / seatLength) : Vec3{};
        for (uint32_t p : m.unit.pieces)
          for (uint32_t ci : connectionsOf[p]) {
            const Connection& c = graph.connections[ci];
            const uint32_t other = c.a == p ? c.b : c.a;
            if (!placed[other] || std::binary_search(m.unit.pieces.begin(), m.unit.pieces.end(), other)) continue;
            for (uint32_t k = 0; k < c.zoneCount; k++) {
              const size_t at = static_cast<size_t>(c.firstZone) + k;
              if (at >= graph.zones.size()) break;
              const connect::MateZone& z = graph.zones[at];
              const double stride = std::max(1.0, z.radius);
              for (double s = 0; s <= seatLength + stride; s += stride) zones.push_back({z.a - in * s, z.b - in * s, z.radius, p, other});
            }
          }
      }
      Box unitBox;
      for (uint32_t p : m.unit.pieces) unitBox.merge(world.box(p));
      const double unitFar = unitBox.empty() ? 0 : farAlong(unitBox, down);
      bool crossed = false, under = false;
      for (size_t k = 0; k < points.size(); k++) {
        if (!unitBox.empty() && unitFar + dot(down, points[k]) > floor + m.seatTravel + kClearMargin) under = true;
        if (k + 1 >= points.size() || crossed) continue;
        const Vec3 step = points[k + 1] - points[k];
        const double len = length(step);
        if (!(len > 0)) continue;
        Xform from;
        from.t = points[k];
        uint32_t hit = UINT32_MAX;
        const bool seatLeg = k + 2 == points.size();
        const double got = world.clearTravel(m.unit.pieces, step * (1 / len), len, &placed, seatLeg ? zones : std::vector<collide::Zone>{}, &hit, from);
        if (got < len - kTravelTol) crossed = true;
      }
      if (crossed) out.crossings++, out.crossed.push_back(f.move);
      if (under) out.underFloor++, out.under.push_back(f.move);
    }
    for (uint32_t p : m.unit.pieces) placed[p] = 1;
  }
  return out;
}

}  // namespace bm::plan
