#pragma once
// Moving a system along one of its freedoms to a pose.
#include <vector>
#include "bm/kin/mobility.h"
#include "bm/kin/system.h"
#include "bm/kin/tolerances.h"
#include "bm/model.h"

namespace bm::kin {

struct Pose {
  std::vector<Xform> body;  ///< each body's motion from where the model has it (a model-space transform)
  /// False when the motion asked for could not be completed: the mechanism reached the end of
  /// what it can do, or the driver does not move in this freedom. `body` is then the last pose
  /// in which every joint closed, and `reached` how far the driver got.
  bool converged = true;
  double reached = 0;
};

/// Moves the system along `mob.freedoms[freedom]` so that `driver` turns by `amount` radians about its own
/// axis of turning (or, if it does not turn in this freedom, travels `amount` LDU), starting
/// from `from` (the model's own pose when null). Everything joined to the bodies the freedom
/// moves takes part, whether or not it is moving at the start.
///
/// The driver advances in steps of at most kDriveStep; after each, every joint is closed again
/// by Newton iteration on the same equations the freedoms came from. Gear ratios hold exactly
/// throughout: a gear's turn is its driver's times the ratio of their teeth, not a sum of
/// corrected steps.
/// `step` is the most the driver advances between corrections (radians; times 20 for LDU):
/// larger is faster and follows a tight mechanism less surely.
Pose drive(const System& sys, const Mobility& mob, size_t freedom, uint32_t driver, double amount, const Pose* from = nullptr, double step = kDriveStep);

/// Where a piece is in a pose.
Xform placed(const Model& model, const System& sys, const Pose& pose, uint32_t piece);

/// The transform that moves a body by `twist` for a time `t`: a turn about a line with a slide
/// along it.
Xform moved(const Twist& twist, double t);

}  // namespace bm::kin
