#pragma once
// Whether two placed parts interpenetrate.
#include <vector>
#include "bm/collide/shape.h"

namespace bm::collide {

/// A capsule in model space (a sphere when a == b) inside which surfaces may cross: the
/// volume of a mate between two joined pieces.
struct Zone {
  Vec3 a, b;
  double radius = 0;
};

struct Hit {
  Vec3 point;  ///< model space: a point where the surfaces cross
  uint32_t triangleA = 0, triangleB = 0;  ///< the two triangles, as indices into each shape's triangle list
  bool innerOfA = false;  ///< which piece's inner surface it was: a's (true) or b's
};

/// How much overlap counts.
/// - Skin: the inner surface of either piece crosses the true surface of the other (more
///   than one skin). For pieces that have nothing to do with each other.
/// - Joined: the two inner surfaces cross each other (more than two skins). Pieces joined to
///   each other fit closely around the joint: hair over a head, a hinge's barrel in its cup.
enum class Depth { Skin, Joined };

/// Whether shape `a` placed by `xa` and shape `b` placed by `xb` interpenetrate: the inner
/// surface of either crosses the true surface of the other, somewhere outside every zone.
/// Touching, and overlap of less than kSkin, is not interpenetration. Never throws; shapes
/// with no triangles and transforms that are not finite or not invertible never overlap.
bool overlap(const Shape& a, const Xform& xa, const Shape& b, const Xform& xb, const std::vector<Zone>& zones = {}, Hit* hit = nullptr, Depth depth = Depth::Skin);

/// Whether `p` lies inside `zone`.
bool inside(const Zone& zone, Vec3 p);

}  // namespace bm::collide
