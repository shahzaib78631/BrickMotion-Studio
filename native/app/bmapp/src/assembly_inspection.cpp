#include "bmapp/assembly_inspection.h"

#include <numbers>
#include <set>
#include "bm/collide/world.h"
#include "bm/kin/system.h"
#include "bm/plan/plan.h"
#include "engine.h"
#include "placement_solver.h"
#include "session_impl.h"

namespace bmapp {
namespace {

Vec3 vertex(bm::Vec3 p) { return {p.x, p.y, p.z}; }

JointType typeOf(bm::connect::JointKind kind) {
  using K = bm::connect::JointKind;
  switch (kind) {
    case K::Fixed: return JointType::Fixed;
    case K::Revolute: return JointType::Hinge;
    case K::Prismatic: return JointType::Slider;
    case K::Cylindrical: return JointType::Cylindrical;
    case K::Spherical: return JointType::Ball;
    case K::Flexible: return JointType::Flexible;
  }
  return JointType::Fixed;
}

double turn(const bm::Piece& a, const bm::Piece& b, bm::Vec3 axis, bool ball) {
  double best = -1, angle = 0;
  axis = bm::normalized(axis);
  for (int i = 0; i < 3; i++) {
    bm::Vec3 u{a.world.r.m[i], a.world.r.m[i + 3], a.world.r.m[i + 6]};
    bm::Vec3 v{b.world.r.m[i], b.world.r.m[i + 3], b.world.r.m[i + 6]};
    if (!ball) {
      u = u - axis * bm::dot(u, axis);
      v = v - axis * bm::dot(v, axis);
    }
    const double scale = bm::length(u) * bm::length(v);
    if (scale < 1e-8 || scale <= best) continue;
    best = scale;
    const double cos = bm::dot(u, v) / scale;
    angle = ball ? std::acos(std::clamp(cos, -1.0, 1.0)) : std::atan2(bm::dot(bm::cross(u, v), axis) / scale, cos);
  }
  return angle * (180 / std::numbers::pi);
}

bool samePose(const bm::Piece& a, const bm::Piece& b) {
  return a.part == b.part && bm::length(a.world.t - b.world.t) < 1e-6 &&
         std::equal(std::begin(a.world.r.m), std::end(a.world.r.m), std::begin(b.world.r.m),
                    [](double x, double y) { return std::abs(x - y) < 1e-6; });
}

bm::Xform rotated(bm::Vec3 axis, bm::Vec3 point, double radians) {
  const double s = std::sin(radians), c = std::cos(radians);
  const auto column = [&](bm::Vec3 v) { return v * c + bm::cross(axis, v) * s + axis * (bm::dot(axis, v) * (1 - c)); };
  const auto x = column({1, 0, 0}), y = column({0, 1, 0}), z = column({0, 0, 1});
  const bm::Mat3 r{{x.x, y.x, z.x, x.y, y.y, z.y, x.z, y.z, z.z}};
  return {r, point - r * point};
}

JointEdit refused(const std::string& reason) {
  JointEdit out;
  out.error = reason;
  return out;
}

}  // namespace

struct AssemblyInspection::Impl {
  std::shared_ptr<Session::Impl> backing;
  bm::Model model;
  PieceList hidden;
  std::unique_ptr<bmtools::ConnectorSources> sources;
  std::optional<bm::connect::Graph> graph;
  bm::collide::ShapeCache shapes;
  std::unique_ptr<bm::collide::World> world;
  std::unique_ptr<PlacementSolver> placement;
  std::optional<bm::kin::System> mechanism;

  Impl(std::shared_ptr<Session::Impl> source) : backing(std::move(source)), model(*backing->model), hidden(backing->hidden) {}

  const bm::connect::Graph& joints() {
    if (!graph) {
      sources = std::make_unique<bmtools::ConnectorSources>(*backing->library, backing->ldraw);
      graph = bm::connect::buildGraph(model, sources->connectors, &sources->gears);
    }
    return *graph;
  }

