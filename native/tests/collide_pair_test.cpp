#include <catch2/catch_test_macros.hpp>
#include <cmath>
#include <cstdlib>
#include <filesystem>
#include <limits>
#include "bm/collide/pair.h"

using namespace bm;
using namespace bm::collide;

namespace {
/// A 20 x 24 x 20 brick body: x and z from -10 to 10, y from 0 to 24.
const Shape& brick() {
  static const Shape shape = buildShape(ldraw::flatten("3005.dat", ldraw::Library(std::filesystem::path(BM_FIXTURES) / "lib")));
  return shape;
}
Xform at(double x, double y, double z) { return {Mat3::identity(), {x, y, z}}; }
bool hits(const Xform& b, const std::vector<Zone>& zones = {}, Hit* hit = nullptr) { return overlap(brick(), at(0, 0, 0), brick(), b, zones, hit); }
}  // namespace

TEST_CASE("bricks that touch do not overlap", "[collide][pair][focus]") {
  REQUIRE_FALSE(hits(at(0, -24, 0)));   // stacked
  REQUIRE_FALSE(hits(at(20, 0, 0)));    // side by side, sharing a wall plane
  REQUIRE_FALSE(hits(at(20, -24, 20))); // touching at one edge
  REQUIRE_FALSE(hits(at(500, 0, 0)));   // nowhere near
}

TEST_CASE("bricks pushed into each other overlap, even when perfectly aligned", "[collide][pair][focus]") {
  REQUIRE(hits(at(10, 0, 0)));     // same height, half a stud into each other
  REQUIRE(hits(at(0, -12, 0)));    // sunk half-way down
  REQUIRE(hits(at(10, -12, 10)));  // a corner into a corner
  REQUIRE(hits(at(3, 5, 7)));      // mostly inside
}

TEST_CASE("the skin decides how much overlap counts", "[collide][pair]") {
  REQUIRE_FALSE(hits(at(19.7, 0, 0)));  // 0.3 LDU into each other: within the skin
  REQUIRE(hits(at(19, 0, 0)));          // 1 LDU: a real overlap
  REQUIRE_FALSE(hits(at(0, -23.7, 0)));
  REQUIRE(hits(at(0, -23, 0)));
}

TEST_CASE("turned and mirrored placements", "[collide][pair]") {
  const double c = std::sqrt(0.5);
  const Xform turned{Mat3{{c, 0, c, 0, 1, 0, -c, 0, c}}, {0, 0, 0}};  // 45 degrees about y, in place
  REQUIRE(overlap(brick(), at(0, 0, 0), brick(), turned));
  // Turned 45 degrees and moved so its corner just reaches into the other's side.
  REQUIRE(overlap(brick(), at(0, 0, 0), brick(), Xform{turned.r, {22, 0, 0}}));        // corner 14.1 from its centre: 2.1 in
  REQUIRE_FALSE(overlap(brick(), at(0, 0, 0), brick(), Xform{turned.r, {24.5, 0, 0}})); // corner 0.4 short
  const Mat3 mirror{{-1, 0, 0, 0, 1, 0, 0, 0, 1}};
  REQUIRE(overlap(brick(), at(0, 0, 0), brick(), Xform{mirror, {10, 0, 0}}));
  REQUIRE_FALSE(overlap(brick(), at(0, 0, 0), brick(), Xform{mirror, {20, 0, 0}}));
  // Both pieces placed somewhere else entirely: only their relative pose matters.
  const Xform far{turned.r, {1000, -300, 77}};
  REQUIRE(overlap(brick(), far, brick(), far * at(10, 0, 0)));
  REQUIRE_FALSE(overlap(brick(), far, brick(), far * at(20, 0, 0)));
}

TEST_CASE("a crossing inside a mate's zone is exempt", "[collide][pair]") {
  Hit hit;
  REQUIRE(hits(at(10, 0, 0), {}, &hit));
  REQUIRE((hit.point.x > -1 && hit.point.x < 11 && hit.point.y > -1 && hit.point.y < 25));
  const Zone covering{{5, 0, 0}, {5, 24, 0}, 40};
  REQUIRE_FALSE(hits(at(10, 0, 0), {covering}));
  const Zone elsewhere{{200, 0, 0}, {200, 24, 0}, 5};
  REQUIRE(hits(at(10, 0, 0), {elsewhere}));
  // A zone that covers only part of the overlap leaves the rest to be found.
  const Zone partial{{5, 0, -10}, {5, 0, -10}, 3};
  REQUIRE(hits(at(10, 0, 0), {partial}));
}

