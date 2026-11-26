#include <catch2/catch_approx.hpp>
#include <catch2/catch_test_macros.hpp>

#include <cmath>
#include <filesystem>
#include <nlohmann/json.hpp>
#include "bm/connect/graph.h"
#include "bm/connect/shadow.h"
#include "bm/io.h"
#include "bm/ldraw/library.h"
#include "bm/ldraw/part_cache.h"
#include "bm/physics/builder.h"
#include "bm/physics/collision.h"
#include "bm/physics/constants.h"
#include "bm/physics/inertia.h"
#include "bm/physics/math_ext.h"
#include "bm/physics/world.h"

namespace {

using namespace bm;
using namespace bm::physics;
using Catch::Approx;

/// Build a closed triangular LDraw mesh of an axis-aligned box in LDU (centred at origin).
ldraw::Mesh makeBoxLdrawMesh(Vec3 halfExtentsLdu) {
  ldraw::Mesh m;
  const float hx = static_cast<float>(halfExtentsLdu.x);
  const float hy = static_cast<float>(halfExtentsLdu.y);
  const float hz = static_cast<float>(halfExtentsLdu.z);
  const float verts[8][3] = {
      {-hx, -hy, -hz}, {hx, -hy, -hz}, {hx, hy, -hz}, {-hx, hy, -hz},
      {-hx, -hy, hz},  {hx, -hy, hz},  {hx, hy, hz},  {-hx, hy, hz},
  };
  for (const auto& v : verts) {
    m.positions.push_back(v[0]);
    m.positions.push_back(v[1]);
    m.positions.push_back(v[2]);
    m.bounds.grow({v[0], v[1], v[2]});
  }
  const uint32_t tris[12][3] = {
      {0, 2, 1}, {0, 3, 2},  // -Z
      {4, 5, 6}, {4, 6, 7},  // +Z
      {0, 1, 5}, {0, 5, 4},  // -Y
      {2, 3, 7}, {2, 7, 6},  // +Y
      {0, 4, 7}, {0, 7, 3},  // -X
      {1, 2, 6}, {1, 6, 5},  // +X
  };
  for (const auto& t : tris) {
    m.triangles.push_back(t[0]);
    m.triangles.push_back(t[1]);
    m.triangles.push_back(t[2]);
  }
  return m;
}

BodyDesc makeBoxBody(Vec3 halfExtentsM, Vec3 posM, BodyMotion motion = BodyMotion::Dynamic,
                     Material mat = materials::kAbs) {
  BodyDesc d;
  d.motion = motion;
  d.pose = {posM, Quat::identity()};
  d.material = mat;
  d.massProps = computeBoxMass(halfExtentsM, mat.density);
  d.shape.parts.push_back({ConvexShape::makeBox(halfExtentsM), Pose::identity(), 0});
  return d;
}

BodyDesc makeSphereBody(double radiusM, Vec3 posM, BodyMotion motion = BodyMotion::Dynamic,
                        Material mat = materials::kAbs) {
  BodyDesc d;
  d.motion = motion;
  d.pose = {posM, Quat::identity()};
  d.material = mat;
  d.massProps = computeSphereMass(radiusM, mat.density);
  d.shape.parts.push_back({ConvexShape::makeSphere(radiusM), Pose::identity(), 0});
  return d;
}

}  // namespace

TEST_CASE("SO(3) quaternions, exp/log map, SPD solve and Jacobi eigendecomposition", "[physics][math]") {
  const Vec3 axis = normalized({1.0, -2.0, 3.0});
  const double angle = 1.234;
  const Quat q = Quat::fromAxisAngle(axis, angle);
  const Mat3 R = q.toMat3();
  const Quat q2 = Quat::fromMat3(R);
  REQUIRE(std::abs(q.w * q2.w + q.x * q2.x + q.y * q2.y + q.z * q2.z) == Approx(1.0).margin(1e-12));

  const Vec3 rotVec = q.toRotVec();
  REQUIRE(rotVec.x == Approx(axis.x * angle).margin(1e-12));
  REQUIRE(rotVec.y == Approx(axis.y * angle).margin(1e-12));
  REQUIRE(rotVec.z == Approx(axis.z * angle).margin(1e-12));
  const Quat q3 = Quat::fromRotVec(rotVec);
  REQUIRE(std::abs(q.w * q3.w + q.x * q3.x + q.y * q3.y + q.z * q3.z) == Approx(1.0).margin(1e-12));

  // Verify symmetric 3x3 eigendecomposition reconstructs S = V * diag(evals) * V^T with det(V) = +1.
  const SymMat3 S{5.0, 3.0, 2.0, 1.2, -0.8, 0.5};
  const Eigen3 eig = eigenSym3(S);
  REQUIRE(determinant(eig.vectors) == Approx(1.0).margin(1e-12));
  const Mat3 recon = eig.vectors * diagMat3(eig.values.x, eig.values.y, eig.values.z) * transpose(eig.vectors);
  const Mat3 orig = S.toMat3();
  for (int i = 0; i < 9; i++) {
    REQUIRE(recon.m[i] == Approx(orig.m[i]).margin(1e-11));
  }

  // Verify Cholesky SPD linear solver.
  const Vec3 xTrue{1.5, -2.25, 0.75};
  const Vec3 b = S * xTrue;
  const Vec3 xSolved = S.solveSpd(b, 0.0);
  REQUIRE(xSolved.x == Approx(xTrue.x).margin(1e-12));
  REQUIRE(xSolved.y == Approx(xTrue.y).margin(1e-12));
  REQUIRE(xSolved.z == Approx(xTrue.z).margin(1e-12));
}

