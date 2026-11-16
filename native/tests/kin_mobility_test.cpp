#include <catch2/catch_test_macros.hpp>
#include <catch2/matchers/catch_matchers_floating_point.hpp>
#include <cmath>
#include "bm/kin/mobility.h"

using namespace bm;
using namespace bm::kin;
using connect::JointKind;
using Catch::Matchers::WithinAbs;

namespace {
const Vec3 kX{1, 0, 0}, kY{0, 1, 0}, kZ{0, 0, 1};

/// A system written by hand: body 0 is the ground unless said otherwise.
struct Rig {
  System sys;
  explicit Rig(uint32_t bodies) {
    sys.bodies = bodies;
    sys.size.assign(bodies, 1);
    if (bodies) sys.size[0] = 100;
    sys.pieces.resize(bodies);
    for (uint32_t b = 0; b < bodies; b++) sys.pieces[b] = {b}, sys.bodyOf.push_back(b);
  }
  void link(uint32_t a, uint32_t b, JointKind kind, Vec3 point, Vec3 axis) { sys.links.push_back({std::min(a, b), std::max(a, b), kind, point, axis, a, b}); }
  /// Meshes the gears on bodies a and b; each `Toothed` is in model space.
  void mesh(uint32_t a, const Toothed& ta, uint32_t b, const Toothed& tb) {
    const auto found = findMeshes({{a, ta, false}, {b, tb, false}});
    REQUIRE(found.size() == 1);
    sys.gearings.push_back({found[0].a, found[0].b, found[0]});
  }
  std::vector<Freedom> mechanisms() const {
    std::vector<Freedom> out;
    for (const Freedom& f : mobility(sys).freedoms)
      if (!f.local) out.push_back(f);
    return out;
  }
};
Toothed spur(int teeth, Vec3 centre, Vec3 axis = {0, 0, 1}) {
  Toothed t;
  t.kind = ToothKind::Spur;
  t.teeth = teeth;
  t.pitchRadius = teeth * 1.25;
  t.axis = axis;
  t.centre = centre;
  t.width = 10;
  return t;
}
Toothed bevel(int teeth, Vec3 centre, Vec3 axis, Vec3 facing) {
  Toothed t = spur(teeth, centre, axis);
  t.kind = ToothKind::Bevel;
  t.facing = facing;
  return t;
}
}  // namespace

TEST_CASE("nothing to move: empty systems, single bodies, rigid structures", "[kin][mobility][focus]") {
  // Review Focus 3.
  REQUIRE(mobility(System{}).freedoms.empty());
  REQUIRE(mobility(Rig(1).sys).freedoms.empty());
  // A triangle of beams pinned at its corners is rigid.
  Rig tri(3);
  tri.link(0, 1, JointKind::Revolute, {0, 0, 0}, kZ);
  tri.link(1, 2, JointKind::Revolute, {100, 0, 0}, kZ);
  tri.link(0, 2, JointKind::Revolute, {50, 80, 0}, kZ);
  const Mobility m = mobility(tri.sys);
  REQUIRE(m.solved);
  REQUIRE(m.freedoms.empty());
  REQUIRE((m.moves == std::vector<uint8_t>{0, 0, 0}));
  REQUIRE(m.held[0] == 1);
}

TEST_CASE("a body on one link is a freedom by itself", "[kin][mobility]") {
  Rig r(4);
  r.link(0, 1, JointKind::Revolute, {100, 0, 0}, kZ);     // a wheel
  r.link(0, 2, JointKind::Cylindrical, {0, 50, 0}, kX);   // a loose axle
  r.link(0, 3, JointKind::Spherical, {0, 0, 70}, kZ);     // a ball
  const Mobility m = mobility(r.sys);
  REQUIRE(m.freedoms.size() == 6);  // 1 + 2 + 3
  for (const Freedom& f : m.freedoms) REQUIRE((f.local && f.bodies.size() == 1));
  REQUIRE(m.solvedBodies == 0);  // none of this needed the equations
  // The wheel turns about its link: its point on the axis does not move.
  const Freedom& wheel = *std::find_if(m.freedoms.begin(), m.freedoms.end(), [](const Freedom& f) { return f.bodies[0] == 1; });
  REQUIRE_THAT(length(velocityAt(wheel.twists[0], {100, 0, 30})), WithinAbs(0, 1e-12));
  REQUIRE_THAT(length(velocityAt(wheel.twists[0], {110, 0, 0})), WithinAbs(10, 1e-12));
}

TEST_CASE("an arm on a hinge carries the wheel on its end", "[kin][mobility]") {
  Rig r(3);
  r.link(0, 1, JointKind::Revolute, {0, 0, 0}, kZ);
  r.link(1, 2, JointKind::Revolute, {100, 0, 0}, kX);
  const Mobility m = mobility(r.sys);
  REQUIRE(m.freedoms.size() == 2);
  REQUIRE((m.freedoms[0].local && m.freedoms[0].bodies == std::vector<uint32_t>{2}));
  REQUIRE((!m.freedoms[1].local && m.freedoms[1].bodies == std::vector<uint32_t>{1, 2}));
  // Swinging the arm moves the wheel's centre about the hinge.
  REQUIRE_THAT(velocityAt(twistOf(m.freedoms[1], 2), {100, 0, 0}).y, WithinAbs(100, 1e-9));
}

