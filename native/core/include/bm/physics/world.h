#pragma once
// The BrickMotion multibody rigid-body physics world:
// substepped TGS/XPBD hybrid constraint solver, implicit gyroscopic dynamics,
// circular Coulomb friction cone, island sleeping, CCD anti-tunneling,
// impact/break event telemetry, raycasting, and deterministic state snapshots.
#include <cstdint>
#include <optional>
#include <unordered_set>
#include <vector>
#include "bm/physics/body.h"
#include "bm/physics/collision.h"
#include "bm/physics/constants.h"
#include "bm/physics/joints.h"

namespace bm::physics {

struct WorldConfig {
  Vec3 gravity = kGravityVec;        ///< m/s^2 (LDraw: +Y is down)
  int substeps = 8;                  ///< physics substeps per frame (e.g. 8 @ 60Hz = 480Hz)
  int velocityIterations = 12;       ///< PGS velocity solver iterations per substep
  int positionIterations = 4;        ///< NGS non-linear position stabilization iterations per substep

  bool floorEnabled = true;          ///< infinite studio tabletop plane
  double floorY = 0.0;               ///< floor plane Y coordinate in metres (+Y is down; solid is y >= floorY)
  Material floorMaterial = materials::kFloor;

  double warmStartFactor = 0.88;     ///< fraction of prior substep impulse carried forward
  double restitutionThreshold = 0.12;  ///< m/s: impacts slower than this settle inelastically (zero micro-bounce)
  double contactSlop = 1.5e-4;       ///< 0.15 mm penetration allowance before position correction
  double maxPositionCorrection = 0.004;  ///< 4 mm max correction per NGS iteration
  double baumgarteContact = 0.0;     ///< split-impulse default (0.0 = pure NGS position stabilization, zero bounce)

  bool enableGyroscopic = true;      ///< implicit gyroscopic torque (accurate precession & Dzhanibekov effect)
  bool enableSleeping = true;        ///< island-based sleeping for zero jitter & fast large scenes
  double sleepLinearVel = 0.008;     ///< m/s (8 mm/s)
  double sleepAngularVel = 0.08;     ///< rad/s
  double sleepTimeRequired = 0.45;   ///< seconds below threshold before island sleeps

  bool enableCcd = true;             ///< conservative-advancement anti-tunneling guard for fast bodies
  double impactEventThreshold = 0.002;  ///< minimum normal impulse (N·s) to emit an ImpactEvent
};

/// Physical impact event emitted during simulation (directly consumable by `bm::sound`!).
struct ImpactEvent {
  double time = 0.0;          ///< simulation timestamp (s)
  uint32_t bodyA = 0;
  uint32_t bodyB = ContactManifold::kFloorBody;
  Vec3 worldPointMeters{};    ///< impact location (SI m)
  Vec3 normal{};              ///< contact normal (A -> B)
  double normalImpulse = 0.0; ///< N·s
  double approachSpeed = 0.0; ///< m/s normal relative closing speed before impact
};

/// Event emitted when a breakable LEGO clutch joint exceeds its structural capacity.
struct JointBreakEvent {
  double time = 0.0;
  uint32_t jointId = 0;
  uint32_t connectionIndex = UINT32_MAX;
  uint32_t bodyA = 0;
  uint32_t bodyB = 0;
  Vec3 worldPointMeters{};
  double stressRatio = 0.0;
  double pullForce = 0.0;
  double shearForce = 0.0;
  double bendTorque = 0.0;
};

/// Per-step diagnostics & energy accounting.
struct StepStats {
  double simTime = 0.0;
  double wallMs = 0.0;
  uint32_t totalBodies = 0;
  uint32_t awakeBodies = 0;
  uint32_t sleepingBodies = 0;
  uint32_t activeIslands = 0;
  uint32_t contactManifolds = 0;
  uint32_t contactPoints = 0;
  uint32_t activeJoints = 0;
  uint32_t brokenJointsThisStep = 0;
  double kineticEnergy = 0.0;
  double potentialEnergy = 0.0;
  double maxPenetration = 0.0;
};

struct RaycastHit {
  uint32_t bodyId = 0;
  uint32_t subShapeIndex = 0;
  uint32_t pieceIndex = UINT32_MAX;
  double distance = 0.0;  ///< SI metres along ray
  Vec3 point{};           ///< SI metres
  Vec3 normal{};          ///< outward unit normal
};

/// Full deterministic state snapshot for timeline scrubbing, undo, and replay.
struct Snapshot {
  double simTime = 0.0;
  struct BodyState {
    Pose pose;
    Vec3 vel, omega;
    bool sleeping = false;
    double sleepTimer = 0.0;
  };
  struct JointState {
    bool active = true;
    bool broken = false;
    double currentAngle = 0.0;
    double currentOffset = 0.0;
    double phaseIntegral = 0.0;
    Vec3 linearImpulse{};
    Vec3 angularImpulse{};
    double limitImpulse = 0.0;
    double linearLimitImpulse = 0.0;
    double motorImpulse = 0.0;
    double linearMotorImpulse = 0.0;
    double frictionImpulse = 0.0;
    double linearFrictionImpulse = 0.0;
    double gearImpulse = 0.0;
    double distanceImpulse = 0.0;
    double coneImpulse = 0.0;
  };
  std::vector<BodyState> bodies;
  std::vector<JointState> joints;
  std::vector<ContactCache::SerializedEntry> contacts;
};

/// The BrickMotion Studio rigid-body & multibody physics engine.
class World {
 public:
  explicit World(WorldConfig config = {});

