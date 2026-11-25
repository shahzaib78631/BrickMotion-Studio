// Planning, playback, the timeline snapshot, lanes and timeline-view maths over bmffi.
#include <catch2/catch_test_macros.hpp>
#include <catch2/matchers/catch_matchers_floating_point.hpp>

#include <chrono>
#include <set>
#include <thread>
#include <vector>

#include "bmffi.h"

using Catch::Matchers::WithinAbs;

namespace {

const char* kHeli = BM_REPO "/samples/helicopter/helicopter.mpd";

struct Fixture {
  BmSession* s = nullptr;
  BmViewport* v = nullptr;
  Fixture() {
    s = bm_session_new();
    BmOpenResult r = bm_session_open(s, kHeli);
    REQUIRE(r.ok);
    bm_open_result_free(r);
    v = bm_viewport_new(s);
    REQUIRE(v != nullptr);
    bm_viewport_resize(v, 640, 480, 1.0);
  }
  ~Fixture() {
    bm_viewport_free(v);
    bm_session_free(s);
  }
  // Draws until the plan is ready or failed (60 s at most).
  BmPlaybackState plan() {
    bm_viewport_request_plan(v);
    const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(60);
    BmPlaybackState st = bm_viewport_playback_state(v);
    while (std::chrono::steady_clock::now() < deadline) {
      bm_viewport_draw(v);
      st = bm_viewport_playback_state(v);
      if (st.plan == BM_PLAN_READY && bm_viewport_planned_version(v) == bm_session_version(s)) return st;
      if (st.plan == BM_PLAN_FAILED) return st;
      std::this_thread::sleep_for(std::chrono::milliseconds(10));
    }
    return st;
  }
};

}  // namespace

TEST_CASE("plan becomes ready") {
  if (!bm_metal_available()) return;
  Fixture f;
  const BmPlaybackState st = f.plan();
  REQUIRE(st.plan == BM_PLAN_READY);
  CHECK(st.duration > 0);
  CHECK(bm_viewport_planned_version(f.v) == bm_session_version(f.s));
  BmString error = bm_viewport_plan_error(f.v);
  CHECK(error.len == 0);
  bm_string_free(error);
}

TEST_CASE("timeline rows match the plan") {
  if (!bm_metal_available()) return;
  Fixture f;
  REQUIRE(f.plan().plan == BM_PLAN_READY);
  BmTimeline* t = bm_viewport_build_timeline(f.v);
  REQUIRE(t != nullptr);
  const BmTimelineInfo info = bm_timeline_info(t);
  CHECK(info.duration > 0);
  CHECK(info.fps > 0);
  CHECK(info.build_end > info.build_start);
  const size_t n = bm_timeline_flights_len(t);
  REQUIRE(n > 0);
  std::set<uint32_t> seen;
  for (size_t i = 0; i < n; ++i) {
    const BmFlightRow row = bm_timeline_flight_at(t, i);
    CHECK(seen.insert(row.piece).second);
    CHECK(row.end >= row.start);
    CHECK(row.name != nullptr);
  }
  CHECK(bm_timeline_flight_at(t, n).name != nullptr);  // out of range: an empty row
  for (size_t i = 0; i < bm_timeline_notes_len(t); ++i) CHECK(bm_timeline_note_at(t, i) != nullptr);
  CHECK(bm_timeline_note_at(t, 999999) != nullptr);
  bm_timeline_free(t);
}

TEST_CASE("seek and play range") {
  if (!bm_metal_available()) return;
  Fixture f;
  REQUIRE(f.plan().plan == BM_PLAN_READY);
  BmTimeline* t = bm_viewport_build_timeline(f.v);
  const double fps = bm_timeline_info(t).fps;
  bm_timeline_free(t);
  bm_viewport_seek(f.v, 1.0);
  bm_viewport_draw(f.v);
  CHECK_THAT(bm_viewport_playback_state(f.v).seconds, WithinAbs(1.0, 1.0 / fps + 1e-9));

  bm_viewport_play_range(f.v, 0, 0.5);
  bool sawPlaying = false;
  const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(10);
  BmPlaybackState st{};
  while (std::chrono::steady_clock::now() < deadline) {
    bm_viewport_draw(f.v);
    st = bm_viewport_playback_state(f.v);
    if (st.playing) sawPlaying = true;
    if (sawPlaying && !st.playing) break;
    std::this_thread::sleep_for(std::chrono::milliseconds(10));
  }
  CHECK(sawPlaying);
  CHECK_FALSE(st.playing);
  CHECK(st.seconds >= 0.5 - 1.0 / fps);
  CHECK(st.seconds <= 0.5 + 1.0 / fps);
}

TEST_CASE("rate, loop and play toggle are accepted") {
  if (!bm_metal_available()) return;
  Fixture f;
  REQUIRE(f.plan().plan == BM_PLAN_READY);
  bm_viewport_set_playback_rate(f.v, 2.0);
  bm_viewport_set_playback_loop(f.v, true);
  bm_viewport_seek(f.v, 0);
  bm_viewport_play(f.v, true);
  bm_viewport_draw(f.v);
  CHECK(bm_viewport_playback_state(f.v).playing);
  bm_viewport_play(f.v, false);
  bm_viewport_draw(f.v);
  CHECK_FALSE(bm_viewport_playback_state(f.v).playing);
}

