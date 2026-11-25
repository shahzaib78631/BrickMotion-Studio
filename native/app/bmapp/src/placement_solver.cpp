#include "placement_solver.h"

#include <array>
#include <chrono>
#include <limits>
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
// Aimed placement (the viewport), as the web editor's placement engine (src/plan/aim.ts).
constexpr double kPickRadius = 24;      ///< LDU across the ray a connector may be and still count
constexpr double kOccludeSlack = 6;     ///< LDU behind the hit surface a stud or socket may sit
constexpr double kBuriedSlack = 14;     ///< hinge fingers and clips: their axis is inside the part
constexpr double kJointSlack = 16;      ///< ball centres and hinge pivots lie deeper still
constexpr double kWallSlack = 5;        ///< a pointer this far below a stud's base is on the wall
constexpr double kHysteresis = 4;       ///< LDU nearer (at its depth) a new seat must be to take over
constexpr size_t kAimedTargets = 6;
constexpr double kHeldWeight = 0.35;    ///< how much the held point's nearness to the ray counts
constexpr size_t kAimedCandidates = 96;
constexpr size_t kAlwaysTried = 16;     ///< seats tested whatever the time, so the answer is steady
constexpr auto kTryBudget = std::chrono::milliseconds(12);
constexpr double kDepthCost = 0.0004;   ///< per LDU a seat sits from the connector's mouth: flush first

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

