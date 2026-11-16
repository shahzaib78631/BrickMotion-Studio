#pragma once
// Every number the planner uses.

namespace bm::plan {

/// A direction is along a release's axis when the cosine of the angle between them is at
/// least this (3 degrees): the rounding of placed files, as kin::kMeshAxis.
inline constexpr double kReleaseAgree = 0.9986;

/// A direction is square to a bar when the cosine of its angle to the bar is at most this.
inline constexpr double kAcrossAgree = 0.0523;

/// LDU a unit must travel freely beyond the engaged length of its mates to count as out of
/// its seat: one stud height.
inline constexpr double kClearMargin = 4.0;

/// LDU short of the asked travel that still counts as having made it: the bisection of the
/// first contact stops within this.
inline constexpr double kTravelTol = 0.1;

/// LDU outside the box of everything built where a flight is in open air: one stud.
inline constexpr double kExitMargin = 20.0;

/// The least a first leg must gain (LDU) for a turn after it to be worth trying.
inline constexpr double kMinLeg = 8.0;

/// The most pieces in a unit grown to find a common direction. Larger things that go in as
/// one are authored submodels or rigid bodies, which have no limit.
inline constexpr int kMaxGroup = 24;

}  // namespace bm::plan
