// Placement preview, commit and stale-version guard tests over bmffi.
#include <catch2/catch_test_macros.hpp>
#include <chrono>
#include <thread>
#include "bmffi.h"

static const char* kHeliPlace = BM_REPO "/samples/helicopter/helicopter.mpd";

static BmSession* openHeliPlace() {
  BmSession* s = bm_session_new();
  BmOpenResult r = bm_session_open(s, kHeliPlace);
  REQUIRE(r.ok);
  bm_open_result_free(r);
  return s;
}

static BmPlacementInput makeInput(const char* part, int32_t color) {
  return BmPlacementInput{
      part, color, -1, 0, false, true, false, true, BM_NO_PIECE, BmVec2{0, 0}, nullptr, 0,
  };
}

static BmPlacementPreview waitPreview(BmViewport* v, uint64_t req) {
  auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(5);
  while (std::chrono::steady_clock::now() < deadline) {
    bm_viewport_draw(v);
    BmPlacementPreview p = bm_viewport_placement_preview(v);
    if (p.request == req && p.state != BM_PLACE_PREPARING && p.state != BM_PLACE_INACTIVE) return p;
    bm_placement_preview_free(p);
    std::this_thread::sleep_for(std::chrono::milliseconds(10));
  }
  return bm_viewport_placement_preview(v);
}

TEST_CASE("preview answers its request and places one piece") {
  if (!bm_metal_available()) return;
  BmSession* s = openHeliPlace();
  BmViewport* v = bm_viewport_new(s);
  REQUIRE(v != nullptr);
  bm_viewport_resize(v, 640, 480, 1.0);
  bm_viewport_fit_all(v);
  bm_viewport_draw(v);
  bm_viewport_show_rest(v);

  BmPlacementInput in = makeInput("3001.dat", 4);
  uint64_t req = bm_viewport_preview_part(v, &in, BmVec2{320, 240});
  REQUIRE(req > 0);
  BmPlacementPreview p = waitPreview(v, req);
  CHECK(p.request == req);
  CHECK((p.state == BM_PLACE_FREE || p.state == BM_PLACE_SNAPPED || p.state == BM_PLACE_BLOCKED));

  if (p.state == BM_PLACE_FREE || p.state == BM_PLACE_SNAPPED) {
    size_t n = bm_session_piece_count(s);
    BmChange placed = bm_session_place_part(s, "3001.dat", 4, p.rotation, p.position, -1, -1, p.generation, p.version);
    CHECK(placed.refused.len == 0);
    bm_change_free(placed);
    CHECK(bm_session_piece_count(s) == n + 1);
    bm_change_free(bm_session_undo(s));
    CHECK(bm_session_piece_count(s) == n);
  }

  bm_placement_preview_free(p);
  bm_viewport_clear_placement_preview(v);
  bm_viewport_free(v);
  bm_session_free(s);
}

TEST_CASE("a stale version is refused") {
  if (!bm_metal_available()) return;
  BmSession* s = openHeliPlace();
  uint64_t gen = bm_session_generation(s);
  uint64_t old_ver = bm_session_version(s);
  uint32_t first = 0;
  bm_change_free(bm_session_remove(s, &first, 1));
  size_t n = bm_session_piece_count(s);
  BmMat3 id{{1, 0, 0, 0, 1, 0, 0, 0, 1}};
  BmChange stale = bm_session_place_part(s, "3001.dat", 4, id, BmVec3{0, 0, 0}, -1, -1, gen, old_ver);
  CHECK(stale.refused.len > 0);
  CHECK(bm_session_piece_count(s) == n);
  bm_change_free(stale);
  bm_session_free(s);
}

TEST_CASE("placement struct sizes") {
  CHECK(bm_struct_size("BmPlacementInput") == sizeof(BmPlacementInput));
  CHECK(bm_struct_size("BmPlacementPreview") == sizeof(BmPlacementPreview));
}