  const WorldConfig& config() const { return config_; }
  WorldConfig& config() { return config_; }
  double time() const { return time_; }

  // ---- Bodies ----
  uint32_t addBody(const BodyDesc& desc);
  Body& body(uint32_t id) { return bodies_[id]; }
  const Body& body(uint32_t id) const { return bodies_[id]; }
  size_t bodyCount() const { return bodies_.size(); }
  const std::vector<Body>& bodies() const { return bodies_; }

  void setBodyPose(uint32_t id, const Pose& pose);
  void setBodyVelocity(uint32_t id, Vec3 vel, Vec3 omega);
  void setBodyMotion(uint32_t id, BodyMotion motion);
  void wakeBody(uint32_t id);
  void wakeAll();

  // ---- Forces & Impulses (SI: N, N·m, N·s) ----
  void applyForce(uint32_t id, Vec3 force);
  void applyForceAtPoint(uint32_t id, Vec3 force, Vec3 worldPoint);
  void applyTorque(uint32_t id, Vec3 torque);
  void applyImpulse(uint32_t id, Vec3 impulse);
  void applyImpulseAtPoint(uint32_t id, Vec3 impulse, Vec3 worldPoint);
  void applyAngularImpulse(uint32_t id, Vec3 angularImpulse);
  /// Radial blast / shockwave impulse (falloff ~ 1 / (1 + (d/radius)^2)) affecting dynamic bodies within `radius`.
  void applyRadialImpulse(Vec3 centerMeters, double radiusMeters, double peakImpulseNs);

  // ---- Joints & Couplings ----
  uint32_t addJoint(const JointDesc& desc);
  Joint& joint(uint32_t id) { return joints_[id]; }
  const Joint& joint(uint32_t id) const { return joints_[id]; }
  size_t jointCount() const { return joints_.size(); }
  const std::vector<Joint>& joints() const { return joints_; }
  void setJointActive(uint32_t jointId, bool active);
  void setJointMotor(uint32_t jointId, const JointMotor& motor, bool linear = false);
  void setGrabTarget(uint32_t jointId, Vec3 worldTargetMeters);

  // ---- Collision Filtering ----
  void ignoreCollisionPair(uint32_t bodyA, uint32_t bodyB);
  void allowCollisionPair(uint32_t bodyA, uint32_t bodyB);
  bool isCollisionIgnored(uint32_t bodyA, uint32_t bodyB) const;

  // ---- Stepping ----
  /// Advance the simulation by `dt` seconds (internally divided into `config.substeps` substeps).
  StepStats step(double dt);

  // ---- Queries & Diagnostics ----
  std::optional<RaycastHit> raycast(Vec3 originMeters, Vec3 dir, double maxDistanceMeters) const;
  std::vector<uint32_t> queryBox(const Box& worldBoxMeters) const;
  std::vector<uint32_t> querySphere(Vec3 centerMeters, double radiusMeters) const;

  const std::vector<ContactManifold>& contacts() const { return manifolds_; }
  const std::vector<ImpactEvent>& impactEvents() const { return impacts_; }
  const std::vector<JointBreakEvent>& breakEvents() const { return breaks_; }
  void clearEvents() {
    impacts_.clear();
    breaks_.clear();
  }

  /// Conservation & energy telemetry (SI: Joules, kg·m/s, kg·m^2/s).
  double kineticEnergy() const;
  double potentialEnergy() const;
  double totalEnergy() const { return kineticEnergy() + potentialEnergy(); }
  Vec3 linearMomentum() const;
  Vec3 angularMomentum(Vec3 originMeters = {}) const;

  /// Deterministic snapshot & restore.
  Snapshot snapshot() const;
  void restore(const Snapshot& snap);

  /// Compute the current world-space LDraw Xform (in LDU) of a specific model piece attached to `bodyId`.
  Xform pieceXformLdu(uint32_t bodyId, size_t localPieceSlot) const;

 private:
  static uint64_t pairKey(uint32_t a, uint32_t b) {
    if (a > b) std::swap(a, b);
    return (uint64_t(a) << 32) | uint64_t(b);
  }

  void syncBvhProxy(uint32_t bodyId, Vec3 displacement = {});
  void detectContacts();
  void buildIslandsAndSleep(double dt);
  void substep(double h, StepStats& stats);
  void integrateVelocities(double h);
  void applyGyroscopicStep(Body& b, double h);
  void solveVelocityConstraints(double h);
  void integratePositions(double h);
  void applyCcdGuard(double h);
  void solvePositionConstraints(double h);
  void evaluateJointBreakage(double h, StepStats& stats);

  WorldConfig config_;
  double time_ = 0.0;
  std::vector<Body> bodies_;
  std::vector<Joint> joints_;
  DynamicBvh bvh_;
  ContactCache contactCache_;
  std::vector<ContactManifold> manifolds_;
  std::unordered_set<uint64_t> ignoredPairs_;
  std::vector<ImpactEvent> impacts_;
  std::vector<JointBreakEvent> breaks_;
  std::vector<Pose> prevPoses_;  ///< scratch poses at start of substep for CCD
};

}  // namespace bm::physics
