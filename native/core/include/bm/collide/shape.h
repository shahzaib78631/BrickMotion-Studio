#pragma once
// A part's collision shape: its true surface, the same surface pulled inward by the skin,
// and a tree over the triangles.
#include <cstdint>
#include <memory>
#include <vector>
#include "bm/collide/tolerances.h"
#include "bm/ldraw/mesh.h"
#include "bm/math.h"

namespace bm::collide {

struct Vec3f {
  float x = 0, y = 0, z = 0;
};

/// Whether two triangles cross: their surfaces pass through each other. Triangles that touch
/// at a point or along an edge, lie in one plane, or have no area do not cross. `where`, if
/// given, receives a point on the line where they cross.
bool trianglesCross(const Vec3f a[3], const Vec3f b[3], Vec3f* where = nullptr);

/// A node of the bounding-volume tree. A leaf (count > 0) covers `count` triangles starting
/// at triangle `left`; an inner node's children are nodes `left` and `left + 1`.
struct Node {
  float min[3], max[3];
  uint32_t left = 0, count = 0;
};

struct Shape {
  std::vector<Vec3f> outer;         ///< the mesh's vertices: the part's true surface
  std::vector<Vec3f> inner;         ///< the same vertices moved inward by kSkin
  std::vector<uint32_t> triangles;  ///< 3 indices per triangle, in tree order
  std::vector<Node> nodes;          ///< nodes[0] is the root; boxes hold both surfaces; empty if no triangles
  Box bounds;                       ///< of the outer surface; empty if there are no triangles
};

/// Builds a part's shape. Two pieces interpenetrate when the inner surface of one crosses
/// the true surface of the other, so surfaces that touch, or overlap by less than the skin,
/// do not count. (Pulling both in by the same amount would not work: two aligned bricks
/// pushed into each other would only ever have coplanar, touching faces.)
///
/// A vertex moves against the normals of the faces that meet at it, so each of those faces
/// moves in by kSkin; a vertex of two-sided geometry (whose normals cancel) stays put.
/// Triangles with no area or with bad indices are dropped.
Shape buildShape(const ldraw::Mesh& mesh);

/// One shape per mesh, built on first use. Thread-safe.
class ShapeCache {
 public:
  ShapeCache();
  ~ShapeCache();
  ShapeCache(const ShapeCache&) = delete;
  ShapeCache& operator=(const ShapeCache&) = delete;
  /// Never null. The mesh is kept alive for as long as the cache holds its shape.
  std::shared_ptr<const Shape> get(const std::shared_ptr<const ldraw::Mesh>& mesh);

 private:
  struct State;
  std::unique_ptr<State> state_;
};

}  // namespace bm::collide
