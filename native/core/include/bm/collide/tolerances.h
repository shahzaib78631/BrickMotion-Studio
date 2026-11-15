#pragma once
// Every tolerance the collision engine uses. Lengths are LDU.

namespace bm::collide {

/// Surfaces that overlap by less than this are not a collision. Real parts are modelled as
/// polygons (a round pin is 16-sided: its corners poke 0.12 into a 16-sided hole turned the
/// other way), friction ridges stand 0.25 proud, and model files place parts to about 0.1.
inline constexpr double kSkin = 0.5;

/// Two triangles must cross by more than this to count; below it they are touching.
inline constexpr double kTouch = 1e-4;

/// How far a mate's exempt volume reaches beyond the connector's own radius: a clip's jaws,
/// a tyre's bead and a socket's wall are just outside the connector they hold.
inline constexpr double kZonePad = 2.0;

/// The exempt radius for a mate with no size of its own (a hinge or wheel record that is
/// only a point and an axis).
inline constexpr double kGenericZone = 10.0;

/// Spacing of the poses checked along a move. Equal to the skin, so nothing thicker than
/// the skin can be stepped over.
inline constexpr double kSweepStep = kSkin;

/// The most poses one move is checked at, however long it is.
inline constexpr int kMaxSweepSteps = 4096;

}  // namespace bm::collide
