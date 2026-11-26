#pragma once
// Internal joint solver declarations shared between joints.cpp and world.cpp.
#include <vector>
#include "bm/physics/body.h"
#include "bm/physics/joints.h"

namespace bm::physics::detail {

/// Initialize precomputed local orthonormal bases and rest tracking on a newly added joint.
void initJoint(Joint& j, const std::vector<Body>& bodies);

/// Warm-start a joint's velocity constraints at the start of a substep and apply spring/damper forces.
void prepareJointVelocity(Joint& j, std::vector<Body>& bodies, double h, double warmStartFactor);

/// Perform one PGS velocity iteration on joint `j`.
void solveJointVelocity(Joint& j, std::vector<Body>& bodies, double h);

/// Perform one NGS positional stabilization iteration on joint `j`.
void solveJointPosition(Joint& j, std::vector<Body>& bodies, double maxCorrection);

/// Compute live reaction force/torque & LEGO clutch stress ratio after a substep.
void updateJointTelemetry(Joint& j, const std::vector<Body>& bodies, double h);

}  // namespace bm::physics::detail
