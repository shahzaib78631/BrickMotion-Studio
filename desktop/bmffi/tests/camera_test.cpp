// Camera tracks, Auto-direct, scene cameras and the export camera over bmffi.
#include <catch2/catch_test_macros.hpp>
#include <catch2/matchers/catch_matchers_floating_point.hpp>

#include <chrono>
#include <cstring>
#include <string>
#include <thread>

#include "bmffi.h"

using Catch::Matchers::WithinAbs;

namespace {

const char* kHeli = BM_REPO "/samples/helicopter/helicopter.mpd";

bool ok(BmChange c) {
  const bool fine = c.refused.len == 0;
  bm_change_free(c);
  return fine;
}

std::string take(BmString s) {
  std::string out = s.ptr ? std::string(s.ptr, s.len) : std::string();
  bm_string_free(s);
  return out;
}

struct Fixture {
  BmSession* s = nullptr;
  BmViewport* v = nullptr;
  Fixture() {
    s = bm_session_new();
    BmOpenResult r = bm_session_open(s, kHeli);
    REQUIRE(r.ok);
    bm_open_result_free(r);
  }
  ~Fixture() {
    if (v) bm_viewport_free(v);
    bm_session_free(s);
  }
  void view() {
    v = bm_viewport_new(s);
    REQUIRE(v != nullptr);
    bm_viewport_resize(v, 320, 240, 1.0);
    bm_viewport_draw(v);
  }
  double plan() {
    bm_viewport_request_plan(v);
    const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(60);
    while (std::chrono::steady_clock::now() < deadline) {
      bm_viewport_draw(v);
      const BmPlaybackState st = bm_viewport_playback_state(v);
      if (st.plan == BM_PLAN_READY && bm_viewport_planned_version(v) == bm_session_version(s)) return st.duration;
      REQUIRE(st.plan != BM_PLAN_FAILED);
      std::this_thread::sleep_for(std::chrono::milliseconds(10));
    }
    FAIL("plan timed out");
    return 0;
  }
  size_t keys(int32_t clock) {
    BmCameraKeys* k = bm_session_camera_keys(s, clock);
    const size_t n = bm_camera_keys_len(k);
    bm_camera_keys_free(k);
    return n;
  }
};

}  // namespace

TEST_CASE("presets are the web's nineteen", "[camera]") {
  BmCameraPresets* p = bm_camera_presets();
  REQUIRE(bm_camera_presets_len(p) == 19);
  for (size_t i = 0; i < 19; ++i) {
    const BmCameraPreset preset = bm_camera_presets_at(p, i);
    CHECK(std::strlen(preset.id) > 0);
    CHECK(std::strlen(preset.label) > 0);
  }
  bm_camera_presets_free(p);
}

TEST_CASE("timeline clock info", "[camera]") {
  Fixture f;
  BmKeyScene scene = bm_session_key_scene(f.s);
  scene.fps = 24, scene.first = 1, scene.last = 48;
  REQUIRE(ok(bm_session_set_key_scene(f.s, scene)));
  const BmCameraClockInfo info = bm_camera_clock_info(BM_CLOCK_TIMELINE, f.s, 30, 9, false);
  CHECK(info.clock == BM_CLOCK_TIMELINE);
  CHECK_THAT(info.duration, WithinAbs(2.0, 1e-12));
  CHECK(info.ready);
  CHECK_FALSE(bm_can_auto_direct(BM_CLOCK_TIMELINE, f.s, true));
  CHECK(bm_can_auto_direct(BM_CLOCK_BUILD, f.s, true));
}

TEST_CASE("export camera round trip", "[camera]") {
  Fixture f;
  CHECK(take(bm_session_export_camera(f.s)) == "track");
  REQUIRE(ok(bm_session_set_export_camera(f.s, "automatic")));
  CHECK(take(bm_session_export_camera(f.s)) == "automatic");
}

TEST_CASE("scene cameras save, activate, remove", "[camera]") {
  Fixture f;
  BmSceneCamera cam{"cam-1", "Front", {0, -60, -400}, {0, -40, 0}, 30, 1, 100000, false};
  REQUIRE(ok(bm_session_save_scene_camera(f.s, cam)));
  BmSceneCameras* c = bm_session_scene_cameras(f.s);
  REQUIRE(bm_scene_cameras_len(c) == 1);
  const std::string id = bm_scene_cameras_at(c, 0).id;
  CHECK(id == "cam-1");
  CHECK(std::string(bm_scene_cameras_at(c, 0).name) == "Front");
  bm_scene_cameras_free(c);
  REQUIRE_FALSE(id.empty());
  REQUIRE(ok(bm_session_activate_scene_camera(f.s, id.c_str())));
  c = bm_session_scene_cameras(f.s);
  CHECK(std::string(bm_scene_cameras_active_id(c)) == id);
  bm_scene_cameras_free(c);
  // renamed in place: same id
  cam.id = id.c_str();
  cam.name = "Hero";
  REQUIRE(ok(bm_session_save_scene_camera(f.s, cam)));
  c = bm_session_scene_cameras(f.s);
  REQUIRE(bm_scene_cameras_len(c) == 1);
  CHECK(std::string(bm_scene_cameras_at(c, 0).name) == "Hero");
  bm_scene_cameras_free(c);
  REQUIRE(ok(bm_session_remove_scene_camera(f.s, id.c_str())));
  c = bm_session_scene_cameras(f.s);
  CHECK(bm_scene_cameras_len(c) == 0);
  bm_scene_cameras_free(c);
}

