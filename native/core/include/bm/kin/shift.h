#pragma once
// Shifts: a body slid to another place where it clicks home, and what it then turns with.
#include <vector>
#include "bm/collide/shape.h"
#include "bm/connect/graph.h"
#include "bm/kin/system.h"
#include "bm/ldraw/part_cache.h"
#include "bm/model.h"

namespace bm::kin {

/// One seat of one detented slide (Link::seats), other than where the model has it.
struct Shift {
  uint32_t link = 0;   ///< index into System::links
  uint32_t body = 0;   ///< the body that is slid: the smaller of the link's two
  Vec3 move;           ///< how it is moved to get there
  /// The bodies that turn with it once it is there (a driving ring pushed into a clutch gear).
  std::vector<uint32_t> turnsWith;
};

/// Every shift the system has. What a slid body turns with is found by collision, not from
/// what the parts are called: at the seat the body is turned once round the slide's line. A
/// body that stops it at every angle is in the way of the slide itself (the fork that pushes
/// it) and says nothing; one that stops it at some angles and not at others has it by the
/// teeth, and turns with it.
std::vector<Shift> findShifts(const Model& model, const connect::Graph& graph, const System& sys, ldraw::PartCache& parts, collide::ShapeCache& shapes);

/// The system as it is with `chosen` made: each body in `turnsWith` is coupled to the slid
/// body so the two turn together about the slide's line.
System shifted(const System& sys, const std::vector<Shift>& chosen);

}  // namespace bm::kin