TEST_CASE("exact polyhedral signed-tetrahedron inertia and Steiner parallel-axis compound body", "[physics][inertia]") {
  // 2x4 LEGO brick solid box: 80 x 24 x 40 LDU = 0.032 x 0.0096 x 0.016 m.
  const Vec3 halfLdu{40.0, 12.0, 20.0};
  const ldraw::Mesh mesh = makeBoxLdrawMesh(halfLdu);
  const MassProperties mp = computeMeshMass(mesh, materials::kAbs.density);
  const MassProperties analytic = computeBoxMass(lduToMeters(halfLdu), materials::kAbs.density);

  REQUIRE(mp.fromExactMesh);
  REQUIRE(mp.mass == Approx(analytic.mass).epsilon(1e-9));
  REQUIRE(length(mp.com) == Approx(0.0).margin(1e-12));
  REQUIRE(mp.inertiaCom.xx == Approx(analytic.inertiaCom.xx).epsilon(1e-9));
  REQUIRE(mp.inertiaCom.yy == Approx(analytic.inertiaCom.yy).epsilon(1e-9));
  REQUIRE(mp.inertiaCom.zz == Approx(analytic.inertiaCom.zz).epsilon(1e-9));
  REQUIRE(mp.inertiaCom.xy == Approx(0.0).margin(1e-15));

  // Two identical cubes separated by +/- d along X: parallel-axis theorem predicts
  //   I_total_yy = 2 * (I_cube + m * d^2), I_total_xx = 2 * I_cube.
  const double half = 0.01;
  const double d = 0.05;
  const MassProperties cube = computeBoxMass({half, half, half}, 1000.0);
  const MassProperties pair = combineMassProperties({
      {cube, {{-d, 0.0, 0.0}, Quat::identity()}},
      {cube, {{+d, 0.0, 0.0}, Quat::identity()}},
  });
  REQUIRE(pair.mass == Approx(2.0 * cube.mass).epsilon(1e-12));
  REQUIRE(length(pair.com) == Approx(0.0).margin(1e-12));
  REQUIRE(pair.inertiaCom.xx == Approx(2.0 * cube.inertiaCom.xx).epsilon(1e-10));
  REQUIRE(pair.inertiaCom.yy == Approx(2.0 * (cube.inertiaCom.yy + cube.mass * d * d)).epsilon(1e-10));
  REQUIRE(pair.inertiaCom.zz == Approx(2.0 * (cube.inertiaCom.zz + cube.mass * d * d)).epsilon(1e-10));
}

TEST_CASE("3D convex hull, GJK/EPA, 4-point clipped face manifold, floor plane and BVH raycast", "[physics][collision]") {
  const ConvexShape boxA = ConvexShape::makeBox({0.016, 0.0048, 0.008});
  const ConvexShape boxB = ConvexShape::makeBox({0.016, 0.0048, 0.008});

  // Flat brick-on-brick overlap by 1 mm along Y.
  ContactManifold m;
  const bool hit = collideConvex(boxA, {{0.0, 0.0, 0.0}, Quat::identity()},
                                 boxB, {{0.0, 0.0086, 0.0}, Quat::identity()}, m);
  REQUIRE(hit);
  REQUIRE(m.pointCount == 4);
  REQUIRE(m.normal.y == Approx(1.0).margin(1e-6));
  for (uint32_t i = 0; i < m.pointCount; i++) {
    REQUIRE(m.points[i].penetration == Approx(0.001).margin(1e-4));
  }

  // Exact convex hull from triangular wedge prism vs box (general GJK + EPA + clipping path).
  const std::vector<Vec3> wedgePts = {
      {-0.01, -0.01, -0.01}, {0.01, -0.01, -0.01}, {-0.01, 0.01, -0.01},
      {-0.01, -0.01,  0.01}, {0.01, -0.01,  0.01}, {-0.01, 0.01,  0.01},
  };
  const auto wedgeHull = std::make_shared<ConvexHull>(ConvexHull::fromPoints(wedgePts));
  REQUIRE(wedgeHull->vertices.size() == 6);
  REQUIRE(wedgeHull->faces.size() == 5);
  const ConvexShape wedgeShape = ConvexShape::makeHull(wedgeHull);
  ContactManifold wm;
  REQUIRE(collideConvex(wedgeShape, {{0.0, 0.0, 0.0}, Quat::identity()},
                        boxB, {{0.0, -0.014, 0.0}, Quat::identity()}, wm));
  REQUIRE(wm.pointCount >= 1);
  REQUIRE(wm.normal.y == Approx(-1.0).margin(1e-4));

  // Floor plane contact: box resting slightly into y = 0 floor (LDraw +Y down => up is (0, -1, 0)).
  ContactManifold fm;
  REQUIRE(collideConvexPlane(boxA, {{0.0, -0.0043, 0.0}, Quat::identity()}, {0.0, -1.0, 0.0}, 0.0, fm));
  REQUIRE(fm.pointCount == 4);
  REQUIRE(fm.normal.y == Approx(1.0).margin(1e-6));
  REQUIRE(fm.points[0].penetration == Approx(0.0005).margin(1e-5));

  // World raycast against box body.
  World world;
  const uint32_t bid = world.addBody(makeBoxBody({0.01, 0.01, 0.01}, {0.0, -0.05, 0.0}, BodyMotion::Static));
  const auto rhit = world.raycast({0.0, -0.20, 0.0}, {0.0, 1.0, 0.0}, 1.0);
  REQUIRE(rhit.has_value());
  REQUIRE(rhit->bodyId == bid);
  REQUIRE(rhit->distance == Approx(0.14).margin(1e-6));
  REQUIRE(rhit->normal.y == Approx(-1.0).margin(1e-6));
}

