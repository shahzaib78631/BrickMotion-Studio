// Drawing a build as it plays, and resizing.
#include <catch2/catch_test_macros.hpp>
#include "bmr/device.h"
#include "gpu_rig.h"

using namespace bm;
using namespace bmr;
using bmtest::piece;

#define NEED_GPU() \
  if (!gpuAvailable()) SKIP("no Metal device")

namespace {
/// Four bricks stacked; three units fly in one after another (the second a pair) from the
/// right, and the fourth does not fly (it appears at its frame).
struct Build {
  plan::Plan plan;
  plan::Timeline timeline;
  Build() {
    plan.moves.resize(3);
    plan.moves[0].unit.pieces = {0};
    plan.moves[1].unit.pieces = {1, 2};
    plan.moves[2].unit.pieces = {3};
    for (uint32_t i = 0; i < 2; i++) {
      plan::Flight f;
      f.move = i, f.startFrame = static_cast<int>(i) * 30, f.frames = 30;
      f.staging.t = {120, 0, 40.0 * i};
      Xform above;
      above.t = {0, -60, 0};
      f.waypoints = {f.staging, above, Xform{}};
      f.at = {0, 0.5, 1};
      timeline.flights.push_back(f);
    }
    plan::Flight still;
    still.move = 2, still.startFrame = 60, still.frames = 0;
    timeline.flights.push_back(still);
    timeline.frames = 60;
  }
};
const std::string kStack = piece("3005.dat", 0, 0, 0, 4) + piece("3005.dat", 0, -24, 0, 0) + piece("3005.dat", 0, -48, 0, 4) + piece("3005.dat", 0, -72, 0, 0);
}  // namespace

TEST_CASE("at the last frame the picture is the finished model; at the first no piece is at its seat", "[gpu][playback]") {
  NEED_GPU();
  bmtest::GpuRig rig(kStack);
  REQUIRE(rig.renderer);
  const Build b;
  const Image rest = rig.shot(FrameOptions{});
  rig.renderer->setFrame(b.plan, b.timeline, b.timeline.frames);
  REQUIRE(compare(rest, rig.shot(FrameOptions{})).meanAbs == 0);
  rig.renderer->setFrame(b.plan, b.timeline, 0);
  const Image first = rig.shot(FrameOptions{});
  REQUIRE(compare(rest, first).meanAbs > 1);
  // No piece at its seat: the seat of each, at the top of the stack's middle, shows background or another piece.
  for (uint32_t p = 0; p < 4; p++) {
    const Scene& s = rig.renderer->scene();
    const Instance& in = s.groups[s.where[p].first].instances[s.where[p].second];
    const Vec3 at = Vec3{in.model[3], in.model[7], in.model[11]} + s.origin;
    const bool hidden = (in.flags & kHidden) != 0;
    INFO("piece " << p);
    REQUIRE((hidden || length(at - Vec3{0, -24.0 * p, 0}) > 1));
  }
  rig.renderer->setRest();
  REQUIRE(compare(rest, rig.shot(FrameOptions{})).meanAbs == 0);
}

TEST_CASE("going back to a frame gives the picture it gave before", "[gpu][playback]") {
  NEED_GPU();
  bmtest::GpuRig rig(kStack);
  REQUIRE(rig.renderer);
  const Build b;
  rig.renderer->setFrame(b.plan, b.timeline, 5);
  const Image a = rig.shot(FrameOptions{});
  rig.renderer->setFrame(b.plan, b.timeline, 40);
  const Image mid = rig.shot(FrameOptions{});
  rig.renderer->setFrame(b.plan, b.timeline, 5);
  const Image c = rig.shot(FrameOptions{});
  REQUIRE(compare(a, mid).meanAbs > 0.5);
  REQUIRE(compare(a, c).meanAbs == 0);
}

TEST_CASE("resizing, to zero and back, keeps drawing", "[gpu][frame]") {
  NEED_GPU();
  bmtest::GpuRig rig(piece("3005.dat", 0, 0, 0, 4));
  REQUIRE(rig.renderer);
  REQUIRE(rig.shot(bmtest::plainOptions()).width == 256);
  rig.renderer->resize(0, 0);
  const FrameStats none = rig.renderer->draw(rig.camera, bmtest::plainOptions());
  REQUIRE(none.drawCalls == 0);
  REQUIRE(none.instances == 0);
  REQUIRE(rig.renderer->pick(5, 5) == UINT32_MAX);
  rig.renderer->resize(512, 300);
  bmr::OrbitCamera o = bmr::OrbitCamera::framing(rig.renderer->scene().bounds, 0.6, 512.0 / 300);
  rig.camera = o.camera(512.0 / 300, rig.renderer->scene().bounds);
  const Image img = rig.shot(bmtest::plainOptions());
  REQUIRE(img.width == 512);
  REQUIRE(img.height == 300);
  const uint8_t* mid = img.at(256, 150);
  REQUIRE(mid[0] > 120);
  REQUIRE(mid[0] > 3 * mid[1]);
  REQUIRE(rig.renderer->pick(256, 150) == 0);
}
