// Build settings, staging & waiting parts, and snap sound settings over bmffi.
#include <catch2/catch_test_macros.hpp>
#include <catch2/matchers/catch_matchers_floating_point.hpp>

#include <chrono>
#include <cstdio>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <string>
#include <thread>
#include <vector>

#include "bmffi.h"

using Catch::Matchers::WithinAbs;

namespace {

const char* kHeli = BM_REPO "/samples/helicopter/helicopter.mpd";
const char* kSnaps = BM_REPO "/public/sounds/snaps";

BmSession* openHeli() {
  BmSession* s = bm_session_new();
  BmOpenResult r = bm_session_open(s, kHeli);
  REQUIRE(r.ok);
  bm_open_result_free(r);
  return s;
}

BmPlaybackState plan(BmSession* s, BmViewport* v) {
  bm_viewport_request_plan(v);
  const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(60);
  BmPlaybackState st = bm_viewport_playback_state(v);
  while (std::chrono::steady_clock::now() < deadline) {
    bm_viewport_draw(v);
    st = bm_viewport_playback_state(v);
    if ((st.plan == BM_PLAN_READY && bm_viewport_planned_version(v) == bm_session_version(s)) ||
        st.plan == BM_PLAN_FAILED)
      return st;
    std::this_thread::sleep_for(std::chrono::milliseconds(10));
  }
  return st;
}

}  // namespace

TEST_CASE("build settings round trip and replan") {
  if (!bm_metal_available()) return;
  BmSession* s = openHeli();
  BmViewport* v = bm_viewport_new(s);
  bm_viewport_resize(v, 320, 240, 1.0);
  REQUIRE(plan(s, v).plan == BM_PLAN_READY);
  CHECK(bm_viewport_planned_version(v) == bm_session_version(s));

  BmBuildSettings b = bm_session_build_settings(s);
  b.pieces_per_second = 4.0;
  b.order = BM_ORDER_BOTTOM_UP;
  BmChange c = bm_session_set_build_settings(s, b);
  CHECK(c.refused.len == 0);
  bm_string_free(c.refused);

  const BmBuildSettings got = bm_session_build_settings(s);
  CHECK_THAT(got.pieces_per_second, WithinAbs(4.0, 1e-6));
  CHECK(got.order == BM_ORDER_BOTTOM_UP);
  CHECK(bm_viewport_planned_version(v) != bm_session_version(s));

  bm_viewport_free(v);
  bm_session_free(s);
}

TEST_CASE("staging round trip") {
  BmSession* s = openHeli();
  BmStagingSettings st = bm_session_staging_settings(s);
  st.layout = "grid";
  st.group = "colour";
  st.sides = "around";
  st.match = "nearest";
  BmChange c = bm_session_set_staging_settings(s, st);
  CHECK(c.refused.len == 0);
  bm_string_free(c.refused);
  const BmStagingSettings got = bm_session_staging_settings(s);
  CHECK(std::string(got.layout) == "grid");
  CHECK(std::string(got.group) == "colour");
  CHECK(std::string(got.sides) == "around");
  CHECK(std::string(got.match) == "nearest");

  st.layout = "camera-frame";
  st.aspect = 16.0 / 9.0;
  c = bm_session_set_staging_settings(s, st);
  CHECK(c.refused.len == 0);
  bm_string_free(c.refused);
  const BmStagingSettings cam = bm_session_staging_settings(s);
  CHECK(std::string(cam.layout) == "camera-frame");
  CHECK_THAT(cam.aspect, WithinAbs(16.0 / 9.0, 1e-6));
  bm_session_free(s);
}

TEST_CASE("apply staging is one undo step") {
  BmSession* s = openHeli();
  const size_t depth = bm_session_undo_depth(s);
  BmStagingSettings st = bm_session_staging_settings(s);
  st.layout = "fan";
  BmChange c = bm_session_apply_staging(s, st, 45.0, false);
  CHECK(c.refused.len == 0);
  bm_string_free(c.refused);
  CHECK(bm_session_undo_depth(s) == depth + 1);
  CHECK(std::string(bm_session_staging_settings(s).layout) == "fan");
  CHECK_THAT(bm_session_staging_turn(s), WithinAbs(45.0, 1e-6));
  bm_session_free(s);
}