TEST_CASE("free-fall kinematics, elastic rebound restitution, and resting sleep", "[physics][dynamics]") {
  // 1. Free-fall trajectory matches y(t) = y0 + 0.5 * g * t^2.
  {
    WorldConfig cfg;
    cfg.floorEnabled = false;
    cfg.substeps = 8;
    World world(cfg);
    BodyDesc d = makeBoxBody({0.01, 0.01, 0.01}, {0.0, -1.0, 0.0});
    d.linearDamping = 0.0;
    d.angularDamping = 0.0;
    const uint32_t id = world.addBody(d);
    const double dt = 1.0 / 60.0;
    for (int i = 0; i < 30; i++) world.step(dt);  // t = 0.5 s
    const double t = 0.5;
    const double h = dt / cfg.substeps;
    const double expectedY = -1.0 + 0.5 * kGravity * t * t;
    // Exact Symplectic Euler position is y0 + 0.5 * g * t * (t + h); within 0.6% of continuous parabola!
    REQUIRE(world.body(id).pose.pos.y == Approx(expectedY + 0.5 * kGravity * t * h).margin(1e-9));
    REQUIRE(world.body(id).pose.pos.y == Approx(expectedY).margin(0.006));
    REQUIRE(world.body(id).vel.y == Approx(kGravity * t).margin(1e-9));
  }

  // 2. Elastic sphere bounce height matches e^2 * h0.
  {
    WorldConfig cfg;
    cfg.floorEnabled = true;
    cfg.floorY = 0.0;
    cfg.floorMaterial.restitution = 0.0;
    cfg.substeps = 12;
    cfg.restitutionThreshold = 0.05;
    World world(cfg);
    Material bouncy = materials::kAbs;
    bouncy.restitution = 0.80;
    const double r = 0.01;
    const double dropH = 0.20;
    BodyDesc d = makeSphereBody(r, {0.0, -(r + dropH), 0.0}, BodyMotion::Dynamic, bouncy);
    d.linearDamping = 0.0;
    const uint32_t id = world.addBody(d);

    bool hitFloor = false;
    double peakHeightAfterBounce = 0.0;
    for (int i = 0; i < 90; i++) {
      world.step(1.0 / 120.0);
      if (!hitFloor && !world.impactEvents().empty()) hitFloor = true;
      if (hitFloor) {
        const double h = -(world.body(id).pose.pos.y + r);
        peakHeightAfterBounce = std::max(peakHeightAfterBounce, h);
      }
    }
    REQUIRE(hitFloor);
    const double expectedPeak = 0.80 * 0.80 * dropH;  // 0.128 m
    REQUIRE(peakHeightAfterBounce == Approx(expectedPeak).epsilon(0.08));
  }

  // 3. Brick dropped onto floor settles cleanly and enters sleep state.
  {
    WorldConfig cfg;
    cfg.floorEnabled = true;
    cfg.floorY = 0.0;
    World world(cfg);
    const uint32_t id = world.addBody(makeBoxBody({0.016, 0.0048, 0.008}, {0.0, -0.02, 0.0}));
    for (int i = 0; i < 120; i++) world.step(1.0 / 60.0);  // 2.0 s
    REQUIRE(world.body(id).pose.pos.y == Approx(-0.0048).margin(0.0005));
    REQUIRE(world.body(id).sleeping);
  }
}