TEST_CASE("empty shapes and broken transforms never overlap", "[collide][pair][focus]") {
  const Shape empty;
  REQUIRE_FALSE(overlap(empty, at(0, 0, 0), brick(), at(0, 0, 0)));
  REQUIRE_FALSE(overlap(brick(), at(0, 0, 0), empty, at(0, 0, 0)));
  const double nan = std::numeric_limits<double>::quiet_NaN();
  REQUIRE_FALSE(overlap(brick(), at(0, 0, 0), brick(), Xform{Mat3::identity(), {nan, 0, 0}}));
  Mat3 flat;
  for (double& v : flat.m) v = 0;
  REQUIRE_FALSE(overlap(brick(), Xform{flat, {0, 0, 0}}, brick(), at(0, 0, 0)));
  REQUIRE_FALSE(overlap(brick(), at(0, 0, 0), brick(), Xform{flat, {0, 0, 0}}));
}

TEST_CASE("touching stays touching far from the origin and at odd angles", "[collide][pair][review]") {
  // Placed thousands of LDU out and turned by an angle with no exact float form, two bricks
  // that share a face must still not overlap: rounding must never turn contact into a crossing.
  for (double angle : {0.1, 0.7, 1.3, 2.9}) {
    const double c = std::cos(angle), s = std::sin(angle);
    const Xform frame{Mat3{{c, 0, s, 0, 1, 0, -s, 0, c}}, {4321.7, -876.3, 2999.9}};
    REQUIRE_FALSE(overlap(brick(), frame, brick(), frame * at(20, 0, 0)));
    REQUIRE_FALSE(overlap(brick(), frame, brick(), frame * at(0, -24, 0)));
    REQUIRE_FALSE(overlap(brick(), frame, brick(), frame * at(20, -24, 20)));
    REQUIRE_FALSE(overlap(brick(), frame, brick(), frame * at(10, 24, 0)));   // half a stud along, on top
    REQUIRE(overlap(brick(), frame, brick(), frame * at(19, 0, 0)));
  }
}

TEST_CASE("a real pin whose tip rests against a brick's end face does not overlap it", "[collide][pair][review][data]") {
  const char* dir = std::getenv("BM_LDRAW_DIR");
  if (!dir) SKIP("BM_LDRAW_DIR is not set");
  const ldraw::Library library(dir);
  const Shape pin = buildShape(ldraw::flatten("2780.dat", library));   // along x, tips at x = -20 and 20
  const Shape wall = buildShape(ldraw::flatten("3007.dat", library));  // a 2x8 brick: x from -80 to 80
  for (double z : {-20.0, 0.0, 3.9, 20.0})   // on the brick's corner edges and across its face
    for (double y : {10.0, 12.3}) {
      INFO("z " << z << " y " << y);
      REQUIRE_FALSE(overlap(pin, at(-100, y, z), wall, at(0, 0, 0)));     // tip exactly on the face
      REQUIRE_FALSE(overlap(pin, at(-100.2, y, z), wall, at(0, 0, 0)));   // just short of it
      REQUIRE(overlap(pin, at(-97, y, z), wall, at(0, 0, 0)));            // 3 LDU into the brick
    }
}

TEST_CASE("joined pieces are allowed a second skin of overlap", "[collide][pair][review]") {
  // 0.8 LDU into each other: an overlap for strangers, a close fit for pieces joined there.
  REQUIRE(overlap(brick(), at(0, 0, 0), brick(), at(19.2, 0, 0)));
  REQUIRE_FALSE(overlap(brick(), at(0, 0, 0), brick(), at(19.2, 0, 0), {}, nullptr, Depth::Joined));
  REQUIRE_FALSE(overlap(brick(), at(0, 0, 0), brick(), at(0, -23.2, 0), {}, nullptr, Depth::Joined));
  // 3 LDU in is an overlap either way.
  REQUIRE(overlap(brick(), at(0, 0, 0), brick(), at(17, 0, 3), {}, nullptr, Depth::Joined));
  REQUIRE(overlap(brick(), at(0, 0, 0), brick(), at(2, -21, 3), {}, nullptr, Depth::Joined));
}

