#include "bmapp/motion_fields.h"

#include <algorithm>

#include "bmapp/session.h"

namespace bmapp {

MotionFields effectiveMotion(const Session* session, MotionScope scope, size_t step, const MotionFields& fields) {
  const MotionFields defaults{1, 0.25, 0, 0};
  std::vector<MotionFields> ordered{fields};
  if (session && scope != MotionScope::Project) {
    if (scope == MotionScope::Parts) ordered.push_back(session->motionFields(MotionScope::Step, step, {}));
    ordered.push_back(session->motionFields(MotionScope::Project, 0, {}));
  }
  ordered.push_back(defaults);
  MotionFields out = defaults;
  for (auto it = ordered.rbegin(); it != ordered.rend(); ++it) {
    if (it->time >= 0) out.time = it->time;
    if (it->landing >= 0) out.landing = it->landing;
    if (it->hover >= 0) out.hover = it->hover;
    if (it->ease >= 0) out.ease = it->ease;
  }
  return out;
}

FlightPhases flightPhases(const MotionFields& effective) {
  FlightPhases phases;
  phases.landing = effective.landing;
  phases.hover = std::min(effective.hover, std::max(0.0, 0.95 - effective.landing));
  phases.travel = 1 - effective.landing - phases.hover;
  return phases;
}

}  // namespace bmapp
