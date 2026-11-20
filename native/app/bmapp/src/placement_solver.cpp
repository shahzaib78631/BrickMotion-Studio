#include "placement_solver.h"

#include <array>
#include <cmath>
#include <tuple>
#include <unordered_map>
#include "bm/connect/infer.h"

namespace bmapp {
namespace {

using bm::Box, bm::Mat3, bm::Vec3, bm::Xform;
using bm::connect::Connector, bm::connect::Gender, bm::connect::SnapKind;

constexpr double kReleaseFactor = 1.4;
constexpr double kConnectorPadding = 6;
constexpr size_t kCollisionCandidates = 8;

Box expanded(Box box, double padding) {
  const Vec3 d{padding, padding, padding};
  return {box.min - d, box.max + d};
}

Box extent(const Connector& connector) {
  Box box;
  box.grow(connector.start);
  box.grow(connector.start + connector.axis * connector.length);
  return box;
}

bool contains(std::span<const uint32_t> pieces, uint32_t piece) {
  return std::find(pieces.begin(), pieces.end(), piece) != pieces.end();
}

bool compatible(const Connector& a, const Connector& b) {
  if (a.kind == b.kind) return a.kind == SnapKind::Generic || a.gender != b.gender;
  return (a.kind == SnapKind::Cyl && a.gender == Gender::Male && b.kind == SnapKind::Clip) ||
         (b.kind == SnapKind::Cyl && b.gender == Gender::Male && a.kind == SnapKind::Clip);
}

Mat3 basis(Vec3 axis, Vec3 side) {
  const Vec3 across = bm::cross(axis, side);
  return {{side.x, across.x, axis.x, side.y, across.y, axis.y, side.z, across.z, axis.z}};
}

bool finite(Vec3 v) { return std::isfinite(v.x) && std::isfinite(v.y) && std::isfinite(v.z); }

double poseDifference(const Xform& a, const Xform& b) {
  double d = bm::length(a.t - b.t);
  for (int i = 0; i < 9; i++) d += std::abs(a.r.m[i] - b.r.m[i]);
  return d;
}

std::optional<double> boxEntry(const Box& b, Vec3 from, Vec3 d) {
  if (b.empty()) return std::nullopt;
  const std::array eye{from.x, from.y, from.z};
  const std::array ray{d.x, d.y, d.z};
  const std::array lo{b.min.x, b.min.y, b.min.z};
  const std::array hi{b.max.x, b.max.y, b.max.z};
  double entry = 0, exit = 1;
  for (size_t i = 0; i < ray.size(); ++i) {
    if (std::abs(ray[i]) < 1e-10) {
      if (eye[i] < lo[i] || eye[i] > hi[i]) return std::nullopt;
      continue;
    }
    const double first = (lo[i] - eye[i]) / ray[i], last = (hi[i] - eye[i]) / ray[i];
    entry = std::max(entry, std::min(first, last));
    exit = std::min(exit, std::max(first, last));
    if (entry > exit) return std::nullopt;
  }
  return entry;
}

/// A long, open connection (such as a bar carrying two clips) can have several occupants
/// as long as the grip intervals are disjoint. Other sites accept a single mate.
bool sharesSeat(const Connector& target, const Connector& a, const Connector& b) {
  if (target.kind != SnapKind::Cyl) return true;
  auto span = [&](const Connector& c) {
    const double start = bm::dot(c.start - target.start, target.axis);
    const double end = start + bm::dot(c.axis, target.axis) * c.length;
    return std::pair{std::max(0.0, std::min(start, end)), std::min(target.length, std::max(start, end))};
  };
  const auto [loA, hiA] = span(a);
  const auto [loB, hiB] = span(b);
  return std::min(hiA, hiB) - std::max(loA, loB) > 0.1;
}

struct Candidate {
  PlacedOnConnector placement;
  double score;
  bool retained;
};

bool ranksBefore(const Candidate& a, const Candidate& b) {
  return std::tuple(!a.retained, a.score, a.placement.site.piece, a.placement.site.connector, a.placement.grip) <
         std::tuple(!b.retained, b.score, b.placement.site.piece, b.placement.site.connector, b.placement.grip);
}

}  // namespace

struct PlacementSolver::Impl {
  const bm::Model& model;
  bm::ldraw::PartCache& parts;
  bm::connect::ConnectorDb& database;
  bm::collide::ShapeCache& shapes;
  bm::collide::World world;
  std::vector<std::optional<std::vector<Connector>>> placed;
  std::unordered_map<uint64_t, std::vector<ConnectorSite>> occupantCache;
  std::unordered_map<std::string, std::vector<bm::connect::PlacementExample>> examples;