namespace {
/// Where overlap(), asked pose by pose every `step` along the way, first holds; -1 if nowhere.
double poseByPose(const Shape& a, const Xform& xa, Vec3 direction, double distance, double step, const Shape& b, const Xform& xb, const std::vector<Zone>& zones = {}) {
  for (double t = 0; t <= distance; t += step) {
    Xform pose = xa;
    pose.t = pose.t + direction * t;
    if (overlap(a, pose, b, xb, zones)) return t;
  }
  return -1;
}
/// What firstCrossing must give, against overlap() asked pose by pose every `step`: a travel
/// within kCrossingResolution of one at which they do cross, and none of those poses crossing
/// before it; or, if it finds none, none of those poses crossing either. Returns the travel
/// (-1 for none).
double agrees(const Shape& a, const Xform& xa, Vec3 direction, double distance, double step, const Shape& b, const Xform& xb, const std::vector<Zone>& zones = {}) {
  const double found = firstCrossing(a, xa, direction, distance, b, xb, zones);
  const double seen = poseByPose(a, xa, direction, distance, step, b, xb, zones);
  INFO("from " << xa.t.x << " " << xa.t.y << " " << xa.t.z << " along " << direction.x << " " << direction.y << " " << direction.z << ": found " << found << ", pose by pose " << seen);
  if (!(found <= distance)) {
    REQUIRE(seen < 0);
    return -1;
  }
  Xform there = xa;
  there.t = there.t + direction * (found + kCrossingResolution);
  REQUIRE(overlap(a, there, b, xb, zones));
  if (seen >= 0) REQUIRE(found <= seen + kCrossingResolution);
  return found;
}
}  // namespace

TEST_CASE("the first crossing along a way is where looking pose by pose finds it first", "[collide][pair][sweep]") {
  struct Case {
    Xform start;
    Vec3 direction;
    bool hits;
  };
  const double r = std::sqrt(0.5);
  const Case cases[] = {
      {at(-60, 0, 0), {1, 0, 0}, true},       // straight into the other brick
      {at(-60, 0, 20), {1, 0, 0}, false},     // past it, sharing a wall plane all the way: never a hit
      {at(-60, 0, 19.2), {1, 0, 0}, true},    // past it 0.8 inside its wall: a hit
      {at(-60, 0, 19.7), {1, 0, 0}, false},   // past it 0.3 inside its wall: under the skin, never a hit
      {at(0, -60, 0), {0, 1, 0}, true},       // down onto it
      {at(-40, -40, 3), {r, r, 0}, true},     // at a slant
      {at(-60, 30, 0), {1, 0, 0}, false},     // underneath, clear
      {at(0, 0, 0), {1, 0, 0}, true},         // starting on top of it, its double: crossing as soon as it moves
  };
  for (const Case& c : cases) REQUIRE((agrees(brick(), c.start, c.direction, 80, 0.01, brick(), at(0, 0, 0)) >= 0) == c.hits);
  // Straight in, it stops where the skin is used up: 60 to touching, a skin and a touch more to cross.
  const double in = firstCrossing(brick(), at(-60, 0, 0), {1, 0, 0}, 80, brick(), at(0, 0, 0));
  REQUIRE(in > 40 + kSkin);
  REQUIRE(in < 40 + kSkin + 0.1);
  REQUIRE(firstCrossing(brick(), at(5, 0, 0), {1, 0, 0}, 80, brick(), at(0, 0, 0)) == 0);  // in the way from the start
  // The moving piece turned, and a zone that forgives the first part of the hit.
  Xform turned = at(-60, 2, 5);
  turned.r = Mat3{{r, 0, r, 0, 1, 0, -r, 0, r}};
  const std::vector<Zone> zone{{{-10, -10, 5}, {-10, 40, 5}, 6}};  // along the wall's edge where the corner arrives
  const double bare = agrees(brick(), turned, {1, 0, 0}, 80, 0.01, brick(), at(0, 0, 0));
  const double forgiven = agrees(brick(), turned, {1, 0, 0}, 80, 0.01, brick(), at(0, 0, 0), zone);
  REQUIRE(bare >= 0);
  REQUIRE(forgiven > bare);
  // No way to go: only where it starts is looked at.
  REQUIRE(firstCrossing(brick(), at(-60, 0, 0), {1, 0, 0}, 0, brick(), at(0, 0, 0)) > 0);
  REQUIRE(firstCrossing(brick(), at(5, 0, 0), {1, 0, 0}, 0, brick(), at(0, 0, 0)) == 0);
}

