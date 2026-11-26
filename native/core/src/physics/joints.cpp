#include "joints_internal.h"

#include <algorithm>
#include <cmath>
#include "bm/physics/constants.h"

namespace bm::physics::detail {
namespace {

constexpr double kBetaVel = 0.20;  ///< gentle Baumgarte bias for joint velocity loop closure
constexpr double kPosSlop = 1e-5;  ///< 0.01 mm positional tolerance
constexpr double kAngSlop = 1e-4;  ///< ~0.006 deg angular tolerance

/// Read body state safely (bodyIdx == UINT32_MAX represents the static world frame).
struct BodyRef {
  Body* ptr = nullptr;
  Pose pose = Pose::identity();
  Vec3 vel{};
  Vec3 omega{};
  double invMass = 0.0;
  SymMat3 invI = SymMat3::zero();

  static BodyRef get(std::vector<Body>& bodies, uint32_t idx) {
    if (idx >= bodies.size()) return {};
    Body& b = bodies[idx];
    return {&b, b.pose, b.vel, b.omega, b.isDynamic() ? b.invMass : 0.0,
            b.isDynamic() ? b.worldInvInertia : SymMat3::zero()};
  }

  void applyLinearImpulse(Vec3 impulse, Vec3 lever) {
    if (!ptr || !ptr->isDynamic()) return;
    ptr->vel = ptr->vel + impulse * invMass;
    ptr->omega = ptr->omega + invI * cross(lever, impulse);
    vel = ptr->vel;
    omega = ptr->omega;
  }

  void applyAngularImpulse(Vec3 angImpulse) {
    if (!ptr || !ptr->isDynamic()) return;
    ptr->omega = ptr->omega + invI * angImpulse;
    omega = ptr->omega;
  }

