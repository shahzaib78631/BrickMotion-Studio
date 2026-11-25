// Edits, camera and arrow-axis tests over bmffi.
#include <catch2/catch_test_macros.hpp>
#include <cmath>
#include <string>
#include "bmffi.h"

static const char* kHeliEdit = BM_REPO "/samples/helicopter/helicopter.mpd";

static BmSession* openHeliEdit() {
  BmSession* s = bm_session_new();
  BmOpenResult r = bm_session_open(s, kHeliEdit);
  REQUIRE(r.ok);
  bm_open_result_free(r);
  return s;
}

TEST_CASE("move is one undo step and moves nothing else") {
  BmSession* s = openHeliEdit();
  uint32_t p0 = 0;
  uint64_t v = bm_session_version(s);
  BmString before = bm_session_copy(s, &p0, 1);
  BmChange c = bm_session_move(s, &p0, 1, BmVec3{20, 0, 0}, false);
  CHECK(c.refused.len == 0);
  CHECK_FALSE(c.structure);
  CHECK(c.version > v);
  bm_change_free(c);
  BmString after = bm_session_copy(s, &p0, 1);
  CHECK(std::string(before.ptr, before.len) != std::string(after.ptr, after.len));
  bm_string_free(after);
  bm_change_free(bm_session_undo(s));
  CHECK(bm_session_can_redo(s));
  BmString restored = bm_session_copy(s, &p0, 1);
  CHECK(std::string(before.ptr, before.len) == std::string(restored.ptr, restored.len));
  bm_string_free(before);
  bm_string_free(restored);
  bm_session_free(s);
}

TEST_CASE("a continuing move joins the previous step") {
  BmSession* s = openHeliEdit();
  uint32_t p0 = 0;
  bm_session_end_gesture(s);
  BmChange c1 = bm_session_move(s, &p0, 1, BmVec3{20, 0, 0}, true);
  CHECK(c1.refused.len == 0);
  bm_change_free(c1);
  BmChange c2 = bm_session_move(s, &p0, 1, BmVec3{20, 0, 0}, true);
  CHECK(c2.refused.len == 0);
  bm_change_free(c2);
  bm_session_end_gesture(s);
  bm_change_free(bm_session_undo(s));
  CHECK_FALSE(bm_session_can_undo(s));
  bm_session_free(s);
}

TEST_CASE("rotate, recolor, duplicate, replace") {
  BmSession* s = openHeliEdit();
  uint32_t p0 = 0;
  size_t n = bm_session_piece_count(s);

  BmMat3 ax = bm_session_axes_of(s, p0);
  double norm = std::hypot(ax.m[0], ax.m[3], ax.m[6]);
  CHECK(std::abs(norm - 1.0) < 1e-6);

  BmChange rot = bm_session_rotate(s, &p0, 1, BmVec3{0, 1, 0}, 90.0, BmVec3{0, 0, 0}, false);
  CHECK(rot.refused.len == 0);
  bm_change_free(rot);

  BmChange rec = bm_session_recolor(s, &p0, 1, 4);
  CHECK(rec.refused.len == 0);
  bm_change_free(rec);

  BmChange dup = bm_session_duplicate(s, &p0, 1, BmVec3{20, 0, 0});
  CHECK(dup.refused.len == 0);
  bm_change_free(dup);
  CHECK(bm_session_piece_count(s) == n + 1);

  BmChange rep = bm_session_replace_part(s, &p0, 1, "3001.dat");
  CHECK(rep.refused.len == 0);
  bm_change_free(rep);

  bm_session_free(s);
}

TEST_CASE("recolor of nothing is a no-op and empty paste is refused") {
  BmSession* s = openHeliEdit();
  uint64_t v = bm_session_version(s);
  BmChange c = bm_session_recolor(s, nullptr, 0, 4);
  CHECK(bm_session_version(s) == v);
  bm_change_free(c);

  BmChange empty = bm_session_paste(s, "", BmVec3{0, 0, 0});
  CHECK(empty.refused.len > 0);
  CHECK(bm_session_version(s) == v);
  bm_change_free(empty);
  bm_session_free(s);
}

TEST_CASE("copy then paste adds the pieces") {
  BmSession* s = openHeliEdit();
  size_t n = bm_session_piece_count(s);
  uint32_t two[] = {0, 1};
  BmString text = bm_session_copy(s, two, 2);
  REQUIRE(text.len > 0);
  std::string str(text.ptr, text.len);
  CHECK(str.find("1 ") != std::string::npos);
  BmChange pasted = bm_session_paste(s, str.c_str(), BmVec3{0, 0, 0});
  CHECK(pasted.refused.len == 0);
  bm_change_free(pasted);
  CHECK(bm_session_piece_count(s) == n + 2);
  bm_string_free(text);

  BmChange empty = bm_session_paste(s, "", BmVec3{0, 0, 0});
  CHECK(empty.refused.len > 0);
  bm_change_free(empty);
  bm_session_free(s);
}

TEST_CASE("camera and arrow axis") {
  BmSession* s = openHeliEdit();
  if (bm_metal_available()) {
    BmViewport* v = bm_viewport_new(s);
    REQUIRE(v != nullptr);
    bm_viewport_resize(v, 320, 240, 1.0);
    bm_viewport_fit_all(v);
    BmCamera cam = bm_viewport_camera(v);
    CHECK(cam.distance > 0.0);
    BmVec3 right = bm_arrow_axis(cam, BM_ARROW_RIGHT);
    CHECK(right.y == 0.0);
    CHECK(std::abs(std::hypot(right.x, right.z) - 1.0) < 1e-9);
    BmVec3 center = bm_viewport_selection_center(v);
    CHECK(std::isfinite(center.x));
    bm_viewport_free(v);
  }
  bm_session_free(s);
}

TEST_CASE("edit struct sizes") {
  CHECK(bm_struct_size("BmVec2") == sizeof(BmVec2));
  CHECK(bm_struct_size("BmVec3") == sizeof(BmVec3));
  CHECK(bm_struct_size("BmMat3") == sizeof(BmMat3));
  CHECK(bm_struct_size("BmCamera") == sizeof(BmCamera));
}