TEST_CASE("lanes from the timeline") {
  if (!bm_metal_available()) return;
  Fixture f;
  const BmPlaybackState st = f.plan();
  REQUIRE(st.plan == BM_PLAN_READY);
  BmTimeline* t = bm_viewport_build_timeline(f.v);
  BmLanes* l = bm_lanes_new(t, f.s);
  REQUIRE(l != nullptr);
  REQUIRE(bm_lanes_runs_len(l) > 0);
  CHECK(bm_lanes_run_index_at(l, 0) == 0);
  CHECK(bm_lanes_travel(l, 0, st.duration, true) > 0);
  const BmLaneRun first = bm_lanes_run_at(l, 0);
  CHECK(first.end >= first.start);
  REQUIRE(bm_lanes_steps_len(l) > 0);
  const BmLaneStep step = bm_lanes_step_at(l, 0);
  CHECK(step.flights > 0);
  std::vector<size_t> flights(step.flights);
  CHECK(bm_lanes_step_flights(l, 0, flights.data(), flights.size()) == step.flights);
  CHECK(flights[0] < bm_timeline_flights_len(t));
  for (size_t i = 0; i < bm_lanes_submodels_len(l); ++i) {
    const BmLaneSubmodel sub = bm_lanes_submodel_at(l, i);
    CHECK(sub.name != nullptr);
    CHECK(bm_lanes_submodel_pieces(l, i, nullptr, 0) == sub.pieces);
  }
  (void)bm_lanes_diagnostics(l, nullptr, 0);

  int32_t target = -1;
  size_t before = 0;
  double at = 0;
  CHECK(bm_lanes_arrival_target(l, t, f.s, first.start, nullptr, 0, &target, &before, &at));
  CHECK(target == first.step);
  CHECK(at >= first.start);

  BmLanes* none = bm_lanes_new(nullptr, f.s);
  CHECK(bm_lanes_run_index_at(none, 0) == -1);
  bm_lanes_free(none);
  bm_lanes_free(l);
  bm_timeline_free(t);
}

TEST_CASE("an edit makes the plan stale") {
  if (!bm_metal_available()) return;
  Fixture f;
  REQUIRE(f.plan().plan == BM_PLAN_READY);
  const uint32_t piece = 0;
  BmChange c = bm_session_move(f.s, &piece, 1, BmVec3{20, 0, 0}, false);
  REQUIRE(c.refused.len == 0);
  bm_string_free(c.refused);
  bm_viewport_draw(f.v);
  const BmPlaybackState st = bm_viewport_playback_state(f.v);
  CHECK((st.stale || st.plan != BM_PLAN_READY));
  CHECK(bm_viewport_planned_version(f.v) != bm_session_version(f.s));
}

TEST_CASE("arrange and show rest") {
  if (!bm_metal_available()) return;
  Fixture f;
  REQUIRE(f.plan().plan == BM_PLAN_READY);
  bm_viewport_arrange(f.v, 0, BM_PREVIEW_EXPLODED);
  bm_viewport_draw(f.v);
  bm_viewport_arrange(f.v, -1, BM_PREVIEW_ASSEMBLED);
  bm_viewport_draw(f.v);
  bm_viewport_show_rest(f.v);
  bm_viewport_draw(f.v);
  CHECK(bm_viewport_playback_state(f.v).at_rest);
  const size_t n = bm_viewport_build_order(f.v, nullptr, 0);
  CHECK(n > 0);
  std::vector<uint32_t> order(n);
  CHECK(bm_viewport_build_order(f.v, order.data(), n) == n);
}

TEST_CASE("sequence duration sets the intro") {
  if (!bm_metal_available()) return;
  Fixture f;
  BmChange c = bm_session_set_sequence_duration(f.s, BM_SEGMENT_INTRO, 2.0);
  REQUIRE(c.refused.len == 0);
  bm_string_free(c.refused);
  REQUIRE(f.plan().plan == BM_PLAN_READY);
  BmTimeline* t = bm_viewport_build_timeline(f.v);
  CHECK_THAT(bm_timeline_info(t).build_start, WithinAbs(2.0, 0.05));
  bm_timeline_free(t);
}

TEST_CASE("preferences and regenerate are accepted") {
  if (!bm_metal_available()) return;
  Fixture f;
  bm_viewport_set_preferences(f.v, BmViewportPreferences{true, true, false, false, false, true});
  bm_viewport_regenerate_plan(f.v, true);
  bm_viewport_draw(f.v);
  CHECK(bm_viewport_playback_state(f.v).plan != BM_PLAN_IDLE);
}

TEST_CASE("pack lane") {
  const double x[] = {0, 5, 12};
  const double w[] = {10, 10, 3};
  uint32_t rows[3] = {9, 9, 9};
  CHECK(bm_pack_lane(x, w, 3, rows) == 2);
  CHECK(rows[0] == 0);
  CHECK(rows[1] == 1);
  CHECK(rows[2] == 0);
  CHECK(bm_pack_lane(nullptr, nullptr, 0, nullptr) == 0);
}

TEST_CASE("timeline view magnify") {
  BmTimelineView view{1, 0, 600, 12, 12};
  CHECK_THAT(bm_timeline_view_time_at(view, 300, 100), WithinAbs(50, 1e-9));
  REQUIRE(bm_timeline_view_magnify(&view, 4, 300));
  CHECK(view.zoom == 4);
  CHECK_THAT(view.offset, WithinAbs(864, 1e-9));
  CHECK_THAT(bm_timeline_view_time_at(view, 300, 100), WithinAbs(50, 1e-9));
  CHECK(bm_timeline_view_pan_at_edge(&view, 599));
  CHECK(bm_timeline_view_reveal(&view, 0, 100, false));
  CHECK(bm_timeline_view_zoom_by(&view, 2, 0, 100));
  CHECK(bm_timeline_view_fit(&view));
  CHECK(view.zoom == 1);
  CHECK(bm_tick_interval(100, 760) == 10);
  CHECK_FALSE(bm_timeline_view_magnify(nullptr, 2, 0));
}