double rayDepth(const bmapp::PlacementAim& aim, Vec3 p) { return bm::dot(p - aim.from, aim.dir); }
double rayGap(const bmapp::PlacementAim& aim, Vec3 p) {
  const double depth = rayDepth(aim, p);
  return bm::length(p - aim.from - aim.dir * depth);
}
/// How far from the pointer a point looks: distance across the ray over its depth.
double rayAngle(const bmapp::PlacementAim& aim, Vec3 p) {
  const double depth = rayDepth(aim, p);
  return depth > 1e-6 ? rayGap(aim, p) / depth : std::numeric_limits<double>::infinity();
}
/// The point of segment [a, a + axis * length] nearest the ray, as a parameter along it.
double nearestOnSegment(const bmapp::PlacementAim& aim, Vec3 a, Vec3 axis, double length) {
  const Vec3 w = a - aim.from;
  const double b = bm::dot(axis, aim.dir), d = bm::dot(axis, w), e = bm::dot(aim.dir, w);
  const double denominator = 1 - b * b;
  const double t = denominator > 1e-9 ? (b * e - d) / denominator : 0;
  return std::clamp(t, 0.0, length);
}
/// A stud, socket or short ring: a part goes on from its open face only.
bool shortCylinder(const Connector& c) { return c.kind == SnapKind::Cyl && c.length <= 8; }
double slackOf(const Connector& c) {
  switch (c.kind) {
    case SnapKind::Cyl: return kOccludeSlack + c.radius;
    case SnapKind::Clip:
    case SnapKind::Finger: return kBuriedSlack;
    case SnapKind::Generic: return kJointSlack;
  }
  return kOccludeSlack;
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

  /// Every way the moving part seats on `site` that mates it and leaves its other occupants
  /// alone, best first in `results` (at most `limit`). `accept` filters seat points before the
  /// mate is checked; `scoreOf` ranks a pose (lower first).
  template <class Accept, class Score>
  void seatsOn(const PlacementRequest& request, const std::vector<Connector>& local, const std::vector<Connector>& oriented,
               const Xform& orientation, ConnectorSite site, bool retained, Accept accept, Score scoreOf,
               std::vector<Candidate>& results, size_t limit) {
    const Connector& target = connectors(site.piece)[site.connector];
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
            if (!accept(point)) continue;
            const Xform pose{rotation, point - rotation * local[grip].start};
            const double score = scoreOf(pose, point, incoming, angleCost, offset);
            if (!std::isfinite(score)) continue;
            const Candidate candidate{{pose, point, grip, site}, score, retained};
            if (results.size() == limit && !ranksBefore(candidate, results.back())) continue;
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
            if (results.size() > limit) results.pop_back();
          }
        }
      }
    }
  }

  std::vector<Candidate> candidates(const PlacementRequest& request, const std::vector<Connector>& local) {
    if (request.aim) return aimedCandidates(request, *request.aim, local);
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
        seatsOn(request, local, oriented, orientation, site, retained,
                [&](Vec3 point) { return bm::length(point - request.point) <= reach; },
                [&](const Xform&, Vec3 point, const Connector& incoming, double angleCost, double offset) {
                  return bm::length(point - request.point) + bm::length(incoming.start) * 0.12 + angleCost * 3 + std::abs(offset) * 0.07;
                },
                results, kCollisionCandidates);
      }
    }
    return results;
  }

  /// The viewport's placement: the free connectors the ray points at (near it, facing the
  /// camera, not hidden behind what it hits), seated so the held point lands nearest the ray.
  std::vector<Candidate> aimedCandidates(const PlacementRequest& request, const PlacementAim& aim,
                                         const std::vector<Connector>& local) {
    std::vector<Candidate> results;
    if (!finite(aim.from) || !finite(aim.dir) || std::abs(bm::length(aim.dir) - 1) > 1e-6) return results;
    const double hitDepth = aim.hitDepth.value_or(std::numeric_limits<double>::infinity());
    const std::optional<Vec3> hit = aim.hitDepth ? std::optional(aim.from + aim.dir * *aim.hitDepth) : std::nullopt;
    // Every piece near the visible stretch of the ray.
    const double far = std::isfinite(hitDepth) ? hitDepth + kJointSlack : 4000;
    Box along;
    along.grow(aim.from);
    along.grow(aim.from + aim.dir * far);
    std::vector<uint32_t> nearby;
    world.near(expanded(along, kPickRadius + kConnectorPadding), nullptr, nearby);

    struct Aimed { ConnectorSite site; double angle; };
    std::vector<Aimed> aimed;
    for (uint32_t piece : nearby) {
      if (contains(request.moving, piece) || contains(request.hidden, piece)) continue;
      if (request.onlyTarget && *request.onlyTarget != piece) continue;
      const auto& targets = connectors(piece);
      for (uint32_t i = 0; i < targets.size(); ++i) {
        const Connector& t = targets[i];
        const Vec3 near = t.start + t.axis * nearestOnSegment(aim, t.start, t.axis, t.length);
        // Seen if any of it is in front of what the ray hits: a stud's own top hides its base.
        const double shallowest = std::min({rayDepth(aim, near), rayDepth(aim, t.start), rayDepth(aim, t.start + t.axis * t.length)});
        if (rayDepth(aim, near) <= 0 || shallowest > hitDepth + slackOf(t) || rayGap(aim, near) > kPickRadius) continue;
        if (t.kind == SnapKind::Cyl && t.gender == Gender::Female && t.openStart != t.openEnd) {
          // A socket open at one end is entered there: its mouth must face the camera and be seen.
          const Vec3 mouth = t.openStart ? t.start : t.start + t.axis * t.length;
          const Vec3 outward = t.openStart ? -t.axis : t.axis;
          if (bm::dot(outward, -aim.dir) <= -0.05 || rayDepth(aim, mouth) > hitDepth + slackOf(t)) continue;
        }
        if (shortCylinder(t)) {
          // A stud is entered from its tip side, a socket from its open face.
          const Vec3 outward = t.gender == Gender::Male ? t.axis : -t.axis;
          if (bm::dot(outward, -aim.dir) <= -0.05) continue;
          // Pointing at the wall below a piece's top studs means beside it, not on top.
          // A ray passing through the stud itself (down a hollow stud's hole) is on the stud.
          if (hit && t.gender == Gender::Male && bm::dot(*hit - t.start, t.axis) < -kWallSlack && rayGap(aim, near) > t.radius) continue;
        }
        aimed.push_back({{piece, i}, rayAngle(aim, near)});
      }
    }
    std::sort(aimed.begin(), aimed.end(), [](const Aimed& a, const Aimed& b) {
      return std::tie(a.angle, a.site.piece, a.site.connector) < std::tie(b.angle, b.site.piece, b.site.connector);
    });
    if (aimed.size() > kAimedTargets) {
      // A retained site stays in the running while it is still near the ray.
      const auto keep = std::find_if(aimed.begin() + kAimedTargets, aimed.end(), [&](const Aimed& a) { return request.retainedSite == a.site; });
      if (keep != aimed.end()) std::iter_swap(aimed.begin() + kAimedTargets - 1, keep);
      aimed.resize(kAimedTargets);
    }

    const Xform orientation{request.freePose.r, {}};
    std::vector<Connector> oriented;
    oriented.reserve(local.size());
    for (const auto& c : local) oriented.push_back(bm::connect::transformed(c, orientation));
    for (const Aimed& entry : aimed) {
      const Connector& target = connectors(entry.site.piece)[entry.site.connector];
      const bool retained = request.retainedSite == entry.site;
      const bool through = target.kind == SnapKind::Cyl && target.gender == Gender::Female && target.openStart && target.openEnd;
      seatsOn(request, local, oriented, orientation, entry.site, false, [](Vec3) { return true; },
              [&](const Xform& pose, Vec3, const Connector&, double angleCost, double offset) {
                const Vec3 held = pose.apply(aim.held);
                // A part goes through a hole from the side the camera sees.
                if (through) {
                  const bool fromStart = bm::dot(held - target.start, target.axis) < target.length * 0.5;
                  const Vec3 mouth = fromStart ? -target.axis : target.axis;
                  if (bm::dot(mouth, -aim.dir) < -0.2) return std::numeric_limits<double>::infinity();
                }
                const double depth = std::max(rayDepth(aim, held), 1.0);
                // The connector pointed at decides first; where the hand holds the part decides
                // how it sits there. Least turning breaks near-ties, and the seat in hand keeps
                // its place unless another is clearly nearer.
                return entry.angle + rayAngle(aim, held) * kHeldWeight + angleCost * 0.002 + std::abs(offset) * kDepthCost -
                       (retained ? kHysteresis / depth : 0);
              },
              results, kAimedCandidates);
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
  if (request.snap && !local->empty() && (request.reach > 0 || request.aim)) {
    // Nearest first. With an aim, keep looking past blocked seats for a while: in a crowded
    // spot the nearest seats collide and a clean one is a little further down the list.
    const auto started = std::chrono::steady_clock::now();
    size_t tried = 0;
    for (const Candidate& candidate : impl_->candidates(request, *local)) {
      if (request.aim && blockedSnap && tried >= kAlwaysTried && std::chrono::steady_clock::now() - started > kTryBudget) break;
      ++tried;
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
    // Aimed at a piece's wall, the part held there sits inside it: bring it back along the
    // ray until it stands clear, touching the face the pointer is on.
    if (request.aim && request.aim->hitDepth) {
      const Box box = shape->bounds.transformed(request.freePose);
      const double span = bm::length(box.max - box.min) + 2;
      for (double back = 1; back <= span; back += 1) {
        Xform pose = request.freePose;
        pose.t = pose.t - request.aim->dir * back;
        if (!impl_->overlapsAt(request, *shape, *local, pose)) return PlacedFreely{pose};
      }
    }
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

std::optional<uint32_t> PlacementSolver::seatAt(std::string_view part, const Xform& pose, uint32_t target) {
  if (target >= impl_->world.size() || impl_->model.library().isInline(part)) return std::nullopt;
  const auto local = impl_->database.get(part, &impl_->model.library());
  const auto& targets = impl_->connectors(target);
  if (local->empty() || targets.empty()) return std::nullopt;
  uint32_t links = 0;
  for (const Connector& c : *local) {
    const auto posed = bm::connect::transformed(c, pose);
    for (const auto& site : targets)
      if (compatible(posed, site) && bm::connect::mate(posed, site)) ++links;
  }
  if (links == 0) return std::nullopt;
  const auto shape = impl_->shapes.get(impl_->model.mesh(std::string(part), impl_->parts));
  if (!shape || shape->nodes.empty()) return std::nullopt;
  if (impl_->blocker(part, *shape, *local, pose, {})) return std::nullopt;
  return links;
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
