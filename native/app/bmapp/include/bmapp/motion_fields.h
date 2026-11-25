#pragma once
// The Build Motion editor's maths, shared by both app shells: inherited flight fields and the
// flight's phases.

#include <cstddef>

#include "bmapp/types.h"

namespace bmapp {

class Session;

/// `fields` with every unset (negative) field taken from the enclosing scope: parts from their
/// step, then the project, then the defaults {1, 0.25, 0, 0}.
MotionFields effectiveMotion(const Session* session, MotionScope scope, size_t step, const MotionFields& fields);

/// Shares of a flight: travel, then hover, then landing (sum 1). Hover leaves at least 5% travel.
struct FlightPhases {
  double travel = 1, hover = 0, landing = 0;
};
FlightPhases flightPhases(const MotionFields& effective);

}  // namespace bmapp
