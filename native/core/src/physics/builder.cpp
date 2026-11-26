#include "bm/physics/builder.h"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <limits>
#include <nlohmann/json.hpp>
#include "bm/kin/constraints.h"
#include "bm/physics/constants.h"
#include "bm/physics/inertia.h"

namespace bm::physics {
namespace {

bool isShockPartName(std::string_view part) {
  return part.find("731") != std::string_view::npos || part.find("76537") != std::string_view::npos ||
         part.find("2909") != std::string_view::npos || part.find("95292") != std::string_view::npos ||
         part.find("shock") != std::string_view::npos || part.find("spring") != std::string_view::npos;
}

/// Derive calibrated LEGO clutch breakability from a `connect::Connection`.
JointStrength calibrateConnectionStrength(const connect::Connection& c, double scale) {
  JointStrength s;
  s.breakable = true;
  const double mates = std::max(1.0, static_cast<double>(c.mates));
  const double gripStuds = std::max(0.25, c.grip / 20.0);  // 20 LDU = 1 stud length
  const double fScale = std::max(0.05, scale);

  switch (c.joint.kind) {
    case connect::JointKind::Fixed:
      s.maxPullForce = fScale * (mates * clutch::kStudPullForce + gripStuds * 0.6);
      s.maxShearForce = fScale * (mates * clutch::kStudShearForce + gripStuds * 1.0);
      s.maxBendTorque = fScale * (mates * clutch::kStudBendTorque * (1.0 + 0.5 * std::sqrt(mates)));
      s.maxTwistTorque = fScale * (mates * clutch::kStudTwistTorque * (1.0 + 0.4 * mates));
      break;
    case connect::JointKind::Revolute:
      s.maxPullForce = fScale * (c.friction ? clutch::kFrictionPinPull : clutch::kFreePinPull) * std::sqrt(mates);
      s.maxShearForce = fScale * 10.0 * std::sqrt(mates);
      s.maxBendTorque = fScale * 0.045 * std::sqrt(mates);
      s.maxTwistTorque = std::numeric_limits<double>::infinity();
      break;
    case connect::JointKind::Prismatic:
    case connect::JointKind::Cylindrical:
      s.maxPullForce = fScale * std::max(3.5, gripStuds * clutch::kAxleSlideForce * 3.0);
      s.maxShearForce = fScale * 10.0 * std::sqrt(mates);
      s.maxBendTorque = fScale * 0.045 * std::sqrt(mates);
      s.maxTwistTorque = c.joint.kind == connect::JointKind::Prismatic
                             ? fScale * 0.05 * gripStuds
                             : std::numeric_limits<double>::infinity();
      break;
    case connect::JointKind::Spherical:
      s.maxPullForce = fScale * clutch::kBallSocketPull;
      s.maxShearForce = fScale * clutch::kBallSocketPull * 1.3;
      s.maxBendTorque = std::numeric_limits<double>::infinity();
      s.maxTwistTorque = std::numeric_limits<double>::infinity();
      break;
    case connect::JointKind::Flexible:
      s.maxPullForce = fScale * 3.0;
      s.maxShearForce = fScale * 3.0;
      s.maxBendTorque = std::numeric_limits<double>::infinity();
      s.maxTwistTorque = std::numeric_limits<double>::infinity();
      break;
  }
  return s;
}

/// Convert a `connect::JointKind` into a physics `JointDesc` between two world bodies.
JointDesc makeJointDescFromConnection(const connect::Connection& c, const Body& bA, const Body& bB,
                                      uint32_t connIndex, bool breakable, double clutchScale) {
  JointDesc jd;
  jd.bodyA = bA.id;
  jd.bodyB = bB.id;
  jd.connectionIndex = connIndex;
  jd.disableCollision = true;

  const Vec3 worldAnchor = lduToMeters(c.joint.point);
  const Vec3 worldAxis = length(c.joint.axis) > 1e-6 ? normalized(c.joint.axis) : Vec3{0.0, 1.0, 0.0};
  jd.localAnchorA = bA.pose.toLocal(worldAnchor);
  jd.localAnchorB = bB.pose.toLocal(worldAnchor);
  jd.localAxisA = bA.pose.dirToLocal(worldAxis);
  jd.localAxisB = bB.pose.dirToLocal(worldAxis);
  jd.localRefRot = (bA.pose.rot.conjugate() * bB.pose.rot).normalized();

  switch (c.joint.kind) {
    case connect::JointKind::Fixed:
      jd.kind = JointKind::Fixed;
      break;
    case connect::JointKind::Revolute:
      jd.kind = JointKind::Revolute;
      jd.angularFriction = c.friction ? clutch::kFrictionPinTorque : clutch::kFreePinTorque;
      break;
    case connect::JointKind::Prismatic:
      jd.kind = JointKind::Prismatic;
      jd.linearFriction = c.friction ? clutch::kAxleSlideForce * std::max(0.5, c.grip / 20.0) : 0.05;
      break;
    case connect::JointKind::Cylindrical:
      jd.kind = JointKind::Cylindrical;
      jd.angularFriction = c.friction ? clutch::kFrictionPinTorque : clutch::kFreePinTorque;
      jd.linearFriction = c.friction ? clutch::kAxleSlideForce * std::max(0.5, c.grip / 20.0) : 0.05;
      break;
    case connect::JointKind::Spherical:
      jd.kind = JointKind::Spherical;
      jd.angularFriction = clutch::kBallSocketTorque;
      break;
    case connect::JointKind::Flexible:
      jd.kind = JointKind::Distance;
      jd.minDistance = 0.0;
      jd.maxDistance = std::max(0.004, length(bB.pose.pos - bA.pose.pos));
      jd.ropeOnly = true;
      jd.linearCompliance = 1e-4;
      break;
  }

  if (breakable) {
    jd.strength = calibrateConnectionStrength(c, clutchScale);
  }
  return jd;
}

/// Convert a `kin::Gearing` into an exact physics `JointKind::Gear` constraint.
JointDesc makeGearDesc(const kin::Gearing& g, uint32_t carrierBody, const std::vector<Body>& bodies) {
  JointDesc jd;
  jd.kind = JointKind::Gear;
  jd.bodyA = g.a;
  jd.bodyB = g.b;
  jd.disableCollision = true;

  const Body& bA = bodies[g.a];
  const Body& bB = bodies[g.b];
  const kin::GearMesh& m = g.mesh;

  const Vec3 worldPt = lduToMeters(m.point);
  const Vec3 axisA = length(m.axisA) > 1e-6 ? normalized(m.axisA) : Vec3{0.0, 1.0, 0.0};
  const Vec3 axisB = length(m.axisB) > 1e-6 ? normalized(m.axisB) : Vec3{0.0, 1.0, 0.0};

  jd.localAnchorA = bA.pose.toLocal(worldPt);
  jd.localAnchorB = bB.pose.toLocal(worldPt);
  jd.localAxisA = bA.pose.dirToLocal(axisA);
  jd.localAxisB = bB.pose.dirToLocal(axisB);

  jd.gear.meshKind = m.kind;
  jd.gear.carrierBody = carrierBody;

  if (m.kind == kin::MeshKind::Screw) {
    // Piston moves by `m.travel` LDU per full turn of input.
    const double advanceMetersPerRad = lduToMeters(m.travel) / kTwoPi;
    jd.gear.ratioA = -advanceMetersPerRad;
    jd.gear.ratioB = 1.0;
    jd.gear.carrierBody = g.housing;
    jd.gear.wormSelfLocking = true;
  } else if (m.kind == kin::MeshKind::Cv || m.kind == kin::MeshKind::Clutch) {
    const double sgn = dot(axisA, axisB) < 0.0 ? -1.0 : 1.0;
    jd.gear.ratioA = 1.0;
    jd.gear.ratioB = -sgn;
  } else if (m.kind == kin::MeshKind::Rack) {
    const double leverA = dot(cross(axisA, m.point - m.pointA), m.tangent);
    const double signA = leverA < 0.0 ? -1.0 : 1.0;
    const double radiusMeters = lduToMeters(m.travel) / kTwoPi;
    jd.gear.ratioA = -signA * radiusMeters;
    jd.gear.ratioB = 1.0;
  } else if (m.kind == kin::MeshKind::Worm) {
    const double countA = std::max(1, m.teethA);
    const double countB = std::max(1, m.teethB);
    const double wayB = dot(cross(axisB, m.point - m.pointB), axisA) < 0.0 ? -1.0 : 1.0;
    const double scale = 1.0 / std::max(countA, countB);
    jd.gear.ratioA = countA * scale;
    jd.gear.ratioB = -wayB * countB * scale;
    jd.gear.wormSelfLocking = true;
  } else {
    // Parallel (spur) or Crossed (bevel) gear mesh.
    const double leverA = dot(cross(axisA, m.point - m.pointA), m.tangent);
    const double leverB = dot(cross(axisB, m.point - m.pointB), m.tangent);
    const double signA = leverA < 0.0 ? -1.0 : 1.0;
    const double signB = leverB < 0.0 ? -1.0 : 1.0;
    const double countA = std::max(1, m.teethA);
    const double countB = std::max(1, m.teethB);
    const double scale = 1.0 / std::max(countA, countB);
    jd.gear.ratioA = signA * countA * scale;
    jd.gear.ratioB = -signB * countB * scale;
  }
  return jd;
}

}  // namespace

std::vector<Xform> BuiltWorld::currentPieceXforms() const {
  std::vector<Xform> out(bodyOfPiece.size(), Xform::identity());
  for (size_t pi = 0; pi < bodyOfPiece.size(); pi++) {
    const uint32_t bid = bodyOfPiece[pi];
    if (bid < world.bodyCount()) {
      out[pi] = world.pieceXformLdu(bid, localSlotOfPiece[pi]);
    }
  }
  return out;
}

BuiltWorld buildWorld(const Model& model, const connect::Graph& graph,
                      const kin::System* systemPtr, ldraw::PartCache& parts,
                      collide::ShapeCache* shapes, const BuildOptions& options) {
  const auto& pieces = model.pieces();
  const uint32_t nPieces = static_cast<uint32_t>(pieces.size());

  // 1. Compute per-piece meshes, hulls, materials, mass properties, and floor Y (maximum Y in LDraw).
  HullCache hullCache;
  std::vector<std::shared_ptr<const ConvexHull>> pieceHulls(nPieces);
  std::vector<MassProperties> pieceMass(nPieces);
  std::vector<Material> pieceMat(nPieces, materials::kAbs);
  std::vector<Pose> pieceWorldPose(nPieces);

  double lowestLduY = -std::numeric_limits<double>::infinity();
  for (uint32_t i = 0; i < nPieces; i++) {
    pieceWorldPose[i] = Pose::fromLduXform(pieces[i].world);
    const auto mesh = model.mesh(pieces[i].part, parts);
    const Material mat = options.autoMaterials ? inferPartMaterial(pieces[i].part, pieces[i].color) : materials::kAbs;
    pieceMat[i] = mat;
    if (mesh && !mesh->bounds.empty()) {
      pieceHulls[i] = hullCache.get(mesh);
      pieceMass[i] = computeMeshMass(*mesh, mat.density);
      const Box wb = mesh->bounds.transformed(pieces[i].world);
      lowestLduY = std::max(lowestLduY, wb.max.y);
    } else {
      const Vec3 halfM = lduToMeters((kPlaceholderBox.max - kPlaceholderBox.min) * 0.5);
      pieceHulls[i] = std::make_shared<ConvexHull>(ConvexHull::fromBox(halfM));
      pieceMass[i] = computeBoxMass(halfM, mat.density * kHollowBoxFill);
      const Box wb = kPlaceholderBox.transformed(pieces[i].world);
      lowestLduY = std::max(lowestLduY, wb.max.y);
    }
  }
  if (!std::isfinite(lowestLduY)) lowestLduY = 0.0;

  // Floor sits at `lowestLduY + dropHeightLdu` (in LDraw +Y is down, so moving floor down by dropHeightLdu
  // gives every piece `dropHeightLdu` of fall distance!).
  WorldConfig wcfg = options.worldConfig;
  const double floorYLdu = lowestLduY + std::max(0.0, options.dropHeightLdu);
  wcfg.floorY = lduToMeters(floorYLdu);

  BuiltWorld built{World(wcfg),
                   std::vector<uint32_t>(nPieces, UINT32_MAX),
                   std::vector<size_t>(nPieces, 0),
                   std::vector<uint32_t>(graph.connections.size(), UINT32_MAX),
                   floorYLdu,
                   0.0};

  // 2. Partition pieces into rigid bodies according to simulation mode.
  kin::System localSystem;
  const kin::System* sys = systemPtr;
  if (options.mode == SimMode::Mechanism && !sys) {
    kin::SystemOptions sopt;
    sopt.testTravel = (shapes != nullptr);
    localSystem = kin::buildSystem(model, graph, &parts, shapes, sopt);
    sys = &localSystem;
  }

  std::vector<std::vector<uint32_t>> groups;
  if (options.mode == SimMode::Mechanism && sys) {
    groups = sys->pieces;
  } else {
    // Destructible or FreePieces: one rigid body per non-segment piece.
    groups.reserve(nPieces);
    for (uint32_t i = 0; i < nPieces; i++) {
      if (i < graph.isSegment.size() && graph.isSegment[i]) continue;
      groups.push_back({i});
    }
  }

  // 3. Create compound rigid bodies with exact parallel-axis inertia & convex sub-shapes.
  std::vector<uint32_t> sysBodyToWorldBody(groups.size(), UINT32_MAX);
  for (size_t gi = 0; gi < groups.size(); gi++) {
    const auto& members = groups[gi];
    if (members.empty()) continue;

    std::vector<PartMassEntry> massEntries;
    massEntries.reserve(members.size());
    for (uint32_t pi : members) {
      massEntries.push_back({pieceMass[pi], pieceWorldPose[pi]});
    }
    const MassProperties bodyMass = combineMassProperties(massEntries);

    // Body world frame sits at combined CoM with identity orientation (local sub-shapes carry each piece's pose).
    const Pose bodyPose{bodyMass.com, Quat::identity()};
    const Pose bodyInv = bodyPose.inverse();

    BodyDesc desc;
    desc.pose = bodyPose;
    desc.massProps = bodyMass;
    desc.massProps.com = {};  // CoM is now at the origin of the body frame!
    desc.motion = (options.mode == SimMode::Mechanism && options.lockGroundBody && sys && gi == sys->ground)
                      ? BodyMotion::Static
                      : BodyMotion::Dynamic;

    // Choose representative body material (prefer RubberTyre if any piece is a tyre for wheel grip!).
    Material bodyMat = pieceMat[members.front()];
    for (uint32_t pi : members) {
      if (pieceMat[pi].staticFriction > bodyMat.staticFriction) bodyMat = pieceMat[pi];
    }
    desc.material = bodyMat;
    desc.label = pieces[members.front()].part;

    for (uint32_t pi : members) {
      const Pose localP = bodyInv * pieceWorldPose[pi];
      desc.shape.parts.push_back({ConvexShape::makeHull(pieceHulls[pi]), localP, pi});
    }

    const uint32_t bid = built.world.addBody(desc);
    sysBodyToWorldBody[gi] = bid;
    Body& body = built.world.body(bid);
    for (uint32_t pi : members) {
      const size_t slot = body.pieceIndices.size();
      body.pieceIndices.push_back(pi);
      body.pieceLocalPoses.push_back(bodyInv * pieceWorldPose[pi]);
      built.bodyOfPiece[pi] = bid;
      built.localSlotOfPiece[pi] = slot;
    }
    built.totalMassGrams += bodyMass.mass * kGramsPerKg;
  }

  // 4. Add joints & mechanical couplings.
  if (options.mode == SimMode::Mechanism && sys) {
    // 4a. Links from kin::System (Revolute, Prismatic, Cylindrical, Spherical).
    for (const kin::Link& l : sys->links) {
      if (l.a >= sysBodyToWorldBody.size() || l.b >= sysBodyToWorldBody.size()) continue;
      const uint32_t bA = sysBodyToWorldBody[l.a];
      const uint32_t bB = sysBodyToWorldBody[l.b];
      if (bA == UINT32_MAX || bB == UINT32_MAX || bA == bB) continue;

      // Find matching graph connection to inherit friction / grip / shock properties.
      bool hasFriction = false;
      double grip = 20.0;
      uint32_t connIdx = UINT32_MAX;
      for (uint32_t ci = 0; ci < graph.connections.size(); ci++) {
        const auto& c = graph.connections[ci];
        if ((c.a == l.pieceA && c.b == l.pieceB) || (c.a == l.pieceB && c.b == l.pieceA)) {
          hasFriction = c.friction;
          grip = c.grip;
          connIdx = ci;
          break;
        }
      }

      JointDesc jd;
      jd.bodyA = bA;
      jd.bodyB = bB;
      jd.connectionIndex = connIdx;
      jd.disableCollision = true;
      const Vec3 anchorW = lduToMeters(l.point);
      const Vec3 axisW = length(l.axis) > 1e-6 ? normalized(l.axis) : Vec3{0.0, 1.0, 0.0};
      jd.localAnchorA = built.world.body(bA).pose.toLocal(anchorW);
      jd.localAnchorB = built.world.body(bB).pose.toLocal(anchorW);
      jd.localAxisA = built.world.body(bA).pose.dirToLocal(axisW);
      jd.localAxisB = built.world.body(bB).pose.dirToLocal(axisW);
      jd.localRefRot = (built.world.body(bA).pose.rot.conjugate() * built.world.body(bB).pose.rot).normalized();

      switch (l.kind) {
        case connect::JointKind::Revolute:
          jd.kind = JointKind::Revolute;
          jd.angularFriction = hasFriction ? clutch::kFrictionPinTorque : clutch::kFreePinTorque;
          break;
        case connect::JointKind::Prismatic:
          jd.kind = JointKind::Prismatic;
          jd.linearFriction = hasFriction ? clutch::kAxleSlideForce * std::max(0.5, grip / 20.0) : 0.05;
          if (options.autoShockSprings &&
              (isShockPartName(pieces[l.pieceA].part) || isShockPartName(pieces[l.pieceB].part))) {
            jd.linearSpring.enabled = true;
            jd.linearSpring.stiffness = options.defaultShockStiffness;
            jd.linearSpring.damping = options.defaultShockDamping;
            jd.linearSpring.restTarget = 0.0;
          }
          break;
        case connect::JointKind::Cylindrical:
          jd.kind = JointKind::Cylindrical;
          jd.angularFriction = hasFriction ? clutch::kFrictionPinTorque : clutch::kFreePinTorque;
          jd.linearFriction = hasFriction ? clutch::kAxleSlideForce * std::max(0.5, grip / 20.0) : 0.05;
          if (options.autoShockSprings &&
              (isShockPartName(pieces[l.pieceA].part) || isShockPartName(pieces[l.pieceB].part))) {
            jd.linearSpring.enabled = true;
            jd.linearSpring.stiffness = options.defaultShockStiffness;
            jd.linearSpring.damping = options.defaultShockDamping;
            jd.linearSpring.restTarget = 0.0;
          }
          break;
        case connect::JointKind::Spherical:
          jd.kind = JointKind::Spherical;
          jd.angularFriction = clutch::kBallSocketTorque;
          break;
        default:
          jd.kind = JointKind::Fixed;
          break;
      }
      const uint32_t jid = built.world.addJoint(jd);
      if (connIdx < built.jointOfConnection.size()) built.jointOfConnection[connIdx] = jid;
    }

    // 4b. Exact Gear, Bevel, Worm, Rack, Screw, and CV couplings from kin::System::gearings!
    const std::vector<uint32_t> sysCarriers = kin::carriers(*sys);
    for (size_t gi = 0; gi < sys->gearings.size(); gi++) {
      kin::Gearing g = sys->gearings[gi];
      if (g.a >= sysBodyToWorldBody.size() || g.b >= sysBodyToWorldBody.size()) continue;
      g.a = sysBodyToWorldBody[g.a];
      g.b = sysBodyToWorldBody[g.b];
      if (g.a == UINT32_MAX || g.b == UINT32_MAX || g.a == g.b) continue;
      uint32_t carrierW = UINT32_MAX;
      if (sysCarriers[gi] < sysBodyToWorldBody.size()) carrierW = sysBodyToWorldBody[sysCarriers[gi]];
      if (g.housing < sysBodyToWorldBody.size()) g.housing = sysBodyToWorldBody[g.housing];
      built.world.addJoint(makeGearDesc(g, carrierW, built.world.bodies()));
    }
  } else if (options.mode == SimMode::Destructible) {
    // Every connection in `graph` becomes a calibrated breakable LEGO clutch joint!
    for (uint32_t ci = 0; ci < graph.connections.size(); ci++) {
      const connect::Connection& c = graph.connections[ci];
      if (c.a >= nPieces || c.b >= nPieces) continue;
      const uint32_t bA = built.bodyOfPiece[c.a];
      const uint32_t bB = built.bodyOfPiece[c.b];
      if (bA == UINT32_MAX || bB == UINT32_MAX || bA == bB) continue;

      const JointDesc jd = makeJointDescFromConnection(
          c, built.world.body(bA), built.world.body(bB), ci, options.breakableJoints, options.clutchStrengthScale);
      built.jointOfConnection[ci] = built.world.addJoint(jd);
    }
    // Suppress initial false-positive collisions between meshed gears even in destructible mode.
    for (const auto& m : graph.meshes) {
      if (m.a < nPieces && m.b < nPieces && built.bodyOfPiece[m.a] != UINT32_MAX && built.bodyOfPiece[m.b] != UINT32_MAX) {
        built.world.ignoreCollisionPair(built.bodyOfPiece[m.a], built.bodyOfPiece[m.b]);
      }
    }
  }

  // 5. Attach requested motors.
  for (const auto& ms : options.motors) {
    const double radPerSec = ms.rpm * kTwoPi / 60.0;
    JointMotor jm;
    jm.enabled = true;
    jm.targetVelocity = radPerSec;
    jm.maxEffort = ms.maxTorque;
    jm.useDcMotorCurve = true;
    jm.noLoadSpeed = std::max(std::abs(radPerSec) * 1.35, clutch::kMotorMMaxOmega);

    if (ms.jointId < built.world.jointCount()) {
      built.world.setJointMotor(ms.jointId, jm, false);
    } else if (ms.bodyIndex < sysBodyToWorldBody.size()) {
      const uint32_t targetBody = sysBodyToWorldBody[ms.bodyIndex];
      for (uint32_t jid = 0; jid < built.world.jointCount(); jid++) {
        const Joint& j = built.world.joint(jid);
        if ((j.desc.kind == JointKind::Revolute || j.desc.kind == JointKind::Cylindrical) &&
            (j.desc.bodyA == targetBody || j.desc.bodyB == targetBody)) {
          built.world.setJointMotor(jid, jm, false);
          break;
        }
      }
    }
  }

  return built;
}

Trajectory bakeTrajectory(BuiltWorld& built, double durationSeconds, double fps) {
  const auto t0 = std::chrono::steady_clock::now();
  Trajectory traj;
  traj.fps = std::max(1.0, fps);
  traj.duration = std::max(0.0, durationSeconds);
  traj.floorYLdu = built.floorYLdu;
  traj.totalMassGrams = built.totalMassGrams;

  const double dt = 1.0 / traj.fps;
  const int numFrames = std::max(1, static_cast<int>(std::round(traj.duration * traj.fps)));
  traj.frames.reserve(static_cast<size_t>(numFrames) + 1);

  built.world.clearEvents();
  // Frame 0: initial rest pose.
  traj.frames.push_back({0.0, built.currentPieceXforms(), built.world.kineticEnergy(),
                         built.world.potentialEnergy(), static_cast<uint32_t>(built.world.bodyCount()), 0});

  for (int f = 1; f <= numFrames; f++) {
    const StepStats stats = built.world.step(dt);
    traj.frames.push_back({stats.simTime, built.currentPieceXforms(), stats.kineticEnergy,
                           stats.potentialEnergy, stats.awakeBodies, stats.contactPoints});
  }

  traj.impacts = built.world.impactEvents();
  traj.breaks = built.world.breakEvents();
  const auto t1 = std::chrono::steady_clock::now();
  traj.wallMs = std::chrono::duration<double, std::milli>(t1 - t0).count();
  return traj;
}

std::string Trajectory::toJson(bool includeFrames) const {
  nlohmann::json j;
  j["fps"] = fps;
  j["duration"] = duration;
  j["floorYLdu"] = floorYLdu;
  j["totalMassGrams"] = totalMassGrams;
  j["wallMs"] = wallMs;
  j["frameCount"] = frames.size();
  j["impactCount"] = impacts.size();
  j["breakCount"] = breaks.size();

  nlohmann::json impArr = nlohmann::json::array();
  for (const auto& e : impacts) {
    impArr.push_back({{"time", e.time}, {"bodyA", e.bodyA}, {"bodyB", e.bodyB},
                      {"pointLdu", {metersToLdu(e.worldPointMeters.x), metersToLdu(e.worldPointMeters.y), metersToLdu(e.worldPointMeters.z)}},
                      {"normalImpulse", e.normalImpulse}, {"approachSpeed", e.approachSpeed}});
  }
  j["impacts"] = std::move(impArr);

  nlohmann::json brkArr = nlohmann::json::array();
  for (const auto& b : breaks) {
    brkArr.push_back({{"time", b.time}, {"jointId", b.jointId}, {"connectionIndex", b.connectionIndex},
                      {"bodyA", b.bodyA}, {"bodyB", b.bodyB}, {"stressRatio", b.stressRatio},
                      {"pullForce", b.pullForce}, {"shearForce", b.shearForce}, {"bendTorque", b.bendTorque}});
  }
  j["breaks"] = std::move(brkArr);

  if (includeFrames) {
    nlohmann::json fArr = nlohmann::json::array();
    for (const auto& f : frames) {
      nlohmann::json poses = nlohmann::json::array();
      for (const auto& xf : f.pieceXforms) {
        poses.push_back({xf.t.x, xf.t.y, xf.t.z,
                         xf.r.m[0], xf.r.m[1], xf.r.m[2],
                         xf.r.m[3], xf.r.m[4], xf.r.m[5],
                         xf.r.m[6], xf.r.m[7], xf.r.m[8]});
      }
      fArr.push_back({{"time", f.time}, {"kineticEnergy", f.kineticEnergy},
                      {"potentialEnergy", f.potentialEnergy}, {"awakeBodies", f.awakeBodies},
                      {"activeContacts", f.activeContacts}, {"poses", std::move(poses)}});
    }
    j["frames"] = std::move(fArr);
  }
  return j.dump(2);
}

StructuralReport analyzeStructure(const Model& model, const connect::Graph& graph,
                                  ldraw::PartCache& parts, const StructuralOptions& options) {
  const auto t0 = std::chrono::steady_clock::now();
  BuildOptions bopt;
  bopt.mode = SimMode::Destructible;
  bopt.dropHeightLdu = 0.0;
  bopt.breakableJoints = true;
  bopt.clutchStrengthScale = options.clutchStrengthScale;
  bopt.worldConfig.gravity = options.gravity;
  bopt.worldConfig.substeps = std::max(4, options.substeps);
  bopt.worldConfig.velocityIterations = 16;
  bopt.worldConfig.positionIterations = 6;
  bopt.worldConfig.enableSleeping = false;  // Keep every body active while solving equilibrium forces.

  BuiltWorld built = buildWorld(model, graph, nullptr, parts, nullptr, bopt);
  // Add strong quasi-static damping so we measure static equilibrium loads rather than impact spikes.
  for (uint32_t i = 0; i < built.world.bodyCount(); i++) {
    built.world.body(i).linearDamping = 4.0;
    built.world.body(i).angularDamping = 4.0;
  }

  const std::vector<Xform> initial = built.currentPieceXforms();
  const int steps = std::max(4, static_cast<int>(std::round(options.settleDuration * 60.0)));
  const double dt = options.settleDuration / static_cast<double>(steps);

  // Track peak stress ratio per connection across the settling window.
  std::vector<JointStress> stressList;
  stressList.reserve(graph.connections.size());
  for (uint32_t ci = 0; ci < graph.connections.size(); ci++) {
    stressList.push_back({ci, graph.connections[ci].a, graph.connections[ci].b, 0, 0, 0, 0, 0, false});
  }

  for (int s = 0; s < steps; s++) {
    built.world.step(dt);
    for (uint32_t ci = 0; ci < graph.connections.size(); ci++) {
      const uint32_t jid = built.jointOfConnection[ci];
      if (jid >= built.world.jointCount()) continue;
      const Joint& j = built.world.joint(jid);
      JointStress& js = stressList[ci];
      if (j.stressRatio >= js.stressRatio) {
        js.pullForce = j.pullForce;
        js.shearForce = j.shearForce;
        js.bendTorque = j.bendTorque;
        js.twistTorque = j.twistTorque;
        js.stressRatio = j.stressRatio;
      }
      if (j.broken) js.failed = true;
    }
  }

  const std::vector<Xform> settled = built.currentPieceXforms();
  StructuralReport report;
  report.totalMassGrams = built.totalMassGrams;
  for (size_t i = 0; i < initial.size(); i++) {
    const double disp = length(settled[i].t - initial[i].t);
    report.maxDisplacementLdu = std::max(report.maxDisplacementLdu, disp);
    if (disp > 4.0) report.unsupportedPieces++;
  }
  for (const auto& js : stressList) {
    report.maxStressRatio = std::max(report.maxStressRatio, js.stressRatio);
    if (js.failed) report.failedJoints++;
  }
  std::sort(stressList.begin(), stressList.end(), [](const JointStress& a, const JointStress& b) {
    return a.stressRatio > b.stressRatio;
  });
  report.joints = std::move(stressList);
  report.structurallySound = (report.failedJoints == 0 && report.unsupportedPieces == 0 && report.maxDisplacementLdu < 4.0);
  const auto t1 = std::chrono::steady_clock::now();
  report.settleTimeMs = std::chrono::duration<double, std::milli>(t1 - t0).count();
  return report;
}

}  // namespace bm::physics
