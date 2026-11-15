#include <catch2/catch_test_macros.hpp>
#include <cmath>
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