TEST_CASE("add key from view, then the playhead key is reused", "[camera]") {
  if (!bm_metal_available()) return;
  Fixture f;
  f.view();
  const double duration = f.plan();
  const BmCameraClockInfo info = bm_camera_clock_info(BM_CLOCK_BUILD, f.s, 30, duration, true);
  BmString id{nullptr, 0};
  bool added = false;
  REQUIRE(ok(bm_add_camera_key_from_view(f.s, f.v, BM_CLOCK_BUILD, 1.0, info, &id, &added)));
  CHECK(added);
  const std::string first = take(id);
  CHECK_FALSE(first.empty());
  REQUIRE(ok(bm_add_camera_key_from_view(f.s, f.v, BM_CLOCK_BUILD, 1.0 + 0.4 / 30, info, &id, &added)));
  CHECK_FALSE(added);
  CHECK(take(id) == first);
  CHECK(f.keys(BM_CLOCK_BUILD) == 1);
  CHECK(f.keys(BM_CLOCK_TIMELINE) == 0);
  BmCameraKeys* k = bm_session_camera_keys(f.s, BM_CLOCK_BUILD);
  CHECK(bm_camera_key_at(k, 1.01, 30) == 0);
  CHECK(bm_camera_key_at(k, 1.2, 30) == -1);
  bm_camera_keys_free(k);
}

TEST_CASE("camera key fields round trip with continuing", "[camera]") {
  if (!bm_metal_available()) return;
  Fixture f;
  f.view();
  const double duration = f.plan();
  BmSceneCamera view = bm_viewport_capture_scene_camera(f.v);
  REQUIRE(ok(bm_session_add_camera_key(f.s, BM_CLOCK_BUILD, 0.5, view, 30, duration)));
  bm_scene_camera_free(view);
  const size_t depth = bm_session_undo_depth(f.s);
  BmCameraKeys* k = bm_session_camera_keys(f.s, BM_CLOCK_BUILD);
  BmCameraKey key = bm_camera_keys_at(k, 0);
  key.lens_mm = 35;
  REQUIRE(ok(bm_session_set_camera_key(f.s, BM_CLOCK_BUILD, key, false)));
  key.lens_mm = 28;
  REQUIRE(ok(bm_session_set_camera_key(f.s, BM_CLOCK_BUILD, key, true)));
  bm_camera_keys_free(k);
  bm_session_end_gesture(f.s);
  CHECK(bm_session_undo_depth(f.s) == depth + 1);
  k = bm_session_camera_keys(f.s, BM_CLOCK_BUILD);
  CHECK_THAT(bm_camera_keys_at(k, 0).lens_mm, WithinAbs(28, 1e-9));
  bm_camera_keys_free(k);
}

TEST_CASE("auto-direct writes a track", "[camera]") {
  if (!bm_metal_available()) return;
  Fixture f;
  f.view();
  CHECK_FALSE(ok(bm_auto_direct(f.s, f.v, BM_CLOCK_BUILD, "showcase")));  // no plan yet
  f.plan();
  REQUIRE(ok(bm_auto_direct(f.s, f.v, BM_CLOCK_BUILD, "showcase")));
  CHECK(f.keys(BM_CLOCK_BUILD) > 0);
  CHECK(take(bm_session_camera_director_style(f.s, BM_CLOCK_BUILD)) == "showcase");
  BmCameraMoves* m = bm_session_camera_moves(f.s, BM_CLOCK_BUILD);
  CHECK(bm_camera_moves_len(m) + 1 == f.keys(BM_CLOCK_BUILD));
  bm_camera_moves_free(m);
  bm_viewport_set_director_preview(f.v, true);
  bm_viewport_draw(f.v);
  CHECK(bm_viewport_follows_camera_track(f.v));
  REQUIRE(ok(bm_session_clear_camera_track(f.s, BM_CLOCK_BUILD)));
  CHECK(f.keys(BM_CLOCK_BUILD) == 0);
}