TEST_CASE("waiting part shift round trip") {
  BmSession* s = openHeli();
  const size_t moved0 = bm_session_moved_waiting_parts(s);
  BmChange c = bm_session_shift_waiting_part(s, 0, BmVec3{40, 0, 20});
  CHECK(c.refused.len == 0);
  bm_string_free(c.refused);
  const BmVec3 shift = bm_session_waiting_shift(s, 0);
  CHECK_THAT(shift.x, WithinAbs(40.0, 1e-6));
  CHECK_THAT(shift.z, WithinAbs(20.0, 1e-6));
  CHECK(bm_session_moved_waiting_parts(s) >= moved0 + 1);
  c = bm_session_put_back_waiting_parts(s);
  CHECK(c.refused.len == 0);
  bm_string_free(c.refused);
  CHECK(bm_session_moved_waiting_parts(s) == 0);
  bm_session_free(s);
}

TEST_CASE("snap mix round trip and presets differ") {
  BmSession* s = openHeli();
  BmSnapMix m = bm_session_snap_mix(s);
  m.enabled = true;
  m.source = BM_SNAP_SYNTHESISED;
  m.volume = 0.75;
  m.room = 0.3;
  m.together = 2;
  BmChange c = bm_session_set_snap_mix(s, m);
  CHECK(c.refused.len == 0);
  bm_string_free(c.refused);
  const BmSnapMix got = bm_session_snap_mix(s);
  CHECK(got.enabled);
  CHECK(got.source == BM_SNAP_SYNTHESISED);
  CHECK_THAT(got.volume, WithinAbs(0.75, 1e-6));
  CHECK_THAT(got.room, WithinAbs(0.3, 1e-6));
  CHECK(got.together == 2);

  const BmSnapMix a = bm_snap_mix_preset("click");
  const BmSnapMix b = bm_snap_mix_preset("soft");
  CHECK(a.click != b.click);
  bm_session_free(s);
}

TEST_CASE("snap preview writes a wav") {
  const auto path = std::filesystem::temp_directory_path() / "bmffi-snap-preview-test.wav";
  std::error_code ec;
  std::filesystem::remove(path, ec);
  BmSnapMix m = bm_snap_mix_preset("physical");
  m.enabled = true;
  REQUIRE(bm_write_snap_preview(m, BM_SNAP_BRICK, kSnaps, path.c_str()));
  std::ifstream in(path, std::ios::binary);
  std::vector<char> bytes((std::istreambuf_iterator<char>(in)), {});
  REQUIRE(bytes.size() > 44);
  CHECK(std::memcmp(bytes.data(), "RIFF", 4) == 0);
  std::filesystem::remove(path, ec);
}

TEST_CASE("snap track needs a plan") {
  if (!bm_metal_available()) return;
  BmSession* s = openHeli();
  BmViewport* v = bm_viewport_new(s);
  bm_viewport_resize(v, 320, 240, 1.0);
  const auto path = std::filesystem::temp_directory_path() / "bmffi-snap-track-test.wav";
  std::error_code ec;
  std::filesystem::remove(path, ec);

  BmString before = bm_viewport_write_snap_track(v, path.c_str(), kSnaps);
  CHECK(before.len > 0);
  bm_string_free(before);

  BmSnapMix m = bm_session_snap_mix(s);
  m.enabled = true;
  BmChange c = bm_session_set_snap_mix(s, m);
  bm_string_free(c.refused);
  REQUIRE(plan(s, v).plan == BM_PLAN_READY);

  BmString after = bm_viewport_write_snap_track(v, path.c_str(), kSnaps);
  CHECK(after.len == 0);
  bm_string_free(after);
  CHECK(std::filesystem::file_size(path) > 44);

  std::filesystem::remove(path, ec);
  bm_viewport_free(v);
  bm_session_free(s);
}
