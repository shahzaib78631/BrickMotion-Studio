#pragma once

#include <cstdint>
#include "bm/math.h"

namespace bmapp {

struct MovingPiece {
  uint32_t piece;
  /// The change in world space is conjugated by this transform in another use of a shared def.
  bm::Xform frame;
  bm::Xform apply(const bm::Xform& worldChange, const bm::Xform& oldPose) const {
    return frame * worldChange * frame.inverse() * oldPose;
  }
};

}  // namespace bmapp
