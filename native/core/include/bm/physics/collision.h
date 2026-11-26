#pragma once
// Collision geometry (exact 3D convex hulls, primitives, compound shapes),
// dynamic AABB tree broadphase, GJK/EPA + Sutherland-Hodgman contact manifold generation,
// persistent contact caching, and raycasting.
#include <cstdint>
#include <memory>
#include <optional>
#include <unordered_map>
#include <vector>
#include "bm/ldraw/mesh.h"
#include "bm/physics/math_ext.h"

namespace bm::physics {

/// A face of a 3D convex hull (CCW vertex indices as seen from outside).
struct HullFace {
  std::vector<uint32_t> vertices;
  Vec3 normal{};   ///< outward unit normal
  double offset = 0.0;  ///< dot(normal, v) for vertices on the face
};

/// 3D convex hull in local SI coordinates (metres), with explicit faces for SAT/clipping manifolds.
struct ConvexHull {
  std::vector<Vec3> vertices;
  std::vector<HullFace> faces;
  Box localBounds;
  Vec3 centroid{};

  bool empty() const { return vertices.empty(); }

  /// Furthest vertex along direction `dir` (in hull local space).
  Vec3 support(Vec3 dir) const;

  /// Build an exact 3D convex hull from a point cloud (in metres). Degenerate/flat inputs fall back to box hull.
  static ConvexHull fromPoints(const std::vector<Vec3>& points);

  /// Build a convex hull directly from an LDraw mesh (converts LDU -> metres).
  static ConvexHull fromLdrawMesh(const ldraw::Mesh& mesh);

  /// Exact 8-vertex, 6-face box convex hull centred at origin.
  static ConvexHull fromBox(Vec3 halfExtents);

  /// Exact cylinder approximation convex hull along local Y axis.
  static ConvexHull fromCylinder(double radius, double halfHeight, int segments = 16);
};

enum class ShapeKind : uint8_t { Box, Sphere, Capsule, Cylinder, ConvexHull };

/// A single convex collision primitive (in local body space, SI metres).
struct ConvexShape {
  ShapeKind kind = ShapeKind::Box;
  Vec3 halfExtents{0.004, 0.0048, 0.004};  ///< Box half-extents (m)
  double radius = 0.004;                   ///< Sphere / Capsule / Cylinder radius (m)
  double halfHeight = 0.0048;              ///< Capsule (cylinder half-length) / Cylinder half-height (m)
  std::shared_ptr<const ConvexHull> hull;  ///< ConvexHull data (also cached for Box/Cylinder clipping)

  /// Support point along world/local direction `dir` in shape local space.
  Vec3 support(Vec3 dir) const;
  /// Local AABB of this shape.
  Box localBounds() const;
  /// World AABB under `pose`.
  Box worldBounds(const Pose& pose) const;
  /// Minimum characteristic radius / thickness (used for CCD motion thresholds).
  double minExtent() const;

  static ConvexShape makeBox(Vec3 halfExtents);
  static ConvexShape makeSphere(double radius);
  static ConvexShape makeCapsule(double radius, double halfHeight);
  static ConvexShape makeCylinder(double radius, double halfHeight, int segments = 16);
  static ConvexShape makeHull(std::shared_ptr<const ConvexHull> hull);
};

/// One sub-shape inside a compound rigid body (e.g., one brick inside a multi-brick assembly).
struct SubShape {
  ConvexShape shape;
  Pose localPose;             ///< relative to the rigid body's CoM frame (SI)
  uint32_t pieceIndex = UINT32_MAX;  ///< original Model piece index, if any
};

/// Dynamic AABB Tree (BVH) broadphase supporting incremental updates, overlap queries, and raycasts.
class DynamicBvh {
 public:
  static constexpr int32_t kNullNode = -1;
  static constexpr double kFattenMargin = 0.0015;  ///< 1.5 mm fattening margin

