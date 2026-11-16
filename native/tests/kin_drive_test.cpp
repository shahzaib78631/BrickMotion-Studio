#include <catch2/catch_test_macros.hpp>
#include <catch2/matchers/catch_matchers_floating_point.hpp>
#include <cmath>
#include "bm/kin/drive.h"

using namespace bm;
using namespace bm::kin;
using connect::JointKind;
using Catch::Matchers::WithinAbs;

namespace {
const Vec3 kZ{0, 0, 1}, kX{1, 0, 0};
constexpr double kPi = 3.14159265358979323846;

struct Rig {
  System sys;
  explicit Rig(uint32_t bodies) {
    sys.bodies = bodies;
    sys.size.assign(bodies, 1);
    sys.size[0] = 100;
    sys.pieces.resize(bodies);
    for (uint32_t b = 0; b < bodies; b++) sys.pieces[b] = {b}, sys.bodyOf.push_back(b);
  }
  void link(uint32_t a, uint32_t b, JointKind kind, Vec3 point, Vec3 axis) { sys.links.push_back({std::min(a, b), std::max(a, b), kind, point, axis, a, b}); }
  Mobility only() const {
    const Mobility m = mobility(sys);
    REQUIRE(m.freedoms.size() == 1);
    return m;
  }
};
Toothed spur(int teeth, Vec3 centre) {
  Toothed t;
  t.kind = ToothKind::Spur;
  t.teeth = teeth;
  t.pitchRadius = teeth * 1.25;
  t.axis = {0, 0, 1};
  t.centre = centre;
  t.width = 10;
  return t;
}
/// A crank-rocker: ground 100, crank 40, coupler ~102, rocker 60. The crank can turn fully.
Rig fourBar() {
  Rig r(4);
  r.link(0, 1, JointKind::Revolute, {0, 0, 0}, kZ);
  r.link(1, 2, JointKind::Revolute, {0, 40, 0}, kZ);
  r.link(2, 3, JointKind::Revolute, {100, 60, 0}, kZ);
  r.link(0, 3, JointKind::Revolute, {100, 0, 0}, kZ);
  return r;
}
double offIdentity(const Xform& x) {
  double worst = length(x.t);
  const Mat3 id;
  for (int i = 0; i < 9; i++) worst = std::max(worst, std::abs(x.r.m[i] - id.m[i]));
  return worst;
}
/// The angle a pose turns a body about z.
double turnZ(const Xform& x) { return std::atan2(x.r.m[3], x.r.m[0]); }
}  // namespace

TEST_CASE("a twist held for a time is a turn about a line", "[kin][drive]") {
  // Turning at 1 rad per unit about the vertical line through (10, 0, 0), for a quarter turn.
  const Twist t{{0, 0, 1}, cross(Vec3{10, 0, 0}, Vec3{0, 0, 1})};
  const Xform q = moved(t, kPi / 2);
  REQUIRE_THAT(length(q.apply({10, 0, 0}) - Vec3{10, 0, 0}), WithinAbs(0, 1e-12));  // on the line: stays
  REQUIRE_THAT(length(q.apply({20, 0, 0}) - Vec3{10, 10, 0}), WithinAbs(0, 1e-12));
  REQUIRE_THAT(length(moved({{}, {3, 0, 0}}, 2).apply({1, 1, 1}) - Vec3{7, 1, 1}), WithinAbs(0, 1e-12));
  REQUIRE(offIdentity(moved(t, 0)) == 0);
}

TEST_CASE("a four-bar's crank turned once round brings everything back", "[kin][drive]") {
  const Rig r = fourBar();
  const Mobility f = r.only();
  const Pose quarter = drive(r.sys, f, 0, 1, kPi / 2);
  REQUIRE(quarter.converged);
  REQUIRE_THAT(std::abs(turnZ(quarter.body[1])), WithinAbs(kPi / 2, 1e-9));
  // The coupler is still as long as it was, and still pinned at both ends.
  const Vec3 pinA = quarter.body[1].apply({0, 40, 0}), pinB = quarter.body[3].apply({100, 60, 0});
  REQUIRE_THAT(length(pinA - pinB), WithinAbs(length(Vec3{100, 20, 0}), 1e-7));
  REQUIRE_THAT(length(quarter.body[2].apply({0, 40, 0}) - pinA), WithinAbs(0, 1e-7));
  REQUIRE_THAT(length(quarter.body[2].apply({100, 60, 0}) - pinB), WithinAbs(0, 1e-7));
  REQUIRE(offIdentity(quarter.body[0]) == 0);  // the ground does not move

  const Pose full = drive(r.sys, f, 0, 1, 2 * kPi);
  REQUIRE(full.converged);
  for (uint32_t b = 0; b < 4; b++) REQUIRE(offIdentity(full.body[b]) < 1e-6);
  // Going on from a pose is the same as going there in one.
  const Pose rest = drive(r.sys, f, 0, 1, 3 * kPi / 2, &quarter);
  for (uint32_t b = 0; b < 4; b++) REQUIRE(offIdentity(rest.body[b]) < 1e-6);
  // Backwards is the mirror.
  const Pose back = drive(r.sys, f, 0, 1, -kPi / 2);
  REQUIRE(back.converged);
  REQUIRE_THAT(turnZ(back.body[1]), WithinAbs(-turnZ(quarter.body[1]), 1e-9));
}

