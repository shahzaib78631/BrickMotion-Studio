#include "bm/physics/world.h"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <limits>
#include <numeric>
#include "joints_internal.h"

namespace bm::physics {
namespace {

struct UnionFind {
  std::vector<uint32_t> parent;
  explicit UnionFind(size_t n) : parent(n) { std::iota(parent.begin(), parent.end(), 0u); }
  uint32_t find(uint32_t x) {
    while (parent[x] != x) x = parent[x] = parent[parent[x]];
    return x;
  }
  void unite(uint32_t a, uint32_t b) {
    a = find(a);
    b = find(b);
    if (a != b) parent[a] = b;
  }
};

MassProperties deriveShapeMass(const CompoundShape& shape, const Material& mat) {
  if (shape.empty()) return computeBoxMass({0.004, 0.0048, 0.004}, mat.density);
  std::vector<PartMassEntry> entries;
  entries.reserve(shape.parts.size());
  for (const auto& sub : shape.parts) {
    MassProperties mp;
    switch (sub.shape.kind) {
      case ShapeKind::Box:
        mp = computeBoxMass(sub.shape.halfExtents, mat.density);
        break;
      case ShapeKind::Sphere:
        mp = computeSphereMass(sub.shape.radius, mat.density);
        break;
      case ShapeKind::Capsule:
        mp = computeCylinderMass(sub.shape.radius, sub.shape.halfHeight + sub.shape.radius * 0.5, mat.density);
        break;
      case ShapeKind::Cylinder:
        mp = computeCylinderMass(sub.shape.radius, sub.shape.halfHeight, mat.density);
        break;
      case ShapeKind::ConvexHull: {
        const Box b = sub.shape.localBounds();
        const Vec3 he = b.empty() ? Vec3{0.004, 0.0048, 0.004} : (b.max - b.min) * 0.5;
        mp = computeBoxMass(he, mat.density * kHollowBoxFill);
        if (!b.empty()) mp.com = (b.min + b.max) * 0.5;
        break;
      }
    }
    entries.push_back({mp, sub.localPose});
  }
  return combineMassProperties(entries);
}

}  // namespace

World::World(WorldConfig config) : config_(config) {}

uint32_t World::addBody(const BodyDesc& desc) {
  const uint32_t id = static_cast<uint32_t>(bodies_.size());
  Body b;
  b.id = id;
  b.motion = desc.motion;
  b.pose = {desc.pose.pos, desc.pose.rot.normalized()};
  b.vel = desc.linearVel;
  b.omega = desc.angularVel;
  b.material = desc.material;
  b.shape = desc.shape;
  b.shape.recomputeBounds();
  b.linearDamping = desc.linearDamping;
  b.angularDamping = desc.angularDamping;
  b.gravityScale = desc.gravityScale;
  b.enableCcd = desc.enableCcd;
  b.allowSleep = desc.allowSleep;
  b.label = desc.label;

  if (b.motion == BodyMotion::Dynamic) {
    MassProperties mp = desc.massProps;
    if (mp.mass <= 0.0) {
      mp = deriveShapeMass(b.shape, b.material);
    }
    b.mass = std::max(mp.mass, kMinMassKg);
    b.invMass = 1.0 / b.mass;
    b.localInertia = mp.inertiaCom;
    // Guarantee non-zero diagonal before inversion.
    if (b.localInertia.xx <= 0.0 || b.localInertia.yy <= 0.0 || b.localInertia.zz <= 0.0) {
      b.localInertia = SymMat3::diag(kMinInertiaKgM2, kMinInertiaKgM2, kMinInertiaKgM2);
    }
    b.localInvInertia = b.localInertia.inverseSpd();
    b.updateWorldInertia();
  }

  b.worldBounds = b.shape.empty() ? Box{b.pose.pos, b.pose.pos} : b.shape.worldBounds(b.pose);
  b.bvhProxy = bvh_.insert(id, b.worldBounds);
  bodies_.push_back(std::move(b));
  return id;
}

void World::setBodyPose(uint32_t id, const Pose& pose) {
  if (id >= bodies_.size()) return;
  Body& b = bodies_[id];
  const Vec3 disp = pose.pos - b.pose.pos;
  b.pose = {pose.pos, pose.rot.normalized()};
  b.updateWorldInertia();
  b.sleeping = false;
  b.sleepTimer = 0.0;
  syncBvhProxy(id, disp);
}

void World::setBodyVelocity(uint32_t id, Vec3 vel, Vec3 omega) {
  if (id >= bodies_.size()) return;
  Body& b = bodies_[id];
  b.vel = vel;
  b.omega = omega;
  if (dot(vel, vel) > 0.0 || dot(omega, omega) > 0.0) wakeBody(id);
}

void World::setBodyMotion(uint32_t id, BodyMotion motion) {
  if (id >= bodies_.size()) return;
  Body& b = bodies_[id];
  b.motion = motion;
  if (motion == BodyMotion::Static) {
    b.vel = {};
    b.omega = {};
    b.invMass = 0.0;
    b.worldInvInertia = SymMat3::zero();
  } else if (motion == BodyMotion::Kinematic) {
    b.invMass = 0.0;
    b.worldInvInertia = SymMat3::zero();
  } else {
    if (b.mass <= 0.0) {
      const MassProperties mp = deriveShapeMass(b.shape, b.material);
      b.mass = std::max(mp.mass, kMinMassKg);
      b.localInertia = mp.inertiaCom;
      b.localInvInertia = b.localInertia.inverseSpd();
    }
    b.invMass = 1.0 / b.mass;
    b.updateWorldInertia();
    b.sleeping = false;
    b.sleepTimer = 0.0;
  }
}

void World::wakeBody(uint32_t id) {
  if (id >= bodies_.size()) return;
  bodies_[id].sleeping = false;
  bodies_[id].sleepTimer = 0.0;
}

void World::wakeAll() {
  for (auto& b : bodies_) {
    b.sleeping = false;
    b.sleepTimer = 0.0;
  }
}

void World::applyForce(uint32_t id, Vec3 f) {
  if (id >= bodies_.size() || !bodies_[id].isDynamic()) return;
  bodies_[id].force = bodies_[id].force + f;
  wakeBody(id);
}

void World::applyForceAtPoint(uint32_t id, Vec3 f, Vec3 worldPoint) {
  if (id >= bodies_.size() || !bodies_[id].isDynamic()) return;
  Body& b = bodies_[id];
  b.force = b.force + f;
  b.torque = b.torque + cross(worldPoint - b.pose.pos, f);
  wakeBody(id);
}

void World::applyTorque(uint32_t id, Vec3 tau) {
  if (id >= bodies_.size() || !bodies_[id].isDynamic()) return;
  bodies_[id].torque = bodies_[id].torque + tau;
  wakeBody(id);
}

void World::applyImpulse(uint32_t id, Vec3 imp) {
  if (id >= bodies_.size() || !bodies_[id].isDynamic()) return;
  Body& b = bodies_[id];
  b.vel = b.vel + imp * b.invMass;
  wakeBody(id);
}

void World::applyImpulseAtPoint(uint32_t id, Vec3 imp, Vec3 worldPoint) {
  if (id >= bodies_.size() || !bodies_[id].isDynamic()) return;
  Body& b = bodies_[id];
  b.vel = b.vel + imp * b.invMass;
  b.omega = b.omega + b.worldInvInertia * cross(worldPoint - b.pose.pos, imp);
  wakeBody(id);
}

void World::applyAngularImpulse(uint32_t id, Vec3 angImp) {
  if (id >= bodies_.size() || !bodies_[id].isDynamic()) return;
  Body& b = bodies_[id];
  b.omega = b.omega + b.worldInvInertia * angImp;
  wakeBody(id);
}

void World::applyRadialImpulse(Vec3 center, double radius, double peakImpulse) {
  if (radius <= 1e-6) return;
  const double r2 = radius * radius;
  for (uint32_t i = 0; i < bodies_.size(); i++) {
    Body& b = bodies_[i];
    if (!b.isDynamic()) continue;
    const Vec3 d = b.pose.pos - center;
    const double d2 = dot(d, d);
    if (d2 >= r2) continue;
    const double dist = std::sqrt(d2);
    const Vec3 dir = dist > 1e-9 ? d * (1.0 / dist) : Vec3{0.0, -1.0, 0.0};
    const double falloff = 1.0 / (1.0 + 4.0 * d2 / r2);
    applyImpulse(i, dir * (peakImpulse * falloff));
  }
}

uint32_t World::addJoint(const JointDesc& desc) {
  const uint32_t id = static_cast<uint32_t>(joints_.size());
  Joint j;
  j.id = id;
  j.desc = desc;
  detail::initJoint(j, bodies_);
  if (desc.disableCollision && desc.bodyA < bodies_.size() && desc.bodyB < bodies_.size()) {
    ignoreCollisionPair(desc.bodyA, desc.bodyB);
  }
  if (desc.bodyA < bodies_.size()) wakeBody(desc.bodyA);
  if (desc.bodyB < bodies_.size()) wakeBody(desc.bodyB);
  joints_.push_back(std::move(j));
  return id;
}

void World::setJointActive(uint32_t jointId, bool active) {
  if (jointId >= joints_.size()) return;
  joints_[jointId].active = active;
  if (active) joints_[jointId].broken = false;
  if (joints_[jointId].desc.bodyA < bodies_.size()) wakeBody(joints_[jointId].desc.bodyA);
  if (joints_[jointId].desc.bodyB < bodies_.size()) wakeBody(joints_[jointId].desc.bodyB);
}

void World::setJointMotor(uint32_t jointId, const JointMotor& motor, bool linear) {
  if (jointId >= joints_.size()) return;
  if (linear) joints_[jointId].desc.linearMotor = motor;
  else joints_[jointId].desc.angularMotor = motor;
  if (joints_[jointId].desc.bodyA < bodies_.size()) wakeBody(joints_[jointId].desc.bodyA);
  if (joints_[jointId].desc.bodyB < bodies_.size()) wakeBody(joints_[jointId].desc.bodyB);
}

void World::setGrabTarget(uint32_t jointId, Vec3 worldTarget) {
  if (jointId >= joints_.size()) return;
  joints_[jointId].desc.localAnchorB = worldTarget;
  if (joints_[jointId].desc.bodyA < bodies_.size()) wakeBody(joints_[jointId].desc.bodyA);
}

void World::ignoreCollisionPair(uint32_t a, uint32_t b) {
  if (a == b) return;
  ignoredPairs_.insert(pairKey(a, b));
}

void World::allowCollisionPair(uint32_t a, uint32_t b) {
  ignoredPairs_.erase(pairKey(a, b));
}

bool World::isCollisionIgnored(uint32_t a, uint32_t b) const {
  return a == b || ignoredPairs_.count(pairKey(a, b)) > 0;
}

void World::syncBvhProxy(uint32_t bodyId, Vec3 displacement) {
  Body& b = bodies_[bodyId];
  b.worldBounds = b.shape.empty() ? Box{b.pose.pos, b.pose.pos} : b.shape.worldBounds(b.pose);
  bvh_.update(b.bvhProxy, b.worldBounds, displacement);
}

void World::detectContacts() {
  manifolds_.clear();

  // 1. Floor plane contacts (LDraw: +Y is down, so floor plane up normal is (0, -1, 0),
  //    planePosOnUp = dot((0, floorY, 0), (0, -1, 0)) = -floorY).
  std::vector<uint32_t> candA, candB;
  if (config_.floorEnabled) {
    const Vec3 up{0.0, -1.0, 0.0};
    const double planeOnUp = -config_.floorY;
    for (uint32_t i = 0; i < bodies_.size(); i++) {
      const Body& b = bodies_[i];
      if (!b.isDynamic() || b.sleeping || b.shape.empty()) continue;
      if (b.worldBounds.max.y < config_.floorY - 0.002) continue;

      // Cull sub-shapes against the floor slab in local body space (O(log N) on large compounds!).
      Box floorWorld = b.worldBounds;
      floorWorld.min.y = config_.floorY - 0.002;
      floorWorld.max.y = std::max(floorWorld.max.y + 0.002, config_.floorY + 0.002);
      const Pose invB = b.pose.inverse();
      const Box floorLocal = floorWorld.transformed({invB.rot.toMat3(), invB.pos});
      b.shape.queryLocal(floorLocal, candA);

      for (uint32_t si : candA) {
        const SubShape& sub = b.shape.parts[si];
        const Pose subPose = b.pose * sub.localPose;
        const Box sb = sub.shape.worldBounds(subPose);
        if (sb.max.y < config_.floorY - 0.001) continue;

        ContactManifold m;
        if (collideConvexPlane(sub.shape, subPose, up, planeOnUp, m)) {
          m.bodyA = i;
          m.bodyB = ContactManifold::kFloorBody;
          m.subA = si;
          m.subB = 0;
          m.friction = combineFriction(b.material.staticFriction, config_.floorMaterial.staticFriction);
          m.restitution = combineRestitution(b.material.restitution, config_.floorMaterial.restitution);
          m.rollingResistance = std::max(b.material.rollingResistance, config_.floorMaterial.rollingResistance);
          m.spinFriction = std::max(b.material.spinFriction, config_.floorMaterial.spinFriction);
          orthonormalBasis(m.normal, m.tangent1, m.tangent2);
          for (uint32_t pi = 0; pi < m.pointCount; pi++) {
            const Vec3 pOnA = subPose.toWorld(m.points[pi].localA);
            m.points[pi].localA = b.pose.toLocal(pOnA);
          }
          manifolds_.push_back(m);
        }
      }
    }
  }

  // 2. Body-vs-body broadphase + local-BVH compound narrowphase.
  std::vector<std::pair<uint32_t, uint32_t>> pairs;
  bvh_.overlappingPairs(pairs);

  struct CachedSub {
    uint32_t idx;
    Pose pose;
    Box box;
  };
  std::vector<CachedSub> subsA, subsB;

  for (const auto& [idA, idB] : pairs) {
    if (isCollisionIgnored(idA, idB)) continue;
    const Body& a = bodies_[idA];
    const Body& b = bodies_[idB];
    if (!a.isDynamic() && !b.isDynamic()) continue;
    if ((a.sleeping || !a.isDynamic()) && (b.sleeping || !b.isDynamic())) continue;
    if (a.shape.empty() || b.shape.empty()) continue;

    // Intersect outer world AABBs first; only query sub-shapes inside the overlap volume!
    const Box overlapW{
        {std::max(a.worldBounds.min.x, b.worldBounds.min.x) - 2e-4,
         std::max(a.worldBounds.min.y, b.worldBounds.min.y) - 2e-4,
         std::max(a.worldBounds.min.z, b.worldBounds.min.z) - 2e-4},
        {std::min(a.worldBounds.max.x, b.worldBounds.max.x) + 2e-4,
         std::min(a.worldBounds.max.y, b.worldBounds.max.y) + 2e-4,
         std::min(a.worldBounds.max.z, b.worldBounds.max.z) + 2e-4},
    };
    if (overlapW.empty()) continue;

    const Pose invA = a.pose.inverse();
    const Pose invB = b.pose.inverse();
    a.shape.queryLocal(overlapW.transformed({invA.rot.toMat3(), invA.pos}), candA);
    if (candA.empty()) continue;
    b.shape.queryLocal(overlapW.transformed({invB.rot.toMat3(), invB.pos}), candB);
    if (candB.empty()) continue;

    // Precompute world poses and AABBs ONCE per surviving sub-shape!
    subsA.clear();
    subsA.reserve(candA.size());
    for (uint32_t si : candA) {
      const Pose p = a.pose * a.shape.parts[si].localPose;
      subsA.push_back({si, p, a.shape.parts[si].shape.worldBounds(p)});
    }
    subsB.clear();
    subsB.reserve(candB.size());
    for (uint32_t sj : candB) {
      const Pose p = b.pose * b.shape.parts[sj].localPose;
      subsB.push_back({sj, p, b.shape.parts[sj].shape.worldBounds(p)});
    }

    // For large compound-vs-compound pairs, build a tiny spatial sweep or use local BVH directly on B!
    // Limit manifolds per rigid-body pair to keep solver O(bodies) even on 1000-piece models.
    uint32_t pairManifolds = 0;
    constexpr uint32_t kMaxManifoldsPerPair = 12;
    const bool useBvhB = (subsA.size() * subsB.size() > 64 && b.shape.parts.size() > 8);
    std::vector<uint32_t> hitB;

    for (const auto& sa : subsA) {
      if (pairManifolds >= kMaxManifoldsPerPair) break;
      const SubShape& subA = a.shape.parts[sa.idx];
      if (useBvhB) {
        const Box qB = Box{sa.box.min - Vec3{2e-4, 2e-4, 2e-4}, sa.box.max + Vec3{2e-4, 2e-4, 2e-4}}
                           .transformed({invB.rot.toMat3(), invB.pos});
        b.shape.queryLocal(qB, hitB);
        for (uint32_t sj : hitB) {
          if (pairManifolds >= kMaxManifoldsPerPair) break;
          const SubShape& subB = b.shape.parts[sj];
          const Pose poseB = b.pose * subB.localPose;
          const Box boxB = subB.shape.worldBounds(poseB);
          if (sa.box.max.x < boxB.min.x - 1e-4 || sa.box.min.x > boxB.max.x + 1e-4 ||
              sa.box.max.y < boxB.min.y - 1e-4 || sa.box.min.y > boxB.max.y + 1e-4 ||
              sa.box.max.z < boxB.min.z - 1e-4 || sa.box.min.z > boxB.max.z + 1e-4) {
            continue;
          }
          ContactManifold m;
          if (collideConvex(subA.shape, sa.pose, subB.shape, poseB, m)) {
            m.bodyA = idA; m.bodyB = idB; m.subA = sa.idx; m.subB = sj;
            m.friction = combineFriction(a.material.staticFriction, b.material.staticFriction);
            m.restitution = combineRestitution(a.material.restitution, b.material.restitution);
            m.rollingResistance = std::max(a.material.rollingResistance, b.material.rollingResistance);
            m.spinFriction = std::max(a.material.spinFriction, b.material.spinFriction);
            orthonormalBasis(m.normal, m.tangent1, m.tangent2);
            for (uint32_t pi = 0; pi < m.pointCount; pi++) {
              const Vec3 pA = sa.pose.toWorld(m.points[pi].localA);
              const Vec3 pB = poseB.toWorld(m.points[pi].localB);
              m.points[pi].localA = a.pose.toLocal(pA);
              m.points[pi].localB = b.pose.toLocal(pB);
            }
            manifolds_.push_back(m);
            pairManifolds++;
          }
        }
      } else {
        for (const auto& sb : subsB) {
          if (pairManifolds >= kMaxManifoldsPerPair) break;
          if (sa.box.max.x < sb.box.min.x - 1e-4 || sa.box.min.x > sb.box.max.x + 1e-4 ||
              sa.box.max.y < sb.box.min.y - 1e-4 || sa.box.min.y > sb.box.max.y + 1e-4 ||
              sa.box.max.z < sb.box.min.z - 1e-4 || sa.box.min.z > sb.box.max.z + 1e-4) {
            continue;
          }
          const SubShape& subB = b.shape.parts[sb.idx];
          ContactManifold m;
          if (collideConvex(subA.shape, sa.pose, subB.shape, sb.pose, m)) {
            m.bodyA = idA; m.bodyB = idB; m.subA = sa.idx; m.subB = sb.idx;
            m.friction = combineFriction(a.material.staticFriction, b.material.staticFriction);
            m.restitution = combineRestitution(a.material.restitution, b.material.restitution);
            m.rollingResistance = std::max(a.material.rollingResistance, b.material.rollingResistance);
            m.spinFriction = std::max(a.material.spinFriction, b.material.spinFriction);
            orthonormalBasis(m.normal, m.tangent1, m.tangent2);
            for (uint32_t pi = 0; pi < m.pointCount; pi++) {
              const Vec3 pA = sa.pose.toWorld(m.points[pi].localA);
              const Vec3 pB = sb.pose.toWorld(m.points[pi].localB);
              m.points[pi].localA = a.pose.toLocal(pA);
              m.points[pi].localB = b.pose.toLocal(pB);
            }
            manifolds_.push_back(m);
            pairManifolds++;
          }
        }
      }
    }
  }

  // Sort manifolds bottom-up (floor contacts first, then descending Y in LDraw where +Y is down)
  // for optimal gravitational weight propagation in tall brick stacks.
  std::sort(manifolds_.begin(), manifolds_.end(), [&](const ContactManifold& a, const ContactManifold& b) {
    const bool aFloor = (a.bodyB == ContactManifold::kFloorBody);
    const bool bFloor = (b.bodyB == ContactManifold::kFloorBody);
    if (aFloor != bFloor) return aFloor;
    const double yA = a.pointCount > 0 ? a.points[0].worldPoint.y : 0.0;
    const double yB = b.pointCount > 0 ? b.points[0].worldPoint.y : 0.0;
    if (std::abs(yA - yB) > 1e-5) return yA > yB;
    if (a.bodyA != b.bodyA) return a.bodyA < b.bodyA;
    return a.bodyB < b.bodyB;
  });

  // Restore warm-started impulses from persistent contact cache.
  contactCache_.restore(manifolds_);
}

void World::applyGyroscopicStep(Body& b, double h) {
  // Symplectic Implicit Midpoint Newton solver for Euler's rigid-body rotational equations:
  //   f(w1) = I*(w1 - w0) + h * (wm x (I*wm)) = 0,  where wm = 0.5*(w0 + w1)
  //   J     = I + (h/2) * ([wm]_x * I - [I*wm]_x)
  // Preserves both angular momentum |L| and rotational kinetic energy to O(h^2)!
  const Vec3 wL0 = b.pose.rot.invRotate(b.omega);
  const Vec3 Iw0 = b.localInertia * wL0;
  if (dot(cross(wL0, Iw0), cross(wL0, Iw0)) <= 1e-32) return;

  const Mat3 I = b.localInertia.toMat3();
  Vec3 wL1 = wL0;
  for (int it = 0; it < 3; it++) {
    const Vec3 wm = (wL0 + wL1) * 0.5;
    const Vec3 Iwm = b.localInertia * wm;
    const Vec3 f = b.localInertia * (wL1 - wL0) + cross(wm, Iwm) * h;
    if (dot(f, f) <= 1e-32) break;
    const Mat3 J = I + (skew(wm) * I - skew(Iwm)) * (0.5 * h);
    const Vec3 dw = bm::inverse(J) * f;
    wL1 = wL1 - dw;
  }
  if (std::isfinite(wL1.x) && std::isfinite(wL1.y) && std::isfinite(wL1.z)) {
    b.omega = b.pose.rot.rotate(wL1);
  }
}

void World::integrateVelocities(double h) {
  for (auto& b : bodies_) {
    if (!b.isDynamic() || b.sleeping) continue;
    b.vel = b.vel + (config_.gravity * b.gravityScale + b.force * b.invMass) * h;
    b.omega = b.omega + (b.worldInvInertia * b.torque) * h;
    if (config_.enableGyroscopic) {
      applyGyroscopicStep(b, h);
    }
    // Exponential damping (unconditionally stable for any damping rate).
    if (b.linearDamping > 0.0) b.vel = b.vel * (1.0 / (1.0 + b.linearDamping * h));
    if (b.angularDamping > 0.0) b.omega = b.omega * (1.0 / (1.0 + b.angularDamping * h));
  }
}

void World::solveVelocityConstraints(double h) {
  // Precompute contact effective masses & restitution targets + warm-start.
  struct PreparedPoint {
    Vec3 rA, rB;
    double normalMass = 0.0;
    double tangMass11 = 0.0, tangMass12 = 0.0, tangMass22 = 0.0;
    double twistMass = 0.0;
    double velocityBias = 0.0;
    double approachSpeed = 0.0;
  };
  struct PreparedManifold {
    PreparedPoint pts[ContactManifold::kMaxPoints]{};
    double delassus[ContactManifold::kMaxPoints][ContactManifold::kMaxPoints]{};
    double diagReg = 0.0;
  };
  std::vector<PreparedManifold> prep(manifolds_.size());

  // Solve symmetric positive-definite N x N system (N <= 4) via Cholesky factorization.
  auto solveCholesky4 = [](const double A[4][4], double reg, const double b[4], double x[4], uint32_t n) -> bool {
    double L[4][4] = {};
    for (uint32_t i = 0; i < n; i++) {
      for (uint32_t j = 0; j <= i; j++) {
        double sum = A[i][j] + (i == j ? reg : 0.0);
        for (uint32_t k = 0; k < j; k++) sum -= L[i][k] * L[j][k];
        if (i == j) {
          if (sum <= 1e-18) return false;
          L[i][j] = std::sqrt(sum);
        } else {
          L[i][j] = sum / L[j][j];
        }
      }
    }
    double y[4] = {};
    for (uint32_t i = 0; i < n; i++) {
      double sum = b[i];
      for (uint32_t k = 0; k < i; k++) sum -= L[i][k] * y[k];
      y[i] = sum / L[i][i];
    }
    for (uint32_t i = n; i-- > 0;) {
      double sum = y[i];
      for (uint32_t k = i + 1; k < n; k++) sum -= L[k][i] * x[k];
      x[i] = sum / L[i][i];
    }
    return true;
  };

  const double warm = config_.warmStartFactor;
  for (size_t mi = 0; mi < manifolds_.size(); mi++) {
    ContactManifold& m = manifolds_[mi];
    Body& a = bodies_[m.bodyA];
    Body* b = m.bodyB < bodies_.size() ? &bodies_[m.bodyB] : nullptr;
    const double invMA = a.isDynamic() ? a.invMass : 0.0;
    const double invMB = (b && b->isDynamic()) ? b->invMass : 0.0;
    const SymMat3 invIA = a.isDynamic() ? a.worldInvInertia : SymMat3::zero();
    const SymMat3 invIB = (b && b->isDynamic()) ? b->worldInvInertia : SymMat3::zero();

    Vec3 rnA[ContactManifold::kMaxPoints]{}, rnB[ContactManifold::kMaxPoints]{};
    double diagSum = 0.0;
    for (uint32_t pi = 0; pi < m.pointCount; pi++) {
      ContactPoint& cp = m.points[pi];
      PreparedPoint& pp = prep[mi].pts[pi];
      pp.rA = a.pose.dirToWorld(cp.localA);
      pp.rB = b ? b->pose.dirToWorld(cp.localB) : Vec3{};

      rnA[pi] = cross(pp.rA, m.normal);
      rnB[pi] = cross(pp.rB, m.normal);
      const double kn = invMA + invMB + dot(rnA[pi], invIA * rnA[pi]) + dot(rnB[pi], invIB * rnB[pi]);
      pp.normalMass = kn > 1e-18 ? 1.0 / kn : 0.0;
      diagSum += kn;

      // Coupled 2x2 tangent inverse-mass matrix.
      const Vec3 rt1A = cross(pp.rA, m.tangent1), rt1B = cross(pp.rB, m.tangent1);
      const Vec3 rt2A = cross(pp.rA, m.tangent2), rt2B = cross(pp.rB, m.tangent2);
      pp.tangMass11 = invMA + invMB + dot(rt1A, invIA * rt1A) + dot(rt1B, invIB * rt1B);
      pp.tangMass22 = invMA + invMB + dot(rt2A, invIA * rt2A) + dot(rt2B, invIB * rt2B);
      pp.tangMass12 = dot(rt1A, invIA * rt2A) + dot(rt1B, invIB * rt2B);

      const double kTwist = dot(m.normal, invIA * m.normal) + dot(m.normal, invIB * m.normal);
      pp.twistMass = kTwist > 1e-18 ? 1.0 / kTwist : 0.0;

      // Relative velocity along normal (B relative to A): negative means approaching!
      const Vec3 vA = a.velocityAtOffset(pp.rA);
      const Vec3 vB = b ? b->velocityAtOffset(pp.rB) : Vec3{};
      const double vn = dot(vB - vA, m.normal);
      pp.approachSpeed = -vn;

      double bias = 0.0;
      if (pp.approachSpeed > config_.restitutionThreshold) {
        bias = m.restitution * pp.approachSpeed;
      }
      // Mild Baumgarte only for deeper penetrations (split with NGS position solver).
      const double deepPen = std::max(0.0, cp.penetration - config_.contactSlop * 2.0);
      if (deepPen > 0.0 && config_.baumgarteContact > 0.0) {
        bias = std::max(bias, (config_.baumgarteContact / h) * deepPen);
      }
      pp.velocityBias = bias;
    }
    // Precompute symmetric N x N Delassus matrix for simultaneous block normal solving.
    if (m.pointCount >= 2) {
      for (uint32_t i = 0; i < m.pointCount; i++) {
        for (uint32_t j = i; j < m.pointCount; j++) {
          const double aij = invMA + invMB + dot(rnA[i], invIA * rnA[j]) + dot(rnB[i], invIB * rnB[j]);
          prep[mi].delassus[i][j] = prep[mi].delassus[j][i] = aij;
        }
      }
      // Tiny Tikhonov regularization resolves the 1D null space of 4 coplanar points with equal-load symmetry!
      prep[mi].diagReg = std::max(1e-12, (diagSum / m.pointCount) * 1e-5);
    }
  }

  // Pass 2: Apply warm-start contact impulses ONLY AFTER all approachSpeed / velocityBias terms are computed!
  for (size_t mi = 0; mi < manifolds_.size(); mi++) {
    ContactManifold& m = manifolds_[mi];
    Body& a = bodies_[m.bodyA];
    Body* b = m.bodyB < bodies_.size() ? &bodies_[m.bodyB] : nullptr;
    const double invMA = a.isDynamic() ? a.invMass : 0.0;
    const double invMB = (b && b->isDynamic()) ? b->invMass : 0.0;
    const SymMat3 invIA = a.isDynamic() ? a.worldInvInertia : SymMat3::zero();
    const SymMat3 invIB = (b && b->isDynamic()) ? b->worldInvInertia : SymMat3::zero();
    for (uint32_t pi = 0; pi < m.pointCount; pi++) {
      ContactPoint& cp = m.points[pi];
      const PreparedPoint& pp = prep[mi].pts[pi];
      cp.normalImpulse *= warm;
      cp.tangentImpulse1 *= warm;
      cp.tangentImpulse2 *= warm;
      cp.twistImpulse *= warm;
      const Vec3 pImp = m.normal * cp.normalImpulse + m.tangent1 * cp.tangentImpulse1 + m.tangent2 * cp.tangentImpulse2;
      if (invMA > 0.0) {
        a.vel = a.vel - pImp * invMA;
        a.omega = a.omega - invIA * (cross(pp.rA, pImp) + m.normal * cp.twistImpulse);
      }
      if (invMB > 0.0) {
        b->vel = b->vel + pImp * invMB;
        b->omega = b->omega + invIB * (cross(pp.rB, pImp) + m.normal * cp.twistImpulse);
      }
    }
  }

  // Prepare & warm-start all active joints.
  for (auto& j : joints_) {
    detail::prepareJointVelocity(j, bodies_, h, warm);
  }

  // Projected Gauss-Seidel (PGS) velocity iterations.
  for (int iter = 0; iter < config_.velocityIterations; iter++) {
    // 1. Solve joints (reverse order on odd iterations for symmetric convergence!).
    if ((iter & 1) == 0) {
      for (auto& j : joints_) detail::solveJointVelocity(j, bodies_, h);
    } else {
      for (size_t i = joints_.size(); i-- > 0;) detail::solveJointVelocity(joints_[i], bodies_, h);
    }

    // 2. Solve contacts (circular Coulomb friction cone + normal + spin + rolling resistance).
    // Alternate forward/reverse manifold and point sweep order on even/odd iterations for symmetric flat stacking!
    const bool revSweep = (iter & 1) != 0;
    const size_t nMan = manifolds_.size();
    for (size_t idx = 0; idx < nMan; idx++) {
      const size_t mi = revSweep ? (nMan - 1 - idx) : idx;
      ContactManifold& m = manifolds_[mi];
      Body& a = bodies_[m.bodyA];
      Body* b = m.bodyB < bodies_.size() ? &bodies_[m.bodyB] : nullptr;
      const double invMA = a.isDynamic() ? a.invMass : 0.0;
      const double invMB = (b && b->isDynamic()) ? b->invMass : 0.0;
      const SymMat3 invIA = a.isDynamic() ? a.worldInvInertia : SymMat3::zero();
      const SymMat3 invIB = (b && b->isDynamic()) ? b->worldInvInertia : SymMat3::zero();

      // Simultaneous N x N Delassus block normal solve (exact equal-load flat stacking!).
      bool blockSolved = false;
      if (m.pointCount >= 2) {
        double rhs[4] = {};
        double x[4] = {};
        for (uint32_t i = 0; i < m.pointCount; i++) {
          const PreparedPoint& pp = prep[mi].pts[i];
          const Vec3 vA = a.velocityAtOffset(pp.rA);
          const Vec3 vB = b ? b->velocityAtOffset(pp.rB) : Vec3{};
          const double vn = dot(vB - vA, m.normal);
          double ax = 0.0;
          for (uint32_t j = 0; j < m.pointCount; j++) ax += prep[mi].delassus[i][j] * m.points[j].normalImpulse;
          rhs[i] = pp.velocityBias - vn + ax;
        }
        if (solveCholesky4(prep[mi].delassus, prep[mi].diagReg, rhs, x, m.pointCount)) {
          bool allNonNeg = true;
          for (uint32_t i = 0; i < m.pointCount; i++)
            if (x[i] < 0.0 || !std::isfinite(x[i])) allNonNeg = false;
          if (allNonNeg) {
            for (uint32_t i = 0; i < m.pointCount; i++) {
              const double apply = x[i] - m.points[i].normalImpulse;
              m.points[i].normalImpulse = x[i];
              const Vec3 imp = m.normal * apply;
              if (invMA > 0.0) {
                a.vel = a.vel - imp * invMA;
                a.omega = a.omega - invIA * cross(prep[mi].pts[i].rA, imp);
              }
              if (invMB > 0.0) {
                b->vel = b->vel + imp * invMB;
                b->omega = b->omega + invIB * cross(prep[mi].pts[i].rB, imp);
              }
            }
            blockSolved = true;
          }
        }
      }

      for (uint32_t pIdx = 0; pIdx < m.pointCount; pIdx++) {
        const uint32_t pi = revSweep ? (m.pointCount - 1 - pIdx) : pIdx;
        ContactPoint& cp = m.points[pi];
        const PreparedPoint& pp = prep[mi].pts[pi];

        // Normal impulse fallback when single-point or partial lifting (active-set inequality).
        if (!blockSolved) {
          const Vec3 vA = a.velocityAtOffset(pp.rA);
          const Vec3 vB = b ? b->velocityAtOffset(pp.rB) : Vec3{};
          const double vn = dot(vB - vA, m.normal);
          const double dLam = (pp.velocityBias - vn) * pp.normalMass;
          const double old = cp.normalImpulse;
          cp.normalImpulse = std::max(0.0, old + dLam);
          const double apply = cp.normalImpulse - old;
          const Vec3 imp = m.normal * apply;
          if (invMA > 0.0) {
            a.vel = a.vel - imp * invMA;
            a.omega = a.omega - invIA * cross(pp.rA, imp);
          }
          if (invMB > 0.0) {
            b->vel = b->vel + imp * invMB;
            b->omega = b->omega + invIB * cross(pp.rB, imp);
          }
        }

        // Coupled 2D isotropic Coulomb friction cone projection.
        if (cp.normalImpulse > 0.0 && m.friction > 0.0) {
          const Vec3 vA = a.velocityAtOffset(pp.rA);
          const Vec3 vB = b ? b->velocityAtOffset(pp.rB) : Vec3{};
          const Vec3 rv = vB - vA;
          const double vt1 = dot(rv, m.tangent1);
          const double vt2 = dot(rv, m.tangent2);
          double d1 = 0.0, d2 = 0.0;
          solveSym2(pp.tangMass11, pp.tangMass12, pp.tangMass22, -vt1, -vt2, d1, d2);

          const double old1 = cp.tangentImpulse1;
          const double old2 = cp.tangentImpulse2;
          double next1 = old1 + d1;
          double next2 = old2 + d2;
          const double maxF = m.friction * cp.normalImpulse;
          const double mag = std::hypot(next1, next2);
          if (mag > maxF && mag > 1e-18) {
            // Kinetic friction drop when sliding past static cone.
            const double kinScale = 0.85 * maxF / mag;
            next1 *= kinScale;
            next2 *= kinScale;
          }
          const double app1 = next1 - old1;
          const double app2 = next2 - old2;
          cp.tangentImpulse1 = next1;
          cp.tangentImpulse2 = next2;
          const Vec3 imp = m.tangent1 * app1 + m.tangent2 * app2;
          if (invMA > 0.0) {
            a.vel = a.vel - imp * invMA;
            a.omega = a.omega - invIA * cross(pp.rA, imp);
          }
          if (invMB > 0.0) {
            b->vel = b->vel + imp * invMB;
            b->omega = b->omega + invIB * cross(pp.rB, imp);
          }

          // Torsional patch (spin) friction about contact normal.
          if (m.spinFriction > 0.0 && pp.twistMass > 0.0) {
            const double relWn = dot((b ? b->omega : Vec3{}) - a.omega, m.normal);
            const double maxTwist = m.friction * m.spinFriction * cp.normalImpulse;
            const double oldTw = cp.twistImpulse;
            cp.twistImpulse = std::clamp(oldTw - relWn * pp.twistMass, -maxTwist, maxTwist);
            const double appTw = cp.twistImpulse - oldTw;
            if (invMA > 0.0) a.omega = a.omega - invIA * (m.normal * appTw);
            if (invMB > 0.0) b->omega = b->omega + invIB * (m.normal * appTw);
          }

          // Rolling resistance opposing tangential relative angular velocity (for tyres/cylinders/spheres).
          if (m.rollingResistance > 0.0) {
            const Vec3 relW = (b ? b->omega : Vec3{}) - a.omega;
            const Vec3 relWT = relW - m.normal * dot(relW, m.normal);
            const double wtLen = length(relWT);
            if (wtLen > 1e-5) {
              const Vec3 rollDir = relWT * (1.0 / wtLen);
              const double kRoll = dot(rollDir, invIA * rollDir) + dot(rollDir, invIB * rollDir);
              if (kRoll > 1e-18) {
                const double rArm = std::max(0.002, length(pp.rA));
                const double maxRollImp = m.rollingResistance * rArm * cp.normalImpulse;
                const double rollImp = std::min(wtLen / kRoll, maxRollImp);
                if (invMA > 0.0) a.omega = a.omega + invIA * (rollDir * rollImp);
                if (invMB > 0.0) b->omega = b->omega - invIB * (rollDir * rollImp);
              }
            }
          }
        }
      }
    }
  }

  // Save solved impulses to contact cache and emit significant impact events.
  contactCache_.save(manifolds_);
  for (size_t mi = 0; mi < manifolds_.size(); mi++) {
    const ContactManifold& m = manifolds_[mi];
    double totalNormalImp = 0.0;
    double maxApproach = 0.0;
    Vec3 avgPoint{};
    for (uint32_t pi = 0; pi < m.pointCount; pi++) {
      totalNormalImp += m.points[pi].normalImpulse;
      maxApproach = std::max(maxApproach, prep[mi].pts[pi].approachSpeed);
      avgPoint = avgPoint + m.points[pi].worldPoint;
    }
    if (m.pointCount > 0 && totalNormalImp >= config_.impactEventThreshold &&
        maxApproach > config_.restitutionThreshold * 0.5) {
      impacts_.push_back({time_, m.bodyA, m.bodyB, avgPoint * (1.0 / m.pointCount),
                          m.normal, totalNormalImp, maxApproach});
    }
  }
}

void World::integratePositions(double h) {
  prevPoses_.resize(bodies_.size());
  for (uint32_t i = 0; i < bodies_.size(); i++) {
    Body& b = bodies_[i];
    prevPoses_[i] = b.pose;
    if (b.isStatic() || (b.isDynamic() && b.sleeping)) continue;
    const Vec3 disp = b.vel * h;
    b.pose.pos = b.pose.pos + disp;
    if (dot(b.omega, b.omega) > 1e-24) {
      b.pose.rot = integrateQuat(b.pose.rot, b.omega, h);
    }
    b.updateWorldInertia();
    syncBvhProxy(i, disp);
  }
}

void World::applyCcdGuard(double h) {
  if (!config_.enableCcd) return;
  // Conservative-advancement anti-tunneling guard:
  // If a fast body moved farther than 50% of its minimum thickness in one substep,
  // check floor plane crossing & swept AABB against static/slow bodies and clamp to TOI.
  for (uint32_t i = 0; i < bodies_.size(); i++) {
    Body& b = bodies_[i];
    if (!b.isDynamic() || b.sleeping || !b.enableCcd || b.shape.empty()) continue;
    const Vec3 disp = b.pose.pos - prevPoses_[i].pos;
    const double moveDist = length(disp);
    const double thresh = 0.5 * b.shape.minExtent();
    if (moveDist <= thresh) continue;

    // 1. Floor CCD: exact bisection if lowest point crossed below floorY.
    if (config_.floorEnabled && b.worldBounds.max.y > config_.floorY + thresh) {
      const Box prevBox = b.shape.worldBounds(prevPoses_[i]);
      if (prevBox.max.y <= config_.floorY + 1e-4) {
        double lo = 0.0, hi = 1.0;
        for (int it = 0; it < 12; it++) {
          const double mid = 0.5 * (lo + hi);
          const Pose testPose{prevPoses_[i].pos + disp * mid, integrateQuat(prevPoses_[i].rot, b.omega, h * mid)};
          if (b.shape.worldBounds(testPose).max.y > config_.floorY) hi = mid;
          else lo = mid;
        }
        b.pose.pos = prevPoses_[i].pos + disp * lo;
        b.pose.rot = integrateQuat(prevPoses_[i].rot, b.omega, h * lo);
        if (b.vel.y > 0.0) b.vel.y = -b.vel.y * combineRestitution(b.material.restitution, config_.floorMaterial.restitution);
        b.updateWorldInertia();
        syncBvhProxy(i, {});
        continue;
      }
    }

    // 2. Swept-box vs other bodies CCD (catches fast projectiles / thin tiles hitting walls).
    Box swept = b.shape.worldBounds(prevPoses_[i]);
    swept.merge(b.worldBounds);
    std::vector<uint32_t> candidates;
    bvh_.query(swept, candidates);
    double earliestToi = 1.0;
    Vec3 hitNormal{};
    bool hitOther = false;
    for (uint32_t otherId : candidates) {
      if (isCollisionIgnored(i, otherId)) continue;
      const Body& other = bodies_[otherId];
      if (other.shape.empty()) continue;
      // Only clamp against static or much slower bodies.
      if (other.isDynamic() && length(other.vel) > 0.5 * moveDist / std::max(h, 1e-9)) continue;

      // Binary-search TOI along [0, earliestToi], culling sub-shapes via local BVH!
      ContactManifold testM;
      std::vector<uint32_t> ccdCandA, ccdCandB;
      const Pose invOther = other.pose.inverse();
      auto hitsAt = [&](double t, Vec3& outN) -> bool {
        const Pose pA{prevPoses_[i].pos + disp * t, integrateQuat(prevPoses_[i].rot, b.omega, h * t)};
        const Box bA = b.shape.worldBounds(pA);
        const Box ov{
            {std::max(bA.min.x, other.worldBounds.min.x), std::max(bA.min.y, other.worldBounds.min.y), std::max(bA.min.z, other.worldBounds.min.z)},
            {std::min(bA.max.x, other.worldBounds.max.x), std::min(bA.max.y, other.worldBounds.max.y), std::min(bA.max.z, other.worldBounds.max.z)},
        };
        if (ov.empty()) return false;
        const Pose invA = pA.inverse();
        b.shape.queryLocal(ov.transformed({invA.rot.toMat3(), invA.pos}), ccdCandA);
        if (ccdCandA.empty()) return false;
        other.shape.queryLocal(ov.transformed({invOther.rot.toMat3(), invOther.pos}), ccdCandB);
        if (ccdCandB.empty()) return false;
        for (uint32_t si : ccdCandA) {
          const auto& sA = b.shape.parts[si];
          const Pose spA = pA * sA.localPose;
          const Box sbA = sA.shape.worldBounds(spA);
          for (uint32_t sj : ccdCandB) {
            const auto& sB = other.shape.parts[sj];
            const Pose spB = other.pose * sB.localPose;
            const Box sbB = sB.shape.worldBounds(spB);
            if (sbA.max.x < sbB.min.x || sbA.min.x > sbB.max.x ||
                sbA.max.y < sbB.min.y || sbA.min.y > sbB.max.y ||
                sbA.max.z < sbB.min.z || sbA.min.z > sbB.max.z) {
              continue;
            }
            if (collideConvex(sA.shape, spA, sB.shape, spB, testM)) {
              outN = testM.normal;
              return true;
            }
          }
        }
        return false;
      };

      Vec3 nCheck{};
      if (hitsAt(0.0, nCheck)) continue;  // Already overlapping at start of substep.
      if (!hitsAt(earliestToi, nCheck)) continue;
      double lo = 0.0, hi = earliestToi;
      for (int it = 0; it < 10; it++) {
        const double mid = 0.5 * (lo + hi);
        if (hitsAt(mid, nCheck)) hi = mid;
        else lo = mid;
      }
      if (lo < earliestToi) {
        earliestToi = lo;
        hitNormal = nCheck;
        hitOther = true;
      }
    }
    if (hitOther) {
      b.pose.pos = prevPoses_[i].pos + disp * earliestToi;
      b.pose.rot = integrateQuat(prevPoses_[i].rot, b.omega, h * earliestToi);
      const double vn = dot(b.vel, hitNormal);
      if (vn > 0.0) b.vel = b.vel - hitNormal * vn;
      b.updateWorldInertia();
      syncBvhProxy(i, {});
    }
  }
}

void World::solvePositionConstraints(double /*h*/) {
  for (int iter = 0; iter < config_.positionIterations; iter++) {
    // 1. Bilateral joint closure (NGS).
    for (auto& j : joints_) {
      detail::solveJointPosition(j, bodies_, config_.maxPositionCorrection);
    }

    // 2. Contact penetration resolution (NGS — zero velocity injection!).
    // Evaluate all contact points of each manifold simultaneously (Jacobi within manifold) so flat
    // 4-corner brick stacks produce exact zero spurious rotational tilt!
    const bool revMan = (iter & 1) != 0;
    const size_t nMan = manifolds_.size();
    for (size_t idx = 0; idx < nMan; idx++) {
      const size_t mi = revMan ? (nMan - 1 - idx) : idx;
      const ContactManifold& m = manifolds_[mi];
      Body& a = bodies_[m.bodyA];
      Body* b = m.bodyB < bodies_.size() ? &bodies_[m.bodyB] : nullptr;
      const double invMA = a.isDynamic() ? a.invMass : 0.0;
      const double invMB = (b && b->isDynamic()) ? b->invMass : 0.0;
      if (invMA == 0.0 && invMB == 0.0) continue;

      const SymMat3 invIA = a.isDynamic() ? a.worldInvInertia : SymMat3::zero();
      const SymMat3 invIB = (b && b->isDynamic()) ? b->worldInvInertia : SymMat3::zero();

      Vec3 sumDpA{}, sumDThetaA{}, sumDpB{}, sumDThetaB{};
      int activePts = 0;
      for (uint32_t pi = 0; pi < m.pointCount; pi++) {
        const ContactPoint& cp = m.points[pi];
        const Vec3 pA = a.pose.toWorld(cp.localA);
        const Vec3 pB = b ? b->pose.toWorld(cp.localB) : cp.localB;
        const double pen = -dot(pB - pA, m.normal);
        if (pen <= config_.contactSlop) continue;

        const double corr = std::min((pen - config_.contactSlop) * 0.40, config_.maxPositionCorrection);
        const Vec3 rA = pA - a.pose.pos;
        const Vec3 rB = b ? (pB - b->pose.pos) : Vec3{};
        const Vec3 rnA = cross(rA, m.normal);
        const Vec3 rnB = cross(rB, m.normal);
        const double k = invMA + invMB + dot(rnA, invIA * rnA) + dot(rnB, invIB * rnB);
        if (k <= 1e-18) continue;

        const double lam = corr / k;
        const Vec3 imp = m.normal * lam;
        if (invMA > 0.0) {
          sumDpA = sumDpA - imp * invMA;
          sumDThetaA = sumDThetaA - (invIA * cross(rA, imp));
        }
        if (invMB > 0.0) {
          sumDpB = sumDpB + imp * invMB;
          sumDThetaB = sumDThetaB + (invIB * cross(rB, imp));
        }
        activePts++;
      }

      if (activePts > 0) {
        const double invN = 1.0 / static_cast<double>(activePts);
        if (invMA > 0.0) {
          a.pose.pos = a.pose.pos + sumDpA * invN;
          const Vec3 dThetaA = sumDThetaA * invN;
          if (dot(dThetaA, dThetaA) > 1e-24) a.pose.rot = (Quat::fromRotVec(dThetaA) * a.pose.rot).normalized();
          a.updateWorldInertia();
        }
        if (invMB > 0.0) {
          b->pose.pos = b->pose.pos + sumDpB * invN;
          const Vec3 dThetaB = sumDThetaB * invN;
          if (dot(dThetaB, dThetaB) > 1e-24) b->pose.rot = (Quat::fromRotVec(dThetaB) * b->pose.rot).normalized();
          b->updateWorldInertia();
        }
      }
    }
  }
}

void World::evaluateJointBreakage(double h, StepStats& stats) {
  for (auto& j : joints_) {
    if (!j.active || j.broken) continue;
    detail::updateJointTelemetry(j, bodies_, h);
    if (j.desc.strength.breakable && j.stressRatio >= 1.0) {
      j.broken = true;
      j.active = false;
      stats.brokenJointsThisStep++;
      if (j.desc.bodyA < bodies_.size() && j.desc.bodyB < bodies_.size()) {
        allowCollisionPair(j.desc.bodyA, j.desc.bodyB);
      }
      if (j.desc.bodyA < bodies_.size()) wakeBody(j.desc.bodyA);
      if (j.desc.bodyB < bodies_.size()) wakeBody(j.desc.bodyB);
      const Vec3 anchorW = j.desc.bodyA < bodies_.size()
                               ? bodies_[j.desc.bodyA].pose.toWorld(j.desc.localAnchorA)
                               : j.desc.localAnchorA;
      breaks_.push_back({time_, j.id, j.desc.connectionIndex, j.desc.bodyA, j.desc.bodyB,
                         anchorW, j.stressRatio, j.pullForce, j.shearForce, j.bendTorque});
    }
  }
}

void World::buildIslandsAndSleep(double dt) {
  const size_t n = bodies_.size();
  UnionFind uf(n);

  // Wake propagation + island connectivity over contacts and active joints.
  for (const auto& m : manifolds_) {
    if (m.bodyB >= n) continue;
    if (bodies_[m.bodyA].isDynamic() && bodies_[m.bodyB].isDynamic()) {
      uf.unite(m.bodyA, m.bodyB);
    }
  }
  for (const auto& j : joints_) {
    if (!j.active || j.broken) continue;
    if (j.desc.bodyA < n && j.desc.bodyB < n &&
        bodies_[j.desc.bodyA].isDynamic() && bodies_[j.desc.bodyB].isDynamic()) {
      uf.unite(j.desc.bodyA, j.desc.bodyB);
    }
    if (j.desc.kind == JointKind::Gear && j.desc.gear.carrierBody < n &&
        j.desc.bodyA < n && bodies_[j.desc.bodyA].isDynamic() && bodies_[j.desc.gear.carrierBody].isDynamic()) {
      uf.unite(j.desc.bodyA, j.desc.gear.carrierBody);
    }
  }

  // Group dynamic bodies by island root.
  std::unordered_map<uint32_t, std::vector<uint32_t>> islands;
  for (uint32_t i = 0; i < n; i++) {
    if (!bodies_[i].isDynamic()) {
      bodies_[i].islandId = UINT32_MAX;
      continue;
    }
    islands[uf.find(i)].push_back(i);
  }

  // Also check if any joint in an island has an active non-zero motor (prevents motorised islands from sleeping).
  std::unordered_set<uint32_t> motorizedRoots;
  for (const auto& j : joints_) {
    if (!j.active || j.broken) continue;
    const bool hasMotor = (j.desc.angularMotor.enabled && std::abs(j.desc.angularMotor.targetVelocity) > 1e-6) ||
                          (j.desc.linearMotor.enabled && std::abs(j.desc.linearMotor.targetVelocity) > 1e-6);
    if (!hasMotor) continue;
    if (j.desc.bodyA < n && bodies_[j.desc.bodyA].isDynamic()) motorizedRoots.insert(uf.find(j.desc.bodyA));
    if (j.desc.bodyB < n && bodies_[j.desc.bodyB].isDynamic()) motorizedRoots.insert(uf.find(j.desc.bodyB));
  }

  uint32_t islandCounter = 0;
  const double v2Thresh = config_.sleepLinearVel * config_.sleepLinearVel;
  const double w2Thresh = config_.sleepAngularVel * config_.sleepAngularVel;

  for (const auto& [root, members] : islands) {
    const uint32_t iid = islandCounter++;
    bool anyAwake = false;
    bool allAllowSleep = config_.enableSleeping && (motorizedRoots.count(root) == 0);
    double minSleepTime = std::numeric_limits<double>::infinity();

    for (uint32_t id : members) {
      Body& b = bodies_[id];
      b.islandId = iid;
      if (!b.sleeping) anyAwake = true;
      if (!b.allowSleep) allAllowSleep = false;
    }

    // If any body in the island is awake, wake the entire island (so collisions wake resting stacks!).
    if (anyAwake) {
      for (uint32_t id : members) {
        Body& b = bodies_[id];
        b.sleeping = false;
        const bool calm = dot(b.vel, b.vel) <= v2Thresh && dot(b.omega, b.omega) <= w2Thresh &&
                          dot(b.force, b.force) <= 1e-18 && dot(b.torque, b.torque) <= 1e-18;
        if (calm) b.sleepTimer += dt;
        else b.sleepTimer = 0.0;
        minSleepTime = std::min(minSleepTime, b.sleepTimer);
      }
      if (allAllowSleep && minSleepTime >= config_.sleepTimeRequired) {
        for (uint32_t id : members) {
          Body& b = bodies_[id];
          b.sleeping = true;
          b.vel = {};
          b.omega = {};
        }
      }
    }
  }
}

void World::substep(double h, StepStats& stats) {
  detectContacts();
  integrateVelocities(h);
  solveVelocityConstraints(h);
  integratePositions(h);
  applyCcdGuard(h);
  solvePositionConstraints(h);
  evaluateJointBreakage(h, stats);
  // Sync BVH boxes after position stabilization.
  for (uint32_t i = 0; i < bodies_.size(); i++) {
    if (bodies_[i].isDynamic() && !bodies_[i].sleeping) {
      syncBvhProxy(i, {});
    }
  }
  time_ += h;
}

StepStats World::step(double dt) {
  const auto t0 = std::chrono::steady_clock::now();
  StepStats stats;
  if (dt <= 0.0) return stats;

  const int sub = std::max(1, config_.substeps);
  const double h = dt / static_cast<double>(sub);

  for (int s = 0; s < sub; s++) {
    substep(h, stats);
  }

  buildIslandsAndSleep(dt);

  // Clear external force/torque accumulators after full step.
  for (auto& b : bodies_) {
    b.force = {};
    b.torque = {};
  }

  // Populate diagnostics.
  stats.simTime = time_;
  stats.totalBodies = static_cast<uint32_t>(bodies_.size());
  std::unordered_set<uint32_t> activeIslands;
  for (const auto& b : bodies_) {
    if (b.isDynamic()) {
      if (b.sleeping) stats.sleepingBodies++;
      else {
        stats.awakeBodies++;
        if (b.islandId != UINT32_MAX) activeIslands.insert(b.islandId);
      }
    }
  }
  stats.activeIslands = static_cast<uint32_t>(activeIslands.size());
  stats.contactManifolds = static_cast<uint32_t>(manifolds_.size());
  for (const auto& m : manifolds_) {
    stats.contactPoints += m.pointCount;
    for (uint32_t i = 0; i < m.pointCount; i++) {
      stats.maxPenetration = std::max(stats.maxPenetration, m.points[i].penetration);
    }
  }
  for (const auto& j : joints_) {
    if (j.active && !j.broken) stats.activeJoints++;
  }
  stats.kineticEnergy = kineticEnergy();
  stats.potentialEnergy = potentialEnergy();
  const auto t1 = std::chrono::steady_clock::now();
  stats.wallMs = std::chrono::duration<double, std::milli>(t1 - t0).count();
  return stats;
}

// ---- Queries & Conservation Diagnostics ----

std::optional<RaycastHit> World::raycast(Vec3 origin, Vec3 dir, double maxDistance) const {
  const double len = length(dir);
  if (len <= 1e-12 || maxDistance <= 0.0) return std::nullopt;
  const Vec3 unitDir = dir * (1.0 / len);

  std::vector<DynamicBvh::RayHitCandidate> candidates;
  bvh_.raycast(origin, unitDir, maxDistance, candidates);

  std::optional<RaycastHit> best;
  double bestT = maxDistance;
  for (const auto& c : candidates) {
    if (c.tEnter > bestT) break;
    const Body& b = bodies_[c.userId];
    for (uint32_t si = 0; si < b.shape.parts.size(); si++) {
      const SubShape& sub = b.shape.parts[si];
      const auto hit = raycastConvex(sub.shape, b.pose * sub.localPose, origin, unitDir, bestT);
      if (hit && hit->t < bestT) {
        bestT = hit->t;
        best = RaycastHit{c.userId, si, sub.pieceIndex, hit->t, hit->point, hit->normal};
      }
    }
  }
  return best;
}

std::vector<uint32_t> World::queryBox(const Box& worldBox) const {
  std::vector<uint32_t> ids;
  bvh_.query(worldBox, ids);
  std::sort(ids.begin(), ids.end());
  ids.erase(std::unique(ids.begin(), ids.end()), ids.end());
  return ids;
}

std::vector<uint32_t> World::querySphere(Vec3 center, double radius) const {
  const Vec3 r{radius, radius, radius};
  std::vector<uint32_t> broad = queryBox({center - r, center + r});
  std::vector<uint32_t> out;
  const double r2 = radius * radius;
  for (uint32_t id : broad) {
    const Box& b = bodies_[id].worldBounds;
    const Vec3 clamped{std::clamp(center.x, b.min.x, b.max.x),
                       std::clamp(center.y, b.min.y, b.max.y),
                       std::clamp(center.z, b.min.z, b.max.z)};
    const Vec3 d = center - clamped;
    if (dot(d, d) <= r2) out.push_back(id);
  }
  return out;
}

double World::kineticEnergy() const {
  double ke = 0.0;
  for (const auto& b : bodies_) ke += b.kineticEnergy();
  return ke;
}

double World::potentialEnergy() const {
  double pe = 0.0;
  for (const auto& b : bodies_) {
    if (!b.isDynamic()) continue;
    // U = -m * (g . (pos - ref)), with reference plane at y = floorY.
    const Vec3 relPos{b.pose.pos.x, b.pose.pos.y - config_.floorY, b.pose.pos.z};
    pe += -b.mass * dot(config_.gravity * b.gravityScale, relPos);
  }
  return pe;
}

Vec3 World::linearMomentum() const {
  Vec3 p{};
  for (const auto& b : bodies_) {
    if (b.isDynamic()) p = p + b.vel * b.mass;
  }
  return p;
}

Vec3 World::angularMomentum(Vec3 origin) const {
  Vec3 L{};
  for (const auto& b : bodies_) {
    if (!b.isDynamic()) continue;
    L = L + cross(b.pose.pos - origin, b.vel * b.mass) + b.worldInertia * b.omega;
  }
  return L;
}

Snapshot World::snapshot() const {
  Snapshot s;
  s.simTime = time_;
  s.bodies.reserve(bodies_.size());
  for (const auto& b : bodies_) {
    s.bodies.push_back({b.pose, b.vel, b.omega, b.sleeping, b.sleepTimer});
  }
  s.joints.reserve(joints_.size());
  for (const auto& j : joints_) {
    s.joints.push_back({j.active, j.broken, j.currentAngle, j.currentOffset, j.phaseIntegral,
                        j.linearImpulse, j.angularImpulse, j.limitImpulse, j.linearLimitImpulse,
                        j.motorImpulse, j.linearMotorImpulse, j.frictionImpulse, j.linearFrictionImpulse,
                        j.gearImpulse, j.distanceImpulse, j.coneImpulse});
  }
  s.contacts = contactCache_.serialize();
  return s;
}

void World::restore(const Snapshot& snap) {
  time_ = snap.simTime;
  const size_t nb = std::min(bodies_.size(), snap.bodies.size());
  for (size_t i = 0; i < nb; i++) {
    Body& b = bodies_[i];
    b.pose = snap.bodies[i].pose;
    b.vel = snap.bodies[i].vel;
    b.omega = snap.bodies[i].omega;
    b.sleeping = snap.bodies[i].sleeping;
    b.sleepTimer = snap.bodies[i].sleepTimer;
    b.force = {};
    b.torque = {};
    b.updateWorldInertia();
    syncBvhProxy(static_cast<uint32_t>(i), {});
  }
  const size_t nj = std::min(joints_.size(), snap.joints.size());
  for (size_t i = 0; i < nj; i++) {
    Joint& j = joints_[i];
    const auto& sj = snap.joints[i];
    j.active = sj.active;
    j.broken = sj.broken;
    j.currentAngle = sj.currentAngle;
    j.currentOffset = sj.currentOffset;
    j.phaseIntegral = sj.phaseIntegral;
    j.linearImpulse = sj.linearImpulse;
    j.angularImpulse = sj.angularImpulse;
    j.limitImpulse = sj.limitImpulse;
    j.linearLimitImpulse = sj.linearLimitImpulse;
    j.motorImpulse = sj.motorImpulse;
    j.linearMotorImpulse = sj.linearMotorImpulse;
    j.frictionImpulse = sj.frictionImpulse;
    j.linearFrictionImpulse = sj.linearFrictionImpulse;
    j.gearImpulse = sj.gearImpulse;
    j.distanceImpulse = sj.distanceImpulse;
    j.coneImpulse = sj.coneImpulse;
    if (j.desc.disableCollision && j.desc.bodyA < bodies_.size() && j.desc.bodyB < bodies_.size()) {
      if (j.active && !j.broken) ignoreCollisionPair(j.desc.bodyA, j.desc.bodyB);
      else allowCollisionPair(j.desc.bodyA, j.desc.bodyB);
    }
  }
  contactCache_.deserialize(snap.contacts);
  manifolds_.clear();
}

Xform World::pieceXformLdu(uint32_t bodyId, size_t localPieceSlot) const {
  if (bodyId >= bodies_.size()) return Xform::identity();
  const Body& b = bodies_[bodyId];
  if (localPieceSlot >= b.pieceLocalPoses.size()) return b.pose.toLduXform();
  return (b.pose * b.pieceLocalPoses[localPieceSlot]).toLduXform();
}

}  // namespace bm::physics
