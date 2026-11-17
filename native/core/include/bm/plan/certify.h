#pragma once
// The certifier: replays a finished plan against the three hard rules. It shares no code with
// the planner (it does not call extract, leaveDirections or the sequencer), so a planner fault
// cannot certify itself. It is the only thing that may call a move certified.
#include "bm/plan/plan.h"

namespace bm::plan {

struct MoveCheck {
  bool flagged = false;         ///< the planner itself could not show how it goes in: not checked further
  bool joined = false;          ///< rule 1: once placed it is joined to something already placed, or it starts its group
  bool clear = false;           ///< rule 2: no pose of its flight interpenetrates a placed piece
  bool alongConnector = false;  ///< rule 3: the leg into its seat satisfies every mate it makes with placed pieces
  uint32_t crossed = UINT32_MAX;
  bool certified() const { return !flagged && joined && clear && alongConnector; }
};

struct Certificate {
  std::vector<MoveCheck> moves;   ///< one per Plan::moves
  std::vector<Certificate> subs;  ///< one per Plan::subs
  /// Totals, sub-plans included.
  int total = 0, certified = 0, floating = 0, crossings = 0, offAxis = 0, flagged = 0, unjoined = 0;
  bool ok() const { return total == certified; }
};

/// Checks every move in build order. Each straight leg of a flight is checked along its whole
/// length, not at sampled poses (World::clearTravel): a crossing is found however briefly it
/// lasts, down to collide::kCrossingResolution of travel.
Certificate certify(const Model& model, const connect::Graph& graph, ldraw::PartCache& parts, collide::ShapeCache& shapes, const Plan& plan);

}  // namespace bm::plan
