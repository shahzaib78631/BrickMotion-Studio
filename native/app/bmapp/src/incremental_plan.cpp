#include "incremental_plan.h"

#include <array>
#include <chrono>
#include <cstring>
#include <limits>
#include <tuple>
#include "bm/plan/tolerances.h"

namespace bmapp {
namespace {

using bm::Box;
using bm::plan::Flag;

bool intersects(const Box& a, const Box& b) {
  return !a.empty() && !b.empty() && a.min.x <= b.max.x && a.max.x >= b.min.x &&
      a.min.y <= b.max.y && a.max.y >= b.min.y && a.min.z <= b.max.z && a.max.z >= b.min.z;
}

bool stationaryRotation(const bm::Xform& pose) {
  const auto identity = bm::Mat3::identity();
  return std::equal(std::begin(pose.r.m), std::end(pose.r.m), std::begin(identity.m),
                    [](double a, double b) { return std::abs(a - b) < 1e-9; });
}

bool crossesChangedBox(const bm::plan::Move& move, const bm::collide::World& world, const Box& bounds) {
  Box seat;
  for (uint32_t p : move.unit.pieces) seat.merge(world.box(p));
  if (seat.empty()) return false;
  Box sweep = seat;
  for (const auto& pose : move.path) {
    if (!stationaryRotation(pose)) return true;  // preserve the constraints rather than estimate a curved sweep
    sweep.merge({seat.min + pose.t, seat.max + pose.t});
  }
  return intersects(sweep, bounds);
}

auto edgesAwayFrom(const bm::connect::Graph& graph, uint32_t piece) {
  std::vector<std::tuple<uint32_t, uint32_t, bm::connect::JointKind, uint16_t>> edges;
  for (const auto& edge : graph.connections)
    if (edge.a != piece && edge.b != piece) edges.emplace_back(edge.a, edge.b, edge.joint.kind, edge.mates);
  return edges;
}

bool unchangedApartFrom(const bm::Model& a, const bm::Model& b, uint32_t changed) {
  if (a.pieces().size() != b.pieces().size() || changed >= a.pieces().size()) return false;
  for (size_t i = 0; i < a.pieces().size(); ++i) {
    const auto& old = a.pieces()[i];
    const auto& now = b.pieces()[i];
    if (old.id != now.id || old.part != now.part || old.step != now.step || old.steps != now.steps || old.path != now.path) return false;
    if (i != changed && std::memcmp(&old.world, &now.world, sizeof old.world) != 0) return false;
  }
  return true;
}

}  // namespace

std::optional<IncrementalPlan> replanMove(const bm::Model& before, const bm::Model& after, uint32_t piece,
    const bmtools::Planned& previous, bm::ldraw::PartCache& parts, bmtools::ConnectorSources& sources,
    bm::collide::ShapeCache& shapes,
    const bm::plan::Style& style, const bm::plan::Options& options, bm::plan::FlightCheckCache& checks) {
  if (!previous.plan.complete || !unchangedApartFrom(before, after, piece)) return std::nullopt;
  const auto target = std::find_if(previous.plan.moves.begin(), previous.plan.moves.end(),
      [&](const auto& move) { return std::find(move.unit.pieces.begin(), move.unit.pieces.end(), piece) != move.unit.pieces.end(); });
  if (target == previous.plan.moves.end() || target->unit.pieces.size() != 1 || target->authoredFlight) return std::nullopt;
  const auto started = std::chrono::steady_clock::now();
  const bm::collide::World world(after, parts, shapes, options.travelCache);
  auto graph = bm::connect::buildGraph(after, sources.connectors, &sources.gears);
  bm::connect::inferJoints(graph, after, sources.connectors, world);
  // A former full solve may have dropped an inferred mate between two untouched parts. Keep
  // that solver decision. Exact connector pairs are still checked against the new graph.
  std::erase_if(graph.connections, [&](const auto& edge) {
    if (edge.a == piece || edge.b == piece || edge.found == bm::connect::Found::Connectors) return false;
    const auto key = std::pair{edge.a, edge.b};
    const auto saved = std::lower_bound(previous.graph.connections.begin(), previous.graph.connections.end(), key,
      [](const auto& c, const auto& key) { return std::pair{c.a, c.b} < key; });
    return saved == previous.graph.connections.end() || saved->a != edge.a || saved->b != edge.b;
  });
  bm::connect::regroup(graph);
  if (edgesAwayFrom(graph, piece) != edgesAwayFrom(previous.graph, piece)) return std::nullopt;
  const bm::plan::Context context(after, graph, world, options.down);
  std::vector<bool> neighbors(after.pieces().size());
  const std::array<const std::vector<bm::connect::Connection>*, 2> both{&graph.connections, &previous.graph.connections};
  for (const auto* connections : both) {
    for (const auto& edge : *connections) {
      if (edge.a == piece) neighbors[edge.b] = true;
      if (edge.b == piece) neighbors[edge.a] = true;
    }
  }
  // Both the old and the new occupied volume can change whether a nearby move is possible.
  Box changed = world.box(piece);
  const auto oldShape = before.mesh(before.pieces()[piece].part, parts);
  if (oldShape) changed.merge(oldShape->bounds.transformed(before.pieces()[piece].world));
  Box bounds;
  for (uint32_t i = 0; i < world.size(); ++i) bounds.merge(world.box(i));
  bm::collide::World::Present present(after.pieces().size(), 0);

  // The sequencer inserts a piece only where it rests on the table or joins a placed piece.
  // Where the table is follows the lowest piece: if the edit moves it, every rest changes.
  constexpr double kOnTable = 0.5;  // LDU, as the sequencer
  const auto bottomOf = [&](const Box& b) {
    if (b.empty()) return -std::numeric_limits<double>::infinity();
    double low = -std::numeric_limits<double>::infinity();
    for (int c = 0; c < 8; c++)
      low = std::max(low, bm::dot(options.down, bm::Vec3{c & 1 ? b.max.x : b.min.x, c & 2 ? b.max.y : b.min.y,
                                                         c & 4 ? b.max.z : b.min.z}));
    return low;
  };
  double tableBefore = -std::numeric_limits<double>::infinity(), table = tableBefore;
  for (uint32_t i = 0; i < world.size(); ++i) {
    const double bottom = bottomOf(world.box(i));
    table = std::max(table, bottom);
    tableBefore = std::max(tableBefore, i == piece && oldShape
        ? bottomOf(oldShape->bounds.transformed(before.pieces()[piece].world)) : bottom);
  }
  if (std::abs(table - tableBefore) > 1e-9) return std::nullopt;
  const auto supported = [&](const std::vector<uint32_t>& unit) {
    for (uint32_t p : unit) {
      if (bottomOf(world.box(p)) >= table - kOnTable) return true;
      for (uint32_t ci : context.connectionsOf[p]) {
        const auto& edge = context.graph.connections[ci];
        const uint32_t other = edge.a == p ? edge.b : edge.a;
        if (present[other] && std::find(unit.begin(), unit.end(), other) == unit.end()) return true;
      }
    }
    return false;
  };

  IncrementalPlan out;
  out.planned.plan = previous.plan;
  out.planned.plan.extractions = 0;
  for (auto& move : out.planned.plan.moves) {
    if (options.cancel && options.cancel->cancelled()) return std::nullopt;
    const auto& unit = move.unit.pieces;
    const bool moved = !unit.empty() && unit.front() == piece;
    const bool adjacent = present[piece] && std::any_of(unit.begin(), unit.end(), [&](uint32_t p) { return neighbors[p]; });
    const bool clashes = present[piece] && crossesChangedBox(move, world, changed);
    if (moved || adjacent || clashes || move.blocker == piece) {
      if (move.authoredFlight) return std::nullopt;
      if (!supported(unit)) return std::nullopt;  // the order itself must change: a full solve
      bm::Vec3 axis;
      if (options.authored && unit.size() == 1 && unit.front() < options.authored->insertionAxis.size())
        axis = options.authored->insertionAxis[unit.front()];
      auto clear = bm::plan::extract(context, move.unit, &present, bounds, axis, true);
      ++out.planned.plan.extractions;
      if (!clear.ok) return std::nullopt;
      move.path = std::move(clear.path);
      move.insertion = -clear.direction;
      move.seatTravel = clear.seatTravel;
      move.blocker = UINT32_MAX;
      move.flag = moved && context.connectionsOf[piece].empty() ? Flag::Unjoined : Flag::None;
    } else {
      ++out.reused;
    }
    for (uint32_t i : unit) present[i] = 1;
  }
  if (out.reused == 0) return std::nullopt;
  out.planned.plan.planMs = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - started).count();
  out.planned.timeline = bm::plan::buildTimeline(after, parts, out.planned.plan, style, options.down,
                                                nullptr, nullptr, &shapes, options.cancel, &checks, options.travelCache);
  if (options.cancel && options.cancel->cancelled()) return std::nullopt;
  out.planned.graph = std::move(graph);
  return out;
}

}  // namespace bmapp
