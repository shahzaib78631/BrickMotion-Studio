#pragma once
// Multibody joints, LEGO clutch breakability, springs/dampers, motors, and exact gear couplings.
#include <cmath>
#include <cstdint>
#include <limits>
#include "bm/kin/gears.h"
#include "bm/physics/constants.h"
#include "bm/physics/math_ext.h"

namespace bm::physics {

enum class JointKind : uint8_t {
  Fixed,        ///< 6-DOF weld / stud clutch (optionally breakable under pull/shear/bend/twist)
  Revolute,     ///< 1-DOF hinge / axle / pin-in-hole (limits, dry friction, motor, torsional spring)
  Prismatic,    ///< 1-DOF slider / piston / shock absorber (limits, friction, motor, linear spring-damper)
  Cylindrical,  ///< 2-DOF turn + slide along shared axis (independent angular & linear limits/friction/springs)
  Spherical,    ///< 3-DOF ball-and-socket / tow ball (swing-cone limit, twist limit, ball friction)
  Gear,         ///< Exact mechanical coupling: spur, bevel, worm (self-locking), rack, screw, CV, planetary
  Distance,     ///< 1-DOF rod or tension-only rope/cable/chain link with optional compliance
  Grab,         ///< Soft 6-DOF/3-DOF interactive pointer drag spring-damper
};

/// Joint limit settings (radians for angular, metres for linear).
struct JointLimits {
  bool enabled = false;
  double lower = -std::numeric_limits<double>::infinity();
  double upper = std::numeric_limits<double>::infinity();
  double restitution = 0.0;  ///< bounce at hard stops (0..1)
};

/// Motor controller attached to a joint DOF.
struct JointMotor {
  bool enabled = false;
  double targetVelocity = 0.0;  ///< rad/s (angular) or m/s (linear)
  double maxEffort = 0.25;      ///< N·m (stall torque) or N (max linear force)
  /// Optional speed-torque droop (realistic DC motor curve: torque falls linearly to 0 at no-load speed).
  bool useDcMotorCurve = false;
  double noLoadSpeed = clutch::kMotorMMaxOmega;
};

/// Hooke spring + viscous damper on a joint DOF.
struct JointSpring {
  bool enabled = false;
  double stiffness = 0.0;   ///< N·m/rad (angular) or N/m (linear)
  double damping = 0.0;     ///< N·m·s/rad (angular) or N·s/m (linear)
  double restTarget = 0.0;  ///< equilibrium angle (rad) or offset (m)
};

/// Calibrated breakability thresholds for LEGO stud/pin/clip/ball clutch failure.
struct JointStrength {
  bool breakable = false;
  double maxPullForce = std::numeric_limits<double>::infinity();    ///< N along release/normal axis
  double maxShearForce = std::numeric_limits<double>::infinity();   ///< N perpendicular to release axis
  double maxBendTorque = std::numeric_limits<double>::infinity();   ///< N·m bending moment
  double maxTwistTorque = std::numeric_limits<double>::infinity();  ///< N·m torsional moment
};

/// Mechanical coupling parameters for `JointKind::Gear`.
struct GearSpec {
  kin::MeshKind meshKind = kin::MeshKind::Parallel;
  /// Coupling ratio: `ratioA * q_a + ratioB * q_b = 0` (relative to `carrierBody` if != UINT32_MAX).
  /// For parallel/bevel gears: ratioA = teethA, ratioB = ±teethB (sign encodes direction).
  /// For rack-and-pinion: bodyA turns, bodyB translates: pitchRadius * omega_a + sign * v_b = 0.
  /// For screw/linear actuator: lead/(2*pi) * omega_a - v_b = 0.
  /// For CV joint: omega_a . axisA - omega_b . axisB = 0.
  double ratioA = 1.0;
  double ratioB = 1.0;
  uint32_t carrierBody = UINT32_MAX;  ///< optional carrier body (for planetary / differential trains)
  double backlash = 0.0;              ///< deadband (rad or m) before teeth engage
  double maxToothForce = std::numeric_limits<double>::infinity();  ///< tooth-skip torque/force cap
  /// Worm gears resist back-driving: driving from bodyB toward worm bodyA is blocked when true.
  bool wormSelfLocking = true;
};

/// Description used to construct any joint in `World`.
struct JointDesc {
  JointKind kind = JointKind::Fixed;
  uint32_t bodyA = 0;
  uint32_t bodyB = 0;  ///< UINT32_MAX attaches bodyA to the static world frame