TEST_CASE("momentum conservation and implicit gyroscopic Dzhanibekov intermediate-axis flip", "[physics][gyro]") {
  // 1. Head-on elastic collision in zero gravity conserves linear momentum & kinetic energy.
  {
    WorldConfig cfg;
    cfg.gravity = {};
    cfg.floorEnabled = false;
    cfg.substeps = 10;
    cfg.restitutionThreshold = 0.01;
    World world(cfg);
    Material elastic = materials::kAbs;
    elastic.restitution = 1.0;
    elastic.staticFriction = 0.0;
    elastic.dynamicFriction = 0.0;

    BodyDesc a = makeSphereBody(0.01, {-0.03, 0.0, 0.0}, BodyMotion::Dynamic, elastic);
    a.linearVel = {0.4, 0.0, 0.0};
    a.linearDamping = a.angularDamping = 0.0;
    BodyDesc b = makeSphereBody(0.01, {+0.03, 0.0, 0.0}, BodyMotion::Dynamic, elastic);
    b.linearVel = {-0.2, 0.0, 0.0};
    b.linearDamping = b.angularDamping = 0.0;
    const uint32_t idA = world.addBody(a);
    const uint32_t idB = world.addBody(b);

    const Vec3 p0 = world.linearMomentum();
    const double ke0 = world.kineticEnergy();
    for (int i = 0; i < 30; i++) world.step(1.0 / 120.0);

    // Spheres of equal mass should exchange velocities!
    REQUIRE(world.body(idA).vel.x == Approx(-0.2).margin(0.02));
    REQUIRE(world.body(idB).vel.x == Approx(0.4).margin(0.02));
    const Vec3 p1 = world.linearMomentum();
    REQUIRE(length(p1 - p0) == Approx(0.0).margin(1e-9));
    REQUIRE(world.kineticEnergy() == Approx(ke0).epsilon(0.03));
  }

  // 2. Dzhanibekov / Tennis Racket Effect: asymmetric rigid body spun about intermediate axis flips 180 deg!
  {
    WorldConfig cfg;
    cfg.gravity = {};
    cfg.floorEnabled = false;
    cfg.enableGyroscopic = true;
    cfg.enableSleeping = false;
    cfg.substeps = 8;
    World world(cfg);

    // Long flat slab: I_x < I_y < I_z (Y is the unstable intermediate principal axis!).
    BodyDesc d = makeBoxBody({0.04, 0.015, 0.004}, {});
    d.linearDamping = 0.0;
    d.angularDamping = 0.0;
    d.angularVel = {0.15, 18.0, 0.0};  // Spin about intermediate Y axis with tiny X perturbation
    const uint32_t id = world.addBody(d);

    const Vec3 L0 = world.angularMomentum();
    const double ke0 = world.kineticEnergy();
    double minAlignY = 1.0;
    for (int i = 0; i < 180; i++) {
      world.step(1.0 / 60.0);
      const Vec3 localYInWorld = world.body(id).pose.dirToWorld({0.0, 1.0, 0.0});
      minAlignY = std::min(minAlignY, localYInWorld.y);
    }
    const Vec3 L1 = world.angularMomentum();
    // Angular momentum vector is conserved and body must have flipped past -0.7 (intermediate-axis instability)!
    REQUIRE(length(L1 - L0) / length(L0) < 0.02);
    REQUIRE(world.kineticEnergy() <= ke0 * 1.02);
    REQUIRE(minAlignY < -0.5);
  }
}

TEST_CASE("6-brick vertical stack stability and CCD anti-tunneling guard", "[physics][stack][ccd]") {
  // 1. Stack of 6 flat 2x4 LEGO bricks stands stably without collapsing or penetrating.
  {
    WorldConfig cfg;
    cfg.floorEnabled = true;
    cfg.floorY = 0.0;
    cfg.substeps = 8;
    cfg.velocityIterations = 16;
    cfg.positionIterations = 6;
    World world(cfg);

    const Vec3 he{0.016, 0.0048, 0.008};  // 32 x 9.6 x 16 mm
    std::vector<uint32_t> ids;
    for (int i = 0; i < 6; i++) {
      const double y = -(he.y * (2.0 * i + 1.0));
      ids.push_back(world.addBody(makeBoxBody(he, {0.0, y, 0.0})));
    }
    for (int f = 0; f < 120; f++) world.step(1.0 / 60.0);
    for (int i = 0; i < 6; i++) {
      const Vec3 p = world.body(ids[i]).pose.pos;
      const double expectedY = -(he.y * (2.0 * i + 1.0));
      REQUIRE(std::abs(p.x) < 0.002);
      REQUIRE(std::abs(p.z) < 0.002);
      REQUIRE(p.y == Approx(expectedY).margin(0.0015));
    }
  }

  // 2. Fast thin tile (3.2 mm thick) fired straight down at 25 m/s does NOT tunnel through floor!
  {
    WorldConfig cfg;
    cfg.floorEnabled = true;
    cfg.floorY = 0.0;
    cfg.enableCcd = true;
    cfg.substeps = 4;
    World world(cfg);

    const Vec3 tileHe{0.008, 0.0016, 0.004};  // 1x2 LEGO tile (3.2 mm thick)
    BodyDesc d = makeBoxBody(tileHe, {0.0, -0.05, 0.0});
    d.linearVel = {0.0, 25.0, 0.0};  // 25 m/s down!
    const uint32_t id = world.addBody(d);
    for (int f = 0; f < 30; f++) world.step(1.0 / 60.0);
    // Must stay above the floor (y <= 0 in LDraw)!
    REQUIRE(world.body(id).pose.pos.y <= 0.001);
  }
}

TEST_CASE("isotropic Coulomb friction holds below critical ramp angle and slides above it", "[physics][friction]") {
  auto simulateRamp = [](double tiltRadians, double mu) {
    WorldConfig cfg;
    cfg.floorEnabled = false;
    cfg.substeps = 8;
    World world(cfg);

    Material mat = materials::kAbs;
    mat.staticFriction = mu;
    mat.dynamicFriction = mu;
    mat.restitution = 0.0;

    // Tilted static ramp around Z axis.
    BodyDesc ramp = makeBoxBody({0.25, 0.01, 0.10}, {0.0, 0.0, 0.0}, BodyMotion::Static, mat);
    ramp.pose.rot = Quat::fromAxisAngle({0.0, 0.0, 1.0}, tiltRadians);
    world.addBody(ramp);

    // Block resting flush on top of the ramp.
    const Vec3 upRamp = ramp.pose.dirToWorld({0.0, -1.0, 0.0});
    const Vec3 startPos = upRamp * (0.01 + 0.005);
    BodyDesc blk = makeBoxBody({0.01, 0.005, 0.01}, startPos, BodyMotion::Dynamic, mat);
    blk.pose.rot = ramp.pose.rot;
    blk.linearDamping = 0.0;
    const uint32_t bid = world.addBody(blk);

    for (int i = 0; i < 45; i++) world.step(1.0 / 60.0);
    return length(world.body(bid).pose.pos - startPos);
  };

  // mu = 0.5 => critical angle atan(0.5) = 26.57 deg.
  // At 14 deg (tan = 0.25 < 0.5): must hold static.
  // At 38 deg (tan = 0.78 > 0.5): must slide cleanly down ramp!
  const double dispLow = simulateRamp(14.0 * kPi / 180.0, 0.50);
  const double dispHigh = simulateRamp(38.0 * kPi / 180.0, 0.50);
  REQUIRE(dispLow < 0.003);
  REQUIRE(dispHigh > 0.10);
}

