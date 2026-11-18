#pragma once
// The seatings of a build, as the sound hears them: when each unit lands in its seat, what it
// joins, and how big it and the model are.
#include <cstdint>
#include <functional>
#include <span>
#include <vector>
#include "bm/connect/graph.h"
#include "bm/math.h"
#include "bm/model.h"
#include "bm/plan/plan.h"
#include "bm/plan/timeline.h"

namespace bms {

struct SnapEvent {
  int frame = 0;                 ///< the first frame poseAt puts the unit in its seat
  uint32_t move = 0;             ///< index into Plan::moves
  uint16_t mates = 0;            ///< connector pairs between the unit and pieces already built
  bool ridge = false;            ///< one of them grips (Connection::friction): a pin's click
  double grip = 0;               ///< LDU engaged
  bm::connect::JointKind joint = bm::connect::JointKind::Fixed;  ///< Fixed if any is; else the first in enum order
  bm::Box unit, touching, built;  ///< the unit, the built pieces it joins, everything built (with it)
  uint32_t builtPieces = 0;      ///< pieces built before it
  double seatSeconds = 0;        ///< how long its last travel into the seat took
  double pan = 0;                ///< -1..1: the unit's centre across the screen at `frame`
};

/// One event per top-level move that flies (Flag::None and frames > 0), in build order.
/// `pieceBoxes` are the pieces' boxes where the model has them; `screenX` says where a point is
/// across the screen at a frame (-1 left edge, 1 right edge). The flights' frame rate is
/// plan::Style{}.fps. Never throws.
std::vector<SnapEvent> snapEvents(const bm::Model& model, const bm::connect::Graph& graph, const bm::plan::Plan& plan, const bm::plan::Timeline& timeline,
                                  std::span<const bm::Box> pieceBoxes, const std::function<double(int frame, bm::Vec3 point)>& screenX);

}  // namespace bms