  Impl(const bm::Model& model, bm::ldraw::PartCache& parts, bm::connect::ConnectorDb& database,
       bm::collide::ShapeCache& shapes)
    : model(model), parts(parts), database(database), shapes(shapes), world(model, parts, shapes),
      placed(model.pieces().size()) {}

  const std::vector<Connector>& connectors(uint32_t piece) {
    auto& cache = placed[piece];
    if (!cache) {
      const auto& part = model.pieces()[piece];
      const auto local = database.get(part.part, &model.library());
      cache.emplace();
      cache->reserve(local->size());
      for (const Connector& c : *local) cache->push_back(bm::connect::transformed(c, part.world));
    }
    return *cache;
  }

  const std::vector<ConnectorSite>& occupants(ConnectorSite site) {
    const uint64_t key = (static_cast<uint64_t>(site.piece) << 32) | site.connector;
    auto [it, added] = occupantCache.try_emplace(key);
    if (!added) return it->second;
    const Connector& target = connectors(site.piece)[site.connector];
    std::vector<uint32_t> nearby;
    world.near(expanded(extent(target), kConnectorPadding), nullptr, nearby);
    for (uint32_t p : nearby) {
      if (p == site.piece) continue;
      const auto& others = connectors(p);
      for (uint32_t i = 0; i < others.size(); ++i)
        if (compatible(target, others[i]) && bm::connect::mate(target, others[i])) it->second.push_back({p, i});
    }
    return it->second;
  }

  std::optional<uint32_t> blocker(std::string_view part, const bm::collide::Shape& shape,
                                  const std::vector<Connector>& local, const Xform& pose,
                                  std::span<const uint32_t> moving) {
    std::vector<uint32_t> nearby;
    world.near(shape.bounds.transformed(pose), nullptr, nearby);
    std::vector<Connector> posed;
    posed.reserve(local.size());
    for (const Connector& c : local) posed.push_back(bm::connect::transformed(c, pose));
    for (uint32_t p : nearby) {
      if (contains(moving, p)) continue;
      const auto& other = model.pieces()[p];
      if (other.part == part && poseDifference(other.world, pose) < 1e-5) return p;
      std::vector<bm::collide::Zone> zones;
      for (const auto& target : connectors(p)) {
        for (const auto& c : posed) {
          if (!compatible(c, target) || !bm::connect::mate(c, target)) continue;
          const auto zone = bm::connect::mateZone(c, target);
          zones.push_back({zone.a, zone.b, zone.radius});
        }
      }
      const auto depth = zones.empty() ? bm::collide::Depth::Skin : bm::collide::Depth::Joined;
      if (bm::collide::overlap(shape, pose, world.shape(p), world.pose(p), zones, nullptr, depth)) return p;
    }
    return std::nullopt;
  }

  std::optional<uint32_t> overlapsAt(const PlacementRequest& request, const bm::collide::Shape& shape,
                                    const std::vector<Connector>& local, const Xform& pose) {
    if (!request.checkCollision) return std::nullopt;
    if (const auto hit = blocker(request.part, shape, local, pose, request.moving)) return hit;
    if (request.dragged.empty() || request.anchor >= world.size()) return std::nullopt;
    const Xform delta = pose * world.pose(request.anchor).inverse();
    for (const auto& p : request.dragged) {
      if (p.piece == request.anchor || p.piece >= world.size()) continue;
      const auto& part = model.pieces()[p.piece].part;
      const auto connectors = database.get(part, &model.library());
      const auto placed = p.apply(delta, world.pose(p.piece));
      if (const auto hit = blocker(part, world.shape(p.piece), *connectors, placed, request.moving)) return hit;
    }
    return std::nullopt;
  }

