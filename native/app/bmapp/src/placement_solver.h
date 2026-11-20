#pragma once

#include <optional>
#include <span>
#include <string_view>
#include <variant>
#include "bm/collide/world.h"
#include "move_preview.h"

namespace bmapp {

struct ConnectorSite {
  uint32_t piece;
  uint32_t connector;
  bool operator==(const ConnectorSite&) const = default;
};

struct PlacedFreely { bm::Xform pose; };
struct PlacedOnConnector {
  bm::Xform pose;
  bm::Vec3 contact;
  uint32_t grip;
  ConnectorSite site;
};
struct PlacementBlocked {
  bm::Xform pose;
  uint32_t blocker;
};
struct PlacedFromExample { bm::Xform pose; };
using Placement = std::variant<PlacedFreely, PlacedOnConnector, PlacedFromExample, PlacementBlocked>;

/// The ray reaches `point` (from the surface under the pointer or the construction plane).
/// The free pose follows that point. Within reach, a compatible free connector can take over.
struct PlacementRequest {
  std::string_view part;
  bm::Xform freePose;
  bm::Vec3 point;
  double reach = 16;
  std::optional<uint32_t> grip;
  std::optional<ConnectorSite> retainedSite;
  std::span<const uint32_t> moving;
  bool snap = true;
  std::span<const uint32_t> hidden = {};
  std::span<const MovingPiece> dragged = {};
  uint32_t anchor = UINT32_MAX;
  bool useReference = false;
  bool checkCollision = true;
  std::optional<uint32_t> onlyTarget = {};
};

/// The focused model at one revision. Query the existing spatial index for local connectors and
/// cache occupancy on demand. The model and caches must outlive the solver and remain stable.
class PlacementSolver {
 public:
  PlacementSolver(const bm::Model& model, bm::ldraw::PartCache& parts, bm::connect::ConnectorDb& connectors,
                  bm::collide::ShapeCache& shapes);
  ~PlacementSolver();
  PlacementSolver(const PlacementSolver&) = delete;
  PlacementSolver& operator=(const PlacementSolver&) = delete;

  uint32_t gripCount(std::string_view part) const;

  /// First surface on the picked piece along a finite ray. Empty when the ray misses it.
  std::optional<bm::Vec3> surface(uint32_t piece, bm::Vec3 from, bm::Vec3 to) const;
  /// Closest visible surface along the ray, with the piece holding it.
  struct Surface { bm::Vec3 point; uint32_t piece; };
  std::optional<Surface> frontSurface(bm::Vec3 from, bm::Vec3 to, std::span<const uint32_t> hidden,
                                     std::span<const uint32_t> moving) const;
  /// Empty for a part without usable geometry or an invalid pose.
  std::optional<Placement> solve(const PlacementRequest& request);
  std::vector<PlacedOnConnector> fits(uint32_t moving, uint32_t target);
  std::optional<PlacedOnConnector> fitNew(std::string_view part, uint32_t target);

 private:
  struct Impl;
  std::unique_ptr<Impl> impl_;
};

}  // namespace bmapp
