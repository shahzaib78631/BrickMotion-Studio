#pragma once
// The physics of a brick seating, and the few numbers it needs. Sources: ABS datasheets (E, rho,
// nu, loss factor), Hertz contact, thin-plate (Kirchhoff) modes, compact-source radiation.
// Values marked "est." are estimates to be checked by ear and, where possible, by measurement.

namespace bms {

// ABS.
inline constexpr double kAbsYoung = 2.3e9;     // Pa
inline constexpr double kAbsDensity = 1050;    // kg/m^3
inline constexpr double kAbsPoisson = 0.35;
inline constexpr double kAbsWall = 1.5e-3;     // m: a brick's walls and top
inline constexpr double kLossFactor = 0.02;    // eta: a mode decays as exp(-pi f eta t)
inline constexpr double kMetresPerLdu = 0.4e-3;

// Modes: the struck face as a simply supported thin plate, m, n = 1..kModes, below kTopHz
// (above it nobody hears it: a 1x1 rings there, so one hears what it lands on).
inline constexpr int kModes = 4;
// A part held in the model (the one landed on, the model itself) has its edges held near clamped
// (a clamped square plate's f11 is 1.83 x the simply supported one) and loses more at its joints.
inline constexpr double kHeldFrequency = 1.83;
inline constexpr double kHeldLossFactor = 0.05;  // est.
inline constexpr double kTopHz = 20000;

// The press: a hand pushes at kPressSpeed; the faces meet and part (restitution kRestitution).
// Hertz contact time for an effective radius kContactRadius (the tube rims on the top face, est.).
inline constexpr double kPressSpeed = 0.1;      // m/s, est.
inline constexpr double kRestitution = 0.5;     // est.
inline constexpr double kContactRadius = 1e-3;  // m, est.
// A part longer than kTiltLdu is pressed a little tilted (kTiltDegrees, drawn per move): one end
// lands, then the other, kFirstShare of the impulse in the first.
inline constexpr double kTiltLdu = 40;
inline constexpr double kTiltDegrees[2] = {0.5, 1.5};
inline constexpr double kFirstShare = 0.6;

// What the impact rings: the unit, the part it lands on, and the model it is joined to, as a plate
// kAssemblyThickness thick at most (bricks clutched together are stiffer than one wall) of
// density kAssemblyFill x ABS (it is hollow), reached through the clutch at kJointTransmission.
inline constexpr double kAssemblyThickness = 9.6e-3;  // m: a brick's height, est.
inline constexpr double kAssemblyFill = 0.3;           // est.
inline constexpr double kJointTransmission = 0.3;      // est.

// A Technic pin's ridge: pushed through the hole it builds up kRidgeForce over kRidgeRamp, then
// lets go in kRidgeRelease, kRidgeDepth before the pin's collar lands.
inline constexpr double kRidgeForce = 4.0;        // N, est.
inline constexpr double kRidgeRamp = 0.002;       // s
inline constexpr double kRidgeRelease = 30e-6;    // s
inline constexpr double kRidgeDepth = 2e-3;       // m

// Sliding friction (an axle in its hole): stick-slip, slips at kSlipRate a second over the
// engaged length, each a drop of up to kSlipShare of kFrictionForce.
inline constexpr double kFrictionForce = 0.15;  // N, est.
inline constexpr double kSlipRate = 3000;       // per s, est.
inline constexpr double kSlipShare = 0.3;
inline constexpr double kSlideMaxSeconds = 0.05;

// Listening: air, a microphone kMicDistance away.
inline constexpr double kAirDensity = 1.2;      // kg/m^3
inline constexpr double kSoundSpeed = 343;      // m/s
inline constexpr double kMicDistance = 0.3;     // m

// Room (off unless SoundOptions::room > 0): a Schroeder reverb, 4 combs and 2 all-passes.
inline constexpr double kCombSeconds[4] = {0.0297, 0.0371, 0.0411, 0.0437};
inline constexpr double kCombFeedback = 0.72;
inline constexpr double kAllPassSeconds[2] = {0.005, 0.0017};
inline constexpr double kAllPassGain = 0.5;
inline constexpr double kStereoSpreadSeconds = 0.0005;

// How far a snap's sound reaches past its seat, and before it (a pin's ridge, a slide).
inline constexpr double kSnapTailSeconds = 0.6;
inline constexpr double kSnapLeadSeconds = 0.06;

}  // namespace bms
