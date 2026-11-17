#include <catch2/catch_test_macros.hpp>
#include <cmath>
#include "bmr/cull.h"
#include "bmr/tolerances.h"
#include "helpers.h"

using namespace bm;
using namespace bmr;
using bmtest::piece;

namespace {
struct Rig {
  ldraw::Library lib = bmtest::fixtureLibrary();
  ldraw::PartCache parts{lib, bmtest::cacheDir()};
};
// The fixture 3005 is a box 20 wide, 24 tall (y 0..24), 20 deep.
const Box kBrick{{-10, 0, -10}, {10, 24, 10}};

std::vector<Box> boundsOf(const Scene& s) {
  std::vector<Box> out;
  for (const Group& g : s.groups) out.push_back(g.part == "3005.dat" ? kBrick : Box{{-20, 0, -40}, {20, 24, 40}});
  return out;
}
// The box of an instance under its matrix, in world space less the origin, by its eight corners.
void corners(const Instance& in, const Box& b, Vec3 out[8]) {
  for (int k = 0; k < 8; k++) {
    const Vec3 p{k & 1 ? b.max.x : b.min.x, k & 2 ? b.max.y : b.min.y, k & 4 ? b.max.z : b.min.z};
    const float* m = in.model;
    out[k] = {m[0] * p.x + m[1] * p.y + m[2] * p.z + m[3], m[4] * p.x + m[5] * p.y + m[6] * p.z + m[7], m[8] * p.x + m[9] * p.y + m[10] * p.z + m[11]};
  }
}
}  // namespace

TEST_CASE("pieces outside the view are culled and those inside are kept", "[cull]") {
  Rig r;
  std::string text;
  for (int i = 0; i < 100; i++) text += piece("3005.dat", 40.0 * i, 0, 0, 4);
  const Model m = bmtest::modelFrom(text, r.lib);
  const Scene s = buildScene(m, r.parts);
  REQUIRE(s.groups.size() == 1);
  // From the front, at a distance where the view is about 800 wide: some 20 bricks.
  Camera c;
  c.target = {1980, 12, 0}, c.eye = {1980, 12, -400 / std::tan(0.3)}, c.aspect = 1, c.near = 1, c.far = 1e5;
  const std::vector<Visible> v = cull(s, boundsOf(s), c, 1000);
  uint32_t kept = 0;
  for (const auto& d : v[0].byDetail) kept += static_cast<uint32_t>(d.size());
  REQUIRE(kept + v[0].culled == 100);
  REQUIRE(kept >= 18);
  REQUIRE(kept <= 24);
  // Checked by projecting corners, not by the frustum: wholly in view is kept, wholly to one side is culled.
  const Mat4 vp = multiply(projectionMatrix(c), viewMatrix(c, s.origin));
  std::vector<bool> isKept(100, false);
  for (const auto& d : v[0].byDetail)
    for (uint32_t i : d) isKept[i] = true;
  for (uint32_t i = 0; i < 100; i++) {
    Vec3 p[8];
    corners(s.groups[0].instances[i], kBrick, p);
    bool allIn = true, allLeft = true, allRight = true;
    for (const Vec3& q : p) {
      float clip[4];
      transform(vp, q, clip);
      const double x = clip[0] / clip[3], y = clip[1] / clip[3];
      allIn = allIn && std::abs(x) <= 1 && std::abs(y) <= 1;
      allLeft = allLeft && x < -1, allRight = allRight && x > 1;
    }
    INFO("brick " << i);
    if (allIn) REQUIRE(isKept[i]);
    if (allLeft || allRight) REQUIRE_FALSE(isKept[i]);
  }
}

TEST_CASE("detail falls with size on screen and nothing is dropped", "[cull]") {
  Rig r;
  const Model m = bmtest::modelFrom(piece("3005.dat", 0, 0, 0, 4), r.lib);
  const Scene s = buildScene(m, r.parts);
  // The brick's sphere is sqrt(10^2 + 12^2 + 10^2) = 18.5 across its middle; it looks
  // 2 * 18.5 * 1000 / (d * tan 0.3) pixels tall from distance d in a view 1000 tall.
  const double radius = std::sqrt(344.0);
  int expected = 0;
  for (double pixels : {200.0, 20.0, 2.0}) {
    Camera c;
    c.target = {0, 12, 0};
    c.eye = {0, 12, -2 * radius * 1000 / (pixels * std::tan(0.3))};
    c.near = 1, c.far = 1e7;
    const std::vector<Visible> v = cull(s, boundsOf(s), c, 1000);
    INFO(pixels << " px");
    REQUIRE(v[0].culled == 0);
    for (int d = 0; d < 3; d++) REQUIRE(v[0].byDetail[d].size() == (d == expected ? 1u : 0u));
    expected++;
  }
  REQUIRE(projectedPixels(radius, 1, 0.6, 1000) == 1000);  // the eye inside the sphere
  // Forced detail puts everything kept at that level.
  Camera c;
  c.target = {0, 12, 0}, c.eye = {0, 12, -100};
  REQUIRE(cull(s, boundsOf(s), c, 1000, 2)[0].byDetail[2].size() == 1);
}

TEST_CASE("culling is the same on one thread and many", "[cull]") {
  Rig r;
  std::string text;
  uint32_t seed = 7;
  auto next = [&] { return (seed = seed * 1664525u + 1013904223u) >> 8; };
  for (int i = 0; i < 2000; i++) text += piece(i % 3 ? "3005.dat" : "3001.dat", double(next() % 4000) - 2000, -double(next() % 400), double(next() % 4000) - 2000, int(next() % 2) ? 4 : 0);
  const Model m = bmtest::modelFrom(text, r.lib);
  const Scene s = buildScene(m, r.parts);
  REQUIRE(s.groups.size() == 4);
  Camera c;
  c.target = {0, 0, 0}, c.eye = {-600, -500, -900}, c.near = 1, c.far = 1e5, c.aspect = 1.6;
  JobPool one(1), many(8);
  const auto a = cull(s, boundsOf(s), c, 1000, -1, true, &one), b = cull(s, boundsOf(s), c, 1000, -1, true, &many);
  uint32_t culled = 0;
  for (size_t g = 0; g < a.size(); g++) {
    REQUIRE(a[g].culled == b[g].culled);
    culled += a[g].culled;
    for (int d = 0; d < 3; d++) REQUIRE(a[g].byDetail[d] == b[g].byDetail[d]);
  }
  REQUIRE(culled > 0);
}
