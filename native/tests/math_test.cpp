#include <catch2/catch_test_macros.hpp>
#include <catch2/matchers/catch_matchers_floating_point.hpp>
#include <cmath>
#include "bm/math.h"

using namespace bm;
using Catch::Matchers::WithinAbs;

static Xform turnY90(Vec3 t) {
  // LDraw row-major: x' = z, z' = -x.
  return Xform{Mat3{{0, 0, 1, 0, 1, 0, -1, 0, 0}}, t};
}

TEST_CASE("a transform times its inverse is the identity", "[math]") {
  const double c = std::cos(0.7), s = std::sin(0.7);
  const Xform a{Mat3{{c, -s, 0, s, c, 0, 0, 0, 1}}, Vec3{3, -40, 12.5}};
  const Xform b = a * turnY90({1, 2, 3});
  const Xform i = b * b.inverse();
  const Xform id = Xform::identity();
  for (int k = 0; k < 9; k++) REQUIRE_THAT(i.r.m[k], WithinAbs(id.r.m[k], 1e-12));
  REQUIRE_THAT(i.t.x, WithinAbs(0, 1e-12));
  REQUIRE_THAT(i.t.y, WithinAbs(0, 1e-12));
  REQUIRE_THAT(i.t.z, WithinAbs(0, 1e-12));
}

TEST_CASE("composition applies the right-hand transform first", "[math]") {
  const Xform move{Mat3::identity(), {10, 0, 0}};
  const Vec3 p = (turnY90({0, 0, 0}) * move).apply({0, 0, 0});
  REQUIRE_THAT(p.x, WithinAbs(0, 1e-12));
  REQUIRE_THAT(p.z, WithinAbs(-10, 1e-12));
}

TEST_CASE("a box turned a quarter keeps its corners", "[math]") {
  Box b;
  REQUIRE(b.empty());
  b.grow({0, 0, 0});
  b.grow({40, 24, 20});
  REQUIRE_FALSE(b.empty());
  const Box t = b.transformed(turnY90({100, 0, 0}));
  REQUIRE_THAT(t.min.x, WithinAbs(100, 1e-12));
  REQUIRE_THAT(t.max.x, WithinAbs(120, 1e-12));
  REQUIRE_THAT(t.min.y, WithinAbs(0, 1e-12));
  REQUIRE_THAT(t.max.y, WithinAbs(24, 1e-12));
  REQUIRE_THAT(t.min.z, WithinAbs(-40, 1e-12));
  REQUIRE_THAT(t.max.z, WithinAbs(0, 1e-12));
  REQUIRE(Box{}.transformed(turnY90({1, 1, 1})).empty());
}

TEST_CASE("determinant sees a mirror", "[math]") {
  REQUIRE(determinant(Mat3::identity()) == 1.0);
  REQUIRE(determinant(Mat3{{-1, 0, 0, 0, 1, 0, 0, 0, 1}}) == -1.0);
}

TEST_CASE("vector basics", "[math]") {
  const Vec3 a{1, 2, 3}, b{4, 5, 6};
  REQUIRE(dot(a, b) == 32.0);
  const Vec3 c = cross(a, b);
  REQUIRE((c.x == -3.0 && c.y == 6.0 && c.z == -3.0));
  REQUIRE_THAT(length(normalized(Vec3{0, 3, 4})), WithinAbs(1, 1e-15));
  REQUIRE(length(normalized(Vec3{0, 0, 0})) == 0.0);
}
