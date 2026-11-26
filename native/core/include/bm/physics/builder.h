#pragma once
// Seamless bridge between BrickMotion Studio's core model/graph/kinematics layers and `bm::physics`:
// - One-call `buildWorld()` in Mechanism, Destructible, or FreePieces mode
// - Trajectory baking to frame-accurate LDraw poses + sound-ready impact events + JSON export
// - Quasi-static structural stress & LEGO clutch failure analysis (upgrades static stability!)
#include <cstdint>
#include <memory>
#include <string>
#include <vector>
#include "bm/collide/shape.h"
#include "bm/connect/graph.h"
#include "bm/kin/system.h"
#include "bm/ldraw/part_cache.h"
#include "bm/model.h"
#include "bm/physics/world.h"

namespace bm::physics {

enum class SimMode : uint8_t {
  /// Uses `kin::System` rigid bodies, active links, gearings, screws, CVs, and shocks.
  /// Ideal for physically simulating motorized mechanisms, vehicles, and suspensions.
  Mechanism,
  /// Keeps every piece (or sub-cluster) as a dynamic body joined by calibrated breakable LEGO
  /// clutch joints. Ideal for drop tests, crashes, collapse analysis, and structural failure.
  Destructible,
  /// Every piece is an independent dynamic rigid body with no joints (brick piles, pouring, scatter).
  FreePieces,
};

struct MotorSpec {
  uint32_t jointId = UINT32_MAX;   ///< direct joint index, or UINT32_MAX to match by body index
  uint32_t bodyIndex = UINT32_MAX; ///< `kin::System` body index to drive
  double rpm = 60.0;               ///< target speed in revolutions per minute
  double maxTorque = clutch::kMotorMStallTorque;  ///< N·m
};

struct BuildOptions {
  SimMode mode = SimMode::Mechanism;
  WorldConfig worldConfig{};
  /// Vertical drop height above the studio floor in LDU (0 = rests directly on floor).
  double dropHeightLdu = 0.0;
  /// In Mechanism mode, lock the largest body (`system.ground`) as Static so mechanisms can run in place.
  bool lockGroundBody = false;
  /// Multiplier on calibrated LEGO clutch break strengths (1.0 = realistic ABS clutch).
  double clutchStrengthScale = 1.0;
  /// Make joints breakable in Destructible mode (always false in Mechanism mode unless enabled).
  bool breakableJoints = true;
  /// Automatically add shock-absorber spring-dampers to prismatic joints between shock parts.
  bool autoShockSprings = true;
  double defaultShockStiffness = clutch::kSoftShockStiffness;
  double defaultShockDamping = clutch::kShockDamping;
  /// Automatically classify rubber tyres and polycarbonate transparent bricks.
  bool autoMaterials = true;
  /// Optional motors to apply after building.
  std::vector<MotorSpec> motors;
};

/// A physics world constructed directly from a BrickMotion `Model`, with full bidirectional piece/joint maps.
struct BuiltWorld {
  World world;
  std::vector<uint32_t> bodyOfPiece;         ///< Model piece index -> World body id (UINT32_MAX if omitted)
  std::vector<size_t> localSlotOfPiece;      ///< Model piece index -> index inside Body::pieceIndices
  std::vector<uint32_t> jointOfConnection;   ///< Graph connection index -> World joint id (UINT32_MAX if merged/none)
  double floorYLdu = 0.0;                    ///< computed floor plane Y in LDraw LDU
  double totalMassGrams = 0.0;

  /// Current world-space LDraw Xform (LDU) for every piece in `model`.
  std::vector<Xform> currentPieceXforms() const;
};

/// Build a full `bm::physics::World` from a BrickMotion Studio model, connection graph, and optional kinematic system.
/// If `system` is null in `SimMode::Mechanism`, it is built internally with `kin::buildSystem`.
BuiltWorld buildWorld(const Model& model, const connect::Graph& graph,
                      const kin::System* system, ldraw::PartCache& parts,
                      collide::ShapeCache* shapes = nullptr,
                      const BuildOptions& options = {});

/// Baked physics animation frame (LDraw LDU placements for all model pieces).
struct TrajectoryFrame {
  double time = 0.0;
  std::vector<Xform> pieceXforms;  ///< one per Model piece (LDU)
  double kineticEnergy = 0.0;
  double potentialEnergy = 0.0;
  uint32_t awakeBodies = 0;
  uint32_t activeContacts = 0;
};

struct Trajectory {
  double fps = 60.0;
  double duration = 0.0;
  double floorYLdu = 0.0;
  double totalMassGrams = 0.0;
  double wallMs = 0.0;
  std::vector<TrajectoryFrame> frames;
  std::vector<ImpactEvent> impacts;
  std::vector<JointBreakEvent> breaks;

  /// Serialize trajectory summary, frames, impacts, and breaks to JSON.
  std::string toJson(bool includeFrames = true) const;
};

/// Step `built.world` for `durationSeconds` at `fps` and capture piece transforms + physical events.
Trajectory bakeTrajectory(BuiltWorld& built, double durationSeconds, double fps = 60.0);

/// Per-connection structural stress result from quasi-static equilibrium analysis.
struct JointStress {
  uint32_t connectionIndex = 0;
  uint32_t pieceA = 0, pieceB = 0;
  double pullForce = 0.0;     ///< N
  double shearForce = 0.0;    ///< N
  double bendTorque = 0.0;    ///< N·m
  double twistTorque = 0.0;   ///< N·m
  double stressRatio = 0.0;   ///< peak load / LEGO clutch capacity (1.0 = failure threshold)
  bool failed = false;        ///< true if clutch gave way during settling
};

/// Full dynamic & structural stability analysis of a BrickMotion model under gravity (or custom acceleration).
struct StructuralReport {
  bool structurallySound = true;  ///< no failed joints and model settled without tipping/collapsing
  double totalMassGrams = 0.0;
  double maxStressRatio = 0.0;
  double maxDisplacementLdu = 0.0;   ///< largest piece sag/shift under gravity (LDU)
  uint32_t failedJoints = 0;
  uint32_t unsupportedPieces = 0;    ///< pieces that fell > 4 LDU under gravity
  std::vector<JointStress> joints;   ///< sorted by stressRatio descending
  double settleTimeMs = 0.0;
};

struct StructuralOptions {
  Vec3 gravity = kGravityVec;        ///< m/s^2 (can also test lateral g-loads, e.g. 2g bump!)
  double settleDuration = 0.35;      ///< seconds of damped settling
  double clutchStrengthScale = 1.0;
  int substeps = 10;
};

/// Solve quasi-static equilibrium forces and LEGO clutch stress across every connection in `model`.
/// Unlike purely geometric `bm::stable::check`, this resolves:
///   - Real 3D joint loads (tension, shear, cantilever bending moment, torsion)
///   - Unjoined pieces resting physically on lower bricks via contact manifolds
///   - Dynamic tipping and structural clutch snap-off!
StructuralReport analyzeStructure(const Model& model, const connect::Graph& graph,
                                  ldraw::PartCache& parts, const StructuralOptions& options = {});

}  // namespace bm::physics
