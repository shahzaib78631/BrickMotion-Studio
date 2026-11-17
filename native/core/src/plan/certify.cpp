#include "bm/plan/certify.h"

#include <algorithm>
#include <cmath>
#include "bm/plan/tolerances.h"

namespace bm::plan {
namespace {

using collide::World;
using connect::Connection;
using connect::Release;
using connect::ReleaseKind;

struct Checker {
  const Model& model;
  const connect::Graph& graph;
  const World& world;
  std::vector<std::vector<uint32_t>> connectionsOf;

  /// Whether a unit entering along `in` (unit vector) is what this mate takes, with `axis`
  /// stored as the way piece b leaves piece a.
  static bool takes(const Release& r, Vec3 in, bool unitIsB) {
    const Vec3 leaves = unitIsB ? r.axis : -r.axis;
    const double c = dot(-in, leaves);
    if (r.kind == ReleaseKind::Along) return c >= kReleaseAgree;
    if (r.kind == ReleaseKind::Either) return std::abs(c) >= kReleaseAgree;
    if (r.kind == ReleaseKind::Across) return std::abs(c) <= kAcrossAgree || (r.orAlong && std::abs(c) >= kReleaseAgree);
    return true;
  }

  Certificate run(const Plan& plan, const std::vector<uint32_t>* within) {
    Certificate out;
    const size_t n = model.pieces().size();
    World::Present placed(n, 0);
    std::vector<uint8_t> inside(n, within ? 0 : 1);
    if (within)
      for (uint32_t p : *within) inside[p] = 1;
    std::vector<uint8_t> groupStarted(graph.groups + 1, 0);
    for (const Move& m : plan.moves) {
      MoveCheck check;
      out.total++;
      auto inUnit = [&](uint32_t p) { return std::binary_search(m.unit.pieces.begin(), m.unit.pieces.end(), p); };
      if (m.flag != Flag::None) {
        check.flagged = true;
        out.flagged++;
        if (m.flag == Flag::Unjoined) out.unjoined++;
      } else {
        // Rule 1: joined to something placed, or the first of its group to be placed.
        bool starts = true;
        for (uint32_t p : m.unit.pieces) {
          const uint32_t g = p < graph.group.size() ? graph.group[p] : graph.groups;
          if (within ? std::any_of(within->begin(), within->end(), [&](uint32_t q) { return placed[q] != 0; }) : groupStarted[std::min<uint32_t>(g, graph.groups)] != 0) starts = false;
        }
        std::vector<collide::Zone> zones;
        bool along = true;
        Vec3 in{};
        double seatLength = 0;
        if (m.path.size() >= 2) {
          const Vec3 back = m.path[1].t - m.path[0].t;
          seatLength = length(back);
          if (seatLength > 0) in = back * (-1 / seatLength);
        }
        for (uint32_t p : m.unit.pieces) {
          for (uint32_t ci : connectionsOf[p]) {
            const Connection& c = graph.connections[ci];
            const uint32_t other = c.a == p ? c.b : c.a;
            if (inUnit(other) || !inside[other] || !placed[other]) continue;
            check.joined = true;
            for (uint32_t k = 0; k < c.zoneCount; k++) {
              const size_t at = static_cast<size_t>(c.firstZone) + k;
              if (at >= graph.releases.size()) break;
              if (!(length(in) > 0) || !takes(graph.releases[at], in, c.b == p)) along = false;
              const connect::MateZone& z = graph.zones[at];
              const double stride = std::max(1.0, z.radius);
              for (double s = 0; s <= seatLength + stride; s += stride) zones.push_back({z.a - in * s, z.b - in * s, z.radius, p, other});  // these two only
            }
          }
        }
        if (starts) check.joined = true;
        check.alongConnector = along && (length(in) > 0 || m.path.empty());
        if (m.path.empty()) check.alongConnector = false;  // no flight was shown at all
        // Rule 2: every leg of the flight, from open air to the seat.
        check.clear = !m.path.empty();
        for (size_t leg = m.path.size(); leg-- > 1 && check.clear;) {
          const Vec3 step = m.path[leg - 1].t - m.path[leg].t;
          const double len = length(step);
          if (!(len > 0)) continue;
          uint32_t hit = UINT32_MAX;
          const double got = world.clearTravel(m.unit.pieces, step * (1 / len), len, &placed, leg == 1 ? zones : std::vector<collide::Zone>{}, &hit, m.path[leg]);
          if (got < len - kTravelTol) check.clear = false, check.crossed = hit;
        }
        if (!check.joined) out.floating++;
        if (!check.clear) out.crossings++;
        if (!check.alongConnector) out.offAxis++;
        if (check.certified()) out.certified++;
      }
      for (uint32_t p : m.unit.pieces) {
        placed[p] = 1;
        if (p < graph.group.size()) groupStarted[std::min<uint32_t>(graph.group[p], graph.groups)] = 1;
      }
      out.moves.push_back(check);
    }
    for (size_t i = 0; i < plan.subs.size(); i++) {
      const std::vector<uint32_t>* unit = nullptr;
      for (const Move& m : plan.moves)
        if (m.sub == static_cast<int>(i)) unit = &m.unit.pieces;
      Certificate sub = unit ? run(plan.subs[i], unit) : Certificate{};
      out.total += sub.total, out.certified += sub.certified, out.floating += sub.floating, out.crossings += sub.crossings;
      out.offAxis += sub.offAxis, out.flagged += sub.flagged, out.unjoined += sub.unjoined;
      out.subs.push_back(std::move(sub));
    }
    return out;
  }
};

}  // namespace

Certificate certify(const Model& model, const connect::Graph& graph, ldraw::PartCache& parts, collide::ShapeCache& shapes, const Plan& plan) {
  const World world(model, parts, shapes);
  Checker checker{model, graph, world, {}};
  checker.connectionsOf.resize(model.pieces().size());
  for (uint32_t i = 0; i < graph.connections.size(); i++) {
    const Connection& c = graph.connections[i];
    if (c.a < checker.connectionsOf.size() && c.b < checker.connectionsOf.size()) checker.connectionsOf[c.a].push_back(i), checker.connectionsOf[c.b].push_back(i);
  }
  return checker.run(plan, nullptr);
}

}  // namespace bm::plan
