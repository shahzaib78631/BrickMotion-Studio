#include "incremental_plan.h"

#include <array>
#include <chrono>
#include <cstring>
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
    const bm::plan::Style& style, const bm::plan::Options& options) {
  if (!previous.plan.complete || !unchangedApartFrom(before, after, piece)) return std::nullopt;
  const auto target = std::find_if(previous.plan.moves.begin(), previous.plan.moves.end(),
      [&](const auto& move) { return std::find(move.unit.pieces.begin(), move.unit.pieces.end(), piece) != move.unit.pieces.end(); });
  if (target == previous.plan.moves.end() || target->unit.pieces.size() != 1 || target->authoredFlight) return std::nullopt;
  const auto started = std::chrono::steady_clock::now();
  const bm::collide::World world(after, parts, shapes);
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
  const bm::plan::Context context(after, graph, world);
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
  changed.merge(oldShape->bounds.transformed(before.pieces()[piece].world));
  Box bounds;
  for (uint32_t i = 0; i < world.size(); ++i) bounds.merge(world.box(i));
  bm::collide::World::Present present(after.pieces().size(), 0);

  IncrementalPlan out;
  out.planned.plan = previous.plan;
  out.planned.plan.extractions = 0;
  bool sameRoutes = true;
  for (auto& move : out.planned.plan.moves) {
    if (options.cancel && options.cancel->cancelled()) return std::nullopt;
    const auto& unit = move.unit.pieces;
    const bool moved = !unit.empty() && unit.front() == piece;
    const bool adjacent = present[piece] && std::any_of(unit.begin(), unit.end(), [&](uint32_t p) { return neighbors[p]; });
    const bool clashes = present[piece] && crossesChangedBox(move, world, changed);
    if (moved || adjacent || clashes || move.blocker == piece) {
      if (move.authoredFlight) return std::nullopt;
      bm::Vec3 axis;
      if (options.authored && unit.size() == 1 && unit.front() < options.authored->insertionAxis.size())
        axis = options.authored->insertionAxis[unit.front()];
      const auto clear = bm::plan::extract(context, move.unit, &present, bounds, axis, false);
      ++out.planned.plan.extractions;
      if (!clear.ok) return std::nullopt;
      sameRoutes = sameRoutes && move.path.size() == clear.path.size() &&
        std::equal(move.path.begin(), move.path.end(), clear.path.begin(), [](const auto& a, const auto& b) {
          return bm::length(a.t - b.t) <= 1e-7 && std::equal(std::begin(a.r.m), std::end(a.r.m), std::begin(b.r.m),
            [](double x, double y) { return std::abs(x - y) <= 1e-9; });
        });
      move.path = clear.path;
      move.insertion = -clear.direction;
      move.seatTravel = clear.seatTravel;
      move.blocker = UINT32_MAX;
      move.flag = Flag::None;
      if (moved && context.connectionsOf[piece].empty()) move.flag = Flag::Unjoined;
    } else {
      ++out.reused;
    }
    for (uint32_t i : unit) present[i] = 1;
  }
  if (out.reused == 0) return std::nullopt;
  out.planned.plan.planMs = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - started).count();
  // A byte-for-byte equivalent seat path still needs new staging distances for a new pose.
  // Keep the already checked flights if the pose is the same (e.g. undoing an in-flight edit).
  if (sameRoutes && std::memcmp(&before.pieces()[piece].world, &after.pieces()[piece].world, sizeof(bm::Xform)) == 0)
    out.planned.timeline = previous.timeline;
  else
    out.planned.timeline = bm::plan::buildTimeline(after, parts, out.planned.plan, style, options.down);
  out.planned.graph = std::move(graph);
  return out;
}

}  // namespace bmapp
