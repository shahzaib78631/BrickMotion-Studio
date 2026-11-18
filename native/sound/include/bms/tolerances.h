#pragma once
// The sound's constants: starting values from the phase 7 plan, to be tuned by ear (the owner's
// listening gate).

namespace bms {

// The unit's footprint rung as a thin ABS plate (Kirchhoff): f_mn = (pi/2) sqrt(D / (rho h))
// ((m/a)^2 + (n/b)^2), D = E h^3 / 12(1 - nu^2), m, n = 1..kModes, below kTopHz.
inline constexpr double kAbsYoung = 2.3e9;     // Pa
inline constexpr double kAbsDensity = 1050;    // kg/m^3
inline constexpr double kAbsPoisson = 0.35;
inline constexpr double kAbsWall = 1.5e-3;     // m
inline constexpr double kMetresPerLdu = 0.4e-3;
inline constexpr int kModes = 3;
inline constexpr double kTopHz = 20000;
inline constexpr double kLossFactor = 0.03;    // eta: a mode decays as exp(-pi f eta t)
inline constexpr double kTouchingLevel = 0.5;  // what it lands on rings at this share
inline constexpr double kPulseSeconds = 0.0002;  // the half-sine force of one click, for a 2x4 footprint
// A smaller part strikes shorter (lighter and stiffer), so its high modes are struck at all: the
// pulse scales with sqrt(footprint / kPulseArea), within kPulseScale.
inline constexpr double kPulseArea = 80.0 * 40.0;  // LDU^2
inline constexpr double kPulseScale[2] = {0.25, 2.0};
inline constexpr double kSmallPartTop = 0.9;  // a part too small to ring below the top keeps its lowest mode at this share of it

// Clicks: 2, 3 or 4 by mates (<= 2, <= 6, more), kClickGap + kClickGapPerDoubling * min(log2 mates, 4)
// apart, the first at the seat, each at kClickFalloff of the one before.
inline constexpr double kClickGap = 0.014;
inline constexpr double kClickGapPerDoubling = 0.003;
inline constexpr double kClickFalloff = 0.75;
inline constexpr double kClickLevel = 1.0;

// Slide: noise band-passed at kSlideHz x the ring pitch (Q kSlideQ), rising over
// min(seatSeconds, kSlideMax) before the seat.
inline constexpr double kSlideHz = 3200;
inline constexpr double kSlideQ = 0.8;
inline constexpr double kSlideMax = 0.08;
inline constexpr double kSlideLevel = 0.12;       // studs
inline constexpr double kSlideRidgeLevel = 0.25;  // a gripping mate (a pin's ridge)
inline constexpr double kSlideAloneLevel = 0.35;  // no clicking mate (an axle): the whole sound

// Thump: a tone falling from kThumpSweep x its pitch over kThumpSweepSeconds, and
// kThumpNoiseSeconds of noise low-passed at kThumpNoiseHz. Pitch, level and decay as the web's
// snapCharacter: a brick (unit kTallLdu or more high) lower and louder than a plate; its size
// grows by kThumpSizePerDoubling for each doubling of the pieces built, up to kThumpSizeMax.
inline constexpr double kThumpSweep = 1.5;
inline constexpr double kThumpSweepSeconds = 0.03;
inline constexpr double kThumpNoiseSeconds = 0.04;
inline constexpr double kThumpNoiseHz = 500;
inline constexpr double kTallLdu = 20;
inline constexpr double kThumpSizePerDoubling = 0.5;
inline constexpr double kThumpSizeMax = 6;
inline constexpr double kThumpLevel = 0.6;

// Room: a Schroeder reverb, 4 combs and 2 all-passes, at SoundOptions::room.
inline constexpr double kCombSeconds[4] = {0.0297, 0.0371, 0.0411, 0.0437};
inline constexpr double kCombFeedback = 0.72;
inline constexpr double kAllPassSeconds[2] = {0.005, 0.0017};
inline constexpr double kAllPassGain = 0.5;
inline constexpr double kStereoSpreadSeconds = 0.0005;  // the right channel's delays are this longer

// How far a snap's sound reaches past its seat.
inline constexpr double kSnapTailSeconds = 0.7;

}  // namespace bms
