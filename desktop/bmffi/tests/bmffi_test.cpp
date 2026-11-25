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

TEST_CASE("adopt moves a worker-loaded document") {
  BmSession* ui = bm_session_new();
  BmSession* w = bm_session_new();
  std::thread([&] { bm_open_result_free(bm_session_open(w, kHeli)); }).join();
  uint64_t g0 = bm_session_generation(ui);
  bm_session_adopt(ui, w);
  CHECK(bm_session_piece_count(ui) == bm_session_piece_count(w));
  CHECK(bm_session_generation(ui) != g0);
  bm_session_free(w);
  bm_session_free(ui);
}