TEST_CASE("a crossing that lasts a fraction of a step of the way is found", "[collide][pair][sweep]") {
  // Corner past corner on a slant: 0.6 into each other at the closest, at a travel of 40.25,
  // and more than a skin only for about a tenth of a step either side of it.
  const double s = std::sqrt(0.5);
  const Xform start = at(19.4 - 40.25 * s, 0, 19.4 + 40.25 * s);
  const Vec3 d{s, 0, -s};
  REQUIRE(poseByPose(brick(), start, d, 80, kSweepStep, brick(), at(0, 0, 0)) < 0);  // stepped over
  const double found = agrees(brick(), start, d, 80, 0.001, brick(), at(0, 0, 0));
  REQUIRE(found > 40.25 - kSweepStep / 2);
  REQUIRE(found < 40.25);
}

TEST_CASE("real parts passing closely: the first crossing is where pose by pose finds it", "[collide][pair][sweep][data]") {
  const char* dir = std::getenv("BM_LDRAW_DIR");
  if (!dir) SKIP("BM_LDRAW_DIR is not set");
  const ldraw::Library library(dir);
  const Shape round = buildShape(ldraw::flatten("3941.dat", library));  // a 2x2 round brick
  const Shape pin = buildShape(ldraw::flatten("2780.dat", library));
  const Shape beam = buildShape(ldraw::flatten("32524.dat", library));  // a 1x7 liftarm
  const double r = std::sqrt(0.5);
  int hitsSeen = 0, clearSeen = 0;
  auto same = [&](const Shape& a, const Xform& xa, Vec3 d, const Shape& b) { (agrees(a, xa, d, 120, 0.02, b, at(0, 0, 0)) >= 0 ? hitsSeen : clearSeen)++; };
  for (double offset : {0.0, 20.0, 38.0, 39.4, 39.8, 40.0, 41.0})  // through, grazing and beside another round brick
    for (Vec3 d : {Vec3{1, 0, 0}, Vec3{0, 1, 0}, Vec3{r, 0, r}}) {
      same(round, at(-60 * d.x + offset * d.z, -60 * d.y, -60 * d.z + offset * (d.x + d.y)), d, round);
    }
  for (double y : {-2.0, 0.0, 10.0, 12.0})  // a pin along x passing a liftarm's holes
    for (double z : {-9.6, 0.0, 9.0, 11.0}) same(pin, at(-90, y, z), {1, 0, 0}, beam);
  Xform tipped = at(-80, 6, 3);
  tipped.r = Mat3{{r, -r, 0, r, r, 0, 0, 0, 1}};
  same(pin, tipped, {1, 0, 0}, beam);
  REQUIRE(hitsSeen > 5);
  REQUIRE(clearSeen > 5);
}

TEST_CASE("where a straight way passes through a surface", "[collide][pair][sweep]") {
  // The brick's body: x and z from -10 to 10, y from 0 to 24.
  Vec3 where;
  const double share = throughSurface(brick(), at(0, 0, 0), {-30, 12, 1}, {30, 12, 1}, &where);
  REQUIRE(std::abs(share - 1.0 / 3) < 1e-6);  // the wall at x = -10, a third of the way
  REQUIRE(std::abs(where.x + 10) < 1e-6);
  REQUIRE(throughSurface(brick(), at(0, 0, 0), {-30, 12, 1}, {-12, 12, 1}) > 1);   // stops short of it
  REQUIRE(throughSurface(brick(), at(0, 0, 0), {-30, 40, 1}, {30, 40, 1}) > 1);    // passes underneath
  REQUIRE(throughSurface(brick(), at(0, 0, 0), {-30, 12, 1}, {-30, 12, 1}) > 1);   // no way at all
  // The same seen with the brick moved and turned a quarter about y.
  Xform placed = at(100, 0, 0);
  placed.r = Mat3{{0, 0, 1, 0, 1, 0, -1, 0, 0}};
  REQUIRE(std::abs(throughSurface(brick(), placed, {70, 12, 1}, {130, 12, 1}) - 1.0 / 3) < 1e-6);
  REQUIRE(throughSurface(Shape{}, at(0, 0, 0), {-30, 12, 1}, {30, 12, 1}) > 1);    // nothing there
}