TEST_CASE("a slider-crank's slider travels twice the crank's radius", "[kin][drive]") {
  Rig r(4);  // 1 crank (radius 30), 2 rod (100 long), 3 slider along x
  r.link(0, 1, JointKind::Revolute, {0, 0, 0}, kZ);
  r.link(1, 2, JointKind::Revolute, {30, 0, 0}, kZ);
  r.link(2, 3, JointKind::Revolute, {130, 0, 0}, kZ);
  r.link(0, 3, JointKind::Prismatic, {130, 0, 0}, kX);
  const Mobility f = r.only();
  const Pose half = drive(r.sys, f, 0, 1, kPi);
  REQUIRE(half.converged);
  REQUIRE_THAT(half.body[3].t.x, WithinAbs(-60, 1e-6));
  REQUIRE_THAT(half.body[3].t.y, WithinAbs(0, 1e-9));
  REQUIRE_THAT(offIdentity({half.body[3].r, {}}), WithinAbs(0, 1e-9));  // it slides without turning
  // Driven by the slider instead, from a pose just past the dead point. The slider does not
  // move in the model's own pose, so forwards is the way the crank's freedom is already taking it.
  const Pose start = drive(r.sys, f, 0, 1, 0.3);
  const Pose pulled = drive(r.sys, f, 0, 3, 30, &start);
  REQUIRE(pulled.converged);
  REQUIRE_THAT(pulled.body[3].t.x - start.body[3].t.x, WithinAbs(-30, 1e-6));
  // Backwards there is only the 1.3 LDU to the dead point.
  const Pose pushed = drive(r.sys, f, 0, 3, -30, &start);
  REQUIRE_FALSE(pushed.converged);
  REQUIRE(std::abs(pushed.reached) < 2);
  REQUIRE_THAT(length(pulled.body[1].apply({30, 0, 0}) - pulled.body[2].apply({30, 0, 0})), WithinAbs(0, 1e-7));
}

TEST_CASE("an 8-tooth gear turned once leaves the 24-tooth gear a third of a turn back, exactly", "[kin][drive]") {
  Rig r(3);
  r.link(0, 1, JointKind::Revolute, {0, 0, 0}, kZ);
  r.link(0, 2, JointKind::Revolute, {40, 0, 0}, kZ);
  const auto meshes = findMeshes({{1, spur(8, {0, 0, 0}), false}, {2, spur(24, {40, 0, 0}), false}});
  REQUIRE(meshes.size() == 1);
  r.sys.gearings.push_back({1, 2, meshes[0]});
  const Mobility f = r.only();
  const Pose turned = drive(r.sys, f, 0, 1, 2 * kPi);
  REQUIRE(turned.converged);
  REQUIRE(offIdentity(turned.body[1]) < 1e-9);
  const double direction = turnZ(drive(r.sys, f, 0, 1, 0.1).body[1]) > 0 ? 1 : -1;  // which way "forward" turned the small gear
  REQUIRE_THAT(turnZ(turned.body[2]), WithinAbs(-direction * 2 * kPi / 3, 1e-9));
  // Driven from the large gear: one turn of it is three of the small one.
  const Pose big = drive(r.sys, f, 0, 2, 2 * kPi / 3);
  REQUIRE(offIdentity(big.body[1]) < 1e-9);
}

TEST_CASE("a linkage driven past what it can do stops at its last good pose", "[kin][drive]") {
  // Crank 40, coupler 50, rocker 26.5 on a ground of 100: no link of it can go right round.
  Rig r(4);
  r.link(0, 1, JointKind::Revolute, {0, 0, 0}, kZ);
  r.link(1, 2, JointKind::Revolute, {40, 0, 0}, kZ);
  r.link(2, 3, JointKind::Revolute, {85, 21.794494717703369, 0}, kZ);  // 50 from the crank pin
  r.link(0, 3, JointKind::Revolute, {100, 0, 0}, kZ);
  REQUIRE_THAT(length(Vec3{85, 21.794494717703369, 0} - Vec3{100, 0, 0}), WithinAbs(26.457513110645905, 1e-9));
  const Mobility f = r.only();
  const Pose stuck = drive(r.sys, f, 0, 1, 2 * kPi);
  REQUIRE_FALSE(stuck.converged);
  REQUIRE(std::abs(stuck.reached) > 0.1);
  REQUIRE(std::abs(stuck.reached) < 2 * kPi);
  // Every joint is still closed in the pose it stopped at.
  REQUIRE_THAT(length(stuck.body[1].apply({40, 0, 0}) - stuck.body[2].apply({40, 0, 0})), WithinAbs(0, 1e-7));
  REQUIRE_THAT(length(stuck.body[3].apply({85, 21.794494717703369, 0}) - stuck.body[2].apply({85, 21.794494717703369, 0})), WithinAbs(0, 1e-7));
}

TEST_CASE("nothing to do: no amount, a driver that does not move, a body out of range", "[kin][drive]") {
  const Rig r = fourBar();
  const Mobility f = r.only();
  const Pose none = drive(r.sys, f, 0, 1, 0);
  REQUIRE(none.converged);
  REQUIRE(none.body.size() == 4);
  for (const Xform& x : none.body) REQUIRE(offIdentity(x) == 0);
  REQUIRE_FALSE(drive(r.sys, f, 0, 0, 1).converged);   // the ground is not moved by it
  REQUIRE_FALSE(drive(r.sys, f, 0, 99, 1).converged);
  REQUIRE(drive(System{}, Mobility{}, 0, 0, 1).body.empty());
  REQUIRE_FALSE(drive(r.sys, f, 5, 1, 1).converged);  // no such freedom
}
