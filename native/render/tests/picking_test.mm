// Which piece is under a pixel, and the outline of the selected ones.
#include <catch2/catch_test_macros.hpp>
#include <cmath>
#include "bmr/device.h"
#include "gpu_rig.h"

using namespace bm;
using namespace bmr;
using bmtest::piece;

#define NEED_GPU() \
  if (!gpuAvailable()) SKIP("no Metal device")

TEST_CASE("the piece under a pixel is the nearest one; the background is none", "[gpu][picking]") {
  NEED_GPU();
  // Piece 0 at the origin; piece 1 the same brick 30 units nearer the eye along its level
  // direction (azimuth 0.6). The framing target is midway, so the middle pixel looks at the
  // near one first.
  const double ax = -std::sin(0.6) * 30, az = -std::cos(0.6) * 30;
  bmtest::GpuRig rig(piece("3005.dat", 0, 0, 0, 4) + piece("3005.dat", ax, 0, az, 0));
  REQUIRE(rig.renderer);
  REQUIRE(rig.renderer->pick(128, 128) == UINT32_MAX);  // nothing drawn yet
  rig.shot(bmtest::plainOptions());
  REQUIRE(rig.renderer->pick(128, 128) == 1);
  REQUIRE(rig.renderer->pick(1, 1) == UINT32_MAX);
  REQUIRE(rig.renderer->pick(-3, 10) == UINT32_MAX);
  REQUIRE(rig.renderer->pick(10, 4000) == UINT32_MAX);
  // The far one, where only it is: its own top centre.
  const auto [x, y] = rig.pixel({0, 0, 0});
  INFO("far top at " << x << "," << y);
  REQUIRE(rig.renderer->pick(x, y) == 0);
}

TEST_CASE("a transparent piece in front is the one picked", "[gpu][picking]") {
  NEED_GPU();
  const double ax = -std::sin(0.6) * 30, az = -std::cos(0.6) * 30;
  bmtest::GpuRig rig(piece("3005.dat", 0, 0, 0, 4) + piece("3005.dat", ax, 0, az, 36));
  REQUIRE(rig.renderer);
  rig.shot(bmtest::plainOptions());
  REQUIRE(rig.renderer->pick(128, 128) == 1);
}

TEST_CASE("a selected piece gets an outline and nothing else changes", "[gpu][picking]") {
  NEED_GPU();
  bmtest::GpuRig rig(piece("3005.dat", -30, 0, 0, 4) + piece("3005.dat", 30, 0, 0, 4));
  REQUIRE(rig.renderer);
  const Image before = rig.shot(bmtest::plainOptions());
  rig.renderer->select({1});
  const Image after = rig.shot(bmtest::plainOptions());
  // Piece 1's silhouette: the pixels pick finds it under.
  std::vector<bool> on(256 * 256, false);
  for (int y = 0; y < 256; y++)
    for (int x = 0; x < 256; x++) on[y * 256 + x] = rig.renderer->pick(x, y) == 1;
  auto nearSilhouette = [&](int x, int y) {
    for (int dy = -4; dy <= 4; dy++)
      for (int dx = -4; dx <= 4; dx++) {
        const int u = x + dx, v = y + dy;
        if (u >= 0 && v >= 0 && u < 256 && v < 256 && on[v * 256 + u]) return true;
      }
    return false;
  };
  int changed = 0, stray = 0, blue = 0;
  for (int y = 0; y < 256; y++)
    for (int x = 0; x < 256; x++) {
      const uint8_t *a = before.at(x, y), *b = after.at(x, y);
      if (a[0] == b[0] && a[1] == b[1] && a[2] == b[2]) continue;
      changed++;
      if (!nearSilhouette(x, y)) stray++;
      if (b[2] > 200 && b[0] < 60) blue++;
    }
  INFO("changed " << changed << " stray " << stray << " blue " << blue);
  REQUIRE(changed > 50);
  REQUIRE(stray == 0);
  REQUIRE(blue > 50);
  // Deselected: the picture is as before.
  rig.renderer->select({});
  REQUIRE(compare(before, rig.shot(bmtest::plainOptions())).meanAbs == 0);
}