TEST_CASE("multibody joints: pendulum, motor & friction pins, prismatic shock absorber, spherical cone, rope", "[physics][joints]") {
  // 1. Revolute compound pendulum: stays at fixed radius and oscillates under gravity.
  {
    WorldConfig cfg;
    cfg.floorEnabled = false;
    cfg.substeps = 10;
    World world(cfg);

    const uint32_t anchor = world.addBody(makeBoxBody({0.01, 0.01, 0.01}, {0.0, 0.0, 0.0}, BodyMotion::Static));
    const double armLen = 0.08;
    BodyDesc bob = makeBoxBody({0.01, 0.01, 0.01}, {armLen, 0.0, 0.0});
    bob.linearDamping = bob.angularDamping = 0.0;
    const uint32_t bobId = world.addBody(bob);

    JointDesc jd;
    jd.kind = JointKind::Revolute;
    jd.bodyA = anchor;
    jd.bodyB = bobId;
    jd.localAnchorA = {0.0, 0.0, 0.0};
    jd.localAnchorB = {-armLen, 0.0, 0.0};
    jd.localAxisA = {0.0, 0.0, 1.0};
    jd.localAxisB = {0.0, 0.0, 1.0};
    world.addJoint(jd);

    const double e0 = world.totalEnergy();
    double maxY = 0.0;
    for (int f = 0; f < 60; f++) {
      world.step(1.0 / 60.0);
      const double r = length(world.body(bobId).pose.pos);
      REQUIRE(r == Approx(armLen).margin(0.001));
      maxY = std::max(maxY, world.body(bobId).pose.pos.y);
    }
    REQUIRE(maxY > armLen * 0.90);
    REQUIRE(world.totalEnergy() == Approx(e0).margin(0.002));
  }

  // 2. Revolute motor + frictionless vs friction pin comparison + angular limits.
  {
    WorldConfig cfg;
    cfg.gravity = {};
    cfg.floorEnabled = false;
    cfg.substeps = 8;
    World world(cfg);

    const uint32_t base = world.addBody(makeBoxBody({0.02, 0.02, 0.02}, {}, BodyMotion::Static));
    const uint32_t freeWheel = world.addBody(makeBoxBody({0.02, 0.005, 0.02}, {0.0, 0.0, 0.0}));
    const uint32_t fricWheel = world.addBody(makeBoxBody({0.02, 0.005, 0.02}, {0.1, 0.0, 0.0}));
    const uint32_t motorWheel = world.addBody(makeBoxBody({0.02, 0.005, 0.02}, {0.2, 0.0, 0.0}));
    world.body(freeWheel).angularDamping = 0.0;
    world.body(fricWheel).angularDamping = 0.0;
    world.setBodyVelocity(freeWheel, {}, {0.0, 20.0, 0.0});
    world.setBodyVelocity(fricWheel, {}, {0.0, 20.0, 0.0});

    JointDesc jFree;
    jFree.kind = JointKind::Revolute;
    jFree.bodyA = base;
    jFree.bodyB = freeWheel;
    jFree.localAxisA = jFree.localAxisB = {0.0, 1.0, 0.0};
    jFree.angularFriction = clutch::kFreePinTorque;
    world.addJoint(jFree);

    JointDesc jFric = jFree;
    jFric.bodyB = fricWheel;
    jFric.localAnchorA = {0.1, 0.0, 0.0};
    jFric.angularFriction = clutch::kFrictionPinTorque;
    world.addJoint(jFric);

    JointDesc jMotor = jFree;
    jMotor.bodyB = motorWheel;
    jMotor.localAnchorA = {0.2, 0.0, 0.0};
    jMotor.angularFriction = 0.0;
    jMotor.angularMotor.enabled = true;
    jMotor.angularMotor.targetVelocity = 12.0;  // rad/s
    jMotor.angularMotor.maxEffort = clutch::kMotorMStallTorque;
    world.addJoint(jMotor);

    for (int i = 0; i < 30; i++) world.step(1.0 / 60.0);
    REQUIRE(world.body(freeWheel).omega.y > world.body(fricWheel).omega.y + 5.0);
    REQUIRE(world.body(motorWheel).omega.y == Approx(12.0).margin(0.3));
  }

  // 3. Prismatic LEGO shock absorber: settles at exact Hooke equilibrium sag x = m*g/k!
  {
    WorldConfig cfg;
    cfg.floorEnabled = false;
    cfg.substeps = 10;
    World world(cfg);

    const uint32_t chassis = world.addBody(makeBoxBody({0.02, 0.01, 0.02}, {0.0, 0.0, 0.0}, BodyMotion::Static));
    BodyDesc wheelHub = makeBoxBody({0.02, 0.02, 0.02}, {0.0, 0.04, 0.0});
    wheelHub.massProps = computeBoxMass({0.02, 0.02, 0.02}, 15000.0);  // ~0.96 kg load for measurable sag
    const uint32_t hubId = world.addBody(wheelHub);
    const double m = world.body(hubId).mass;
    const double k = clutch::kHardShockStiffness;  // 520 N/m

    JointDesc shock;
    shock.kind = JointKind::Prismatic;
    shock.bodyA = chassis;
    shock.bodyB = hubId;
    shock.localAnchorA = {0.0, 0.04, 0.0};
    shock.localAnchorB = {0.0, 0.0, 0.0};
    shock.localAxisA = shock.localAxisB = {0.0, 1.0, 0.0};
    shock.linearSpring.enabled = true;
    shock.linearSpring.stiffness = k;
    shock.linearSpring.damping = 12.0;
    shock.linearSpring.restTarget = 0.0;
    shock.linearLimits.enabled = true;
    shock.linearLimits.lower = -0.02;
    shock.linearLimits.upper = 0.04;
    const uint32_t jid = world.addJoint(shock);

    for (int f = 0; f < 180; f++) world.step(1.0 / 60.0);  // 3 s to damp out completely
    const double expectedSag = (m * kGravity) / k;
    REQUIRE(world.joint(jid).currentOffset == Approx(expectedSag).margin(0.001));
    REQUIRE(std::abs(world.body(hubId).pose.pos.x) < 1e-4);
    REQUIRE(std::abs(world.body(hubId).pose.pos.z) < 1e-4);
  }

  // 4. Tension-only rope catches falling mass at exact maxDistance.
  {
    WorldConfig cfg;
    cfg.floorEnabled = false;
    cfg.substeps = 10;
    World world(cfg);

    const uint32_t peg = world.addBody(makeBoxBody({0.005, 0.005, 0.005}, {0.0, 0.0, 0.0}, BodyMotion::Static));
    const uint32_t massId = world.addBody(makeSphereBody(0.008, {0.0, 0.02, 0.0}));
    JointDesc rope;
    rope.kind = JointKind::Distance;
    rope.bodyA = peg;
    rope.bodyB = massId;
    rope.ropeOnly = true;
    rope.maxDistance = 0.06;
    world.addJoint(rope);

    for (int f = 0; f < 60; f++) world.step(1.0 / 60.0);
    REQUIRE(world.body(massId).pose.pos.y <= 0.062);
    REQUIRE(world.body(massId).pose.pos.y >= 0.04);
  }
}

