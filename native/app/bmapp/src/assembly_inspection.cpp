#include "bmapp/assembly_inspection.h"

#include <cmath>
#include <cstdio>
#include <numbers>
#include <set>
#include <unordered_map>
#include <unordered_set>
#include "bm/collide/world.h"
#include "bm/kin/system.h"
#include "bm/plan/plan.h"
#include "bm/stable/stability.h"
#include "engine.h"
#include "habits.h"
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

LoosePieces AssemblyInspection::loosePieces() {
  LoosePieces out;
  try {
    (void)impl_->joints();
    bm::Model copy = impl_->model;
    // Applied to a copy: a correction is applied only where it crosses nothing new.
    const auto corrections = bm::plan::correctPlacements(copy, impl_->sources->connectors, *impl_->backing->full,
                                                         impl_->shapes, true);
    for (const auto& c : corrections) {
      if (c.piece >= impl_->model.pieces().size() || !impl_->visible(c.piece)) continue;
      LoosePiece row;
      row.piece = c.piece, row.onto = c.onto;
      std::copy_n(c.to.r.m, 9, row.pose.rotation.m);
      row.pose.position = vertex(c.to.t);
      row.offset = c.offset, row.angle = c.angle;
      row.safe = c.applied;
      row.note = c.note;
      out.pieces.push_back(std::move(row));
    }
  } catch (const std::exception& e) {
    out.error = e.what();
  }
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
std::vector<HabitFit> AssemblyInspection::habitFits(uint32_t target, size_t limit) {
  std::vector<HabitFit> out;
  const auto& pieces = impl_->model.pieces();
  if (target >= pieces.size() || !impl_->visible(target) || limit == 0) return out;
  const auto table = loadHabits(defaultHabitsFile());
  if (!table) return out;
  const bm::Piece& anchor = pieces[target];
  const auto* habits = table->of(anchor.part);
  if (!habits) return out;
  // The model's most common colour other than the anchor's, for parts builders colour apart.
  std::unordered_map<int, size_t> counts;
  for (const auto& piece : pieces)
    if (piece.color != anchor.color) ++counts[piece.color];
  int other = anchor.color;
  size_t most = 0;
  for (const auto& [color, count] : counts)
    if (count > most || (count == most && color < other)) most = count, other = color;
  // Rank by how many models do it; mated connectors only break ties. Best pose per part.
  const auto better = [](const HabitFit& a, const HabitFit& b) {
    return a.models != b.models ? a.models > b.models : a.links > b.links;
  };
  std::vector<HabitFit> ranked;
  std::unordered_map<std::string, size_t> best;
  PlacementSolver* solver = nullptr;
  try {
    solver = &impl_->solver();
  } catch (const std::exception&) {
    return out;
  }
  for (const Habit& habit : *habits) {
    std::string part = table->parts[habit.part];
    if (!part.ends_with(".dat")) part += ".dat";
    const auto earlier = best.find(part);
    if (earlier != best.end() && ranked[earlier->second].models > habit.models) continue;
    const bm::Xform pose = anchor.world * habit.relative;
    std::optional<uint32_t> links;
    try {
      links = solver->seatAt(part, pose, target);
    } catch (const std::exception&) {
      continue;  // a part the library cannot read; the others still count
    }
    if (!links) continue;
    HabitFit fit;
    fit.name = part;
    const auto* file = impl_->model.library().find(part);
    fit.description = file && !file->description.empty() ? file->description : part;
    fit.color = habit.sameColour >= 50 ? anchor.color : other;
    std::copy_n(pose.r.m, 9, fit.pose.rotation.m);
    fit.pose.position = vertex(pose.t);
    fit.models = habit.models;
    fit.total = table->models;
    fit.links = *links;
    fit.joint = habit.joint;
    if (earlier == best.end()) {
      best[part] = ranked.size();
      ranked.push_back(std::move(fit));
    } else if (better(fit, ranked[earlier->second])) {
      ranked[earlier->second] = std::move(fit);
    }
  }
  std::stable_sort(ranked.begin(), ranked.end(), better);
  for (auto& fit : ranked) {
    if (out.size() >= limit) break;
    out.push_back(std::move(fit));
  }
  return out;
}

JointEdit AssemblyInspection::changeJoint(uint32_t fixed, uint32_t moving, double degrees, bool collision) {
  return changeJointEx(fixed, moving, degrees, 0.0, {0, 0, 0}, collision);
}

JointInfo AssemblyInspection::jointInfo(uint32_t fixed, uint32_t moving, bool collision) {
  JointInfo info;
  try {
    const auto& pieces = impl_->model.pieces();
    if (fixed >= pieces.size() || moving >= pieces.size()) {
      info.error = "Choose a connection first.";
      return info;
    }
    const auto& graph = impl_->joints();
    const auto pair = std::minmax(fixed, moving);
    const auto edge = std::find_if(graph.connections.begin(), graph.connections.end(), [&](const auto& c) {
      return c.a == pair.first && c.b == pair.second;
    });
    if (edge == graph.connections.end()) {
      info.error = "The two parts are no longer connected.";
      return info;
    }
    std::vector<bool> branch(pieces.size());
    std::vector<std::vector<uint32_t>> neighbors(pieces.size());
    for (const auto& connection : graph.connections) {
      if (&connection == &*edge) continue;
      neighbors[connection.a].push_back(connection.b);
      neighbors[connection.b].push_back(connection.a);
    }
    info.pieces.push_back(moving);
    branch[moving] = true;
    for (size_t i = 0; i < info.pieces.size(); ++i) {
      for (uint32_t p : neighbors[info.pieces[i]]) {
        if (p == fixed) {
          info.pieces.clear();
          info.error = "Another connection holds this branch in place.";
          return info;
        }
        if (branch[p]) continue;
        branch[p] = true;
        info.pieces.push_back(p);
      }
    }
    std::sort(info.pieces.begin(), info.pieces.end());

    if (!impl_->mechanism)
      impl_->mechanism = bm::kin::buildSystem(impl_->model, graph, nullptr, nullptr, {.testTravel = false});
    const auto bodies = std::minmax(impl_->mechanism->bodyOf[fixed], impl_->mechanism->bodyOf[moving]);
    const auto& links = impl_->mechanism->links;
    const auto link = std::find_if(links.begin(), links.end(), [&](const auto& l) {
      return l.a == bodies.first && l.b == bodies.second;
    });
    if (link == links.end()) {
      info.type = typeOf(edge->joint.kind);
      info.pivot = vertex(edge->joint.point);
      info.axis = vertex(edge->joint.axis);
      info.error = "This connection is rigidly locked.";
      return info;
    }
    info.type = typeOf(link->kind);
    info.pivot = vertex(link->point);
    bm::Vec3 axis = bm::normalized(link->axis);
    if (bm::length(axis) < 0.5 && link->kind == bm::connect::JointKind::Spherical) axis = {0, 1, 0};
    info.axis = vertex(axis);
    info.canTurn = link->kind == bm::connect::JointKind::Revolute ||
                   link->kind == bm::connect::JointKind::Cylindrical ||
                   link->kind == bm::connect::JointKind::Spherical;
    info.canSlide = link->kind == bm::connect::JointKind::Prismatic ||
                    link->kind == bm::connect::JointKind::Cylindrical;

    auto partTitle = [&](uint32_t piece) -> std::string {
      if (piece >= pieces.size()) return "";
      const auto* file = impl_->model.library().find(pieces[piece].part);
      return file && !file->description.empty() ? file->description : pieces[piece].part;
    };

    if (info.canTurn && bm::length(axis) >= 0.5) {
      if (!collision) {
        info.minDeg = -180.0;
        info.maxDeg = 180.0;
        info.fullTurn = true;
      } else {
        std::vector<MovingPiece> dragged;
        dragged.reserve(info.pieces.size());
        for (uint32_t p : info.pieces) dragged.push_back({p, {}});
        const auto& start = pieces[moving].world;
        auto probe = [&](double deg, std::string& blocker) -> bool {
          const auto next = rotated(axis, link->point, deg * std::numbers::pi / 180.0) * start;
          const auto pose = impl_->solver().solve({.part = pieces[moving].part, .freePose = next,
            .moving = info.pieces, .snap = false, .dragged = dragged, .anchor = moving});
          if (!pose) return false;
          if (const auto* blocked = std::get_if<PlacementBlocked>(&*pose)) {
            blocker = partTitle(blocked->blocker);
            return false;
          }
          return true;
        };
        auto sweep = [&](double sign, std::string& blocker) -> double {
          double lastOk = 0.0;
          constexpr double step = 6.0;
          for (double a = step; a <= 180.0 + 1e-6; a += step) {
            const double deg = sign * std::min(a, 180.0);
            std::string hit;
            if (probe(deg, hit)) {
              lastOk = deg;
            } else {
              blocker = hit;
              // Refine free limit to ~0.2° with binary search.
              double lo = lastOk, hi = deg;
              for (int it = 0; it < 5; ++it) {
                const double mid = 0.5 * (lo + hi);
                std::string midHit;
                if (probe(mid, midHit)) lo = mid;
                else { hi = mid; if (!midHit.empty()) blocker = midHit; }
              }
              return lo;
            }
          }
          return sign * 180.0;
        };
        info.maxDeg = sweep(1.0, info.maxBlocker);
        info.minDeg = sweep(-1.0, info.minBlocker);
        info.fullTurn = info.maxDeg >= 179.5 && info.minDeg <= -179.5;
      }
    }

    if (info.canSlide && bm::length(axis) >= 0.5) {
      if (!collision) {
        info.minSlide = -160.0;
        info.maxSlide = 160.0;
      } else {
        const auto& world = impl_->geometry();
        std::vector<bm::collide::Zone> zones;
        for (size_t i = edge->firstZone; i < edge->firstZone + edge->zoneCount; i++) {
          const auto& z = graph.zones[i];
          zones.push_back({z.a, z.b, z.radius, fixed, moving});
        }
        info.maxSlide = world.clearTravel(info.pieces, axis, 160.0, nullptr, zones);
        info.minSlide = -world.clearTravel(info.pieces, -axis, 160.0, nullptr, zones);
      }
    }
    return info;
  } catch (const std::exception& e) {
    info.error = e.what();
    return info;
  }
}

JointEdit AssemblyInspection::changeJointEx(uint32_t fixed, uint32_t moving, double degrees, double slideLdu,
                                            Vec3 axisOverride, bool collision) {
  try {
    const auto& pieces = impl_->model.pieces();
    if (fixed >= pieces.size() || moving >= pieces.size() || !std::isfinite(degrees) || !std::isfinite(slideLdu) ||
        std::abs(degrees) > 360.0 || std::abs(slideLdu) > 1000.0)
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
    if (degrees == 0 && slideLdu == 0) {
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
      if (link == links.end()) return refused("This connection cannot move.");
      const bool wantsTurn = std::abs(degrees) > 1e-9;
      const bool wantsSlide = std::abs(slideLdu) > 1e-9;
      if (wantsTurn && link->kind == bm::connect::JointKind::Prismatic)
        return refused("This connection slides only and cannot turn.");
      if (wantsSlide && link->kind != bm::connect::JointKind::Prismatic && link->kind != bm::connect::JointKind::Cylindrical)
        return refused("This connection cannot slide.");
      bm::Vec3 axis = bm::normalized(link->axis);
      const bm::Vec3 custom{axisOverride.x, axisOverride.y, axisOverride.z};
      if (link->kind == bm::connect::JointKind::Spherical && bm::length(custom) > 0.5) {
        axis = bm::normalized(custom);
      } else if (bm::length(axis) < 0.5 && link->kind == bm::connect::JointKind::Spherical) {
        axis = {0, 1, 0};
      }
      if (bm::length(axis) < 0.5) return refused("This connection has no motion axis.");
      const double radians = degrees * std::numbers::pi / 180.0;
      const auto makeDelta = [&](double frac) {
        bm::Xform step = wantsTurn ? rotated(axis, link->point, radians * frac) : bm::Xform{};
        if (wantsSlide) step.t = step.t + axis * (slideLdu * frac);
        return step;
      };
      delta = makeDelta(1.0);
      if (collision) {
        std::vector<MovingPiece> dragged;
        for (uint32_t p : out.pieces) dragged.push_back({p, {}});
        const auto& start = pieces[moving].world;
        const auto& bounds = impl_->geometry().box(moving);
        const double radius = bounds.empty() ? 20 : bm::length(bounds.max - bounds.min);
        const int turnSteps = wantsTurn ? static_cast<int>(std::ceil(std::abs(radians) * radius / 2)) : 0;
        const int slideSteps = wantsSlide ? static_cast<int>(std::ceil(std::abs(slideLdu) / 4.0)) : 0;
        const int intervals = std::clamp(std::max(turnSteps, slideSteps), 3, 72);
        for (int i = 1; i <= intervals; i++) {
          const auto next = makeDelta(static_cast<double>(i) / intervals) * start;
          const auto pose = impl_->solver().solve({.part = pieces[moving].part, .freePose = next,
            .moving = out.pieces, .snap = false, .dragged = dragged, .anchor = moving});
          if (!pose) return refused("This part has no usable collision geometry.");
          if (const auto* blocked = std::get_if<PlacementBlocked>(&*pose))
            return refused("Motion is blocked by " + pieces[blocked->blocker].part + ".");
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

ModelChecks AssemblyInspection::checkModel() {
  ModelChecks out;
  try {
    auto graph = impl_->joints();
    const auto& model = impl_->model;
    const auto& pieces = model.pieces();
    auto& parts = *impl_->backing->full;
    bm::connect::inferJoints(graph, model, impl_->sources->connectors, impl_->geometry());
    const auto label = [&](uint32_t piece) {
      return "Part " + std::to_string(piece + 1) + " · " + pieces[piece].part;
    };
    for (const auto& overlap : bm::collide::findOverlaps(model, graph, parts, impl_->shapes).overlaps) {
      out.findings.push_back({ModelCheckKind::Overlap, label(overlap.a) + " and " + label(overlap.b),
          overlap.duplicate ? "These pieces occupy the same placement." : "The part surfaces cross outside their mating connectors.",
          {overlap.a, overlap.b}});
    }

    const auto stability = bm::stable::check(model, graph, parts);
    for (const auto& group : stability.groups) {
      if (group.onFloor || group.pieces.empty()) continue;
      const auto title = group.pieces.size() == 1 ? label(group.pieces.front()) : std::to_string(group.pieces.size()) + " connected parts";
      out.findings.push_back({ModelCheckKind::Unsupported, title, "This group has no connected support down to the model's floor.", group.pieces});
    }
    for (const auto index : stability.tipping) {
      const auto& group = stability.groups[index];
      out.findings.push_back({ModelCheckKind::Tipping, label(group.pieces.front()),
          "The group's centre of mass falls outside its footprint on the floor.", group.pieces});
    }

    std::vector<size_t> connections(pieces.size());
    for (const auto& edge : graph.connections) {
      ++connections[edge.a];
      ++connections[edge.b];
    }
    for (const auto& edge : graph.connections) {
      if (edge.mates != 1 || edge.found != bm::connect::Found::Connectors || edge.joint.kind != bm::connect::JointKind::Fixed ||
          (connections[edge.a] != 1 && connections[edge.b] != 1)) continue;
      out.findings.push_back({ModelCheckKind::SingleConnector, label(edge.a) + " and " + label(edge.b),
          "One mated connector secures this attachment. Review it if it needs to carry a load.", {edge.a, edge.b}});
    }

    const auto& load = model.report();
    std::unordered_map<std::string, PieceList> missingPieces;
    for (const auto& name : load.missing) missingPieces.try_emplace(name);
    for (uint32_t piece = 0; piece < pieces.size(); ++piece)
      if (const auto found = missingPieces.find(pieces[piece].part); found != missingPieces.end()) found->second.push_back(piece);
    for (const auto& name : load.missing) {
      out.findings.push_back({ModelCheckKind::MissingDefinition, name,
          "The model refers to a part or submodel that could not be loaded.", std::move(missingPieces.at(name))});
    }
    for (const auto& colour : load.unknownColors)
      out.findings.push_back({ModelCheckKind::UnknownColour, colour, "This colour is drawn with the fallback palette entry.", {}});
    for (const auto& cycle : load.cycles)
      out.findings.push_back({ModelCheckKind::SubmodelLoop, cycle, "This chain refers back to a model it already contains.", {}});
  } catch (const std::exception& error) {
    return {{}, error.what()};
  }
  return out;
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

PieceList looseUncheck(const LoosePieceList& rows, uint32_t piece, const PieceList& chosen) {
  std::unordered_set<uint32_t> removed;
  std::vector<uint32_t> pending{piece};
  while (!pending.empty()) {
    const uint32_t next = pending.back();
    pending.pop_back();
    if (!removed.insert(next).second) continue;
    for (const auto& row : rows)
      if (row.onto == next) pending.push_back(row.piece);
  }
  PieceList out;
  out.reserve(chosen.size());
  for (uint32_t p : chosen)
    if (!removed.contains(p)) out.push_back(p);
  return out;
}

PieceList initialLooseChoice(const LoosePieceList& rows) {
  PieceList chosen;
  std::unordered_set<uint32_t> chosenSet;
  for (const auto& row : rows) {
    if (row.safe && chosenSet.insert(row.piece).second) chosen.push_back(row.piece);
  }
  for (const auto& row : rows) {
    if (chosenSet.contains(row.piece)) continue;
    for (const auto& dependent : rows) {
      if (dependent.onto != row.piece) continue;
      chosen = looseUncheck(rows, dependent.piece, chosen);
    }
  }
  return chosen;
}

uint32_t looseWaitingOn(const LoosePieceList& rows, uint32_t piece, const PieceList& chosen) {
  std::unordered_map<uint32_t, const LoosePiece*> listed;
  for (const auto& row : rows) listed.try_emplace(row.piece, &row);
  const auto self = listed.find(piece);
  if (self == listed.end()) return UINT32_MAX;
  const std::unordered_set<uint32_t> chosenSet(chosen.begin(), chosen.end());
  std::unordered_set<uint32_t> seen{piece};
  uint32_t holder = self->second->onto;
  while (true) {
    const auto next = listed.find(holder);
    if (next == listed.end() || !seen.insert(holder).second) break;
    if (!chosenSet.contains(holder)) return holder;
    holder = next->second->onto;
  }
  return UINT32_MAX;
}

std::string looseDetail(const LoosePiece& row, const std::string& ontoName) {
  std::vector<std::string> parts;
  char buf[64];
  if (row.offset >= 0.05) {
    std::snprintf(buf, sizeof(buf), "%.1f LDU off", row.offset);
    parts.emplace_back(buf);
  }
  if (row.angle >= 0.05) {
    std::snprintf(buf, sizeof(buf), "turned %.1f\xc2\xb0", row.angle);
    parts.emplace_back(buf);
  }
  parts.push_back("on " + ontoName);
  std::string text;
  for (size_t i = 0; i < parts.size(); ++i) {
    if (i > 0) text += " \xc2\xb7 ";
    text += parts[i];
  }
  if (!row.safe) {
    text += row.note.empty() ? " \xc2\xb7 would cross another part" : " \xc2\xb7 " + row.note;
  }
  return text;
}

std::string habitWhy(const HabitFit& fit) {
  const auto grouped = [](uint32_t n) {
    const std::string digits = std::to_string(n);
    std::string out;
    out.reserve(digits.size() + digits.size() / 3);
    for (size_t i = 0; i < digits.size(); ++i) {
      if (i > 0 && (digits.size() - i) % 3 == 0) out += ',';
      out += digits[i];
    }
    return out;
  };
  std::string out = "In " + grouped(fit.models) + " of " + grouped(fit.total) + " BrickNet models";
  if (!fit.joint.empty() && fit.joint != "stud") out += " \xc2\xb7 " + fit.joint;
  return out;
}

}  // namespace bmapp

void bmappRetainAssemblyInspection(bmapp::AssemblyInspection* p) { p->refs_.fetch_add(1, std::memory_order_relaxed); }
void bmappReleaseAssemblyInspection(bmapp::AssemblyInspection* p) {
  if (p->refs_.fetch_sub(1, std::memory_order_acq_rel) == 1) delete p;
}
