// Drawing a build as it plays, and resizing.
#include <catch2/catch_approx.hpp>
#include <catch2/catch_test_macros.hpp>
#include "bmr/device.h"
#include "bmr/tolerances.h"
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

TEST_CASE("the key light's shadow is drawn again only when a piece moves", "[gpu][playback]") {
  NEED_GPU();
  bmtest::GpuRig rig(kStack);
  REQUIRE(rig.renderer);
  const Build b;
  const FrameOptions options{};
  rig.renderer->setFrame(b.plan, b.timeline, 40);
  REQUIRE(rig.renderer->draw(rig.camera, options).shadowDrawn);
  const FrameStats still = rig.renderer->draw(rig.camera, options);
  REQUIRE_FALSE(still.shadowDrawn);  // the same poses: the shadow map is kept
  rig.renderer->select({1});
  REQUIRE_FALSE(rig.renderer->draw(rig.camera, options).shadowDrawn);  // selecting moves nothing
  FrameOptions low = options;
  low.forceDetail = 2;
  REQUIRE(rig.renderer->draw(rig.camera, low).shadowDrawn);  // another detail: drawn again
  REQUIRE(rig.renderer->draw(rig.camera, options).shadowDrawn);
  rig.renderer->select({});
  // Moved on and back: the picture is the one a renderer that never left frame 40 draws.
  rig.renderer->setFrame(b.plan, b.timeline, 10);
  REQUIRE(rig.renderer->draw(rig.camera, options).shadowDrawn);
  rig.renderer->setFrame(b.plan, b.timeline, 40);
  bmtest::GpuRig fresh(kStack);
  fresh.renderer->setFrame(b.plan, b.timeline, 40);
  REQUIRE(compare(fresh.shot(options), rig.shot(options)).meanAbs == 0);
}

TEST_CASE("a pick after the pieces move, before the next frame, finds what the last frame showed", "[gpu][playback][picking]") {
  NEED_GPU();
  bmtest::GpuRig rig(kStack);
  REQUIRE(rig.renderer);
  const Build b;
  rig.shot(bmtest::plainOptions());
  // The bottom brick's front face, at rest.
  const auto [x, y] = rig.pixel({0, 12, -10});
  INFO("front of piece 0 at " << x << "," << y);
  REQUIRE(rig.renderer->pick(x, y) == 0);
  // At frame 0 it waits at its staging point, 120 to the right; nothing has been drawn since.
  rig.renderer->setFrame(b.plan, b.timeline, 0);
  REQUIRE(rig.renderer->pick(x, y) == 0);
  // Once that frame is drawn, the pick follows it.
  rig.shot(bmtest::plainOptions());
  REQUIRE(rig.renderer->pick(x, y) != 0);
}

TEST_CASE("the selection's bounds are where the selected pieces are shown now", "[gpu][playback]") {
  NEED_GPU();
  bmtest::GpuRig rig(kStack);
  REQUIRE(rig.renderer);
  const Build b;
  REQUIRE(rig.renderer->selectionBounds().empty());
  rig.renderer->select({0, 3});
  // At rest: the bottom brick and the top one, 1x1 bricks from y = -72 to 24.
  bm::Box rest = rig.renderer->selectionBounds();
  REQUIRE(rest.min.x == Catch::Approx(-10).margin(0.01));
  REQUIRE(rest.min.y == Catch::Approx(-72).margin(0.01));
  REQUIRE(rest.max.y == Catch::Approx(24).margin(0.01));
  // At frame 0 the bottom one waits 120 to the right and the top one is not shown yet.
  rig.renderer->setFrame(b.plan, b.timeline, 0);
  const bm::Box now = rig.renderer->selectionBounds();
  REQUIRE(now.min.x == Catch::Approx(110).margin(0.01));
  REQUIRE(now.max.x == Catch::Approx(130).margin(0.01));
  REQUIRE(now.min.y == Catch::Approx(0).margin(0.01));
}

namespace {
/// Six bricks in six colours (six groups, so six shares when the maps are drawn over frames),
/// stacked in a stair.
std::string stair() {
  std::string text;
  const int colors[6] = {4, 1, 2, 14, 0, 15};
  for (int i = 0; i < 6; i++) text += piece("3005.dat", 20.0 * i, -24.0 * i, 0, colors[i]);
  return text;
}
}  // namespace

TEST_CASE("maps drawn over frames come to the picture drawn whole, and the first is whole", "[gpu][playback]") {
  NEED_GPU();
  bmtest::GpuRig rig(stair());
  REQUIRE(rig.renderer);
  // Lights that turn with the camera, so that turning it makes the maps stale.
  FrameOptions follow{};
  follow.lightsFollowCamera = true;
  FrameOptions over = follow;
  over.mapTrianglesPerFrame = 1;  // a group a frame
  const FrameStats first = rig.renderer->draw(rig.camera, over);
  REQUIRE_FALSE(first.settling);
  {
    bmtest::GpuRig whole(stair());
    REQUIRE(compare(whole.shot(follow), rig.renderer->readback()).meanAbs == 0);
  }
  // Turned a little (the lights turn with it): the old maps are shown while new ones are drawn.
  bmr::OrbitCamera o = bmr::OrbitCamera::framing(rig.renderer->scene().bounds, 0.6, 1.0);
  o.azimuth = 0.8, o.elevation = 0.45;
  rig.camera = o.camera(1.0, rig.renderer->scene().bounds);
  int draws = 0;
  for (bool settling = true; settling && draws < 20; draws++) settling = rig.renderer->draw(rig.camera, over).settling;
  REQUIRE(draws >= 6);
  REQUIRE(draws < 20);
  bmtest::GpuRig turned(stair());
  turned.camera = rig.camera;
  REQUIRE(compare(turned.shot(follow), rig.renderer->readback()).meanAbs == 0);
}

TEST_CASE("with maps drawn over frames, a piece in flight casts its shadow where it is", "[gpu][playback]") {
  NEED_GPU();
  const Build b;
  // Lights fixed, so only the pieces' moving makes the maps stale; a group a frame, the slowest
  // the maps can be drawn again here.
  FrameOptions over{}, whole{};
  over.lightsFollowCamera = whole.lightsFollowCamera = false;
  over.mapTrianglesPerFrame = 1;
  // The key light's shadow alone (no floor, so no height map): where each piece is, every frame.
  // A resting piece that starts to move may stay in a map begun before it moved (at most two
  // builds); with the floor's light that is held to the detail tolerances, and it is gone once
  // the maps have been drawn again after the last piece landed.
  for (const bool floor : {false, true}) {
    bmtest::GpuRig rig(kStack), ref(kStack);
    REQUIRE(rig.renderer);
    over.floor = whole.floor = floor;
    for (int f = 0; f <= b.timeline.frames; f++) {
      rig.renderer->setFrame(b.plan, b.timeline, f);
      ref.renderer->setFrame(b.plan, b.timeline, f);
      const Difference c = compare(ref.shot(whole), rig.shot(over));
      INFO("floor " << floor << ", frame " << f << ": mean " << c.meanAbs << ", worst block " << c.worstBlock);
      if (!floor) REQUIRE(c.meanAbs < 0.02);
      REQUIRE(c.meanAbs < kDetailMeanTolerance);
      REQUIRE(c.worstBlock < kDetailBlockTolerance);
    }
    int draws = 0;
    for (bool settling = true; settling && draws < 20; draws++) settling = rig.renderer->draw(rig.camera, over).settling;
    REQUIRE(draws < 20);
    REQUIRE(compare(ref.shot(whole), rig.renderer->readback()).meanAbs == 0);
  }
}
