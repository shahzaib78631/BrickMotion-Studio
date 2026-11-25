#pragma once

#include "bm/plan/constraints.h"
#include "bm/plan/timeline.h"

namespace bmapp {

class Session;

struct AnimationAuthoring {
  struct Motion {
    double time = 1, landing = -1, hover = -1;
    bm::plan::Ease ease = bm::plan::Ease::Smooth;
  };
  bm::plan::Style style;
  /// The project's build settings that reach the sequencer (Options) rather than the Style.
  bm::plan::Order order = bm::plan::Order::Reverse;
  bool cleanGrownUnits = false;
  bm::plan::Constraints constraints;
  std::vector<Motion> motion;
  std::vector<double> holds;
  std::vector<std::pair<uint32_t, double>> waitingTurns;
  /// Waiting spots dragged across the floor (assembly.floorShift), by piece, LDU.
  std::vector<std::pair<uint32_t, bm::Vec3>> waitingShifts;
  /// The whole staging area turned about the model, degrees (stagingTurns).
  double stagingTurn = 0;
};

/// Captures the active model's authored settings while the session owns the source.
AnimationAuthoring animationAuthoring(const Session& session);
void retimeAnimation(const bm::Model& model, const bm::plan::Plan& plan, bm::plan::Timeline& timeline,
                     const AnimationAuthoring& authored);
bool canTurnOnFloor(const bm::plan::Flight& flight);
double waitFacingSeat(const bm::plan::Flight& flight);
/// Turns the whole staging area `degrees` about the middle of the model's footprint: every flight
/// waits swung round the model and eases back onto its planned way in (Flight::swing).
void swingStaging(const bm::Model& model, bm::plan::Timeline& timeline, double degrees);
/// Puts each dragged piece's waiting spot where it was dragged (Flight::shift); every other
/// flight waits where planned. Cheap, and changes nothing but where pieces wait: a drag never
/// replans (the web's applyFloorShifts). A piece built in a unit with others is not moved alone.
void shiftWaitingParts(const bm::plan::Plan& plan, bm::plan::Timeline& timeline,
                       const std::vector<std::pair<uint32_t, bm::Vec3>>& shifts, size_t pieceCount);
void orientWaitingParts(const bm::Model& model, const bm::plan::Plan& plan, bm::plan::Timeline& timeline,
                        const AnimationAuthoring& authored, bm::ldraw::PartCache& parts, bm::collide::ShapeCache& shapes,
                        std::vector<std::string>& notes, const bm::CancelToken& cancel);

}  // namespace bmapp
