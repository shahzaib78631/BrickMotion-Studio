// Keyframes over bmffi: keys, key objects, key rows, the key scene, flight paths and the shared maths.
#include <catch2/catch_test_macros.hpp>
#include <catch2/matchers/catch_matchers_floating_point.hpp>

#include <chrono>
#include <thread>
#include <vector>

#include "bmffi.h"

using Catch::Matchers::WithinAbs;

namespace {

const char* kHeli = BM_REPO "/samples/helicopter/helicopter.mpd";

BmSession* openHeli() {
  BmSession* s = bm_session_new();
  BmOpenResult r = bm_session_open(s, kHeli);
  REQUIRE(r.ok);
  bm_open_result_free(r);
  return s;
}

// The first part (not a submodel use) of the first step that has one.
uint32_t firstPart(const BmSession* s) {
  BmSteps* st = bm_session_steps(s);
  const size_t steps = bm_steps_len(st);
  bm_steps_free(st);
  for (size_t step = 0; step < steps; ++step) {
    BmItems* it = bm_session_step_items(s, step);
    for (size_t i = 0; i < bm_items_len(it); ++i) {
      if (bm_items_at(it, i).submodel) continue;
      uint32_t p = 0;
      if (bm_item_pieces(it, i, &p, 1) > 0) {
        bm_items_free(it);
        return p;
      }
    }
    bm_items_free(it);
  }
  FAIL("no part");
  return 0;
}

BmKeyframe key(int32_t channel, int32_t frame, double value) { return BmKeyframe{channel, frame, value, BM_INTERP_SMOOTH}; }

bool ok(BmChange c) {
  const bool fine = c.refused.len == 0;
  bm_change_free(c);
  return fine;
}

std::vector<BmKeyframe> keysOf(const BmSession* s, uint32_t piece) {
  BmKeyObjects* o = bm_session_key_objects(s);
  std::vector<BmKeyframe> out;
  for (size_t i = 0; i < bm_key_objects_len(o); ++i) {
    const BmKeyObjectRow row = bm_key_objects_at(o, i);
    if (row.piece != piece || row.submodel) continue;
    out.resize(row.keys);
    bm_key_objects_keys(o, i, out.data(), out.size());
  }
  bm_key_objects_free(o);
  return out;
}

}  // namespace

TEST_CASE("keys round trip", "[keys]") {
  BmSession* s = openHeli();
  const uint32_t p = firstPart(s);
  const BmKeyframe keys[] = {key(BM_KEY_POSITION_X, 10, 1), key(BM_KEY_POSITION_Y, 10, 2), key(BM_KEY_POSITION_X, 20, 3)};
  REQUIRE(ok(bm_session_set_keys(s, p, keys, 3, false, false)));
  BmKeyObjects* o = bm_session_key_objects(s);
  REQUIRE(bm_key_objects_len(o) > 0);
  const BmKeyObjectRow row = bm_key_objects_at(o, 0);
  CHECK(row.piece == p);
  CHECK(row.keyed);
  CHECK_FALSE(row.submodel);
  CHECK(row.keys == 3);
  CHECK(row.markers == 2);
  int32_t frames[2] = {};
  size_t channels[2] = {};
  REQUIRE(bm_key_objects_markers(o, 0, frames, channels, 2) == 2);
  CHECK(frames[0] == 10);
  CHECK(channels[0] == 2);
  CHECK(frames[1] == 20);
  CHECK(channels[1] == 1);
  std::vector<uint32_t> members(row.members);
  CHECK(bm_key_objects_members(o, 0, members.data(), members.size()) == row.members);
  bm_key_objects_free(o);
  CHECK_THAT(bm_session_key_value(s, p, BM_KEY_POSITION_X, 15, false), WithinAbs(2, 1e-6));  // smooth between 1 and 3
  REQUIRE(ok(bm_session_remove_keys(s, p, keys, 1, false)));
  CHECK(keysOf(s, p).size() == 2);
  bm_session_free(s);
}

TEST_CASE("move keys at the scene edge", "[keys]") {
  BmSession* s = openHeli();
  const uint32_t p = firstPart(s);
  const BmKeyframe k = key(BM_KEY_POSITION_X, 245, 1);
  REQUIRE(ok(bm_session_set_keys(s, p, &k, 1, false, false)));
  REQUIRE(ok(bm_session_move_keys(s, p, &k, 1, 3, false)));
  std::vector<BmKeyframe> after = keysOf(s, p);
  REQUIRE(after.size() == 1);
  CHECK(after[0].frame == 248);
  // the app clamps with the offset limits before it calls; the engine does not clamp for it
  int32_t lower = 0, upper = 0;
  bm_key_offset_limits(bm_session_key_scene(s), 248, 248, &lower, &upper);
  CHECK(lower == -247);
  CHECK(upper == 2);
  bm_session_free(s);
}

TEST_CASE("key rows move and remove", "[keys]") {
  BmSession* s = openHeli();
  const uint32_t p = firstPart(s);
  const BmKeyframe keys[] = {key(BM_KEY_POSITION_X, 10, 1), key(BM_KEY_ROTATION_Y, 10, 30)};
  REQUIRE(ok(bm_session_set_keys(s, p, keys, 2, false, false)));
  const BmKeyRowPick pick{p, 10, false};
  REQUIRE(ok(bm_session_move_key_rows(s, &pick, 1, 5)));
  for (const BmKeyframe& k : keysOf(s, p)) CHECK(k.frame == 15);
  const BmKeyRowPick moved{p, 15, false};
  REQUIRE(ok(bm_session_remove_key_rows(s, &moved, 1)));
  CHECK(keysOf(s, p).empty());
  bm_session_free(s);
}

