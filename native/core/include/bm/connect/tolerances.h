#pragma once
// Every tolerance the connection engine uses, in one place. Lengths are LDU (1 stud = 20).

namespace bm::connect {

/// Two axes count as parallel above this cosine (3.5 degrees). Model files and connector
/// data round their rotations to four decimals, which is worth up to about 2.5 degrees on a
/// minifig hand or arm; the next real angle a part is built at (a hinge step) is far larger.
inline constexpr double kAxisParallel = 0.998135;

/// How far a male connector's start may sit off the female's axis. Real files place parts
/// to 0.5-1 LDU at worst; a neighbouring stud is 20 away.
inline constexpr double kAxisOffset = 1.5;

/// Radii within this of each other are "the same size": a 6.0 stud in a 6.0 socket, a 6.25
/// lip in a 6.0 bore. The next real size up or down is at least 2 away (bar 4, stud 6, 8).
inline constexpr double kRadiusSlack = 0.75;

/// A male section wider than the bore it sits in is a clash only beyond this length, so a
/// chamfer or a rounding error at a section boundary is not one.
inline constexpr double kMinInterference = 1.0;

/// The least engaged length that counts as connected. A stud is 4 long, so a stud pushed in
/// a quarter of the way already holds.
inline constexpr double kMinGrip = 1.0;

/// A round bar grips the core of a cross-shaped axle hole when its radius is this share of
/// the cross's radius (4 in 6), give or take kRadiusSlack.
inline constexpr double kAxleCoreRatio = 2.0 / 3.0;

/// Ball centres, generic connector positions, and "the same line" when combining mates.
inline constexpr double kPointMatch = 2.0;
inline constexpr double kLineMatch = 1.0;

/// A rubber tyre stretches onto its rim: the measured bore and seat radii may differ by this.
inline constexpr double kTyreSlack = 3.0;

/// A clip with no stated length holds this much bar.
inline constexpr double kMinClipLength = 2.0;

/// Consecutive segments of one hose or cable lie this close together (origin to origin).
/// Generated segments are a few LDU long; a gap larger than this starts another element.
inline constexpr double kSegmentGap = 40.0;

/// How near a part's connector must be to the end of a flexible element for the element
/// to count as attached there.
inline constexpr double kSegmentReach = 14.0;

/// Spatial hash cell for finding candidate pairs. Larger than any connector radius.
inline constexpr double kHashCell = 16.0;

}  // namespace bm::connect