TEST_CASE("exact gear couplings: spur 3:1 reduction, rack-and-pinion, and self-locking worm drive", "[physics][gears]") {
  // 1. Spur gear train: 8T driving 24T => driven spins at exactly -1/3 speed with zero phase drift.
  {
    WorldConfig cfg;
    cfg.gravity = {};
    cfg.floorEnabled = false;
    cfg.substeps = 10;
    World world(cfg);

    const uint32_t frame = world.addBody(makeBoxBody({0.05, 0.01, 0.02}, {}, BodyMotion::Static));
    const uint32_t gear8 = world.addBody(makeBoxBody({0.008, 0.004, 0.008}, {-0.016, 0.0, 0.0}));
    const uint32_t gear24 = world.addBody(makeBoxBody({0.024, 0.004, 0.024}, {+0.016, 0.0, 0.0}));

    JointDesc revA;
    revA.kind = JointKind::Revolute;
    revA.bodyA = frame;
    revA.bodyB = gear8;
    revA.localAnchorA = {-0.016, 0.0, 0.0};
    revA.localAxisA = revA.localAxisB = {0.0, 1.0, 0.0};
    revA.angularMotor.enabled = true;
    revA.angularMotor.targetVelocity = 15.0;  // rad/s
    revA.angularMotor.maxEffort = 0.2;
    const uint32_t jA = world.addJoint(revA);

    JointDesc revB = revA;
    revB.bodyB = gear24;
    revB.localAnchorA = {+0.016, 0.0, 0.0};
    revB.angularMotor.enabled = false;
    const uint32_t jB = world.addJoint(revB);

    JointDesc mesh;
    mesh.kind = JointKind::Gear;
    mesh.bodyA = gear8;
    mesh.bodyB = gear24;
    mesh.localAxisA = mesh.localAxisB = {0.0, 1.0, 0.0};
    mesh.gear.meshKind = kin::MeshKind::Parallel;
    mesh.gear.ratioA = 8.0 / 24.0;
    mesh.gear.ratioB = 24.0 / 24.0;  // 8*wA + 24*wB = 0 => wB = -wA / 3
    mesh.gear.carrierBody = frame;
    world.addJoint(mesh);

    for (int f = 0; f < 60; f++) world.step(1.0 / 60.0);
    REQUIRE(world.body(gear8).omega.y == Approx(15.0).margin(0.2));
    REQUIRE(world.body(gear24).omega.y == Approx(-5.0).margin(0.15));
    // Cumulative angle ratio stays exact over full multi-turn rotation!
    REQUIRE(world.joint(jB).currentAngle / world.joint(jA).currentAngle == Approx(-1.0 / 3.0).margin(0.01));
  }

  // 2. Rack-and-pinion: pinion radius r = 0.008 m turning at 10 rad/s drives rack at 0.08 m/s!
  {
    WorldConfig cfg;
    cfg.gravity = {};
    cfg.floorEnabled = false;
    cfg.substeps = 10;
    World world(cfg);

    const uint32_t frame = world.addBody(makeBoxBody({0.05, 0.01, 0.02}, {}, BodyMotion::Static));
    const uint32_t pinion = world.addBody(makeBoxBody({0.008, 0.008, 0.004}, {0.0, 0.0, 0.0}));
    const uint32_t rack = world.addBody(makeBoxBody({0.04, 0.004, 0.004}, {0.0, 0.012, 0.0}));

    JointDesc rev;
    rev.kind = JointKind::Revolute;
    rev.bodyA = frame;
    rev.bodyB = pinion;
    rev.localAxisA = rev.localAxisB = {0.0, 0.0, 1.0};
    rev.angularMotor.enabled = true;
    rev.angularMotor.targetVelocity = 10.0;
    rev.angularMotor.maxEffort = 0.2;
    world.addJoint(rev);

    JointDesc slider;
    slider.kind = JointKind::Prismatic;
    slider.bodyA = frame;
    slider.bodyB = rack;
    slider.localAnchorA = {0.0, 0.012, 0.0};
    slider.localAxisA = slider.localAxisB = {1.0, 0.0, 0.0};
    world.addJoint(slider);

    JointDesc rmesh;
    rmesh.kind = JointKind::Gear;
    rmesh.bodyA = pinion;
    rmesh.bodyB = rack;
    rmesh.localAxisA = {0.0, 0.0, 1.0};
    rmesh.localAxisB = {1.0, 0.0, 0.0};
    rmesh.gear.meshKind = kin::MeshKind::Rack;
    rmesh.gear.ratioA = -0.008;  // -r * omega + v = 0 => v = r * omega
    rmesh.gear.ratioB = 1.0;
    rmesh.gear.carrierBody = frame;
    world.addJoint(rmesh);

    for (int f = 0; f < 30; f++) world.step(1.0 / 60.0);
    REQUIRE(world.body(rack).vel.x == Approx(0.08).margin(0.005));
  }

  // 3. Worm gear self-locking: driving gear cannot back-drive stationary worm.
  {
    WorldConfig cfg;
    cfg.gravity = {};
    cfg.floorEnabled = false;
    cfg.substeps = 8;
    World world(cfg);

    const uint32_t frame = world.addBody(makeBoxBody({0.05, 0.01, 0.02}, {}, BodyMotion::Static));
    const uint32_t worm = world.addBody(makeBoxBody({0.01, 0.006, 0.006}, {0.0, 0.0, 0.0}));
    const uint32_t wheel = world.addBody(makeBoxBody({0.02, 0.004, 0.02}, {0.0, 0.02, 0.0}));

    JointDesc jW;
    jW.kind = JointKind::Revolute;
    jW.bodyA = frame; jW.bodyB = worm;
    jW.localAxisA = jW.localAxisB = {1.0, 0.0, 0.0};
    world.addJoint(jW);

    JointDesc jG;
    jG.kind = JointKind::Revolute;
    jG.bodyA = frame; jG.bodyB = wheel;
    jG.localAnchorA = {0.0, 0.02, 0.0};
    jG.localAxisA = jG.localAxisB = {0.0, 0.0, 1.0};
    world.addJoint(jG);

    JointDesc wm;
    wm.kind = JointKind::Gear;
    wm.bodyA = worm; wm.bodyB = wheel;
    wm.localAxisA = {1.0, 0.0, 0.0};
    wm.localAxisB = {0.0, 0.0, 1.0};
    wm.gear.meshKind = kin::MeshKind::Worm;
    wm.gear.ratioA = 1.0 / 24.0;
    wm.gear.ratioB = -1.0;
    wm.gear.wormSelfLocking = true;
    wm.gear.carrierBody = frame;
    world.addJoint(wm);

    // Apply external torque trying to back-drive the wheel against the worm!
    for (int f = 0; f < 30; f++) {
      world.applyTorque(wheel, {0.0, 0.0, 0.05});
      world.step(1.0 / 60.0);
    }
    REQUIRE(std::abs(world.body(worm).omega.x) < 0.05);
    REQUIRE(std::abs(world.body(wheel).omega.z) < 0.15);
  }
}

