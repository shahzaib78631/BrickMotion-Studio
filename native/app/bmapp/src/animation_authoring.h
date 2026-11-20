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
  bm::plan::Constraints constraints;
  std::vector<Motion> motion;
  std::vector<double> holds;
  std::vector<std::pair<uint32_t, double>> waitingTurns;
};

/// Captures the active model's authored settings while the session owns the source.
AnimationAuthoring animationAuthoring(const Session& session);
void retimeAnimation(const bm::Model& model, const bm::plan::Plan& plan, bm::plan::Timeline& timeline,
                     const AnimationAuthoring& authored);
bool canTurnOnFloor(const bm::plan::Flight& flight);
double waitFacingSeat(const bm::plan::Flight& flight);
void orientWaitingParts(const bm::Model& model, const bm::plan::Plan& plan, bm::plan::Timeline& timeline,
                        const AnimationAuthoring& authored, bm::ldraw::PartCache& parts, bm::collide::ShapeCache& shapes,
                        std::vector<std::string>& notes, const bm::CancelToken& cancel);

}  // namespace bmapp
