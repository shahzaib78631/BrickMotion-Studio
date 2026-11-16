#pragma once
// Every tolerance the kinematics engine uses, in one place. Lengths are LDU (1 stud = 20).

namespace bm::kin {

/// Gear axes count as parallel above this cosine, and as perpendicular below its sine
/// (3.5 degrees): the same allowance the connection engine gives rounded rotations.
inline constexpr double kMeshAxis = 0.998135;
inline constexpr double kMeshCross = 0.061049;

/// How far two pitch circles may be from touching. Technic pitch radii go in steps of 5 LDU
/// (8 teeth = 10, 12 = 15, 16 = 20) and official models mesh gears up to 2 off: across a
/// diagonal (two 16-tooth gears 2 by 0.5 studs apart are 41.2 for 40), or with a little play.
/// The next thing that is not a mesh (2 by 1 studs, 44.7) is well outside it.
inline constexpr double kPitchSlack = 2.0;

/// A pinion's pitch circle to a rack's pitch line. Racks sit on plates and half-stud offsets,
/// so official models run them up to 4.5 from the ideal (8880's front rack is 3 off).
inline constexpr double kRackSlack = 4.5;

/// Bevels: how far the two pitch circles may be apart where they should touch. The measured
/// tooth centres sit up to half a tooth width along the shaft from the true pitch cone.
inline constexpr double kBevelSlack = 3.5;

/// A pinion may lean this far (cosine of 0.55 rad) about the rack's length: a rack carried on
/// steering arms swings on an arc under its pinion.
inline constexpr double kRackTilt = 0.8525;

/// Two parallel gears must share at least this much tooth width to drive each other.
inline constexpr double kMinFaceShare = 2.0;

/// A slide is real when the piece can move this far along it without running into something.
/// Parts that are stopped sit against each other (0 to 1 LDU of play in files); a real slide
/// (a piston, a driving ring) travels 4 or more.
inline constexpr double kMinTravel = 2.0;

/// A gear's shaft line, measured from its teeth, and the line of the link it turns on are the
/// same shaft when this close. Files set bevels up to kBevelSlack off.
inline constexpr double kShaftMatch = 4.0;

/// An equation adds to the rank when what is left of it, after the others, is more than this
/// share of the largest. Equations are in radians and studs, so a link that a file misplaces
/// by a hundredth of an LDU still closes; one misplaced by more really is a different link.
inline constexpr double kRankTol = 1e-6;

/// A twist smaller than this (radians, or studs, per unit of the freedom) is no motion.
inline constexpr double kStill = 1e-7;

/// The most bodies solved together. The work grows with the cube of this; 400 bodies take a
/// few seconds. Larger moving cores are reported as not solved rather than attempted.
inline constexpr int kMaxSolveBodies = 400;

/// The driver moves at most this far between corrections: radians, or (times 20) LDU.
inline constexpr double kDriveStep = 0.05;

/// The joints count as closed when every equation is within this (radians, or studs).
inline constexpr double kCloseTol = 1e-10;

/// When some body goes this many times faster than the driver, the driver is not what moves
/// the motion and driving it further is given up.
inline constexpr double kMaxDriveGearing = 1000.0;

/// A drive step is cut down by at most this for a body that goes faster than the driver, so a
/// long train costs a bounded number of steps.
inline constexpr double kMaxStepCut = 8.0;

/// A joint the file has out of line by up to this (studs: two ten-thousandths of an LDU) is
/// closed as far as it can be when no correction closes it further. Set from what files
/// show: 42000's wing linkage stays about 1e-6 out however it is driven. A mechanism at the
/// end of its travel opens by far more than this and is stopped.
inline constexpr double kCloseSlack = 1e-5;

/// Newton steps allowed to close the joints after each move. It converges in three or four
/// when it converges at all.
inline constexpr int kMaxNewton = 20;

/// The step, in radians, at which a slid body is turned round its line to see what has it by
/// the teeth: one degree, finer than the play of a dog clutch.
inline constexpr double kClutchStep = 0.017453292519943295;

}  // namespace bm::kin