TEST_CASE("a four-bar linkage has one freedom that moves three bodies", "[kin][mobility]") {
  Rig r(4);
  r.link(0, 1, JointKind::Revolute, {0, 0, 0}, kZ);
  r.link(1, 2, JointKind::Revolute, {0, 40, 0}, kZ);
  r.link(2, 3, JointKind::Revolute, {100, 60, 0}, kZ);
  r.link(0, 3, JointKind::Revolute, {100, 0, 0}, kZ);
  const Mobility m = mobility(r.sys);
  REQUIRE(m.solved);
  REQUIRE(m.freedoms.size() == 1);
  REQUIRE((m.freedoms[0].bodies == std::vector<uint32_t>{1, 2, 3} && !m.freedoms[0].local));
  REQUIRE(m.solvedBodies == 3);
  // The coupler's two pins move with the crank and the rocker.
  const Freedom& f = m.freedoms[0];
  REQUIRE_THAT(length(velocityAt(twistOf(f, 1), {0, 40, 0}) - velocityAt(twistOf(f, 2), {0, 40, 0})), WithinAbs(0, 1e-9));
  REQUIRE_THAT(length(velocityAt(twistOf(f, 3), {100, 60, 0}) - velocityAt(twistOf(f, 2), {100, 60, 0})), WithinAbs(0, 1e-9));
}

TEST_CASE("meshed gears turn in the exact ratio of their teeth", "[kin][mobility]") {
  Rig r(3);
  r.link(0, 1, JointKind::Revolute, {0, 0, 0}, kZ);
  r.link(0, 2, JointKind::Revolute, {40, 0, 0}, kZ);
  r.mesh(1, spur(8, {0, 0, 0}), 2, spur(24, {40, 0, 0}));
  const auto found = r.mechanisms();
  REQUIRE(found.size() == 1);
  const auto ratio13 = ratio(found[0], 1, 2);
  REQUIRE(ratio13.has_value());
  REQUIRE((ratio13->exact && ratio13->num == -1 && ratio13->den == 3));
  REQUIRE_THAT(ratio13->value, WithinAbs(-1.0 / 3, 1e-12));
  const auto back = ratio(found[0], 2, 1);
  REQUIRE((back->num == -3 && back->den == 1));
  REQUIRE_FALSE(ratio(found[0], 0, 1).has_value());  // the ground does not turn

  // A train: 8 -> 24 on one shaft with a 16 -> 40 after it: 1/3 * 16/40 = 2/15, turning the same way.
  Rig train(4);
  train.link(0, 1, JointKind::Revolute, {0, 0, 0}, kZ);
  train.link(0, 2, JointKind::Revolute, {40, 0, 0}, kZ);
  train.link(0, 3, JointKind::Revolute, {110, 0, 0}, kZ);
  train.mesh(1, spur(8, {0, 0, 0}), 2, spur(24, {40, 0, 0}));
  train.mesh(2, spur(16, {40, 0, 20}), 3, spur(40, {110, 0, 20}));
  const auto t = train.mechanisms();
  REQUIRE(t.size() == 1);
  const auto overall = ratio(t[0], 1, 3);
  REQUIRE((overall->exact && overall->num == 2 && overall->den == 15));
}

TEST_CASE("a ring of gears whose ratios cannot agree is locked", "[kin][mobility][focus]") {
  // Review Focus 4: three gears each meshing the other two.
  Rig r(4);
  const Vec3 a{0, 0, 0}, b{40, 0, 0}, c{20, 34.641016151377549, 0};  // 16 teeth each, 40 apart
  r.link(0, 1, JointKind::Revolute, a, kZ);
  r.link(0, 2, JointKind::Revolute, b, kZ);
  r.link(0, 3, JointKind::Revolute, c, kZ);
  r.mesh(1, spur(16, a), 2, spur(16, b));
  r.mesh(2, spur(16, b), 3, spur(16, c));
  r.mesh(1, spur(16, a), 3, spur(16, c));
  const Mobility m = mobility(r.sys);
  REQUIRE(m.solved);
  REQUIRE(m.freedoms.empty());
  REQUIRE((m.moves[1] == 0 && m.moves[2] == 0 && m.moves[3] == 0));
}

TEST_CASE("a rack moves at the pinion's rim speed", "[kin][mobility]") {
  Rig r(3);
  r.link(0, 1, JointKind::Revolute, {0, -14, 0}, kZ);
  r.link(0, 2, JointKind::Prismatic, {0, 0, 0}, kX);
  Toothed rack;
  rack.kind = ToothKind::Rack;
  rack.teeth = 10;
  rack.axis = kX;
  rack.centre = {0, -4, 0};
  rack.length = 80;
  rack.width = 20;
  rack.face = {0, -1, 0};
  r.mesh(1, spur(8, {0, -14, 0}), 2, rack);
  const auto found = r.mechanisms();
  REQUIRE(found.size() == 1);
  const Twist pinion = twistOf(found[0], 1), slide = twistOf(found[0], 2);
  REQUIRE_THAT(length(slide.angular), WithinAbs(0, 1e-12));
  REQUIRE_THAT(length(slide.linear), WithinAbs(10 * length(pinion.angular), 1e-9));  // radius 10
  REQUIRE_THAT(std::abs(slide.linear.x), WithinAbs(length(slide.linear), 1e-12));
}

