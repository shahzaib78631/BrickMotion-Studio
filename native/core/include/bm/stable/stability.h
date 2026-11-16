#pragma once
// Whether a model, or a build step of it, stands: does every piece reach the floor through
// joints, and does each group's weight fall inside what it stands on.
#include <cstdint>
#include <vector>
#include "bm/connect/graph.h"
#include "bm/ldraw/part_cache.h"
#include "bm/model.h"

namespace bm::stable {

struct Options {
  Vec3 down{0, 1, 0};  ///< LDraw's y points down
  /// Per piece, for a build step: only these pieces are there. Null: all of them.
  const std::vector<uint8_t>* present = nullptr;
};

/// A set of pieces joined to each other (by any joint), taken as one rigid thing as posed.
struct Group {
  std::vector<uint32_t> pieces;
  double mass = 0;       ///< grams
  Vec3 centre;           ///< centre of mass
  bool onFloor = false;  ///< some point of it is on the floor
  /// LDU from the centre of mass, seen from above, to the edge of what it stands on: positive
  /// inside. Standing on a point or a line it is never positive. 0 when not on the floor.
  double margin = 0;
};

struct Result {
  bool stands = true;                 ///< nothing unsupported, nothing tipping
  std::vector<Group> groups;          ///< largest first
  std::vector<uint32_t> unsupported;  ///< pieces of groups that do not reach the floor
  std::vector<uint32_t> tipping;      ///< indices into `groups`: on the floor, weight outside the footprint
  double mass = 0;                    ///< grams, all present pieces
  double margin = 0;                  ///< the smallest margin over the groups on the floor
};

/// The weight of one piece of a part, in grams, and where its centre of mass is in part space.
/// From the volume its mesh encloses; from its box (kHollowShare) when the mesh encloses none.
double massOf(const ldraw::Mesh& mesh, Vec3* centre = nullptr);

/// Checks the model as posed. The floor is the plane under the lowest point of the whole
/// model, whichever pieces are present. Groups that move
/// against each other (a hinge) are still one group here: it asks whether the model stands as
/// it is, not whether it stays so when touched. Not checked: whether the joints are strong
/// enough to carry the load, and pieces that merely rest on others without a joint (they are
/// reported unsupported).
Result check(const Model& model, const connect::Graph& graph, ldraw::PartCache& parts, Options options = {});

}  // namespace bm::stable