  // Local frames on body A and body B (SI metres, relative to each body's CoM).
  Vec3 localAnchorA{};
  Vec3 localAnchorB{};
  Vec3 localAxisA{0.0, 1.0, 0.0};  ///< primary axis (hinge/slider/shaft/pull-off direction) in A's frame
  Vec3 localAxisB{0.0, 1.0, 0.0};  ///< primary axis in B's frame
  Quat localRefRot = Quat::identity();  ///< rest relative orientation qA^-1 * qB

  // Compliance (XPBD-style inverse stiffness: 0 = rigid, >0 = elastic flex).
  double linearCompliance = 0.0;   ///< m/N
  double angularCompliance = 0.0;  ///< rad/(N·m)

  // Angular DOF parameters (Revolute, Cylindrical, Spherical).
  JointLimits angularLimits;
  JointMotor angularMotor;
  JointSpring angularSpring;
  double angularFriction = 0.0;  ///< N·m dry Coulomb joint friction

  // Linear DOF parameters (Prismatic, Cylindrical, Distance).
  JointLimits linearLimits;
  JointMotor linearMotor;
  JointSpring linearSpring;
  double linearFriction = 0.0;   ///< N dry Coulomb sliding friction

  // Spherical cone limit (max half-angle in radians between axisA and axisB).
  double coneMaxAngle = kPi;

  // Distance joint parameters.
  double minDistance = 0.0;
  double maxDistance = 0.0;
  bool ropeOnly = false;  ///< true = unilateral tension-only cable/string (no compression)

  // Gear coupling parameters.
  GearSpec gear;

  // Breakable clutch strength.
  JointStrength strength;

  // Whether collision between bodyA and bodyB should be suppressed while this joint is intact.
  bool disableCollision = true;

  // Optional provenance: index into connect::Graph::connections (UINT32_MAX if synthetic).
  uint32_t connectionIndex = UINT32_MAX;
};

/// Live joint instance inside `World`, including warm-started impulses and live force/stress telemetry.
struct Joint {
  uint32_t id = 0;
  JointDesc desc;
  bool active = true;
  bool broken = false;

  // Orthonormal reference basis in A/B local frames (precomputed from localAxisA/B).
  Vec3 localPerpA1{}, localPerpA2{};
  Vec3 localPerpB1{}, localPerpB2{};

  // Warm-started Lagrange multipliers (SI impulse units: N·s and N·m·s).
  Vec3 linearImpulse{};         ///< 3-DOF positional constraint impulse (world frame)
  Vec3 angularImpulse{};        ///< 3-DOF rotational constraint impulse (world frame)
  double limitImpulse = 0.0;    ///< angular or linear limit impulse
  double linearLimitImpulse = 0.0;
  double motorImpulse = 0.0;
  double linearMotorImpulse = 0.0;
  double frictionImpulse = 0.0;
  double linearFrictionImpulse = 0.0;
  double gearImpulse = 0.0;
  double distanceImpulse = 0.0;
  double coneImpulse = 0.0;

  // Continuous multi-turn unwrapped angle tracking for Revolute / Cylindrical / Gear joints.
  double currentAngle = 0.0;
  double currentOffset = 0.0;
  double phaseIntegral = 0.0;  ///< exact accumulated gear phase error (rad or m)

  // Live telemetry computed after each substep (SI: Newtons and Newton-metres).
  Vec3 reactionForce{};       ///< world-space force exerted by A on B (N)
  Vec3 reactionTorque{};      ///< world-space torque exerted by A on B (N·m)
  double pullForce = 0.0;     ///< axial pull-off force component (N)
  double shearForce = 0.0;    ///< transverse shear force component (N)
  double bendTorque = 0.0;    ///< bending moment magnitude (N·m)
  double twistTorque = 0.0;   ///< torsional moment magnitude (N·m)
  double stressRatio = 0.0;   ///< max(load / capacity) across modes; >= 1.0 triggers break
};

}  // namespace bm::physics