  void applyPosCorrection(Vec3 dp, Vec3 dTheta) {
    if (!ptr || !ptr->isDynamic()) return;
    ptr->pose.pos = ptr->pose.pos + dp;
    if (dot(dTheta, dTheta) > 1e-24) {
      ptr->pose.rot = (Quat::fromRotVec(dTheta) * ptr->pose.rot).normalized();
      ptr->updateWorldInertia();
    }
    pose = ptr->pose;
    invI = ptr->worldInvInertia;
  }
};

/// Build the 3x3 point-to-point effective inverse mass matrix:
///   K = (wA + wB)*E - [rA]_x I_A^-1 [rA]_x - [rB]_x I_B^-1 [rB]_x + reg * E
SymMat3 pointEffectiveInvMass(double wA, const SymMat3& invIA, Vec3 rA,
                              double wB, const SymMat3& invIB, Vec3 rB, double reg = 0.0) {
  Mat3 k = diagMat3(wA + wB + reg, wA + wB + reg, wA + wB + reg);
  if (wA > 0.0) {
    const Mat3 sA = skew(rA);
    k = k - (sA * invIA.toMat3() * sA);
  }
  if (wB > 0.0) {
    const Mat3 sB = skew(rB);
    k = k - (sB * invIB.toMat3() * sB);
  }
  return SymMat3::fromMat3Sym(k);
}

/// Scalar 1-DOF linear constraint effective inverse mass along unit direction `dir` with lever arms `rA`, `rB`.
double scalarLinearInvMass(const BodyRef& a, Vec3 rA, const BodyRef& b, Vec3 rB, Vec3 dir) {
  double k = a.invMass + b.invMass;
  if (a.invMass > 0.0) {
    const Vec3 cA = cross(rA, dir);
    k += dot(cA, a.invI * cA);
  }
  if (b.invMass > 0.0) {
    const Vec3 cB = cross(rB, dir);
    k += dot(cB, b.invI * cB);
  }
  return k;
}

/// Scalar 1-DOF angular constraint effective inverse mass along unit axis `axis`.
double scalarAngularInvMass(const BodyRef& a, const BodyRef& b, Vec3 axis) {
  return dot(axis, a.invI * axis) + dot(axis, b.invI * axis);
}

/// Compute wrapped signed angle of B relative to A about world axis `uA`, then unwrap smoothly from `prevAngle`.
double measureUnwrappedAngle(const Joint& j, const BodyRef& a, const BodyRef& b, Vec3 uA) {
  const Vec3 refA = a.pose.dirToWorld(j.localPerpA1);
  const Vec3 refB = b.pose.dirToWorld(j.localPerpB1);
  // Project refB onto plane perpendicular to uA.
  Vec3 projB = refB - uA * dot(refB, uA);
  const double len = length(projB);
  if (len < 1e-9) return j.currentAngle;
  projB = projB * (1.0 / len);
  const Vec3 refA2 = cross(uA, refA);
  const double raw = std::atan2(dot(projB, refA2), dot(projB, refA));
  // Unwrap delta into (-pi, pi] relative to j.currentAngle.
  double delta = std::fmod(raw - j.currentAngle + kPi, kTwoPi);
  if (delta < 0.0) delta += kTwoPi;
  delta -= kPi;
  return j.currentAngle + delta;
}

/// Effective DC motor torque limit accounting for linear speed-torque droop if enabled.
double effectiveMotorEffort(const JointMotor& m, double currentSpeed) {
  if (!m.useDcMotorCurve || m.noLoadSpeed <= 1e-6) return std::max(0.0, m.maxEffort);
  // Stall torque at 0 speed, falls linearly to 0 at noLoadSpeed in driving direction.
  const double sign = m.targetVelocity >= 0.0 ? 1.0 : -1.0;
  const double forwardRatio = (currentSpeed * sign) / m.noLoadSpeed;
  const double factor = std::clamp(1.0 - forwardRatio, 0.05, 1.5);
  return std::max(0.0, m.maxEffort * factor);
}

/// Solve a 1-DOF angular motor/friction/limit row about world axis `axis`.
void solveAngularDofRow(Joint& j, BodyRef& a, BodyRef& b, Vec3 axis, double h) {
  const double invM = scalarAngularInvMass(a, b, axis);
  if (invM <= 1e-18) return;
  const double effM = 1.0 / invM;
  const double relW = dot(b.omega - a.omega, axis);

  // 1. Motor drive.
  if (j.desc.angularMotor.enabled) {
    const double maxTau = effectiveMotorEffort(j.desc.angularMotor, relW);
    const double maxImp = maxTau * h;
    const double dImp = (j.desc.angularMotor.targetVelocity - relW) * effM;
    const double old = j.motorImpulse;
    j.motorImpulse = std::clamp(old + dImp, -maxImp, maxImp);
    const double apply = j.motorImpulse - old;
    a.applyAngularImpulse(-axis * apply);
    b.applyAngularImpulse(axis * apply);
  }

  // 2. Dry Coulomb joint friction (e.g. Technic friction pin vs frictionless pin).
  if (j.desc.angularFriction > 0.0) {
    const double relW2 = dot(b.omega - a.omega, axis);
    const double maxImp = j.desc.angularFriction * h;
    const double dImp = -relW2 * effM;
    const double old = j.frictionImpulse;
    j.frictionImpulse = std::clamp(old + dImp, -maxImp, maxImp);
    const double apply = j.frictionImpulse - old;
    a.applyAngularImpulse(-axis * apply);
    b.applyAngularImpulse(axis * apply);
  }

  // 3. Angular limits (unilateral inequality).
  if (j.desc.angularLimits.enabled && j.desc.angularLimits.lower <= j.desc.angularLimits.upper) {
    const double relW3 = dot(b.omega - a.omega, axis);
    if (j.currentAngle <= j.desc.angularLimits.lower) {
      const double err = j.desc.angularLimits.lower - j.currentAngle;
      const double bounce = relW3 < -0.1 ? -j.desc.angularLimits.restitution * relW3 : 0.0;
      const double bias = std::max(bounce, (kBetaVel / h) * std::max(0.0, err - kAngSlop));
      const double dImp = (bias - relW3) * effM;
      const double old = j.limitImpulse;
      j.limitImpulse = std::max(0.0, old + dImp);
      const double apply = j.limitImpulse - old;
      a.applyAngularImpulse(-axis * apply);
      b.applyAngularImpulse(axis * apply);
    } else if (j.currentAngle >= j.desc.angularLimits.upper) {
      const double err = j.currentAngle - j.desc.angularLimits.upper;
      const double bounce = relW3 > 0.1 ? -j.desc.angularLimits.restitution * relW3 : 0.0;
      const double bias = std::min(bounce, -(kBetaVel / h) * std::max(0.0, err - kAngSlop));
      const double dImp = (bias - relW3) * effM;
      const double old = j.limitImpulse;
      j.limitImpulse = std::min(0.0, old + dImp);
      const double apply = j.limitImpulse - old;
      a.applyAngularImpulse(-axis * apply);
      b.applyAngularImpulse(axis * apply);
    } else {
      j.limitImpulse = 0.0;
    }
  }
}

/// Solve a 1-DOF linear motor/friction/limit row along world axis `axis` with anchor offsets `rA`, `rB`.
void solveLinearDofRow(Joint& j, BodyRef& a, BodyRef& b, Vec3 rA, Vec3 rB, Vec3 d, Vec3 axis, double h) {
  const Vec3 leverA = rA + d;
  const double invM = scalarLinearInvMass(a, leverA, b, rB, axis);
  if (invM <= 1e-18) return;
  const double effM = 1.0 / invM;
  auto relSpeed = [&]() {
    return dot(b.vel + cross(b.omega, rB) - a.vel - cross(a.omega, leverA), axis);
  };

  // 1. Linear motor / actuator.
  if (j.desc.linearMotor.enabled) {
    const double maxF = effectiveMotorEffort(j.desc.linearMotor, relSpeed());
    const double maxImp = maxF * h;
    const double dImp = (j.desc.linearMotor.targetVelocity - relSpeed()) * effM;
    const double old = j.linearMotorImpulse;
    j.linearMotorImpulse = std::clamp(old + dImp, -maxImp, maxImp);
    const double apply = j.linearMotorImpulse - old;
    a.applyLinearImpulse(-axis * apply, leverA);
    b.applyLinearImpulse(axis * apply, rB);
  }

  // 2. Dry Coulomb sliding friction.
  if (j.desc.linearFriction > 0.0) {
    const double maxImp = j.desc.linearFriction * h;
    const double dImp = -relSpeed() * effM;
    const double old = j.linearFrictionImpulse;
    j.linearFrictionImpulse = std::clamp(old + dImp, -maxImp, maxImp);
    const double apply = j.linearFrictionImpulse - old;
    a.applyLinearImpulse(-axis * apply, leverA);
    b.applyLinearImpulse(axis * apply, rB);
  }

  // 3. Linear stroke limits.
  if (j.desc.linearLimits.enabled && j.desc.linearLimits.lower <= j.desc.linearLimits.upper) {
    const double rv = relSpeed();
    if (j.currentOffset <= j.desc.linearLimits.lower) {
      const double err = j.desc.linearLimits.lower - j.currentOffset;
      const double bounce = rv < -0.05 ? -j.desc.linearLimits.restitution * rv : 0.0;
      const double bias = std::max(bounce, (kBetaVel / h) * std::max(0.0, err - kPosSlop));
      const double dImp = (bias - rv) * effM;
      const double old = j.linearLimitImpulse;
      j.linearLimitImpulse = std::max(0.0, old + dImp);
      const double apply = j.linearLimitImpulse - old;
      a.applyLinearImpulse(-axis * apply, leverA);
      b.applyLinearImpulse(axis * apply, rB);
    } else if (j.currentOffset >= j.desc.linearLimits.upper) {
      const double err = j.currentOffset - j.desc.linearLimits.upper;
      const double bounce = rv > 0.05 ? -j.desc.linearLimits.restitution * rv : 0.0;
      const double bias = std::min(bounce, -(kBetaVel / h) * std::max(0.0, err - kPosSlop));
      const double dImp = (bias - rv) * effM;
      const double old = j.linearLimitImpulse;
      j.linearLimitImpulse = std::min(0.0, old + dImp);
      const double apply = j.linearLimitImpulse - old;
      a.applyLinearImpulse(-axis * apply, leverA);
      b.applyLinearImpulse(axis * apply, rB);
    } else {
      j.linearLimitImpulse = 0.0;
    }
  }
}

/// Solve 2-DOF angular alignment locking `uA` and `uB` to stay collinear (used by Revolute & Cylindrical).
void solveAxisAlignVelocity(Joint& j, BodyRef& a, BodyRef& b, Vec3 uA, Vec3 uB, double h) {
  Vec3 p1, p2;
  orthonormalBasis(uA, p1, p2);
  const Vec3 alignErr = cross(uA, uB);  // Rotation vector moving uA -> uB.
  const Vec3 relW = b.omega - a.omega;

  const double e1 = dot(alignErr, p1);
  const double e2 = dot(alignErr, p2);
  const double w1 = dot(relW, p1);
  const double w2 = dot(relW, p2);

  const SymMat3 invISum = a.invI + b.invI;
  const Vec3 ip1 = invISum * p1;
  const Vec3 ip2 = invISum * p2;
  const double reg = j.desc.angularCompliance / (h * h);
  const double k11 = dot(p1, ip1) + reg;
  const double k12 = dot(p1, ip2);
  const double k22 = dot(p2, ip2) + reg;

  const double lam1 = dot(j.angularImpulse, p1);
  const double lam2 = dot(j.angularImpulse, p2);
  const double rhs1 = -(w1 + (kBetaVel / h) * e1 + reg * lam1);
  const double rhs2 = -(w2 + (kBetaVel / h) * e2 + reg * lam2);

  double d1 = 0.0, d2 = 0.0;
  solveSym2(k11, k12, k22, rhs1, rhs2, d1, d2);
  const Vec3 dImp = p1 * d1 + p2 * d2;
  j.angularImpulse = j.angularImpulse + dImp;
  a.applyAngularImpulse(-dImp);
  b.applyAngularImpulse(dImp);
}

/// Solve 2-DOF perpendicular line translation constraint (used by Prismatic & Cylindrical).
void solveLineConstraintVelocity(Joint& j, BodyRef& a, BodyRef& b, Vec3 rA, Vec3 rB, Vec3 d, Vec3 uA, double h) {
  Vec3 p1, p2;
  orthonormalBasis(uA, p1, p2);
  const Vec3 leverA = rA + d;
  const Vec3 relV = b.vel + cross(b.omega, rB) - a.vel - cross(a.omega, leverA);

  const Vec3 cA1 = cross(leverA, p1), cB1 = cross(rB, p1);
  const Vec3 cA2 = cross(leverA, p2), cB2 = cross(rB, p2);

  const double reg = j.desc.linearCompliance / (h * h);
  const double k11 = a.invMass + b.invMass + dot(cA1, a.invI * cA1) + dot(cB1, b.invI * cB1) + reg;
  const double k22 = a.invMass + b.invMass + dot(cA2, a.invI * cA2) + dot(cB2, b.invI * cB2) + reg;
  const double k12 = dot(cA1, a.invI * cA2) + dot(cB1, b.invI * cB2);

  const double lam1 = dot(j.linearImpulse, p1);
  const double lam2 = dot(j.linearImpulse, p2);
  const double rhs1 = -(dot(relV, p1) + (kBetaVel / h) * dot(d, p1) + reg * lam1);
  const double rhs2 = -(dot(relV, p2) + (kBetaVel / h) * dot(d, p2) + reg * lam2);

  double d1 = 0.0, d2 = 0.0;
  solveSym2(k11, k12, k22, rhs1, rhs2, d1, d2);
  const Vec3 dImp = p1 * d1 + p2 * d2;
  j.linearImpulse = j.linearImpulse + dImp;
  a.applyLinearImpulse(-dImp, leverA);
  b.applyLinearImpulse(dImp, rB);
}

}  // namespace

void initJoint(Joint& j, const std::vector<Body>& bodies) {
  j.desc.localAxisA = length(j.desc.localAxisA) > 1e-9 ? normalized(j.desc.localAxisA) : Vec3{0, 1, 0};
  j.desc.localAxisB = length(j.desc.localAxisB) > 1e-9 ? normalized(j.desc.localAxisB) : Vec3{0, 1, 0};
  orthonormalBasis(j.desc.localAxisA, j.localPerpA1, j.localPerpA2);

  // Align localPerpB1 with localPerpA1 in world space at construction so initial angle == 0!
  const Pose poseA = j.desc.bodyA < bodies.size() ? bodies[j.desc.bodyA].pose : Pose::identity();
  const Pose poseB = j.desc.bodyB < bodies.size() ? bodies[j.desc.bodyB].pose : Pose::identity();
  const Vec3 worldPerpA1 = poseA.dirToWorld(j.localPerpA1);
  Vec3 perpB1 = poseB.dirToLocal(worldPerpA1);
  perpB1 = perpB1 - j.desc.localAxisB * dot(perpB1, j.desc.localAxisB);
  if (length(perpB1) > 1e-6) {
    j.localPerpB1 = normalized(perpB1);
    j.localPerpB2 = cross(j.desc.localAxisB, j.localPerpB1);
  } else {
    orthonormalBasis(j.desc.localAxisB, j.localPerpB1, j.localPerpB2);
  }

  // Record rest relative orientation if identity was passed without override.
  j.currentAngle = 0.0;
  j.currentOffset = 0.0;
  j.phaseIntegral = 0.0;
  if (j.desc.kind == JointKind::Prismatic || j.desc.kind == JointKind::Cylindrical) {
    const Vec3 pA = poseA.toWorld(j.desc.localAnchorA);
    const Vec3 pB = poseB.toWorld(j.desc.localAnchorB);
    const Vec3 uA = poseA.dirToWorld(j.desc.localAxisA);
    j.currentOffset = dot(pB - pA, uA);
  }
}

void prepareJointVelocity(Joint& j, std::vector<Body>& bodies, double h, double warmStartFactor) {
  if (!j.active || j.broken) return;
  BodyRef a = BodyRef::get(bodies, j.desc.bodyA);
  BodyRef b = BodyRef::get(bodies, j.desc.bodyB);
  if (a.invMass == 0.0 && b.invMass == 0.0) return;

  const Vec3 rA = a.pose.dirToWorld(j.desc.localAnchorA);
  const Vec3 rB = b.pose.dirToWorld(j.desc.localAnchorB);
  const Vec3 uA = a.pose.dirToWorld(j.desc.localAxisA);
  const Vec3 uB = b.pose.dirToWorld(j.desc.localAxisB);
  const Vec3 d = (b.pose.pos + rB) - (a.pose.pos + rA);

  // Track continuous coordinates & apply physical Hooke springs + viscous dampers (semi-implicit).
  if (j.desc.kind == JointKind::Revolute || j.desc.kind == JointKind::Cylindrical) {
    j.currentAngle = measureUnwrappedAngle(j, a, b, uA);
    if (j.desc.angularSpring.enabled) {
      const double relW = dot(b.omega - a.omega, uA);
      const double disp = j.currentAngle - j.desc.angularSpring.restTarget;
      const double tau = -(j.desc.angularSpring.stiffness * disp + j.desc.angularSpring.damping * relW);
      // Clamp spring impulse for unconditional stability on stiff springs.
      const double invM = scalarAngularInvMass(a, b, uA);
      const double maxSafe = invM > 1e-18 ? (std::abs(disp) / (h * invM) + std::abs(relW) / invM) * 2.0 : 0.0;
      const double imp = std::clamp(tau * h, -maxSafe, maxSafe);
      a.applyAngularImpulse(-uA * imp);
      b.applyAngularImpulse(uA * imp);
    }
  }
  if (j.desc.kind == JointKind::Prismatic || j.desc.kind == JointKind::Cylindrical) {
    j.currentOffset = dot(d, uA);
    if (j.desc.linearSpring.enabled) {
      const Vec3 leverA = rA + d;
      const double relV = dot(b.vel + cross(b.omega, rB) - a.vel - cross(a.omega, leverA), uA);
      const double disp = j.currentOffset - j.desc.linearSpring.restTarget;
      // Implicitly damped Hooke spring step (stiffness k, damping c):
      //   F = -(k*(x + h*v) + c*v) / (1 + h*(c + h*k)*invM)
      const double invM = scalarLinearInvMass(a, leverA, b, rB, uA);
      const double k = j.desc.linearSpring.stiffness;
      const double c = j.desc.linearSpring.damping;
      const double denom = 1.0 + h * (c + h * k) * invM;
      const double force = -(k * (disp + h * relV) + c * relV) / std::max(denom, 1.0);
      const Vec3 imp = uA * (force * h);
      a.applyLinearImpulse(-imp, leverA);
      b.applyLinearImpulse(imp, rB);
    }
  }

  // Warm-start accumulated impulses from previous substep.
  j.linearImpulse = j.linearImpulse * warmStartFactor;
  j.angularImpulse = j.angularImpulse * warmStartFactor;
  j.limitImpulse *= warmStartFactor;
  j.linearLimitImpulse *= warmStartFactor;
  j.motorImpulse *= warmStartFactor;
  j.linearMotorImpulse *= warmStartFactor;
  j.frictionImpulse *= warmStartFactor;
  j.linearFrictionImpulse *= warmStartFactor;
  j.gearImpulse *= warmStartFactor;
  j.distanceImpulse *= warmStartFactor;
  j.coneImpulse *= warmStartFactor;

  switch (j.desc.kind) {
    case JointKind::Fixed:
      a.applyLinearImpulse(-j.linearImpulse, rA);
      b.applyLinearImpulse(j.linearImpulse, rB);
      a.applyAngularImpulse(-j.angularImpulse);
      b.applyAngularImpulse(j.angularImpulse);
      break;
    case JointKind::Revolute:
      a.applyLinearImpulse(-j.linearImpulse, rA);
      b.applyLinearImpulse(j.linearImpulse, rB);
      a.applyAngularImpulse(-j.angularImpulse);
      b.applyAngularImpulse(j.angularImpulse);
      {
        const double axial = j.motorImpulse + j.frictionImpulse + j.limitImpulse;
        a.applyAngularImpulse(-uA * axial);
        b.applyAngularImpulse(uA * axial);
      }
      break;
    case JointKind::Prismatic: {
      const Vec3 leverA = rA + d;
      const Vec3 axialImp = uA * (j.linearMotorImpulse + j.linearFrictionImpulse + j.linearLimitImpulse);
      a.applyLinearImpulse(-(j.linearImpulse + axialImp), leverA);
      b.applyLinearImpulse(j.linearImpulse + axialImp, rB);
      a.applyAngularImpulse(-j.angularImpulse);
      b.applyAngularImpulse(j.angularImpulse);
      break;
    }
    case JointKind::Cylindrical: {
      const Vec3 leverA = rA + d;
      const Vec3 axialLin = uA * (j.linearMotorImpulse + j.linearFrictionImpulse + j.linearLimitImpulse);
      a.applyLinearImpulse(-(j.linearImpulse + axialLin), leverA);
      b.applyLinearImpulse(j.linearImpulse + axialLin, rB);
      const Vec3 axialAng = uA * (j.motorImpulse + j.frictionImpulse + j.limitImpulse);
      a.applyAngularImpulse(-(j.angularImpulse + axialAng));
      b.applyAngularImpulse(j.angularImpulse + axialAng);
      break;
    }
    case JointKind::Spherical:
      a.applyLinearImpulse(-j.linearImpulse, rA);
      b.applyLinearImpulse(j.linearImpulse, rB);
      a.applyAngularImpulse(-j.angularImpulse);
      b.applyAngularImpulse(j.angularImpulse);
      break;
    case JointKind::Distance: {
      const double dist = length(d);
      if (dist > 1e-9) {
        const Vec3 dir = d * (1.0 / dist);
        a.applyLinearImpulse(-dir * j.distanceImpulse, rA);
        b.applyLinearImpulse(dir * j.distanceImpulse, rB);
      }
      break;
    }
    case JointKind::Grab:
      a.applyLinearImpulse(-j.linearImpulse, rA);
      break;
    case JointKind::Gear: {
      BodyRef carrier = BodyRef::get(bodies, j.desc.gear.carrierBody);
      const bool isLinearB = j.desc.gear.meshKind == kin::MeshKind::Rack || j.desc.gear.meshKind == kin::MeshKind::Screw;
      // Do not warm-start self-locking worm/screw onto the input shaft (prevents phantom back-drive kicks).
      const bool selfLock = (j.desc.gear.meshKind == kin::MeshKind::Worm || j.desc.gear.meshKind == kin::MeshKind::Screw) &&
                            j.desc.gear.wormSelfLocking;
      if (selfLock) {
        j.gearImpulse = 0.0;
        break;
      }
      const double lam = j.gearImpulse;
      a.applyAngularImpulse(uA * (j.desc.gear.ratioA * lam));
      if (isLinearB) {
        b.applyLinearImpulse(uB * (j.desc.gear.ratioB * lam), rB);
        if (carrier.invMass > 0.0) {
          const Vec3 rCB = (b.pose.pos + rB) - carrier.pose.pos;
          carrier.applyLinearImpulse(-uB * (j.desc.gear.ratioB * lam), rCB);
          carrier.applyAngularImpulse(-uA * (j.desc.gear.ratioA * lam));
        }
      } else {
        b.applyAngularImpulse(uB * (j.desc.gear.ratioB * lam));
        if (carrier.invMass > 0.0) {
          carrier.applyAngularImpulse(-(uA * j.desc.gear.ratioA + uB * j.desc.gear.ratioB) * lam);
        }
      }
      break;
    }
  }
}

void solveJointVelocity(Joint& j, std::vector<Body>& bodies, double h) {
  if (!j.active || j.broken) return;
  BodyRef a = BodyRef::get(bodies, j.desc.bodyA);
  BodyRef b = BodyRef::get(bodies, j.desc.bodyB);
  if (a.invMass == 0.0 && b.invMass == 0.0) return;

  const Vec3 rA = a.pose.dirToWorld(j.desc.localAnchorA);
  const Vec3 rB = b.pose.dirToWorld(j.desc.localAnchorB);
  const Vec3 uA = a.pose.dirToWorld(j.desc.localAxisA);
  const Vec3 uB = b.pose.dirToWorld(j.desc.localAxisB);
  const Vec3 d = (b.pose.pos + rB) - (a.pose.pos + rA);

  switch (j.desc.kind) {
    case JointKind::Fixed: {
      // 3-DOF point lock (coupled 3x3 SPD block).
      const double linReg = j.desc.linearCompliance / (h * h);
      const SymMat3 kLin = pointEffectiveInvMass(a.invMass, a.invI, rA, b.invMass, b.invI, rB, linReg);
      const Vec3 relV = b.vel + cross(b.omega, rB) - a.vel - cross(a.omega, rA);
      const Vec3 rhsLin = -(relV + d * (kBetaVel / h) + j.linearImpulse * linReg);
      const Vec3 dLin = kLin.solveSpd(rhsLin);
      j.linearImpulse = j.linearImpulse + dLin;
      a.applyLinearImpulse(-dLin, rA);
      b.applyLinearImpulse(dLin, rB);

      // 3-DOF orientation lock (coupled 3x3 SPD block).
      const Quat targetQ = (a.pose.rot * j.desc.localRefRot).normalized();
      const Quat qErr = (b.pose.rot * targetQ.conjugate()).normalized();
      const Vec3 angErr = qErr.toRotVec();
      const double angReg = j.desc.angularCompliance / (h * h);
      const SymMat3 kAng = a.invI + b.invI + SymMat3::diag(angReg, angReg, angReg);
      const Vec3 relW = b.omega - a.omega;
      const Vec3 rhsAng = -(relW + angErr * (kBetaVel / h) + j.angularImpulse * angReg);
      const Vec3 dAng = kAng.solveSpd(rhsAng);
      j.angularImpulse = j.angularImpulse + dAng;
      a.applyAngularImpulse(-dAng);
      b.applyAngularImpulse(dAng);
      break;
    }

    case JointKind::Revolute: {
      // 3-DOF point lock.
      const double linReg = j.desc.linearCompliance / (h * h);
      const SymMat3 kLin = pointEffectiveInvMass(a.invMass, a.invI, rA, b.invMass, b.invI, rB, linReg);
      const Vec3 relV = b.vel + cross(b.omega, rB) - a.vel - cross(a.omega, rA);
      const Vec3 dLin = kLin.solveSpd(-(relV + d * (kBetaVel / h) + j.linearImpulse * linReg));
      j.linearImpulse = j.linearImpulse + dLin;
      a.applyLinearImpulse(-dLin, rA);
      b.applyLinearImpulse(dLin, rB);

      // 2-DOF axis alignment.
      solveAxisAlignVelocity(j, a, b, uA, uB, h);

      // 1-DOF rotation motor, friction, limits.
      solveAngularDofRow(j, a, b, uA, h);
      break;
    }

    case JointKind::Prismatic: {
      // 3-DOF orientation lock.
      const Quat targetQ = (a.pose.rot * j.desc.localRefRot).normalized();
      const Vec3 angErr = (b.pose.rot * targetQ.conjugate()).normalized().toRotVec();
      const double angReg = j.desc.angularCompliance / (h * h);
      const SymMat3 kAng = a.invI + b.invI + SymMat3::diag(angReg, angReg, angReg);
      const Vec3 dAng = kAng.solveSpd(-(b.omega - a.omega + angErr * (kBetaVel / h) + j.angularImpulse * angReg));
      j.angularImpulse = j.angularImpulse + dAng;
      a.applyAngularImpulse(-dAng);
      b.applyAngularImpulse(dAng);

      // 2-DOF perpendicular line lock.
      solveLineConstraintVelocity(j, a, b, rA, rB, d, uA, h);

      // 1-DOF linear motor, friction, stroke limits.
      solveLinearDofRow(j, a, b, rA, rB, d, uA, h);
      break;
    }

    case JointKind::Cylindrical: {
      solveAxisAlignVelocity(j, a, b, uA, uB, h);
      solveLineConstraintVelocity(j, a, b, rA, rB, d, uA, h);
      solveAngularDofRow(j, a, b, uA, h);
      solveLinearDofRow(j, a, b, rA, rB, d, uA, h);
      break;
    }

    case JointKind::Spherical: {
      // 3-DOF ball-and-socket point lock.
      const double linReg = j.desc.linearCompliance / (h * h);
      const SymMat3 kLin = pointEffectiveInvMass(a.invMass, a.invI, rA, b.invMass, b.invI, rB, linReg);
      const Vec3 relV = b.vel + cross(b.omega, rB) - a.vel - cross(a.omega, rA);
      const Vec3 dLin = kLin.solveSpd(-(relV + d * (kBetaVel / h) + j.linearImpulse * linReg));
      j.linearImpulse = j.linearImpulse + dLin;
      a.applyLinearImpulse(-dLin, rA);
      b.applyLinearImpulse(dLin, rB);

      // 3D isotropic ball-socket dry friction torque.
      if (j.desc.angularFriction > 0.0) {
        const SymMat3 kAng = a.invI + b.invI;
        const Vec3 relW = b.omega - a.omega;
        const Vec3 dAng = kAng.solveSpd(-relW);
        const Vec3 old = j.angularImpulse;
        Vec3 next = old + dAng;
        const double maxImp = j.desc.angularFriction * h;
        const double n = length(next);
        if (n > maxImp && n > 1e-18) next = next * (maxImp / n);
        const Vec3 apply = next - old;
        j.angularImpulse = next;
        a.applyAngularImpulse(-apply);
        b.applyAngularImpulse(apply);
      }

      // Swing-cone limit (half-angle <= coneMaxAngle).
      if (j.desc.coneMaxAngle < kPi - 1e-3) {
        const double cosA = std::clamp(dot(uA, uB), -1.0, 1.0);
        const double angle = std::acos(cosA);
        if (angle > j.desc.coneMaxAngle) {
          Vec3 swingAxis = cross(uA, uB);
          const double sl = length(swingAxis);
          if (sl > 1e-9) {
            swingAxis = swingAxis * (1.0 / sl);
            const double invM = scalarAngularInvMass(a, b, swingAxis);
            if (invM > 1e-18) {
              const double relW = dot(b.omega - a.omega, swingAxis);
              const double bias = -(kBetaVel / h) * (angle - j.desc.coneMaxAngle);
              const double dImp = (bias - relW) / invM;
              const double old = j.coneImpulse;
              j.coneImpulse = std::min(0.0, old + dImp);
              const double apply = j.coneImpulse - old;
              a.applyAngularImpulse(-swingAxis * apply);
              b.applyAngularImpulse(swingAxis * apply);
            }
          }
        } else {
          j.coneImpulse = 0.0;
        }
      }
      break;
    }

    case JointKind::Distance: {
      const double dist = length(d);
      if (dist <= 1e-9) break;
      const Vec3 dir = d * (1.0 / dist);
      const double reg = j.desc.linearCompliance / (h * h);
      const double invM = scalarLinearInvMass(a, rA, b, rB, dir) + reg;
      if (invM <= 1e-18) break;
      const double relV = dot(b.vel + cross(b.omega, rB) - a.vel - cross(a.omega, rA), dir);

      if (j.desc.ropeOnly) {
        // Tension-only cable: pulls inward when dist >= maxDistance, slack otherwise.
        if (dist >= j.desc.maxDistance) {
          const double err = dist - j.desc.maxDistance;
          const double dImp = -(relV + (kBetaVel / h) * err + reg * j.distanceImpulse) / invM;
          const double old = j.distanceImpulse;
          j.distanceImpulse = std::min(0.0, old + dImp);
          const double apply = j.distanceImpulse - old;
          a.applyLinearImpulse(-dir * apply, rA);
          b.applyLinearImpulse(dir * apply, rB);
        } else {
          j.distanceImpulse = 0.0;
        }
      } else {
        // Bilateral rod (or bounded length [minDistance, maxDistance]).
        double err = 0.0;
        bool active = false;
        bool lowerOnly = false, upperOnly = false;
        if (j.desc.minDistance >= j.desc.maxDistance - 1e-9) {
          err = dist - j.desc.maxDistance;
          active = true;
        } else if (dist > j.desc.maxDistance) {
          err = dist - j.desc.maxDistance;
          active = true;
          upperOnly = true;
        } else if (dist < j.desc.minDistance) {
          err = dist - j.desc.minDistance;
          active = true;
          lowerOnly = true;
        }
        if (active) {
          const double dImp = -(relV + (kBetaVel / h) * err + reg * j.distanceImpulse) / invM;
          const double old = j.distanceImpulse;
          double next = old + dImp;
          if (upperOnly) next = std::min(0.0, next);
          if (lowerOnly) next = std::max(0.0, next);
          const double apply = next - old;
          j.distanceImpulse = next;
          a.applyLinearImpulse(-dir * apply, rA);
          b.applyLinearImpulse(dir * apply, rB);
        } else {
          j.distanceImpulse = 0.0;
        }
      }
      break;
    }

    case JointKind::Grab: {
      // Soft 3-DOF drag spring pulling bodyA's localAnchorA toward world-space target `localAnchorB`.
      const Vec3 targetW = j.desc.localAnchorB;
      const Vec3 err = (a.pose.pos + rA) - targetW;
      const double reg = std::max(j.desc.linearCompliance, 1e-3) / (h * h);
      const SymMat3 kLin = pointEffectiveInvMass(a.invMass, a.invI, rA, 0.0, SymMat3::zero(), {}, reg);
      const Vec3 velA = a.vel + cross(a.omega, rA);
      const Vec3 dLin = kLin.solveSpd(-(velA + err * (0.35 / h) + j.linearImpulse * reg));
      j.linearImpulse = j.linearImpulse + dLin;
      a.applyLinearImpulse(dLin, rA);
      break;
    }

    case JointKind::Gear: {
      BodyRef carrier = BodyRef::get(bodies, j.desc.gear.carrierBody);
      const GearSpec& g = j.desc.gear;
      const bool isLinearB = g.meshKind == kin::MeshKind::Rack || g.meshKind == kin::MeshKind::Screw;

      // Apply backlash deadband to phase error.
      double phaseErr = 0.0;
      if (std::abs(j.phaseIntegral) > g.backlash) {
        phaseErr = j.phaseIntegral - std::copysign(g.backlash, j.phaseIntegral);
      }

      const Vec3 jwA = uA * g.ratioA;
      double cVel = dot(a.omega - carrier.omega, jwA);
      double invM = dot(jwA, a.invI * jwA);

      if (isLinearB) {
        const Vec3 jvB = uB * g.ratioB;
        const Vec3 jwB = cross(rB, jvB);
        const Vec3 rCB = (b.pose.pos + rB) - carrier.pose.pos;
        const Vec3 jvC = -jvB;
        const Vec3 jwC = -jwA - cross(rCB, jvB);
        cVel += dot(b.vel - carrier.vel, jvB) + dot(b.omega, jwB) - dot(carrier.omega, cross(rCB, jvB));
        invM += b.invMass * dot(jvB, jvB) + dot(jwB, b.invI * jwB);
        if (carrier.invMass > 0.0) {
          invM += carrier.invMass * dot(jvC, jvC) + dot(jwC, carrier.invI * jwC);
        }
        const double reg = j.desc.angularCompliance / (h * h);
        if (invM + reg <= 1e-18) break;
        const double dLam = -(cVel + (0.15 / h) * phaseErr + reg * j.gearImpulse) / (invM + reg);
        const double maxImp = std::isfinite(g.maxToothForce) ? g.maxToothForce * h : 1e12;
        const double old = j.gearImpulse;
        j.gearImpulse = std::clamp(old + dLam, -maxImp, maxImp);
        const double apply = j.gearImpulse - old;
        // Self-locking worm/screw asymmetry: do not let rack/piston freely spin input if self-locking and B drives.
        const bool blockA = (g.meshKind == kin::MeshKind::Screw && g.wormSelfLocking &&
                             std::abs(dot(a.omega - carrier.omega, uA)) < 1e-3 && std::abs(dot(b.vel, uB)) > 1e-4);
        if (!blockA) a.applyAngularImpulse(jwA * apply);
        b.applyLinearImpulse(jvB * apply, rB);
        if (carrier.invMass > 0.0) {
          carrier.applyLinearImpulse(jvC * apply, rCB);
          carrier.applyAngularImpulse(-jwA * apply);
        }
      } else {
        // Worm gear self-locking: when worm shaft A is stationary, thread flank friction locks
        // driven wheel B directly against the carrier/housing without applying back-drive torque to A!
        const bool wormLocked = (g.meshKind == kin::MeshKind::Worm && g.wormSelfLocking &&
                                 std::abs(dot(a.omega - carrier.omega, uA)) < 0.05);
        if (wormLocked) {
          const double relWB = dot(b.omega - carrier.omega, uB);
          const double lockInvM = dot(uB, b.invI * uB) + (carrier.invMass > 0.0 ? dot(uB, carrier.invI * uB) : 0.0);
          if (lockInvM > 1e-18) {
            const double dLock = -relWB / lockInvM;
            b.applyAngularImpulse(uB * dLock);
            if (carrier.invMass > 0.0) carrier.applyAngularImpulse(-uB * dLock);
          }
          break;
        }
        const Vec3 jwB = uB * g.ratioB;
        const Vec3 jwC = -(jwA + jwB);
        cVel += dot(b.omega - carrier.omega, jwB);
        invM += dot(jwB, b.invI * jwB);
        if (carrier.invMass > 0.0) invM += dot(jwC, carrier.invI * jwC);
        const double reg = j.desc.angularCompliance / (h * h);
        if (invM + reg <= 1e-18) break;
        const double dLam = -(cVel + (0.15 / h) * phaseErr + reg * j.gearImpulse) / (invM + reg);
        const double maxImp = std::isfinite(g.maxToothForce) ? g.maxToothForce * h : 1e12;
        const double old = j.gearImpulse;
        j.gearImpulse = std::clamp(old + dLam, -maxImp, maxImp);
        const double apply = j.gearImpulse - old;
        a.applyAngularImpulse(jwA * apply);
        b.applyAngularImpulse(jwB * apply);
        if (carrier.invMass > 0.0) carrier.applyAngularImpulse(jwC * apply);
      }
      break;
    }
  }
}

void solveJointPosition(Joint& j, std::vector<Body>& bodies, double maxCorrection) {
  if (!j.active || j.broken) return;
  if (j.desc.kind == JointKind::Gear || j.desc.kind == JointKind::Grab) return;
  BodyRef a = BodyRef::get(bodies, j.desc.bodyA);
  BodyRef b = BodyRef::get(bodies, j.desc.bodyB);
  if (a.invMass == 0.0 && b.invMass == 0.0) return;

  const Vec3 rA = a.pose.dirToWorld(j.desc.localAnchorA);
  const Vec3 rB = b.pose.dirToWorld(j.desc.localAnchorB);
  const Vec3 d = (b.pose.pos + rB) - (a.pose.pos + rA);

  auto clampVec = [&](Vec3 v, double cap) {
    const double l = length(v);
    return (l > cap && l > 1e-18) ? v * (cap / l) : v;
  };

  // Point-to-point positional closure.
  if (j.desc.kind == JointKind::Fixed || j.desc.kind == JointKind::Revolute || j.desc.kind == JointKind::Spherical) {
    const double errLen = length(d);
    if (errLen > kPosSlop) {
      const Vec3 corr = clampVec(d, maxCorrection);
      const SymMat3 kLin = pointEffectiveInvMass(a.invMass, a.invI, rA, b.invMass, b.invI, rB, 1e-12);
      const Vec3 imp = kLin.solveSpd(-corr);
      a.applyPosCorrection(-imp * a.invMass, -(a.invI * cross(rA, imp)));
      b.applyPosCorrection(imp * b.invMass, b.invI * cross(rB, imp));
    }
  }

  // Full orientation closure.
  if (j.desc.kind == JointKind::Fixed || j.desc.kind == JointKind::Prismatic) {
    const Quat targetQ = (a.pose.rot * j.desc.localRefRot).normalized();
    const Vec3 angErr = (b.pose.rot * targetQ.conjugate()).normalized().toRotVec();
    if (length(angErr) > kAngSlop) {
      const Vec3 corr = clampVec(angErr, 0.25);
      const SymMat3 kAng = a.invI + b.invI;
      const Vec3 imp = kAng.solveSpd(-corr);
      a.applyPosCorrection({}, -(a.invI * imp));
      b.applyPosCorrection({}, b.invI * imp);
    }
  }

  // 2-DOF axis alignment closure.
  if (j.desc.kind == JointKind::Revolute || j.desc.kind == JointKind::Cylindrical) {
    const Vec3 uA2 = a.pose.dirToWorld(j.desc.localAxisA);
    const Vec3 uB2 = b.pose.dirToWorld(j.desc.localAxisB);
    const Vec3 alignErr = cross(uA2, uB2);
    if (length(alignErr) > kAngSlop) {
      const Vec3 corr = clampVec(alignErr, 0.25);
      const SymMat3 kAng = a.invI + b.invI;
      const Vec3 imp = kAng.solveSpd(-corr);
      a.applyPosCorrection({}, -(a.invI * imp));
      b.applyPosCorrection({}, b.invI * imp);
    }
  }

  // 2-DOF perpendicular line closure.
  if (j.desc.kind == JointKind::Prismatic || j.desc.kind == JointKind::Cylindrical) {
    const Vec3 rA2 = a.pose.dirToWorld(j.desc.localAnchorA);
    const Vec3 rB2 = b.pose.dirToWorld(j.desc.localAnchorB);
    const Vec3 uA2 = a.pose.dirToWorld(j.desc.localAxisA);
    const Vec3 d2 = (b.pose.pos + rB2) - (a.pose.pos + rA2);
    const Vec3 perp = d2 - uA2 * dot(d2, uA2);
    if (length(perp) > kPosSlop) {
      const Vec3 corr = clampVec(perp, maxCorrection);
      const Vec3 leverA = rA2 + d2;
      const SymMat3 kLin = pointEffectiveInvMass(a.invMass, a.invI, leverA, b.invMass, b.invI, rB2, 1e-12);
      const Vec3 imp = kLin.solveSpd(-corr);
      // Keep correction purely perpendicular to uA2.
      const Vec3 perpImp = imp - uA2 * dot(imp, uA2);
      a.applyPosCorrection(-perpImp * a.invMass, -(a.invI * cross(leverA, perpImp)));
      b.applyPosCorrection(perpImp * b.invMass, b.invI * cross(rB2, perpImp));
    }
  }

  // Distance / rope positional closure.
  if (j.desc.kind == JointKind::Distance) {
    const double dist = length(d);
    if (dist > 1e-9) {
      double err = 0.0;
      if (j.desc.ropeOnly) {
        if (dist > j.desc.maxDistance) err = dist - j.desc.maxDistance;
      } else if (j.desc.minDistance >= j.desc.maxDistance - 1e-9) {
        err = dist - j.desc.maxDistance;
      } else if (dist > j.desc.maxDistance) {
        err = dist - j.desc.maxDistance;
      } else if (dist < j.desc.minDistance) {
        err = dist - j.desc.minDistance;
      }
      if (std::abs(err) > kPosSlop) {
        const Vec3 dir = d * (1.0 / dist);
        const double invM = scalarLinearInvMass(a, rA, b, rB, dir);
        if (invM > 1e-18) {
          const double corr = std::clamp(err, -maxCorrection, maxCorrection);
          const double imp = -corr / invM;
          a.applyPosCorrection(-dir * (imp * a.invMass), -(a.invI * cross(rA, dir * imp)));
          b.applyPosCorrection(dir * (imp * b.invMass), b.invI * cross(rB, dir * imp));
        }
      }
    }
  }
}

void updateJointTelemetry(Joint& j, const std::vector<Body>& bodies, double h) {
  if (!j.active || j.broken || h <= 1e-12) {
    j.reactionForce = {};
    j.reactionTorque = {};
    j.pullForce = j.shearForce = j.bendTorque = j.twistTorque = j.stressRatio = 0.0;
    return;
  }
  // Update exact post-solve gear phase integral using the true solved velocities (never mid-warm-start!).
  if (j.desc.kind == JointKind::Gear) {
    const Pose pA = j.desc.bodyA < bodies.size() ? bodies[j.desc.bodyA].pose : Pose::identity();
    const Pose pB = j.desc.bodyB < bodies.size() ? bodies[j.desc.bodyB].pose : Pose::identity();
    const Pose pC = j.desc.gear.carrierBody < bodies.size() ? bodies[j.desc.gear.carrierBody].pose : Pose::identity();
    const Vec3 wA_v = j.desc.bodyA < bodies.size() ? bodies[j.desc.bodyA].omega : Vec3{};
    const Vec3 wB_v = j.desc.bodyB < bodies.size() ? bodies[j.desc.bodyB].omega : Vec3{};
    const Vec3 vB_v = j.desc.bodyB < bodies.size() ? bodies[j.desc.bodyB].vel : Vec3{};
    const Vec3 wC_v = j.desc.gear.carrierBody < bodies.size() ? bodies[j.desc.gear.carrierBody].omega : Vec3{};
    const Vec3 vC_v = j.desc.gear.carrierBody < bodies.size() ? bodies[j.desc.gear.carrierBody].vel : Vec3{};
    const Vec3 uA = pA.dirToWorld(j.desc.localAxisA);
    const Vec3 uB = pB.dirToWorld(j.desc.localAxisB);
    const Vec3 rB = pB.dirToWorld(j.desc.localAnchorB);
    const bool isLinearB = j.desc.gear.meshKind == kin::MeshKind::Rack || j.desc.gear.meshKind == kin::MeshKind::Screw;
    const double qDotA = dot(wA_v - wC_v, uA);
    double qDotB = 0.0;
    if (isLinearB) {
      const Vec3 rCB = (pB.pos + rB) - pC.pos;
      qDotB = dot(vB_v + cross(wB_v, rB) - vC_v - cross(wC_v, rCB), uB);
    } else {
      qDotB = dot(wB_v - wC_v, uB);
    }
    j.phaseIntegral += (j.desc.gear.ratioA * qDotA + j.desc.gear.ratioB * qDotB) * h;
  }

  const double invH = 1.0 / h;
  const Pose poseA = j.desc.bodyA < bodies.size() ? bodies[j.desc.bodyA].pose : Pose::identity();
  const Vec3 uA = poseA.dirToWorld(j.desc.localAxisA);

  j.reactionForce = j.linearImpulse * invH;
  j.reactionTorque = j.angularImpulse * invH;

  const double axialF = dot(j.reactionForce, uA);
  j.pullForce = std::abs(axialF);
  j.shearForce = length(j.reactionForce - uA * axialF);

  const double axialT = dot(j.reactionTorque, uA);
  j.twistTorque = std::abs(axialT);
  j.bendTorque = length(j.reactionTorque - uA * axialT);

  const JointStrength& s = j.desc.strength;
  double ratio = 0.0;
  if (std::isfinite(s.maxPullForce) && s.maxPullForce > 0.0)
    ratio = std::max(ratio, j.pullForce / s.maxPullForce);
  if (std::isfinite(s.maxShearForce) && s.maxShearForce > 0.0)
    ratio = std::max(ratio, j.shearForce / s.maxShearForce);
  if (std::isfinite(s.maxBendTorque) && s.maxBendTorque > 0.0)
    ratio = std::max(ratio, j.bendTorque / s.maxBendTorque);
  if (std::isfinite(s.maxTwistTorque) && s.maxTwistTorque > 0.0)
    ratio = std::max(ratio, j.twistTorque / s.maxTwistTorque);
  j.stressRatio = ratio;
}

}  // namespace bm::physics::detail
