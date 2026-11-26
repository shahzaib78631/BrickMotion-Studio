#pragma once
// Rigid body state, mass/inertia representation, and piece mapping.
#include <cstdint>
#include <string>
#include <vector>
#include "bm/physics/collision.h"
#include "bm/physics/constants.h"
#include "bm/physics/inertia.h"
#include "bm/physics/math_ext.h"

namespace bm::physics {

enum class BodyMotion : uint8_t {
  Dynamic,    ///< Simulated under gravity, forces, contacts, and constraints
  Static,     ///< Infinite mass, zero velocity (ground, fixed baseplate, locked chassis)
  Kinematic,  ///< Infinite mass, velocity-driven by animation or user input
};

/// Specification used to create a rigid body in `World`.
struct BodyDesc {
  BodyMotion motion = BodyMotion::Dynamic;
  Pose pose = Pose::identity();      ///< initial world pose of the body's CoM frame (SI metres)
  Vec3 linearVel{};                  ///< m/s
  Vec3 angularVel{};                 ///< rad/s (world space)
  MassProperties massProps{};        ///< if mass <= 0 for Dynamic, auto-derived from shape + material
  Material material = materials::kAbs;
  CompoundShape shape;
  double linearDamping = 0.02;       ///< s^-1 gentle aerodynamic drag
  double angularDamping = 0.04;      ///< s^-1
  double gravityScale = 1.0;         ///< multiplier on world gravity
  bool enableCcd = true;             ///< enable continuous collision detection guard
  bool allowSleep = true;
  std::string label;                 ///< optional diagnostic label
};

/// Live rigid body inside `World` (all state in SI units: metres, kg, seconds, radians).
struct Body {
  uint32_t id = 0;
  BodyMotion motion = BodyMotion::Dynamic;

  // CoM world-space pose & velocities.
  Pose pose = Pose::identity();
  Vec3 vel{};       ///< linear velocity of CoM (m/s)
  Vec3 omega{};     ///< angular velocity in world frame (rad/s)

  // External force & torque accumulators (cleared after each full step).
  Vec3 force{};     ///< N
  Vec3 torque{};    ///< N·m

  // Mass & inertia (local inertia is about the body's CoM in body frame).
  double mass = 0.0;
  double invMass = 0.0;
  SymMat3 localInertia = SymMat3::zero();
  SymMat3 localInvInertia = SymMat3::zero();
  SymMat3 worldInertia = SymMat3::zero();
  SymMat3 worldInvInertia = SymMat3::zero();

  Material material = materials::kAbs;
  CompoundShape shape;
  Box worldBounds;
  int32_t bvhProxy = DynamicBvh::kNullNode;

  double linearDamping = 0.02;
  double angularDamping = 0.04;
  double gravityScale = 1.0;
  bool enableCcd = true;
  bool allowSleep = true;
  bool sleeping = false;
  double sleepTimer = 0.0;

  // Island / solver transient indices.
  uint32_t islandId = UINT32_MAX;
  std::string label;

  // Mapping back to BrickMotion Model pieces (each piece's rigid offset from this body's CoM frame in SI).
  std::vector<uint32_t> pieceIndices;
  std::vector<Pose> pieceLocalPoses;

  bool isDynamic() const { return motion == BodyMotion::Dynamic && invMass > 0.0; }
  bool isStatic() const { return motion == BodyMotion::Static; }
  bool isKinematic() const { return motion == BodyMotion::Kinematic; }

  /// Update world-space inertia tensor and inverse from current orientation.
  void updateWorldInertia() {
    if (!isDynamic()) {
      worldInertia = SymMat3::zero();
      worldInvInertia = SymMat3::zero();
      return;
    }
    const Mat3 r = pose.rot.toMat3();
    worldInertia = localInertia.rotated(r);
    worldInvInertia = localInvInertia.rotated(r);
  }

  /// World velocity of a point given by lever arm `r = worldPoint - pose.pos`.
  Vec3 velocityAtOffset(Vec3 r) const { return vel + cross(omega, r); }

  /// World velocity of a world-space point `p`.
  Vec3 velocityAtPoint(Vec3 p) const { return vel + cross(omega, p - pose.pos); }

  /// Linear + rotational kinetic energy (Joules).
  double kineticEnergy() const {
    if (!isDynamic()) return 0.0;
    return 0.5 * mass * dot(vel, vel) + 0.5 * dot(omega, worldInertia * omega);
  }
};

}  // namespace bm::physics
