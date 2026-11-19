#pragma once
#include <vector>
#include "bmf/beats.h"
#include "bmf/body.h"
#include "bmf/rules.h"
#include "bmf/shots.h"

namespace bm::film {

/// How well a track films its build: what it showed, what it missed, and how it moved.
struct Report {
  int landings = 0;         ///< top-level flights
  int landingsInFrame = 0;  ///< of them, in frame and not hidden at the frame they land
  std::vector<int> missed;  ///< the flights that were not
  int insideFrames = 0;     ///< frames whose eye is inside a landed piece or under the floor
  double maxJerk = 0;       ///< largest angular jerk within a shot, radians per second cubed
  double maxTargetJump = 0; ///< largest frame-to-frame target move within a shot, LDU
  double cutsPerMinute = 0, shortestShot = 0;
  std::vector<RuleMiss> rules;  ///< the editing rules the shot list breaks
  double ms = 0;                ///< the director plus the body, filled by the caller
};

Report measure(const Track& track, const std::vector<Shot>& shots, const Beats& beats, const plan::Timeline& t, const plan::Plan& plan, const collide::World& world);

}  // namespace bm::film
