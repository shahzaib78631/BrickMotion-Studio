#pragma once
// Physical constants, unit conversions, LEGO material properties, and calibrated clutch strengths.
//
// Internal solver units: SI (metres, kilograms, seconds, radians, Newtons, N·m).
// Coordinate system: LDraw right-handed axes (+X right, +Y down, +Z forward; gravity is +Y).
// Public model-facing helpers convert losslessly between LDU (1 LDU = 0.4 mm) and metres.
#include <cmath>
#include <cstdint>
#include <string_view>
#include "bm/math.h"

namespace bm::physics {

inline constexpr double kPi = 3.14159265358979323846;
inline constexpr double kTwoPi = 2.0 * kPi;

// Unit conversions (exact LDraw specification: 1 stud = 20 LDU = 8.0 mm => 1 LDU = 0.4 mm).
inline constexpr double kMetersPerLdu = 0.0004;
inline constexpr double kLduPerMeter = 2500.0;
inline constexpr double kGramsPerKg = 1000.0;
inline constexpr double kKgPerGram = 0.001;

/// Standard terrestrial gravity (m/s^2), pointing along +Y (LDraw down).
inline constexpr double kGravity = 9.80665;
inline constexpr Vec3 kGravityVec{0.0, kGravity, 0.0};

inline constexpr Vec3 lduToMeters(Vec3 p) { return p * kMetersPerLdu; }
inline constexpr Vec3 metersToLdu(Vec3 p) { return p * kLduPerMeter; }
inline constexpr double lduToMeters(double v) { return v * kMetersPerLdu; }
inline constexpr double metersToLdu(double v) { return v * kLduPerMeter; }

/// Surface and bulk physical material properties.
struct Material {
  double density = 1050.0;            ///< kg/m^3 (ABS plastic = 1050)
  double staticFriction = 0.28;       ///< Coulomb static friction coefficient mu_s
  double dynamicFriction = 0.22;      ///< Coulomb kinetic friction coefficient mu_k
  double restitution = 0.36;          ///< coefficient of restitution (0..1)
  double rollingResistance = 0.0025;  ///< dimensionless rolling resistance coefficient
  double spinFriction = 0.003;        ///< torsional patch friction length scale (m)
};

namespace materials {
/// Standard injection-moulded ABS brick (LDraw opaque plastic).
inline constexpr Material kAbs{1050.0, 0.28, 0.22, 0.36, 0.0025, 0.003};
/// Soft TPE / rubber tyre or tread link.
inline constexpr Material kRubberTyre{1150.0, 0.92, 0.80, 0.52, 0.012, 0.008};
/// Transparent polycarbonate (windscreens, canopies, lenses).
inline constexpr Material kPolycarbonate{1200.0, 0.34, 0.27, 0.34, 0.0025, 0.003};
/// Studio tabletop / sweep floor surface.
inline constexpr Material kFloor{2200.0, 0.44, 0.35, 0.28, 0.004, 0.004};
/// High-friction Technic clutch / rubberised damper.
inline constexpr Material kHighGrip{1150.0, 0.85, 0.72, 0.25, 0.008, 0.006};
}  // namespace materials

/// Combine two surface materials for a contact pair (geometric mean for friction, max-weighted for restitution).
inline double combineFriction(double a, double b) { return std::sqrt(std::max(0.0, a * b)); }
inline double combineRestitution(double a, double b) { return std::max(a, b); }

/// Calibrated LEGO mechanical clutch capacities (SI: Newtons and Newton-metres).
/// Derived from measured LEGO ABS stud/pin pull-off forces (typical single stud ~1.5–2.5 N).
namespace clutch {
inline constexpr double kStudPullForce = 2.0;          ///< N per mated stud along pull-off axis
inline constexpr double kStudShearForce = 3.8;         ///< N per mated stud perpendicular to axis
inline constexpr double kStudBendTorque = 0.016;       ///< N·m per stud-lever pair
inline constexpr double kStudTwistTorque = 0.0045;     ///< N·m single stud torsional clutch

inline constexpr double kFrictionPinPull = 6.0;        ///< N (e.g. 2780 black Technic pin)
inline constexpr double kFrictionPinTorque = 0.0075;   ///< N·m rotational Coulomb friction
inline constexpr double kFreePinPull = 4.0;            ///< N (e.g. 3673 grey frictionless pin)
inline constexpr double kFreePinTorque = 0.00004;      ///< N·m minimal bearing friction

inline constexpr double kAxleSlideForce = 1.4;         ///< N per stud (20 LDU) of axle engagement
inline constexpr double kClipSnapForce = 2.4;          ///< N bar-in-clip release force
inline constexpr double kClipHingeTorque = 0.005;      ///< N·m clip hinge friction
inline constexpr double kBallSocketPull = 4.8;         ///< N towball/Mixel ball snap force
inline constexpr double kBallSocketTorque = 0.011;     ///< N·m ball-in-socket friction

/// Typical LEGO Technic shock absorber spring rates (N/m) and damping (N·s/m).
inline constexpr double kSoftShockStiffness = 220.0;   ///< N/m (grey/soft spring)
inline constexpr double kHardShockStiffness = 520.0;   ///< N/m (yellow/hard spring)
inline constexpr double kShockDamping = 4.5;           ///< N·s/m viscous + seal damping

/// Typical LEGO Power Functions motor reference specs (no-load rad/s, stall torque N·m).
inline constexpr double kMotorMMaxOmega = 42.4;        ///< ~405 RPM
inline constexpr double kMotorMStallTorque = 0.11;     ///< N·m
inline constexpr double kMotorXLMaxOmega = 23.0;       ///< ~220 RPM
inline constexpr double kMotorXLStallTorque = 0.40;    ///< N·m
}  // namespace clutch

/// Default fallback hollow-shell share when an LDraw part mesh is open or non-manifold.
inline constexpr double kHollowBoxFill = 0.25;
inline constexpr double kMinEnclosedFill = 0.02;

/// Minimum physically meaningful mass & inertia guards (prevents division by zero on degenerate parts).
inline constexpr double kMinMassKg = 1.0e-5;           ///< 0.01 grams
inline constexpr double kMinInertiaKgM2 = 1.0e-11;     ///< kg·m^2

/// Heuristic material classification from LDraw part name and colour code.
Material inferPartMaterial(std::string_view partName, int ldrawColor, bool isTyre = false);

}  // namespace bm::physics