TEST_CASE("a worm turns its gear one tooth a turn", "[kin][mobility]") {
  Rig r(3);
  r.link(0, 1, JointKind::Revolute, {0, 0, 0}, kZ);   // the worm, along z
  r.link(0, 2, JointKind::Revolute, {40, 0, 0}, kY);  // a 24-tooth gear beside it
  Toothed worm;
  worm.kind = ToothKind::Worm;
  worm.teeth = 1;
  worm.axis = kZ;
  worm.pitchRadius = 10;
  worm.width = 40;
  worm.lead = 2 * 3.14159265358979323846 * 30 / 24;  // one tooth of a 24-tooth gear of radius 30
  r.mesh(2, spur(24, {40, 0, 0}, kY), 1, worm);
  const auto found = r.mechanisms();
  REQUIRE(found.size() == 1);
  const auto reduction = ratio(found[0], 1, 2);
  REQUIRE((reduction->exact && std::abs(reduction->num) == 1 && reduction->den == 24));
}

TEST_CASE("a differential has two freedoms, and its side gears turn opposite ways on a still carrier", "[kin][mobility]") {
  // Ground 0; carrier 1 and the two side gears 2, 3 turn about x; the planet 4 turns about z on the carrier.
  Rig r(5);
  r.link(0, 1, JointKind::Revolute, {0, 0, 0}, kX);
  r.link(0, 2, JointKind::Revolute, {-15, 0, 0}, kX);
  r.link(0, 3, JointKind::Revolute, {15, 0, 0}, kX);
  r.link(1, 4, JointKind::Revolute, {0, 0, 15}, kZ);
  r.mesh(2, bevel(12, {-15, 0, 0}, kX, {1, 0, 0}), 4, bevel(12, {0, 0, 15}, kZ, {0, 0, -1}));
  r.mesh(3, bevel(12, {15, 0, 0}, kX, {-1, 0, 0}), 4, bevel(12, {0, 0, 15}, kZ, {0, 0, -1}));
  const Mobility m = mobility(r.sys);
  REQUIRE(m.solved);
  REQUIRE(m.freedoms.size() == 2);
  // In every motion the carrier turns at the mean of the two side gears.
  for (const Freedom& f : m.freedoms) {
    const double carrier = twistOf(f, 1).angular.x, left = twistOf(f, 2).angular.x, right = twistOf(f, 3).angular.x;
    REQUIRE_THAT(carrier, WithinAbs((left + right) / 2, 1e-9));
  }
}

TEST_CASE("separate mechanisms come out as separate freedoms", "[kin][mobility]") {
  // Two gear pairs that have nothing to do with each other, in one system.
  Rig r(5);
  for (uint32_t pair = 0; pair < 2; pair++) {
    const double y = 200.0 * pair;
    r.link(0, 1 + 2 * pair, JointKind::Revolute, {0, y, 0}, kZ);
    r.link(0, 2 + 2 * pair, JointKind::Revolute, {40, y, 0}, kZ);
    r.mesh(1 + 2 * pair, spur(8, {0, y, 0}), 2 + 2 * pair, spur(24, {40, y, 0}));
  }
  const auto found = r.mechanisms();
  REQUIRE(found.size() == 2);
  for (const Freedom& f : found) REQUIRE(f.bodies.size() == 2);
  REQUIRE(found[0].bodies != found[1].bodies);
}

TEST_CASE("a group with no ground in it holds its largest body still", "[kin][mobility]") {
  Rig r(4);  // bodies 1, 2, 3 are a hinge chain apart from the ground
  r.sys.size = {100, 5, 9, 2};
  r.link(1, 2, JointKind::Revolute, {0, 0, 0}, kZ);
  r.link(2, 3, JointKind::Revolute, {50, 0, 0}, kZ);
  const Mobility m = mobility(r.sys);
  REQUIRE((m.held[2] == 1 && m.held[1] == 0 && m.held[3] == 0));
  REQUIRE(m.freedoms.size() == 2);
  REQUIRE((m.moves[2] == 0 && m.moves[1] == 1 && m.moves[3] == 1));
}

TEST_CASE("a moving core over the limit is reported, not attempted", "[kin][mobility][focus]") {
  // Review Focus 5: a ring of 500 hinged bodies.
  const uint32_t n = 500;
  Rig r(n);
  for (uint32_t i = 0; i < n; i++) r.link(i, (i + 1) % n, JointKind::Revolute, {10.0 * i, 0, 0}, kZ);
  const Mobility m = mobility(r.sys);
  REQUIRE_FALSE(m.solved);
  REQUIRE(m.reason.find("499") != std::string::npos);
}