TEST_CASE("key scene round trip", "[keys]") {
  BmSession* s = openHeli();
  BmKeyScene scene = bm_session_key_scene(s);
  CHECK(scene.fps == 24);
  scene.fps = 30, scene.first = 5, scene.last = 95, scene.build_linked = true, scene.build_start = 10, scene.build_speed = 1.5;
  REQUIRE(ok(bm_session_set_key_scene(s, scene)));
  const BmKeyScene back = bm_session_key_scene(s);
  CHECK(back.fps == 30);
  CHECK(back.first == 5);
  CHECK(back.last == 95);
  CHECK(back.build_linked);
  CHECK(back.build_start == 10);
  CHECK(back.build_speed == 1.5);
  bm_session_free(s);
}

TEST_CASE("set keys continuing is one undo step", "[keys]") {
  BmSession* s = openHeli();
  const uint32_t p = firstPart(s);
  const size_t depth = bm_session_undo_depth(s);
  bm_session_end_gesture(s);
  for (int i = 0; i < 3; ++i) {
    const BmKeyframe k = key(BM_KEY_POSITION_X, 12, double(i));
    REQUIRE(ok(bm_session_set_keys(s, p, &k, 1, true, false)));
  }
  bm_session_end_gesture(s);
  CHECK(bm_session_undo_depth(s) == depth + 1);
  bm_session_free(s);
}

TEST_CASE("flight path from baked keys", "[keys]") {
  if (!bm_metal_available()) return;
  BmSession* s = openHeli();
  const uint32_t p = firstPart(s);
  BmViewport* v = bm_viewport_new(s);
  REQUIRE(v != nullptr);
  bm_viewport_resize(v, 320, 240, 1.0);
  bm_viewport_draw(v);
  const BmKeyframe baked[] = {key(BM_KEY_POSITION_Y, 1, -10), key(BM_KEY_POSITION_Y, 24, 0)};
  REQUIRE(ok(bm_session_set_baked_keys(s, p, baked, 2)));
  bm_viewport_draw(v);
  BmFlightPath* path = bm_viewport_flight_path(v, p);
  REQUIRE(path != nullptr);
  CHECK(bm_flight_path_line(path, nullptr, 0) >= 2);
  const size_t before = bm_flight_path_keys(path, nullptr, 0);
  CHECK(before >= 2);
  bm_flight_path_free(path);
  REQUIRE(ok(bm_session_add_flight_path_point(s, p, 12)));
  bm_viewport_draw(v);
  path = bm_viewport_flight_path(v, p);
  REQUIRE(path != nullptr);
  CHECK(bm_flight_path_keys(path, nullptr, 0) == before + 1);
  bm_flight_path_free(path);
  bm_viewport_free(v);
  bm_session_free(s);
}

TEST_CASE("use keyframes plays the key scene", "[keys]") {
  if (!bm_metal_available()) return;
  BmSession* s = openHeli();
  BmKeyScene scene = bm_session_key_scene(s);
  scene.fps = 24, scene.first = 1, scene.last = 49, scene.build_linked = false;
  REQUIRE(ok(bm_session_set_key_scene(s, scene)));
  BmViewport* v = bm_viewport_new(s);
  REQUIRE(v != nullptr);
  bm_viewport_resize(v, 320, 240, 1.0);
  bm_viewport_use_keyframes(v, true);
  bm_viewport_draw(v);
  CHECK_THAT(bm_viewport_playback_state(v).duration, WithinAbs(2.0, 1e-9));
  bm_viewport_seek(v, 1.0);
  CHECK_THAT(bm_viewport_playback_state(v).seconds, WithinAbs(1.0, 1e-6));
  scene.build_linked = true;
  REQUIRE(ok(bm_session_set_key_scene(s, scene)));
  bm_viewport_draw(v);
  bm_viewport_seek(v, 1.5);
  CHECK(bm_viewport_playback_state(v).seconds != 1.5);  // nothing to show without a plan
  bm_viewport_free(v);
  bm_session_free(s);
}

TEST_CASE("shared key maths", "[keys]") {
  BmKeyframe out[3];
  REQUIRE(bm_auto_key_values(BM_GIZMO_TOOL_MOVE, BmVec3{1, 2, 3}, BmVec3{20, 40, -60}, 12, out, 3) == 3);
  CHECK(out[0].channel == BM_KEY_POSITION_X);
  CHECK_THAT(out[0].value, WithinAbs(2, 1e-9));
  CHECK_THAT(out[1].value, WithinAbs(0, 1e-9));
  CHECK_THAT(out[2].value, WithinAbs(6, 1e-9));
  CHECK(out[2].frame == 12);
  CHECK(bm_auto_key_values(9, BmVec3{}, BmVec3{}, 1, out, 3) == 0);
  BmKeyScene scene{24, 1, 50, false, 1, 1};
  CHECK(bm_linked_key_scene(scene, true, 4.0).last == 97);
  scene.build_start = 25, scene.build_speed = 2, scene.last = 250;
  CHECK_THAT(bm_flight_keys_start(scene, 3.0), WithinAbs(2.5, 1e-9));
  const int32_t frames[] = {10, 20};
  int32_t found = 0;
  REQUIRE(bm_key_adjacent_frame(frames, 2, 15, true, &found));
  CHECK(found == 20);
  CHECK_FALSE(bm_key_adjacent_frame(frames, 2, 20, true, &found));

  BmSession* s = openHeli();
  const uint32_t p = firstPart(s);
  uint32_t piece = 0;
  bool submodel = true;
  REQUIRE(bm_auto_key_target(s, &p, 1, true, -1, &piece, &submodel));
  CHECK(piece == p);
  CHECK_FALSE(submodel);
  CHECK_FALSE(bm_auto_key_target(s, &p, 1, false, -1, &piece, &submodel));
  bm_session_free(s);
}
