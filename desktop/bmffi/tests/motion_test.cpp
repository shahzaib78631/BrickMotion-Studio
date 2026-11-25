// Motion fields, flight bake, motion check, joints and insertion direction over bmffi.
#include <catch2/catch_test_macros.hpp>
#include <catch2/matchers/catch_matchers_floating_point.hpp>

#include <chrono>
#include <set>
#include <cmath>
#include <string>
#include <thread>
#include <vector>

#include "bmffi.h"

using Catch::Matchers::WithinAbs;

namespace {

const char* kHeli = BM_REPO "/samples/helicopter/helicopter.mpd";

bool ok(BmChange c) {
  const bool fine = c.refused.len == 0;
  bm_change_free(c);
  return fine;
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
  void plan() {
    v = bm_viewport_new(s);
    REQUIRE(v != nullptr);
    bm_viewport_resize(v, 320, 240, 1.0);
    bm_viewport_request_plan(v);
    const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(60);
    while (std::chrono::steady_clock::now() < deadline) {
      bm_viewport_draw(v);
      const BmPlaybackState st = bm_viewport_playback_state(v);
      if (st.plan == BM_PLAN_READY && bm_viewport_planned_version(v) == bm_session_version(s)) return;
      REQUIRE(st.plan != BM_PLAN_FAILED);
      std::this_thread::sleep_for(std::chrono::milliseconds(10));
    }
    FAIL("plan timed out");
  }
  // A flown part of the open model itself (flight paths show only for those).
  uint32_t flownPiece() {
    std::set<uint32_t> local;
    BmSteps* st = bm_session_steps(s);
    const size_t steps = bm_steps_len(st);
    bm_steps_free(st);
    for (size_t step = 0; step < steps; ++step) {
      BmItems* it = bm_session_step_items(s, step);
      for (size_t i = 0; i < bm_items_len(it); ++i) {
        uint32_t piece = 0;
        if (!bm_items_at(it, i).submodel && bm_item_pieces(it, i, &piece, 1) == 1) local.insert(piece);
      }
      bm_items_free(it);
    }
    BmTimeline* t = bm_viewport_build_timeline(v);
    REQUIRE(t != nullptr);
    uint32_t found = BM_NO_PIECE;
    for (size_t i = 0; i < bm_timeline_flights_len(t) && found == BM_NO_PIECE; ++i)
      if (local.count(bm_timeline_flight_at(t, i).piece)) found = bm_timeline_flight_at(t, i).piece;
    bm_timeline_free(t);
    REQUIRE(found != BM_NO_PIECE);
    return found;
  }
};

}  // namespace

TEST_CASE("motion fields round trip and inherit", "[motion]") {
  Fixture f;
  BmMotionFields project{2, -1, -1, -1};
  REQUIRE(ok(bm_session_set_motion_fields(f.s, BM_MOTION_PROJECT, 0, nullptr, 0, project)));
  const BmMotionFields back = bm_session_motion_fields(f.s, BM_MOTION_PROJECT, 0, nullptr, 0);
  CHECK(back.time == 2);
  CHECK(back.landing < 0);
  const BmMotionFields parts = bm_effective_motion(f.s, BM_MOTION_PARTS, 0, BmMotionFields{-1, -1, -1, -1});
  CHECK_THAT(parts.time, WithinAbs(2, 1e-12));
  CHECK_THAT(parts.landing, WithinAbs(0.25, 1e-12));
  CHECK(parts.ease == 0);
}

TEST_CASE("flight phases", "[motion]") {
  double travel = 0, hover = 0, landing = 0;
  bm_flight_phases(BmMotionFields{1, 0.25, 0.9, 0}, &travel, &hover, &landing);
  CHECK_THAT(hover, WithinAbs(0.7, 1e-12));
  CHECK_THAT(travel, WithinAbs(0.05, 1e-12));
  CHECK_THAT(landing, WithinAbs(0.25, 1e-12));
}

TEST_CASE("bake capture without a plan is null", "[motion]") {
  if (!bm_metal_available()) return;
  Fixture f;
  f.v = bm_viewport_new(f.s);
  REQUIRE(f.v != nullptr);
  const uint32_t p = 0;
  CHECK(bm_viewport_capture_flight_bake(f.v, &p, 1, false) == nullptr);
}