  std::optional<PlacedFromExample> reference(const PlacementRequest& request) {
    std::vector<uint32_t> nearby;
    world.near(expanded({request.point, request.point}, request.reach), nullptr, nearby);
    std::optional<PlacedFromExample> result;
    double closest = request.reach;
    const std::string part(request.part);
    for (uint32_t p : nearby) {
      if (contains(request.hidden, p) || contains(request.moving, p)) continue;
      const bm::Piece& host = model.pieces()[p];
      auto [it, inserted] = examples.try_emplace(host.part);
      if (inserted) it->second = bm::connect::placementExamples(model.library(), host.part);
      for (const auto& example : it->second) {
        if (const auto align = bm::connect::alignExample(model.library(), example.part, part)) {
          const Xform pose = host.world * example.at * *align;
          const double det = bm::determinant(pose.r);
          if (!std::isfinite(det) || std::abs(det) < 1e-9 ||
              std::signbit(det) != std::signbit(bm::determinant(request.freePose.r))) continue;
          const double distance = bm::length(pose.t - request.point);
          if (distance < closest) {
            closest = distance;
            result = PlacedFromExample{pose};
          }
        }
      }
    }
    return result;
  }

  std::vector<Candidate> candidates(const PlacementRequest& request, const std::vector<Connector>& local) {
    std::vector<Candidate> results;
    std::vector<uint32_t> nearby;
    world.near(expanded({request.point, request.point}, request.reach * kReleaseFactor + kConnectorPadding), nullptr, nearby);
    const Xform orientation{request.freePose.r, {}};
    std::vector<Connector> oriented;
    oriented.reserve(local.size());
    for (const auto& c : local) oriented.push_back(bm::connect::transformed(c, orientation));

    for (uint32_t piece : nearby) {
      if (contains(request.moving, piece) || contains(request.hidden, piece)) continue;
      if (request.onlyTarget && *request.onlyTarget != piece) continue;
      const auto& targets = connectors(piece);
      for (uint32_t i = 0; i < targets.size(); ++i) {
        const ConnectorSite site{piece, i};
        const Connector& target = targets[i];
        const bool retained = request.retainedSite == site;
        const double reach = request.reach * (retained ? kReleaseFactor : 1);
        const double near = std::clamp(bm::dot(request.point - target.start, target.axis), 0.0, target.length);
        if (bm::length(target.start + target.axis * near - request.point) > reach) continue;
        for (uint32_t grip = 0; grip < oriented.size(); ++grip) {
          if (request.grip && grip != *request.grip) continue;
          const auto& incoming = oriented[grip];
          if (!compatible(incoming, target)) continue;
          const Mat3 toSourceFrame = bm::inverse(basis(incoming.axis, incoming.side));
          for (double sign : {1.0, -1.0}) {
            const Vec3 axis = target.axis * sign;
            Vec3 preferred = bm::normalized(incoming.side - axis * bm::dot(axis, incoming.side));
            if (bm::length(preferred) < 0.5) preferred = target.side;
            const Vec3 cross = bm::cross(axis, target.side);
            const std::array sides{preferred, target.side, cross, -target.side, -cross};
            const double end = sign * incoming.length;
            const std::array offsets{0.0, target.length - end, (target.length - end) * 0.5, target.length, -end};
            for (const Vec3 side : sides) {
              const Mat3 turn = basis(axis, side) * toSourceFrame;
              const Mat3 rotation = turn * orientation.r;
              const double angleCost = std::max(0.0, 3 - turn.m[0] - turn.m[4] - turn.m[8]);
              for (double offset : offsets) {
                const Vec3 point = target.start + target.axis * offset;
                const double distance = bm::length(point - request.point);
                if (distance > reach) continue;
                const double score = distance + bm::length(incoming.start) * 0.12 + angleCost * 3 + std::abs(offset) * 0.07;
                const Xform pose{rotation, point - rotation * local[grip].start};
                const Candidate candidate{{pose, point, grip, site}, score, retained};
                if (results.size() == kCollisionCandidates && !ranksBefore(candidate, results.back())) continue;
                if (std::any_of(results.begin(), results.end(), [&](const Candidate& existing) {
                  return poseDifference(existing.placement.pose, pose) < 1e-5 && !ranksBefore(candidate, existing);
                })) continue;
                const auto posed = bm::connect::transformed(local[grip], pose);
                if (!bm::connect::mate(posed, target)) continue;
                const auto& occupied = occupants(site);
                if (std::any_of(occupied.begin(), occupied.end(), [&](ConnectorSite c) {
                  return !contains(request.moving, c.piece) && sharesSeat(target, posed, connectors(c.piece)[c.connector]);
                })) continue;
                std::erase_if(results, [&](const Candidate& existing) { return poseDifference(existing.placement.pose, pose) < 1e-5; });
                results.insert(std::upper_bound(results.begin(), results.end(), candidate, ranksBefore), candidate);
                if (results.size() > kCollisionCandidates) results.pop_back();
              }
            }
          }
        }
      }
    }
    return results;
  }
};

PlacementSolver::PlacementSolver(const bm::Model& model, bm::ldraw::PartCache& parts,
                                 bm::connect::ConnectorDb& connectors, bm::collide::ShapeCache& shapes)
  : impl_(std::make_unique<Impl>(model, parts, connectors, shapes)) {}

PlacementSolver::~PlacementSolver() = default;

uint32_t PlacementSolver::gripCount(std::string_view part) const {
  return static_cast<uint32_t>(impl_->database.get(part, &impl_->model.library())->size());
}

std::optional<Vec3> PlacementSolver::surface(uint32_t piece, Vec3 from, Vec3 to) const {
  if (piece >= impl_->world.size() || !finite(from) || !finite(to)) return std::nullopt;
  Vec3 at;
  if (bm::collide::throughSurface(impl_->world.shape(piece), impl_->world.pose(piece), from, to, &at) <= 1) return at;
  return std::nullopt;
}

std::optional<PlacementSolver::Surface> PlacementSolver::frontSurface(
    Vec3 from, Vec3 to, std::span<const uint32_t> hidden, std::span<const uint32_t> moving) const {
  if (!finite(from) || !finite(to)) return std::nullopt;
  Box reach;
  reach.grow(from);
  reach.grow(to);
  std::vector<uint32_t> nearby;
  impl_->world.near(reach, nullptr, nearby);
  std::vector<std::pair<double, uint32_t>> ordered;
  for (uint32_t p : nearby) {
    if (contains(hidden, p) || contains(moving, p)) continue;
    if (const auto entry = boxEntry(impl_->world.box(p), from, to - from)) ordered.emplace_back(*entry, p);
  }
  std::sort(ordered.begin(), ordered.end());
  std::optional<Surface> result;
  double limit = 1;
  for (const auto& [entry, piece] : ordered) {
    if (entry > limit) break;
    Vec3 at;
    const auto hit = bm::collide::throughSurface(impl_->world.shape(piece), impl_->world.pose(piece), from, to, &at);
    if (hit < limit || (!result && hit == limit)) {
      result = Surface{at, piece};
      limit = hit;
    }
  }
  return result;
}

std::optional<Placement> PlacementSolver::solve(const PlacementRequest& request) {
  if (!finite(request.point) || !finite(request.freePose.t) || !std::isfinite(request.reach) || request.reach < 0 ||
      !std::isfinite(bm::determinant(request.freePose.r)) || std::abs(bm::determinant(request.freePose.r)) < 1e-9)
    return std::nullopt;
  const auto shape = impl_->shapes.get(impl_->model.mesh(std::string(request.part), impl_->parts));
  if (shape->nodes.empty()) return std::nullopt;
  const auto local = impl_->database.get(request.part, &impl_->model.library());

  std::optional<PlacementBlocked> blockedSnap;
  if (request.snap && !local->empty() && request.reach > 0) {
    for (const Candidate& candidate : impl_->candidates(request, *local)) {
      const auto blocker = impl_->overlapsAt(request, *shape, *local, candidate.placement.pose);
      if (!blocker) return candidate.placement;
      if (!blockedSnap) blockedSnap = PlacementBlocked{candidate.placement.pose, *blocker};
    }
  }
  if (request.snap && request.useReference && request.reach > 0) {
    if (const auto reference = impl_->reference(request)) {
      if (const auto hit = impl_->overlapsAt(request, *shape, *local, reference->pose)) {
        if (!blockedSnap) blockedSnap = PlacementBlocked{reference->pose, *hit};
      } else {
        return *reference;
      }
    }
  }
  if (blockedSnap) return *blockedSnap;
  if (const auto blocker = impl_->overlapsAt(request, *shape, *local, request.freePose)) {
    return PlacementBlocked{request.freePose, *blocker};
  }
  return PlacedFreely{request.freePose};
}

std::optional<PlacedOnConnector> PlacementSolver::fitNew(std::string_view part, uint32_t target) {
  if (target >= impl_->world.size() || impl_->model.library().isInline(part)) return std::nullopt;
  const auto local = impl_->database.get(part, &impl_->model.library());
  const auto& targets = impl_->connectors(target);
  if (local->empty() || targets.empty()) return std::nullopt;
  std::shared_ptr<const bm::collide::Shape> shape;
  for (const auto& site : targets) {
    if (std::none_of(local->begin(), local->end(), [&](const auto& c) { return compatible(c, site); })) continue;
    PlacementRequest request{.part = part, .point = site.start, .reach = 12, .onlyTarget = target};
    const auto candidates = impl_->candidates(request, *local);
    if (candidates.empty()) continue;
    if (!shape) shape = impl_->shapes.get(impl_->model.mesh(std::string(part), impl_->parts));
    if (shape->nodes.empty()) return std::nullopt;
    for (const auto& option : candidates) {
      if (!impl_->overlapsAt(request, *shape, *local, option.placement.pose)) return option.placement;
    }
  }
  return std::nullopt;
}

std::vector<PlacedOnConnector> PlacementSolver::fits(uint32_t moving, uint32_t target) {
  auto& worker = *impl_;
  const auto& pieces = worker.model.pieces();
  if (moving >= pieces.size() || target >= pieces.size() || moving == target) return {};
  const auto& piece = pieces[moving];
  const auto grips = worker.database.get(piece.part, &worker.model.library());
  if (grips->empty()) return {};
  const std::array excluded{moving};
  PlacementRequest request{.part = piece.part, .freePose = piece.world, .point = piece.world.t,
                           .reach = 5, .grip = {}, .retainedSite = {}, .moving = excluded,
                           .onlyTarget = target};
  std::vector<PlacedOnConnector> all;
  for (const auto& contact : worker.connectors(target)) {
    request.point = contact.start;
    for (const auto& candidate : worker.candidates(request, *grips)) {
      const auto& pose = candidate.placement.pose;
      if (std::any_of(all.begin(), all.end(), [&](const auto& other) { return poseDifference(pose, other.pose) < 1e-5; })) continue;
      if (!worker.overlapsAt(request, worker.world.shape(moving), *grips, pose)) all.push_back(candidate.placement);
    }
  }
  std::stable_sort(all.begin(), all.end(), [&](const auto& a, const auto& b) {
    return poseDifference(a.pose, piece.world) < poseDifference(b.pose, piece.world);
  });
  if (all.size() > 12) all.resize(12);
  return all;
}

}  // namespace bmapp
