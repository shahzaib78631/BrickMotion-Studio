#pragma once
// The bodies of a model that can move against each other, and the links between them.
#include <cstdint>
#include <vector>
#include "bm/collide/shape.h"
#include "bm/connect/graph.h"
#include "bm/kin/gears.h"
#include "bm/ldraw/part_cache.h"
#include "bm/model.h"

namespace bm::kin {

/// A joint between two bodies: everything that joins them, combined.
struct Link {
  uint32_t a = 0, b = 0;  ///< body indices, a < b
  connect::JointKind kind = connect::JointKind::Revolute;  ///< Revolute, Prismatic, Cylindrical or Spherical
  Vec3 point, axis;       ///< the line it turns about or slides along; a ball's centre
  uint32_t pieceA = 0, pieceB = 0;  ///< a pair of pieces it joins, pieceA in body a
};

/// A gear mesh between two bodies.
struct Gearing {
  uint32_t a = 0, b = 0;  ///< the bodies of mesh.a and mesh.b
  GearMesh mesh;
  uint32_t housing = UINT32_MAX;  ///< screw: the body of mesh.housing
};

struct System {
  std::vector<uint32_t> bodyOf;  ///< per piece
  uint32_t bodies = 0;
  std::vector<uint32_t> size;    ///< pieces per body
  uint32_t ground = 0;           ///< the body with the most pieces
  std::vector<Link> links;       ///< sorted by (a, b); one per pair of bodies
  std::vector<Gearing> gearings;
  std::vector<uint32_t> heldSlides;  ///< indices into Graph::connections: slides found not to move
  std::vector<std::vector<uint32_t>> pieces;  ///< per body
};

struct SystemOptions {
  /// Test each slide that is not a friction fit for room to travel (needs the parts' shapes).
  /// Without it every such slide is taken as real.
  bool testTravel = true;
};

/// Reduces the connection graph to what can move.
///
/// Pieces joined by fixed joints are one body to begin with. Then, until nothing changes:
/// - **A slide that does not move is removed.** A friction fit (a keyed axle, a snap lip, a
///   clip) holds where it was pushed. Any other slide is real if the smaller of the two
///   bodies has kMinTravel of room along it, one way or the other.
/// - **Everything between two bodies is combined** (connect::combine); if nothing is left free
///   the two are one body.
/// - **Two bodies turning on one shaft** are joined through it: a pin through two beams is a
///   hinge between the beams, so two pins lock them.
/// Stretches of flexible elements are bodies of their own with no links.
///
/// Bodies that are rigid only as a structure (a triangle of beams) stay separate here; the
/// mobility analysis finds that they do not move.
/// `parts` and `shapes` may be null when `options.testTravel` is false.
System buildSystem(const Model& model, const connect::Graph& graph, ldraw::PartCache* parts, collide::ShapeCache* shapes, SystemOptions options = {});

}  // namespace bm::kin
