#pragma once
// Whether two placed parts interpenetrate.
#include <cstddef>
#include <cstdint>
#include <vector>
#include "bm/collide/shape.h"

namespace bm::collide {

/// No piece in particular: a zone that names no pieces lets any two cross inside it.
inline constexpr uint32_t kAnyPiece = UINT32_MAX;

/// A capsule in model space (a sphere when a == b) inside which surfaces may cross: the
/// volume of a mate between two joined pieces. When it names the two (model piece indices,
/// either way round), only those two may cross there: a tyre's zone is everywhere, and lets the
/// tyre and its rim cross anywhere, but not the rim and the pin it slides along. Naming only
/// `first` lets that piece cross any other there; naming none lets any two. The tests of two
/// shapes below see no pieces and take every zone given; World's queries honour the names.
struct Zone {
  Vec3 a, b;
  double radius = 0;
  uint32_t first = kAnyPiece, second = kAnyPiece;
};

/// Whether `zone` lets pieces `p` and `q` cross inside it. kAnyPiece stands for a shape that is
/// not one of the model's pieces.
inline bool lets(const Zone& zone, uint32_t p, uint32_t q) {
  if (zone.first == kAnyPiece) return true;
  if (zone.second == kAnyPiece) return zone.first == p || zone.first == q;
  return (zone.first == p && zone.second == q) || (zone.first == q && zone.second == p);
}

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

/// `a` is carried from `xa` along unit vector `direction` (model space, no turning) by up to
/// `distance`. Returns where overlap(a, there, b, xb, zones) first holds, to within
/// kCrossingResolution, or infinity if it holds nowhere on the way. Not sampled: a crossing is
/// found however briefly it lasts (down to that resolution), as when two
/// corners pass each other a little more than a skin apart. One walk of the two trees finds when
/// each pair of triangles can touch at all; for each such pair, when it crosses is then worked
/// out (see pair.cpp).
double firstCrossing(const Shape& a, const Xform& xa, Vec3 direction, double distance, const Shape& b, const Xform& xb, const std::vector<Zone>& zones = {});

/// Where the straight way from `from` to `to` (model space) first passes through the true
/// surface of `b`, as a share of the way (0..1); more than 1 if it does not. A passage along a
/// triangle or through its very edge is not counted, so an answer is always a clean passage
/// through the surface. `where` receives the point.
double throughSurface(const Shape& b, const Xform& xb, Vec3 from, Vec3 to, Vec3* where = nullptr);

/// Whether `p` lies inside `zone`.
bool inside(const Zone& zone, Vec3 p);

}  // namespace bm::collide