  bm::collide::World& geometry() {
    if (!world) world = std::make_unique<bm::collide::World>(model, *backing->full, shapes);
    return *world;
  }

  bool visible(uint32_t piece) const { return !std::binary_search(hidden.begin(), hidden.end(), piece); }

  PlacementSolver& solver() {
    (void)joints();
    if (!placement) placement = std::make_unique<PlacementSolver>(model, *backing->full, sources->connectors, shapes);
    return *placement;
  }
};

AssemblyInspection::AssemblyInspection(std::unique_ptr<Impl> impl) : impl_(std::move(impl)) {}
AssemblyInspection::~AssemblyInspection() = default;

AssemblyInspection* AssemblyInspection::capture(const Session* session) {
  if (!session || !session->impl().model) return nullptr;
  return new AssemblyInspection(std::make_unique<Impl>(session->shared()));
}

PieceList AssemblyInspection::body(uint32_t piece) {
  const auto& rigid = impl_->joints().body;
  PieceList out;
  if (piece < rigid.size())
    for (uint32_t i = 0; i < rigid.size(); ++i)
      if (rigid[i] == rigid[piece] && impl_->visible(i)) out.push_back(i);
  return out;
}

std::vector<FitPose> AssemblyInspection::fits(uint32_t moving, uint32_t target) {
  std::vector<FitPose> out;
  if (moving >= impl_->model.pieces().size()) return out;
  try {
    const bm::Vec3 start = impl_->model.pieces()[moving].world.t;
    for (const auto& fit : impl_->solver().fits(moving, target)) {
      FitPose result;
      std::copy_n(fit.pose.r.m, 9, result.pose.rotation.m);
      result.pose.position = vertex(fit.pose.t);
      result.contact = vertex(fit.contact);
      result.travel = bm::length(fit.pose.t - start);
      out.push_back(result);
    }
  } catch (const std::exception&) {
    return {};
  }
  return out;
}

std::vector<FittingPart> AssemblyInspection::fittingParts(uint32_t target, const std::vector<std::string>& candidates, size_t limit) {
  std::vector<FittingPart> out;
  if (target >= impl_->model.pieces().size() || !impl_->visible(target)) return out;
  try {
    auto& solver = impl_->solver();
    for (const auto& part : candidates) {
      if (out.size() >= limit) break;
      if (const auto fit = solver.fitNew(part, target)) out.push_back({part, vertex(fit->contact)});
    }
  } catch (const std::exception&) {
    return out;
  }
  return out;
}
JointEdit AssemblyInspection::changeJoint(uint32_t fixed, uint32_t moving, double degrees, bool collision) {
  try {
    const auto& pieces = impl_->model.pieces();
    if (fixed >= pieces.size() || moving >= pieces.size() || !std::isfinite(degrees) || std::abs(degrees) > 90)
      return refused("Choose a connection first.");
    const auto& graph = impl_->joints();
    const auto pair = std::minmax(fixed, moving);
    const auto edge = std::find_if(graph.connections.begin(), graph.connections.end(), [&](const auto& c) {
      return c.a == pair.first && c.b == pair.second;
    });
    if (edge == graph.connections.end()) return refused("The two parts are no longer connected.");
    JointEdit out;
    out.pivot = moving;
    std::vector<bool> branch(pieces.size());
    std::vector<std::vector<uint32_t>> neighbors(pieces.size());
    for (const auto& connection : graph.connections) {
      if (&connection == &*edge) continue;
      neighbors[connection.a].push_back(connection.b);
      neighbors[connection.b].push_back(connection.a);
    }
    out.pieces.push_back(moving);
    branch[moving] = true;
    for (size_t i = 0; i < out.pieces.size(); ++i) {
      for (uint32_t p : neighbors[out.pieces[i]]) {
        if (p == fixed) return refused("Another connection holds this branch in place.");
        if (branch[p]) continue;
        branch[p] = true;
        out.pieces.push_back(p);
      }
    }
    std::sort(out.pieces.begin(), out.pieces.end());
    bm::Xform delta;
    if (degrees == 0) {
      const auto& world = impl_->geometry();
      const bm::plan::Context context(impl_->model, graph, world);
      const auto exits = bm::plan::leaveDirections(context, {out.pieces}, nullptr);
      bool separated = false;
      for (const auto& exit : exits) {
        if (bm::length(exit.direction) < 0.5) continue;
        const double distance = std::max(8.0, exit.travel + 4);
        std::vector<bm::collide::Zone> zones;
        for (size_t i = edge->firstZone; i < edge->firstZone + edge->zoneCount; i++) {
          const auto& zone = graph.zones[i];
          if (!bm::plan::carriesZone(graph.releases[i], exit.direction)) continue;
          zones.push_back({zone.a, zone.b, zone.radius, fixed, moving});
        }
        if (collision && world.clearTravel(out.pieces, exit.direction, distance, nullptr, zones) < distance - 0.01) continue;
        delta.t = exit.direction * distance;
        separated = true;
        break;
      }
      if (!separated) return refused("There is no clear release along this connection.");
    } else {
      if (!impl_->mechanism)
        impl_->mechanism = bm::kin::buildSystem(impl_->model, graph, nullptr, nullptr, {.testTravel = false});
      const auto bodies = std::minmax(impl_->mechanism->bodyOf[fixed], impl_->mechanism->bodyOf[moving]);
      const auto& links = impl_->mechanism->links;
      const auto link = std::find_if(links.begin(), links.end(), [&](const auto& l) { return l.a == bodies.first && l.b == bodies.second; });
      if (link == links.end() || link->kind == bm::connect::JointKind::Prismatic)
        return refused("This connection cannot turn.");
      bm::Vec3 axis = bm::normalized(link->axis);
      if (bm::length(axis) < 0.5 && link->kind == bm::connect::JointKind::Spherical) axis = {0, 1, 0};
      if (bm::length(axis) < 0.5) return refused("This connection has no rotation axis.");
      const double radians = degrees * std::numbers::pi / 180;
      delta = rotated(axis, link->point, radians);
      if (collision) {
        std::vector<MovingPiece> dragged;
        for (uint32_t p : out.pieces) dragged.push_back({p, {}});
        const auto& start = pieces[moving].world;
        const auto& bounds = impl_->geometry().box(moving);
        const double radius = bounds.empty() ? 20 : bm::length(bounds.max - bounds.min);
        const int intervals = std::clamp(static_cast<int>(std::ceil(std::abs(radians) * radius / 2)), 3, 72);
        for (int i = 1; i <= intervals; i++) {
          const auto next = rotated(axis, link->point, radians * i / intervals) * start;
          const auto pose = impl_->solver().solve({.part = pieces[moving].part, .freePose = next,
            .moving = out.pieces, .snap = false, .dragged = dragged, .anchor = moving});
          if (!pose) return refused("This part has no usable collision geometry.");
          if (const auto* blocked = std::get_if<PlacementBlocked>(&*pose))
            return refused("Rotation is blocked by " + pieces[blocked->blocker].part + ".");
        }
      }
    }
    const auto pose = delta * pieces[moving].world;
    std::copy_n(pose.r.m, 9, out.pose.rotation.m);
    out.pose.position = vertex(pose.t);
    return out;
  } catch (const std::exception& e) {
    return refused(e.what());
  }
}

AssemblyReport AssemblyInspection::inspect(const PieceList& selection, bool showAllJoints, bool checkGeometry) {
  AssemblyReport out;
  try {
    const auto& graph = impl_->joints();
    const auto& pieces = impl_->model.pieces();
    std::vector<bool> selected(pieces.size());
    std::set<uint32_t> groups, bodies;
    for (uint32_t i : selection) {
      if (i >= pieces.size()) continue;
      selected[i] = true;
      groups.insert(graph.group[i]);
      bodies.insert(graph.body[i]);
      if (!graph.hasConnectors[i]) out.withoutConnectors.push_back(i);
    }
    for (uint32_t i = 0; i < pieces.size(); i++) {
      if (!impl_->visible(i)) continue;
      if (groups.contains(graph.group[i])) out.connected.push_back(i);
      if (bodies.contains(graph.body[i])) out.rigid.push_back(i);
    }
    for (const auto& connection : graph.connections) {
      if (!impl_->visible(connection.a) || !impl_->visible(connection.b)) continue;
      const JointType kind = typeOf(connection.joint.kind);
      if (!selected[connection.a] && !selected[connection.b] && (!showAllJoints || kind == JointType::Fixed)) continue;
      JointRow row;
      row.a = connection.a;
      row.b = connection.b;
      row.type = kind;
      row.point = vertex(connection.joint.point);
      row.axis = vertex(connection.joint.axis);
      row.angle = turn(pieces[row.a], pieces[row.b], connection.joint.axis, kind == JointType::Ball);
      row.mateCount = connection.mates;
      if (connection.zoneCount > 0 && connection.firstZone < graph.releases.size()) {
        const auto& release = graph.releases[connection.firstZone];
        row.release = vertex(release.axis);
        row.clearance = release.travel;
      }
      out.joints.push_back(row);
    }
    if (!checkGeometry || selection.empty()) return out;

    const auto& world = impl_->geometry();
    std::set<uint32_t> touch;
    std::vector<uint32_t> near;
    for (uint32_t a : selection) {
      if (a >= pieces.size() || world.box(a).empty()) continue;
      touch.insert(a);
      constexpr double tolerance = bm::collide::kTouch;
      const bm::Vec3 margin{tolerance, tolerance, tolerance};
      world.near({world.box(a).min - margin, world.box(a).max + margin}, nullptr, near);
      for (uint32_t b : near) {
        if (a == b || (b < a && selected[b])) continue;
        if (impl_->visible(b) && bm::collide::touching(world.shape(a), world.pose(a), world.shape(b), world.pose(b)))
          touch.insert(b);
        if (graph.isSegment[a] || graph.isSegment[b]) continue;
        const auto [lo, hi] = std::minmax(a, b);
        const auto key = std::pair{lo, hi};
        const auto mate = std::lower_bound(graph.connections.begin(), graph.connections.end(), key,
          [](const auto& edge, const auto& pair) { return std::pair{edge.a, edge.b} < pair; });
        std::vector<bm::collide::Zone> zones;
        if (mate != graph.connections.end() && mate->a == lo && mate->b == hi)
          for (size_t i = mate->firstZone; i < mate->firstZone + mate->zoneCount; i++) {
            const auto& zone = graph.zones[i];
            zones.push_back({zone.a, zone.b, zone.radius});
          }
        const bool duplicate = samePose(pieces[a], pieces[b]);
        const auto depth = zones.empty() ? bm::collide::Depth::Skin : bm::collide::Depth::Joined;
        if (duplicate || bm::collide::overlap(world.shape(a), world.pose(a), world.shape(b), world.pose(b), zones, nullptr, depth))
          out.overlaps.push_back({lo, hi, duplicate});
      }
    }
    out.touching.assign(touch.begin(), touch.end());
  } catch (const std::exception& e) {
    out.error = e.what();
  }
  return out;
}

}  // namespace bmapp

void bmappRetainAssemblyInspection(bmapp::AssemblyInspection* p) { p->refs_.fetch_add(1, std::memory_order_relaxed); }
void bmappReleaseAssemblyInspection(bmapp::AssemblyInspection* p) {
  if (p->refs_.fetch_sub(1, std::memory_order_acq_rel) == 1) delete p;
}