  /// Insert a proxy with user payload `userId` and world AABB `box`. Returns proxy handle.
  int32_t insert(uint32_t userId, const Box& box);
  void remove(int32_t proxyId);
  /// Update proxy AABB with optional displacement prediction. Returns true if tree was re-inserted.
  bool update(int32_t proxyId, const Box& box, Vec3 displacement = {});
  const Box& fatBox(int32_t proxyId) const;
  uint32_t userId(int32_t proxyId) const;
  void clear();

  /// Report all overlapping proxy userIds whose fat AABBs intersect `queryBox`.
  void query(const Box& queryBox, std::vector<uint32_t>& outUserIds) const;

  /// Report all unique overlapping pairs (userA < userB) among all proxies in the tree.
  void overlappingPairs(std::vector<std::pair<uint32_t, uint32_t>>& outPairs) const;

  /// Raycast against proxy AABBs; invokes `callback(userId, tEnter)` returning refined maxT.
  struct RayHitCandidate {
    uint32_t userId = 0;
    double tEnter = 0.0;
  };
  void raycast(Vec3 origin, Vec3 dir, double maxT, std::vector<RayHitCandidate>& out) const;

 private:
  struct Node {
    Box box;
    uint32_t userId = UINT32_MAX;
    int32_t parent = kNullNode;
    int32_t left = kNullNode;
    int32_t right = kNullNode;
    int32_t height = -1;
    bool isLeaf() const { return left == kNullNode; }
  };

  int32_t allocateNode();
  void freeNode(int32_t id);
  void insertLeaf(int32_t leaf);
  void removeLeaf(int32_t leaf);
  int32_t balance(int32_t iA);

  std::vector<Node> nodes_;
  int32_t root_ = kNullNode;
  int32_t freeList_ = kNullNode;
};

/// A body's full collision geometry: one or more convex sub-shapes, with an internal local BVH
/// for O(log N) sub-shape culling on large multi-hundred-piece LEGO compound bodies.
struct CompoundShape {
  std::vector<SubShape> parts;
  std::vector<Box> partLocalBoxes;  ///< cached local AABB of each sub-shape in body frame
  Box localBounds;
  DynamicBvh localBvh;              ///< populated automatically when parts.size() > 8

  bool empty() const { return parts.empty(); }
  void recomputeBounds();
  Box worldBounds(const Pose& pose) const;
  double minExtent() const;
  /// Indices of sub-shapes whose local AABB overlaps `localQueryBox`.
  void queryLocal(const Box& localQueryBox, std::vector<uint32_t>& outIndices) const;
};

/// A single contact point within a contact manifold (SI metres & N·s impulses).
struct ContactPoint {
  Vec3 worldPoint{};      ///< contact point on surface A/B midpoint (world space, m)
  Vec3 localA{};          ///< anchor on body A in A's local CoM frame (m)
  Vec3 localB{};          ///< anchor on body B in B's local CoM frame (m)
  double penetration = 0.0;  ///< positive = penetrating depth (m)
  uint64_t featureId = 0;    ///< stable geometric feature key for warm-starting

  // Warm-started accumulated impulses (persisted across substeps).
  double normalImpulse = 0.0;
  double tangentImpulse1 = 0.0;
  double tangentImpulse2 = 0.0;
  double twistImpulse = 0.0;
};

/// Contact manifold between two bodies (or a body and the floor when bodyB == UINT32_MAX).
struct ContactManifold {
  static constexpr uint32_t kFloorBody = UINT32_MAX;
  static constexpr size_t kMaxPoints = 4;

