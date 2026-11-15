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
};

/// Whether shape `a` placed by `xa` and shape `b` placed by `xb` interpenetrate: the inner
/// surface of either crosses the true surface of the other, somewhere outside every zone.
/// Touching, and overlap of less than kSkin, is not interpenetration. Never throws; shapes
/// with no triangles and transforms that are not finite or not invertible never overlap.
bool overlap(const Shape& a, const Xform& xa, const Shape& b, const Xform& xb, const std::vector<Zone>& zones = {}, Hit* hit = nullptr);

/// Whether `p` lies inside `zone`.
bool inside(const Zone& zone, Vec3 p);

}  // namespace bm::collide
