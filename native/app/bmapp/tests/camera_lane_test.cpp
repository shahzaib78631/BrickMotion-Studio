// A Camera lane's shared rules (camera_lane.h), moved down from the Swift app.
#include <catch2/catch_approx.hpp>
#include <catch2/catch_test_macros.hpp>

#include <chrono>
#include <thread>

#include "bmapp/camera_lane.h"
#include "bmapp/session.h"
#include "bmapp/viewport.h"

using Catch::Approx;

namespace {

bmapp::CameraTrackKey keyAt(const char* id, double seconds) {
  bmapp::CameraTrackKey k;
  k.id = id;
  k.seconds = seconds;
  return k;
}

void threeBricks(bmapp::Session& session) {
  REQUIRE(session.newBlank().ok);
  for (const double y : {-24.0, -48.0, -72.0})
    REQUIRE(session.placePart("3001.dat", 4, {{}, {0, y, 0}}, 0, session.generation(), session.version()).refused.empty());
}

void finishPlan(bmapp::Viewport& viewport) {
  viewport.requestPlan();
  const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(25);
  while (viewport.planState() == bmapp::PlanState::Planning && std::chrono::steady_clock::now() < deadline) {
    viewport.draw(nullptr);
    std::this_thread::sleep_for(std::chrono::milliseconds(5));
  }
  REQUIRE(viewport.planState() == bmapp::PlanState::Ready);
}

}  // namespace

TEST_CASE("camera clock on the timeline", "[camera lane]") {
  bmapp::Session s;
  REQUIRE(s.newBlank().ok);
  bmapp::KeyScene scene = s.keyScene();
  scene.fps = 24, scene.first = 1, scene.last = 48;
  REQUIRE(s.setKeyScene(scene).refused.empty());
  const bmapp::CameraClockInfo info = bmapp::cameraClockInfo(bmapp::CameraClock::Timeline, &s, 30, 9, false);
  CHECK(info.fps == Approx(24));
  CHECK(info.duration == Approx(2.0));
  CHECK(info.ready);
  CHECK(double(scene.last - scene.first) / scene.fps == Approx(47.0 / 24));  // the lane's scale differs on purpose
  const bmapp::CameraClockInfo build = bmapp::cameraClockInfo(bmapp::CameraClock::Build, &s, 30, 9, false);
  CHECK(build.fps == Approx(30));
  CHECK(build.duration == Approx(9));
  CHECK_FALSE(build.ready);
}

TEST_CASE("camera key at the playhead", "[camera lane]") {
  const std::vector<bmapp::CameraTrackKey> keys{keyAt("a", 1.0), keyAt("b", 2.0)};
  std::string id;
  REQUIRE(bmapp::cameraKeyAt(keys, 1.01, 30, &id));
  CHECK(id == "a");
  CHECK_FALSE(bmapp::cameraKeyAt(keys, 1.02, 30, &id));
  REQUIRE(bmapp::cameraKeyAt(keys, 1.99, 30, &id));
  CHECK(id == "b");
}

TEST_CASE("can auto-direct", "[camera lane]") {
  bmapp::Session s;
  REQUIRE(s.newBlank().ok);
  CHECK(bmapp::canAutoDirect(bmapp::CameraClock::Build, &s, true));
  CHECK_FALSE(bmapp::canAutoDirect(bmapp::CameraClock::Build, &s, false));
  CHECK_FALSE(bmapp::canAutoDirect(bmapp::CameraClock::Timeline, &s, true));
  bmapp::KeyScene scene = s.keyScene();
  scene.buildLinked = true;
  REQUIRE(s.setKeyScene(scene).refused.empty());
  CHECK(bmapp::canAutoDirect(bmapp::CameraClock::Timeline, &s, true));
  CHECK_FALSE(bmapp::canAutoDirect(bmapp::CameraClock::Timeline, &s, false));
}

TEST_CASE("add key from view replaces the key at the playhead", "[camera lane]") {
  bmapp::Session s;
  threeBricks(s);
  bmapp::Viewport viewport(s);
  if (!viewport.ok()) SKIP("no Metal device");
  viewport.resize(320, 180, 1);
  viewport.setPreferences({});
  finishPlan(viewport);
  const double duration = viewport.buildTimeline().duration;
  const bmapp::CameraClockInfo info = bmapp::cameraClockInfo(bmapp::CameraClock::Build, &s, 30, duration, true);
  const bmapp::CameraKeyResult first = bmapp::addCameraKeyFromView(s, viewport, bmapp::CameraClock::Build, 1.0, info);
  REQUIRE(first.changed.refused.empty());
  CHECK(first.added);
  REQUIRE(s.cameraKeys(bmapp::CameraClock::Build).size() == 1);
  CHECK(first.id == s.cameraKeys(bmapp::CameraClock::Build)[0].id);
  const bmapp::CameraKeyResult again =
      bmapp::addCameraKeyFromView(s, viewport, bmapp::CameraClock::Build, 1.0 + 0.4 / 30, info);
  CHECK_FALSE(again.added);
  CHECK(again.id == first.id);
  CHECK(s.cameraKeys(bmapp::CameraClock::Build).size() == 1);
}

TEST_CASE("aim at the same target does nothing", "[camera lane]") {
  bmapp::Session s;
  threeBricks(s);
  bmapp::Viewport viewport(s);
  if (!viewport.ok()) SKIP("no Metal device");
  viewport.resize(320, 180, 1);
  viewport.setPreferences({});
  finishPlan(viewport);
  const double duration = viewport.buildTimeline().duration;
  const bmapp::CameraClockInfo info = bmapp::cameraClockInfo(bmapp::CameraClock::Build, &s, 30, duration, true);
  REQUIRE(bmapp::addCameraKeyFromView(s, viewport, bmapp::CameraClock::Build, 0.5, info).added);
  const bmapp::CameraTrackKey key = s.cameraKeys(bmapp::CameraClock::Build)[0];
  const size_t depth = s.undoDepth();
  bmapp::aimCameraKey(s, viewport, bmapp::CameraClock::Build, key, key.target);
  CHECK(s.undoDepth() == depth);
  REQUIRE(bmapp::aimCameraKey(s, viewport, bmapp::CameraClock::Build, key, key.target == "model" ? "build" : "model")
              .refused.empty());
  CHECK(s.undoDepth() == depth + 1);
}

TEST_CASE("auto-direct without a plan is refused", "[camera lane]") {
  bmapp::Session s;
  threeBricks(s);
  bmapp::Viewport viewport(s);
  if (!viewport.ok()) SKIP("no Metal device");
  const bmapp::Changed changed = bmapp::autoDirect(s, viewport, bmapp::CameraClock::Build, "showcase");
  CHECK_FALSE(changed.refused.empty());
  CHECK(s.cameraKeys(bmapp::CameraClock::Build).empty());
}