TEST_CASE("bake on a worker thread then apply, then check motion", "[motion]") {
  if (!bm_metal_available()) return;
  Fixture f;
  f.plan();
  const uint32_t p = f.flownPiece();
  BmFlightBake* bake = bm_viewport_capture_flight_bake(f.v, &p, 1, false);
  REQUIRE(bake != nullptr);
  CHECK_FALSE(bm_flight_bake_replaces_keys(bake));
  BmFlightBakeResult result{};
  std::thread worker([&] { result = bm_flight_bake_prepare(bake); });
  worker.join();
  CHECK(result.error.len == 0);
  bm_string_free(result.error);
  CHECK(result.flights == 1);
  CHECK(result.keys > 0);
  REQUIRE(ok(bm_session_apply_flight_bake(f.s, bake)));
  bm_flight_bake_free(bake);
  BmKeyObjects* o = bm_session_key_objects(f.s);
  bool baked = false;
  for (size_t i = 0; i < bm_key_objects_len(o); ++i) {
    const BmKeyObjectRow row = bm_key_objects_at(o, i);
    if (row.piece == p && row.baked && row.keys > 0) baked = true;
  }
  bm_key_objects_free(o);
  CHECK(baked);
  CHECK(bm_session_has_editable_flight_keys(f.s, p));

  bm_viewport_use_keyframes(f.v, true);
  bm_viewport_draw(f.v);
  BmFlightPath* path = bm_viewport_flight_path(f.v, p);
  CHECK(path != nullptr);
  bm_flight_path_free(path);
  BmMotionAudit* audit = bm_viewport_audit_motion(f.v, p);
  REQUIRE(audit != nullptr);
  BmMotionReport* report = nullptr;
  std::thread checker([&] { report = bm_motion_audit_check(audit); });
  checker.join();
  REQUIRE(report != nullptr);
  int32_t tested = 0, stride = 0, intervals = 0;
  bm_motion_report_counts(report, &tested, &stride, &intervals);
  CHECK(tested > 0);
  CHECK(stride >= 1);
  for (size_t i = 0; i < bm_motion_report_contacts_len(report); ++i) CHECK(bm_motion_report_contact_at(report, i).first_frame >= 0);
  bm_motion_report_free(report);
  bm_motion_audit_free(audit);
}

TEST_CASE("joints of the helicopter", "[motion]") {
  Fixture f;
  BmInspection* inspection = bm_inspection_capture(f.s);
  REQUIRE(inspection != nullptr);
  BmJoints* joints = bm_inspection_joints(inspection, nullptr, 0, true, false);
  REQUIRE(joints != nullptr);
  CHECK(std::string(bm_joints_error(joints)).empty());
  const BmJointRow* turning = nullptr;
  std::vector<BmJointRow> rows;
  for (size_t i = 0; i < bm_joints_len(joints); ++i) rows.push_back(bm_joints_at(joints, i));
  for (const BmJointRow& r : rows)
    if (r.type == BM_JOINT_HINGE || r.type == BM_JOINT_CYLINDRICAL || r.type == BM_JOINT_BALL) turning = &r;
  REQUIRE(turning != nullptr);
  const BmJointRow joint = *turning;
  bm_joints_free(joints);
  CHECK(bm_inspection_body(inspection, joint.b, nullptr, 0) >= 1);
  BmJointEdit* edit = bm_inspection_change_joint(inspection, joint.a, joint.b, 15, false);
  REQUIRE(edit != nullptr);
  INFO(bm_joint_edit_error(edit));
  REQUIRE(std::string(bm_joint_edit_error(edit)).empty());
  const size_t n = bm_joint_edit_pieces(edit, nullptr, 0);
  REQUIRE(n > 0);
  std::vector<uint32_t> pieces(n);
  bm_joint_edit_pieces(edit, pieces.data(), n);
  BmMat3 rotation{};
  BmVec3 position{};
  bm_joint_edit_pose(edit, &rotation, &position);
  const uint32_t pivot = bm_joint_edit_pivot(edit);
  bm_joint_edit_free(edit);
  bm_inspection_free(inspection);

  const uint64_t gen = bm_session_generation(f.s), ver = bm_session_version(f.s);
  CHECK_FALSE(ok(bm_session_place_moved(f.s, pieces.data(), n, pivot, rotation, position, gen, ver - 1)));
  const size_t depth = bm_session_undo_depth(f.s);
  REQUIRE(ok(bm_session_place_moved(f.s, pieces.data(), n, pivot, rotation, position, gen, ver)));
  CHECK(bm_session_undo_depth(f.s) == depth + 1);
}

TEST_CASE("insertion direction round trip", "[motion]") {
  Fixture f;
  const uint32_t p = 0;
  REQUIRE(ok(bm_session_set_insertion_direction(f.s, &p, 1, BmVec3{0, -1, 0})));
  const BmVec3 d = bm_session_insertion_direction(f.s, p);
  CHECK_THAT(d.y, WithinAbs(-1, 1e-9));
  REQUIRE(ok(bm_session_set_insertion_direction(f.s, &p, 1, BmVec3{0, 0, 0})));
  CHECK_THAT(std::abs(bm_session_insertion_direction(f.s, p).y), WithinAbs(0, 1e-9));
}
