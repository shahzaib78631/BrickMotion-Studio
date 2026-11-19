#include <catch2/catch_approx.hpp>
#include <catch2/catch_test_macros.hpp>
#include <algorithm>
#include <cmath>
#include "bmf/lens.h"

using namespace bm;
using namespace bm::film;
using Catch::Approx;

namespace {
std::vector<Vec3> cornersOf(Vec3 lo, Vec3 hi) {
  std::vector<Vec3> out;
  for (int i = 0; i < 8; i++) out.push_back({i & 1 ? hi.x : lo.x, i & 2 ? hi.y : lo.y, i & 4 ? hi.z : lo.z});
  return out;
}
/// The largest |ndc| over the points, horizontally and vertically.
std::pair<double, double> extent(const Rig& rig, const FrameShape& shape, const std::vector<Vec3>& pts) {
  double x = 0, y = 0;
  for (Vec3 p : pts) {
    const Vec3 s = project(rig, shape, p);
    x = std::max(x, std::abs(s.x)), y = std::max(y, std::abs(s.y));
  }
  return {x, y};
}
}  // namespace

TEST_CASE("a 50 mm lens on 36 mm is 39.6 degrees tall", "[lens]") { REQUIRE(fovY(50, 36) == Approx(0.6911).margin(1e-4)); }

TEST_CASE("a cube fits exactly: every corner is inside the frame and one touches its edge", "[lens]") {
  const auto pts = cornersOf({-20, -20, -20}, {20, 20, 20});
  FrameShape shape;
  Rig rig{{0, 0, 0}, 0.6, 0.45, 0};
  rig.distance = fitDistance(pts, rig.target, rig.azimuth, rig.elevation, rig.lensMm, shape, 1.0);
  const auto [x, y] = extent(rig, shape, pts);
  REQUIRE(x <= shape.safe + 1e-6);
  REQUIRE(y <= shape.safe + 1e-6);
  REQUIRE(std::max(x, y) == Approx(shape.safe).margin(1e-3));
}

TEST_CASE("a tall model fits a wide frame and a wide model fits a tall one", "[lens]") {
  const auto tall = cornersOf({-10, -400, -10}, {10, 0, 10}), wide = cornersOf({-200, -20, -10}, {200, 0, 10});
  FrameShape cinema;
  cinema.aspect = 21.0 / 9;
  FrameShape phone;
  phone.aspect = 9.0 / 16;
  Rig a{{0, -200, 0}, 0.3, 0.2, 0}, b{{0, -10, 0}, 0.3, 0.2, 0};
  a.distance = fitDistance(tall, a.target, a.azimuth, a.elevation, a.lensMm, cinema, 1.0);
  b.distance = fitDistance(wide, b.target, b.azimuth, b.elevation, b.lensMm, phone, 1.0);
  const auto [ax, ay] = extent(a, cinema, tall);
  const auto [bx, by] = extent(b, phone, wide);
  REQUIRE(std::max(ax, ay) <= cinema.safe + 1e-6);
  REQUIRE(std::max(bx, by) <= phone.safe + 1e-6);
  REQUIRE(ay > ax);  // the tall one is held by the frame's height
  REQUIRE(bx > by);  // the wide one by its width
  REQUIRE(ay == Approx(cinema.safe).margin(1e-3));
  REQUIRE(bx == Approx(phone.safe).margin(1e-3));
}

TEST_CASE("lead room puts the subject behind the centre", "[lens]") {
  const auto pts = cornersOf({-10, -10, -10}, {10, 10, 10});
  FrameShape shape;
  Rig rig{{0, 0, 0}, 0, 0, 0};
  rig.distance = fitDistance(pts, rig.target, rig.azimuth, rig.elevation, rig.lensMm, shape, 0.5);
  rig.target = composedTarget(pts, rig.azimuth, rig.elevation, {1, 0, 0}, rig.distance, rig.lensMm, shape);
  const Vec3 c = project(rig, shape, {0, 0, 0});
  REQUIRE(c.x == Approx(-kLeadShare).margin(0.01));
  REQUIRE(c.y == Approx(0).margin(0.01));
  // With no lead it is centred.
  rig.target = composedTarget(pts, rig.azimuth, rig.elevation, {}, rig.distance, rig.lensMm, shape);
  REQUIRE(project(rig, shape, {0, 0, 0}).x == Approx(0).margin(1e-9));
}