  uint32_t bodyA = 0;
  uint32_t bodyB = kFloorBody;
  uint32_t subA = 0;
  uint32_t subB = 0;
  Vec3 normal{};          ///< unit normal pointing from A toward B (pushing B along +normal, A along -normal)
  Vec3 tangent1{};
  Vec3 tangent2{};
  double friction = 0.25;
  double restitution = 0.35;
  double rollingResistance = 0.0025;
  double spinFriction = 0.003;
  uint32_t pointCount = 0;
  ContactPoint points[kMaxPoints]{};
};

/// Narrowphase GJK + EPA + Sutherland-Hodgman face-clipping contact manifold generator.
/// Normal points from A to B. Returns true if intersecting (or within contact margin).
bool collideConvex(const ConvexShape& a, const Pose& poseA,
                   const ConvexShape& b, const Pose& poseB,
                   ContactManifold& out);

/// Exact contact manifold between a convex shape and a static infinite plane `dot(p, planeNormal) >= planeOffset`
/// (for LDraw floor at y = floorY where +Y is down, planeNormal = {0, -1, 0} pointing UP, solid region y >= floorY).
/// Outward normal of the manifold points from bodyA toward floor (i.e. +Y down, so impulse pushes bodyA UP along -normal).
bool collideConvexPlane(const ConvexShape& a, const Pose& poseA,
                        Vec3 planeUpNormal, double planePosOnUp,
                        ContactManifold& out);

/// Exact ray-vs-convex-shape intersection. Returns hit parameter t in [0, maxT] and outward unit normal.
struct ShapeRayHit {
  double t = 0.0;
  Vec3 point{};
  Vec3 normal{};
};
std::optional<ShapeRayHit> raycastConvex(const ConvexShape& shape, const Pose& pose,
                                         Vec3 origin, Vec3 unitDir, double maxT);

/// Persistent contact cache keyed by (bodyA, bodyB, subA, subB) for impulse warm-starting.
class ContactCache {
 public:
  struct SerializedEntry {
    uint32_t bodyA = 0, bodyB = 0, subA = 0, subB = 0;
    uint32_t count = 0;
    uint32_t age = 0;
    struct Point {
      Vec3 localA{}, localB{};
      uint64_t featureId = 0;
      double normalImpulse = 0, tangentImpulse1 = 0, tangentImpulse2 = 0, twistImpulse = 0;
    };
    Point points[ContactManifold::kMaxPoints]{};
  };

  /// Restore cached impulses into newly detected manifolds before velocity solving.
  void restore(std::vector<ContactManifold>& activeManifolds);
  /// Save post-solve impulses back into the cache and prune stale entries.
  void save(const std::vector<ContactManifold>& activeManifolds);
  void clear();
  std::vector<SerializedEntry> serialize() const;
  void deserialize(const std::vector<SerializedEntry>& entries);

 private:
  struct Key {
    uint32_t bodyA, bodyB, subA, subB;
    bool operator==(const Key& o) const = default;
  };
  struct KeyHash {
    size_t operator()(const Key& k) const noexcept {
      uint64_t h = (uint64_t(k.bodyA) << 32) | k.bodyB;
      h ^= (uint64_t(k.subA) << 16) ^ (uint64_t(k.subB) * 0x9e3779b97f4a7c15ULL);
      h ^= h >> 30;
      h *= 0xbf58476d1ce4e5b9ULL;
      h ^= h >> 27;
      return static_cast<size_t>(h);
    }
  };
  struct CachedPoint {
    Vec3 localA, localB;
    uint64_t featureId = 0;
    double normalImpulse = 0;
    double tangentImpulse1 = 0;
    double tangentImpulse2 = 0;
    double twistImpulse = 0;
  };
  struct Entry {
    uint32_t count = 0;
    CachedPoint points[ContactManifold::kMaxPoints]{};
    uint32_t age = 0;
  };
  std::unordered_map<Key, Entry, KeyHash> cache_;
};

/// Thread-safe cache of ConvexHulls built from LDraw part meshes.
class HullCache {
 public:
  std::shared_ptr<const ConvexHull> get(const std::shared_ptr<const ldraw::Mesh>& mesh);
  void clear();

 private:
  std::unordered_map<const ldraw::Mesh*, std::shared_ptr<const ConvexHull>> map_;
};

}  // namespace bm::physics
