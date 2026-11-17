#pragma once
// Every tolerance the collision engine uses. Lengths are LDU.

namespace bm::collide {

/// Surfaces that overlap by less than this are not a collision. Real parts are modelled as
/// polygons (a round pin is 16-sided: its corners poke 0.12 into a 16-sided hole turned the
/// other way), friction ridges stand 0.25 proud, and model files place parts to about 0.1.
inline constexpr double kSkin = 0.5;

/// Two triangles must cross by more than this to count; below it they are touching.
inline constexpr double kTouch = 0.05;

/// How far a mate's exempt volume reaches beyond the connector's own radius: a clip's jaws,
/// a tyre's bead and a socket's wall are just outside the connector they hold.
inline constexpr double kZonePad = 2.0;

/// The exempt radius for a mate with no size of its own (a hinge or wheel record that is
/// only a point and an axis).
inline constexpr double kGenericZone = 10.0;

/// A mate that holds by stretching (a rubber tyre on its rim) lets the two pieces cross
/// anywhere: its zone is everything.
inline constexpr double kElasticZone = 1e9;

/// How far a gear's teeth reach beyond its pitch circle, and a rack's beyond its pitch line.
/// Technic teeth are about 2.5 LDU either side of the pitch circle; 3 covers the modelled tips.
inline constexpr double kToothReach = 3.0;

/// Spacing of the poses checked along a move that turns (World::sweep), and the unit a straight
/// move is looked at in stretches of. Equal to the skin. A straight move is not sampled
/// (firstCrossing): samples this far apart step over a graze, two corners passing each other a
/// little more than a skin apart, that lasts a fraction of a step.
inline constexpr double kSweepStep = kSkin;

/// How closely firstCrossing() places where two pieces moving past each other begin to cross.
inline constexpr double kCrossingResolution = 1e-3;

/// The most poses one move is checked at, however long it is.
inline constexpr int kMaxSweepSteps = 4096;

}  // namespace bm::collide
