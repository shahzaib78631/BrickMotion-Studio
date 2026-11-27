// The C interface the Rust app relies on, against the real engine.
#include <catch2/catch_test_macros.hpp>
#include <cstdlib>
#include <string>
#include <thread>
#include <vector>
#include "bmffi.h"

static const char* kHeli = BM_REPO "/samples/helicopter/helicopter.mpd";

TEST_CASE("open helicopter and render a frame") {
  BmSession* s = bm_session_new();
  BmOpenResult r = bm_session_open(s, kHeli);
  REQUIRE(r.ok);
  bm_open_result_free(r);
  CHECK(bm_session_piece_count(s) > 100);
  BmViewport* v = bm_viewport_new(s);
  REQUIRE(v);
  REQUIRE(bm_viewport_ok(v));
  bm_viewport_set_background(v, 0.1, 0.1, 0.12);
  bm_viewport_resize(v, 320, 240, 1.0);
  bm_viewport_fit_all(v);
  for (int i = 0; i < 30 && bm_viewport_draw(v); ++i) {
  }
  std::vector<uint8_t> px(320 * 240 * 4);
  int w = 0, h = 0;
  REQUIRE(bm_viewport_readback(v, px.data(), px.size(), &w, &h));
  CHECK(w == 320);
  CHECK(h == 240);
  size_t lit = 0;
  for (size_t i = 0; i < px.size(); i += 4) lit += (px[i] > 60 || px[i + 1] > 60 || px[i + 2] > 60);
  CHECK(lit > 1000);
  CHECK(bm_viewport_pick(v, 160, 120) != BM_NO_PIECE);
  CHECK(bm_viewport_pick(v, 2, 2) == BM_NO_PIECE);
  bm_viewport_free(v);
  bm_session_free(s);
}

TEST_CASE("open failure keeps the message") {
  BmSession* s = bm_session_new();
  BmOpenResult r = bm_session_open(s, "/no/such/file.mpd");
  CHECK_FALSE(r.ok);
  CHECK(r.error.len > 0);
  bm_open_result_free(r);
  bm_session_free(s);
}

TEST_CASE("open_without_ldraw_reports") {
  setenv("BM_LDRAW_DIR", "/nonexistent-ldraw", 1);
  BmSession* s = bm_session_new();
  BmOpenResult r = bm_session_open(s, kHeli);
  CHECK_FALSE(r.ok);
  REQUIRE(r.error.ptr);
  CHECK(std::string(r.error.ptr) ==
        "No LDraw parts library at /nonexistent-ldraw (set by BM_LDRAW_DIR). Point BM_LDRAW_DIR at the folder that holds LDConfig.ldr.");
  CHECK(bm_session_piece_count(s) == 0);
  bm_open_result_free(r);
  bm_session_free(s);
  unsetenv("BM_LDRAW_DIR");
}

TEST_CASE("zero size resize is ignored") {
  BmSession* s = bm_session_new();
  bm_open_result_free(bm_session_open(s, kHeli));
  BmViewport* v = bm_viewport_new(s);
  REQUIRE(v);
  bm_viewport_resize(v, 0, 0, 2.0);
  bm_viewport_draw(v);
  bm_viewport_free(v);
  bm_session_free(s);
}

TEST_CASE("metal is available exactly when a viewport can be made") {
  BmSession* s = bm_session_new();
  bm_open_result_free(bm_session_open(s, kHeli));
  BmViewport* v = bm_viewport_new(s);
  CHECK(bm_metal_available() == (v != nullptr));
  bm_viewport_free(v);
  bm_session_free(s);
}

TEST_CASE("marquee takes the pieces inside a rectangle") {
  BmSession* s = bm_session_new();
  bm_open_result_free(bm_session_open(s, kHeli));
  BmViewport* v = bm_viewport_new(s);
  if (!v) {
    bm_session_free(s);
    return;
  }
  bm_viewport_resize(v, 400, 300, 1.0);
  bm_viewport_fit_all(v);
  bm_viewport_draw(v);
  const size_t all = bm_viewport_marquee(v, 0, 0, 400, 300, false, nullptr, 0);
  CHECK(all > 0);
  std::vector<uint32_t> got(all);
  CHECK(bm_viewport_marquee(v, 400, 300, 0, 0, false, got.data(), got.size()) == all);  // either corner first
  CHECK(bm_viewport_marquee(v, 0, 0, 3, 3, false, nullptr, 0) == 0);
  CHECK(bm_viewport_marquee(nullptr, 0, 0, 400, 300, false, nullptr, 0) == 0);
  bm_viewport_free(v);
  bm_session_free(s);
}

TEST_CASE("focus a submodel and return to the main model") {
  BmSession* s = bm_session_new();
  BmOpenResult r = bm_session_open(s, kHeli);
  REQUIRE(r.ok);
  bm_open_result_free(r);
  auto take = [](BmString str) {
    std::string out = str.ptr ? std::string(str.ptr, str.len) : std::string();
    bm_string_free(str);
    return out;
  };
  CHECK(take(bm_session_focus_path(s)).empty());
  const char* path[] = {"helicopter - underside 1.ldr"};
  BmChange c = bm_session_focus(s, path, 1);
  CHECK(c.refused.len == 0);
  bm_change_free(c);
  CHECK(take(bm_session_focused(s)) == "helicopter - underside 1.ldr");
  CHECK(take(bm_session_focus_path(s)) == "helicopter - underside 1.ldr");
  c = bm_session_focus(s, nullptr, 0);
  CHECK(c.refused.len == 0);
  bm_change_free(c);
  CHECK(take(bm_session_focus_path(s)).empty());
  // Unknown names are dropped: only the path's valid leading part is kept.
  const char* unknown[] = {"helicopter - underside 1.ldr", "no such model"};
  c = bm_session_focus(s, unknown, 2);
  bm_change_free(c);
  CHECK(take(bm_session_focus_path(s)) == "helicopter - underside 1.ldr");
  bm_session_free(s);
}
