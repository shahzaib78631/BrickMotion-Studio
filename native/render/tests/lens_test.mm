// Depth of field (shaders/lens.metal): the plane in focus stays sharp, what is off it blurs.
#include <catch2/catch_test_macros.hpp>
#include <cmath>
#include <cstdlib>
#include "bmr/device.h"
#include "bmr/image.h"
#include "gpu_rig.h"

using namespace bm;
using namespace bmr;

namespace {

/// How much two pictures differ within `radius` pixels of a point: the mean of |a - b| over RGB.
double differenceNear(const Image& a, const Image& b, std::pair<int, int> at, int radius) {
  double sum = 0;
  int n = 0;
  for (int y = at.second - radius; y <= at.second + radius; y++)
    for (int x = at.first - radius; x <= at.first + radius; x++) {
      const uint8_t *p = a.at(x, y), *q = b.at(x, y);
      if (!p || !q) continue;
      for (int c = 0; c < 3; c++) sum += std::abs(int(p[c]) - int(q[c]));
      n += 3;
    }
  return n ? sum / n : 0;
}

/// Distance from the eye to a point along the view, as FrameOptions::focusDistance counts it.
double alongView(const Camera& camera, Vec3 p) { return dot(p - camera.eye, normalized(camera.target - camera.eye)); }

}  // namespace

TEST_CASE("depth of field keeps the plane in focus sharp and blurs what is off it", "[gpu][frame][lens]") {
  if (!gpuAvailable()) SKIP("no Metal device");
  // Two red bricks seen from the front (-z): one near, one far behind it and to the side.
  const Vec3 nearBrick{-40, 12, 0}, farBrick{60, 12, 600};
  bmtest::GpuRig rig(bmtest::piece("3005.dat", -40, 0, 0, 4) + bmtest::piece("3005.dat", 60, 0, 600, 1), 320, 240, 0.0, 0.1);
  REQUIRE(rig.renderer);
  FrameOptions sharp = bmtest::plainOptions();
  const Image still = rig.shot(sharp);
  const auto nearAt = rig.pixel(nearBrick), farAt = rig.pixel(farBrick);
  INFO("near brick at " << nearAt.first << "," << nearAt.second << ", far brick at " << farAt.first << "," << farAt.second);

  FrameOptions onNear = sharp;
  onNear.lensBlur = 18.0 / 1080 * 2;
  // focused on the face each brick turns to the camera (the bricks are 20 deep)
  onNear.focusDistance = alongView(rig.camera, nearBrick - Vec3{0, 0, 10});
  const Image nearFocused = rig.shot(onNear);
  FrameOptions onFar = onNear;
  onFar.focusDistance = alongView(rig.camera, farBrick - Vec3{0, 0, 10});
  const Image farFocused = rig.shot(onFar);
  if (const char* dump = std::getenv("BMR_DUMP")) {
    writePng(still, std::filesystem::path(dump) / "lens_sharp.png");
    writePng(nearFocused, std::filesystem::path(dump) / "lens_near.png");
    writePng(farFocused, std::filesystem::path(dump) / "lens_far.png");
  }

  // The brick in focus looks as it does without the lens, but for its antialiased rim (one
  // depth sample a pixel: a rim pixel whose sample is the backdrop blurs as the backdrop,
  // as in the web's lens); the other one does not.
  const double nearKept = differenceNear(still, nearFocused, nearAt, 14), farLost = differenceNear(still, nearFocused, farAt, 8);
  const double farKept = differenceNear(still, farFocused, farAt, 8), nearLost = differenceNear(still, farFocused, nearAt, 14);
  INFO("focused near: near differs " << nearKept << ", far " << farLost << "; focused far: far " << farKept << ", near " << nearLost);
  CHECK(nearKept < 2.5);
  CHECK(farKept < 5);
  CHECK(farLost > 4 * nearKept + 2);
  CHECK(nearLost > 4 * farKept + 2);

  // No blur asked for: the frame is drawn exactly as without the lens.
  FrameOptions none = onNear;
  none.lensBlur = 0;
  const Image unchanged = rig.shot(none);
  CHECK(unchanged.rgba == still.rgba);
}