TEST_CASE("breakable LEGO stud clutch snaps under overload and emits JointBreakEvent", "[physics][clutch]") {
  WorldConfig cfg;
  cfg.floorEnabled = false;
  cfg.substeps = 10;
  World world(cfg);

  const uint32_t ceiling = world.addBody(makeBoxBody({0.02, 0.005, 0.02}, {0.0, 0.0, 0.0}, BodyMotion::Static));
  // Light brick (~3 g => 0.03 N weight) hangs easily from a 2.0 N LEGO stud clutch.
  const uint32_t brick = world.addBody(makeBoxBody({0.016, 0.0048, 0.008}, {0.0, 0.0098, 0.0}));

  JointDesc stud;
  stud.kind = JointKind::Fixed;
  stud.bodyA = ceiling;
  stud.bodyB = brick;
  stud.localAnchorA = {0.0, 0.005, 0.0};
  stud.localAnchorB = {0.0, -0.0048, 0.0};
  stud.localAxisA = stud.localAxisB = {0.0, 1.0, 0.0};
  stud.strength.breakable = true;
  stud.strength.maxPullForce = clutch::kStudPullForce;  // 2.0 N
  stud.strength.maxShearForce = clutch::kStudShearForce;
  stud.strength.maxBendTorque = clutch::kStudBendTorque;
  stud.strength.maxTwistTorque = clutch::kStudTwistTorque;
  const uint32_t jid = world.addJoint(stud);

  // Under normal gravity alone (~0.03 N << 2.0 N), clutch holds solidly!
  for (int f = 0; f < 20; f++) world.step(1.0 / 60.0);
  REQUIRE(!world.joint(jid).broken);
  REQUIRE(world.joint(jid).stressRatio < 0.1);
  REQUIRE(world.breakEvents().empty());

  // Now yank downward with 6.0 N (> 2.0 N clutch pull capacity) -> must snap!
  for (int f = 0; f < 10; f++) {
    world.applyForce(brick, {0.0, 6.0, 0.0});
    world.step(1.0 / 60.0);
  }
  REQUIRE(world.joint(jid).broken);
  REQUIRE(world.breakEvents().size() == 1);
  REQUIRE(world.breakEvents()[0].jointId == jid);
  REQUIRE(world.breakEvents()[0].stressRatio >= 1.0);

  // Detached brick now falls freely under gravity!
  const double ySnap = world.body(brick).pose.pos.y;
  for (int f = 0; f < 15; f++) world.step(1.0 / 60.0);
  REQUIRE(world.body(brick).pose.pos.y > ySnap + 0.05);
}

