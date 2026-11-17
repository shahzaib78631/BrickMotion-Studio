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

/// What trianglesCross() decides on: each triangle must pass through the other's plane, by more
/// than kTouch on each side, and then this is how far the two stretches where they do overlap
/// along the line where the planes meet (negative if they miss each other along it; minus
/// infinity if they do not pass through each other's planes, or have no area). They cross when
/// it is more than kTouch. `where`, if given and they overlap, receives a point of the overlap.
double crossLength(const Vec3 a[3], const Vec3 b[3], Vec3* where = nullptr);

/// A node of the bounding-volume tree. A leaf (count > 0) covers `count` triangles starting
/// at triangle `left`; an inner node's children are nodes `left` and `left + 1`.
struct Node {
  float min[3], max[3];    ///< box of the true surface under this node
  float imin[3], imax[3];  ///< box of the inner surface under it; min > max when none of it survives
  uint32_t left = 0, count = 0;
};

struct Shape {
  std::vector<Vec3f> outer;         ///< the mesh's vertices: the part's true surface
  std::vector<uint32_t> triangles;  ///< 3 indices into `outer` per triangle, in tree order
  /// The inner surface: 3 points per triangle, in the same order as `triangles`. Each
  /// triangle is moved inward by kSkin along its own normal and trimmed back from the edges
  /// where the surface turns outward. A triangle too small to survive that has three equal points.
  std::vector<Vec3f> inner;
  std::vector<Node> nodes;          ///< nodes[0] is the root; one box per surface; empty if no triangles
  Box bounds;                       ///< of the outer surface; empty if there are no triangles
};

/// Builds a part's shape. Two pieces interpenetrate when the inner surface of one crosses
/// the true surface of the other, so surfaces that touch, or overlap by less than the skin,
/// do not count. (Pulling both in by the same amount would not work: two aligned bricks
/// pushed into each other would only ever have coplanar, touching faces.)
///
/// The inner surface is built face by face, not by moving shared corners: a corner shared by
/// a sloped face and the faces around it has no single inward direction, and moving it tilts
/// the sloped face out through its own edge. Each face keeps its plane's direction and is
/// trimmed back from each edge by as much as the turn of the surface there requires: one
/// skin at a brick's rim, a tenth of that between the facets of a cylinder, so round parts
/// keep their inner surface.
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
