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
/// What firstOverlap must give: overlap() asked at every travel in turn.
size_t poseByPose(const Shape& a, const Xform& xa, Vec3 direction, const std::vector<double>& at, const Shape& b, const Xform& xb, const std::vector<Zone>& zones) {
  for (size_t i = 0; i < at.size(); i++) {
    Xform pose = xa;
    pose.t = pose.t + direction * at[i];
    if (overlap(a, pose, b, xb, zones)) return i;
  }
  return at.size();
}
std::vector<double> every(double step, double upTo) {
  std::vector<double> at;
  for (double t = 0; t <= upTo; t += step) at.push_back(t);
  return at;
}
}  // namespace

TEST_CASE("a whole way looked at in one go gives what looking pose by pose gives", "[collide][pair][sweep]") {
  const std::vector<double> travels = every(0.5, 80);
  struct Case {
    Xform start;
    Vec3 direction;
  };
  const double r = std::sqrt(0.5);
  const Case cases[] = {
      {at(-60, 0, 0), {1, 0, 0}},        // straight into the other brick
      {at(-60, 0, 20), {1, 0, 0}},       // past it, sharing a wall plane all the way: never a hit
      {at(-60, 0, 19.2), {1, 0, 0}},     // past it 0.8 inside its wall: a hit
      {at(-60, 0, 19.7), {1, 0, 0}},     // past it 0.3 inside its wall: under the skin, never a hit
      {at(0, -60, 0), {0, 1, 0}},        // down onto it
      {at(-40, -40, 3), {r, r, 0}},      // at a slant
      {at(-60, 30, 0), {1, 0, 0}},       // underneath, clear
      {at(0, 0, 0), {1, 0, 0}},          // starting inside it
  };
  for (const Case& c : cases) {
    INFO("from " << c.start.t.x << " " << c.start.t.y << " " << c.start.t.z << " along " << c.direction.x << " " << c.direction.y << " " << c.direction.z);
    REQUIRE(firstOverlap(brick(), c.start, c.direction, travels.data(), travels.size(), brick(), at(0, 0, 0)) == poseByPose(brick(), c.start, c.direction, travels, brick(), at(0, 0, 0), {}));
  }
  // The moving piece turned, and a zone that forgives the first part of the hit.
  Xform turned = at(-60, 2, 5);
  turned.r = Mat3{{r, 0, r, 0, 1, 0, -r, 0, r}};
  const std::vector<Zone> zone{{{-10, -10, 5}, {-10, 40, 5}, 6}};  // along the wall's edge where the corner arrives
  REQUIRE(firstOverlap(brick(), turned, {1, 0, 0}, travels.data(), travels.size(), brick(), at(0, 0, 0)) == poseByPose(brick(), turned, {1, 0, 0}, travels, brick(), at(0, 0, 0), {}));
  REQUIRE(firstOverlap(brick(), turned, {1, 0, 0}, travels.data(), travels.size(), brick(), at(0, 0, 0), zone) == poseByPose(brick(), turned, {1, 0, 0}, travels, brick(), at(0, 0, 0), zone));
  REQUIRE(poseByPose(brick(), turned, {1, 0, 0}, travels, brick(), at(0, 0, 0), zone) > poseByPose(brick(), turned, {1, 0, 0}, travels, brick(), at(0, 0, 0), {}));
  REQUIRE(firstOverlap(brick(), at(0, 0, 0), {1, 0, 0}, travels.data(), 0, brick(), at(0, 0, 0)) == 0);  // no travels: none hits
}

TEST_CASE("real parts passing closely: one go gives what pose by pose gives", "[collide][pair][sweep][data]") {
  const char* dir = std::getenv("BM_LDRAW_DIR");
  if (!dir) SKIP("BM_LDRAW_DIR is not set");
  const ldraw::Library library(dir);
  const Shape round = buildShape(ldraw::flatten("3941.dat", library));  // a 2x2 round brick
  const Shape pin = buildShape(ldraw::flatten("2780.dat", library));
  const Shape beam = buildShape(ldraw::flatten("32524.dat", library));  // a 1x7 liftarm
  const std::vector<double> travels = every(0.5, 120);
  const double r = std::sqrt(0.5);
  int hitsSeen = 0, clearSeen = 0;
  auto same = [&](const Shape& a, const Xform& xa, Vec3 d, const Shape& b) {
    const size_t want = poseByPose(a, xa, d, travels, b, at(0, 0, 0), {});
    INFO("from " << xa.t.x << " " << xa.t.y << " " << xa.t.z << " along " << d.x << " " << d.y << " " << d.z);
    REQUIRE(firstOverlap(a, xa, d, travels.data(), travels.size(), b, at(0, 0, 0)) == want);
    (want < travels.size() ? hitsSeen : clearSeen)++;
  };
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