TEST_CASE("deterministic state snapshot and exact rewind replay", "[physics][snapshot]") {
  World world;
  const uint32_t b0 = world.addBody(makeBoxBody({0.016, 0.0048, 0.008}, {0.0, -0.04, 0.0}));
  const uint32_t b1 = world.addBody(makeBoxBody({0.008, 0.0048, 0.008}, {0.005, -0.07, 0.002}));
  world.setBodyVelocity(b1, {0.1, 0.0, -0.05}, {2.0, -1.0, 3.0});

  for (int f = 0; f < 15; f++) world.step(1.0 / 60.0);
  const Snapshot snap = world.snapshot();

  for (int f = 0; f < 30; f++) world.step(1.0 / 60.0);
  const Pose pose0Run1 = world.body(b0).pose;
  const Pose pose1Run1 = world.body(b1).pose;
  const Vec3 vel1Run1 = world.body(b1).vel;

  world.restore(snap);
  for (int f = 0; f < 30; f++) world.step(1.0 / 60.0);
  REQUIRE(length(world.body(b0).pose.pos - pose0Run1.pos) == Approx(0.0).margin(1e-12));
  REQUIRE(length(world.body(b1).pose.pos - pose1Run1.pos) == Approx(0.0).margin(1e-12));
  REQUIRE(length(world.body(b1).vel - vel1Run1) == Approx(0.0).margin(1e-12));
}

TEST_CASE("end-to-end BrickMotion model bridge, trajectory baking, and structural stress analysis", "[physics][bridge]") {
  const std::filesystem::path libDir = std::filesystem::path(BM_FIXTURES) / "lib";
  const std::filesystem::path shadowDir = std::filesystem::path(BM_FIXTURES) / "shadow";

  const ldraw::Library library(libDir);
  const connect::ShadowLibrary shadow(shadowDir);
  connect::ConnectorDb db(library, shadow);
  ldraw::PartCache parts(library, {});

  // Build a 3-brick 2x4 vertical tower using fixture part `c2x4.dat` (which has full stud/anti-stud shadow connectors).
  Model::Data data{{}, {}, {}, library, {}};
  for (int i = 0; i < 3; i++) {
    Piece p;
    p.id = "0/" + std::to_string(i);
    p.part = "c2x4.dat";
    p.color = 4;
    p.world = {Mat3::identity(), {0.0, -24.0 * i, 0.0}};
    p.step = i;
    data.pieces.push_back(std::move(p));
  }
  const Model model(std::move(data));
  REQUIRE(model.pieces().size() == 3);
  const connect::Graph graph = connect::buildGraph(model, db);
  REQUIRE(graph.connections.size() == 2);

  // 1. Mechanism mode drop + bakeTrajectory + JSON serialization.
  BuildOptions bopt;
  bopt.mode = SimMode::Mechanism;
  bopt.dropHeightLdu = 30.0;  // 12 mm drop onto floor
  BuiltWorld built = buildWorld(model, graph, nullptr, parts, nullptr, bopt);
  REQUIRE(built.world.bodyCount() >= 1);
  REQUIRE(built.totalMassGrams > 0.0);

  const Trajectory traj = bakeTrajectory(built, 0.5, 60.0);
  REQUIRE(traj.frames.size() == 31);
  REQUIRE(traj.frames.front().pieceXforms.size() == model.pieces().size());
  REQUIRE(traj.impacts.size() >= 1);
  const auto parsed = nlohmann::json::parse(traj.toJson(false));
  REQUIRE(parsed["frameCount"].get<size_t>() == 31);

  // 2. Quasi-static structural stress analysis on the stacked fixture model: must be structurally sound!
  StructuralOptions sopt;
  sopt.settleDuration = 0.25;
  const StructuralReport rep = analyzeStructure(model, graph, parts, sopt);
  REQUIRE(rep.totalMassGrams > 0.0);
  REQUIRE(rep.failedJoints == 0);
  REQUIRE(rep.structurallySound);
}
