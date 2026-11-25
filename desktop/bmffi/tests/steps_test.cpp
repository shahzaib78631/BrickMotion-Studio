// Build steps, step items and step edits tests over bmffi (using samples/8880-1.mpd which has >= 2 steps).
#include <catch2/catch_test_macros.hpp>
#include <algorithm>
#include <string>
#include <vector>
#include "bmffi.h"

static const char* kMultiStep = BM_REPO "/samples/8880-1.mpd";

static BmSession* openMultiStep() {
  BmSession* s = bm_session_new();
  BmOpenResult r = bm_session_open(s, kMultiStep);
  REQUIRE(r.ok);
  bm_open_result_free(r);
  return s;
}

static size_t stepLen(const BmSession* s) {
  BmSteps* st = bm_session_steps(s);
  REQUIRE(st != nullptr);
  size_t n = bm_steps_len(st);
  bm_steps_free(st);
  return n;
}

static std::vector<uint32_t> stepPieces(const BmSession* s, size_t step) {
  size_t n = bm_session_pieces_of_step(s, step, nullptr, 0);
  std::vector<uint32_t> out(n);
  if (n > 0) bm_session_pieces_of_step(s, step, out.data(), out.size());
  return out;
}

TEST_CASE("steps list and items carry their pieces") {
  BmSession* s = openMultiStep();
  BmSteps* st = bm_session_steps(s);
  REQUIRE(st != nullptr);
  size_t n = bm_steps_len(st);
  REQUIRE(n >= 2);
  BmStepRow r0 = bm_steps_at(st, 0);
  CHECK(r0.index == 0);
  CHECK(r0.pieces > 0);
  bm_steps_free(st);

  BmItems* it = bm_session_step_items(s, 0);
  REQUIRE(it != nullptr);
  size_t itemCount = bm_items_len(it);
  REQUIRE(itemCount > 0);
  size_t sumPieces = 0;
  for (size_t i = 0; i < itemCount; ++i) {
    BmItemRow row = bm_items_at(it, i);
    size_t pn = bm_item_pieces(it, i, nullptr, 0);
    CHECK(pn == row.pieces);
    sumPieces += pn;
  }
  bm_items_free(it);
  CHECK(sumPieces == stepPieces(s, 0).size());
  bm_session_free(s);
}

TEST_CASE("insert then delete a step") {
  BmSession* s = openMultiStep();
  size_t n = stepLen(s);
  BmChange ins = bm_session_insert_step(s, 1);
  CHECK(ins.refused.len == 0);
  bm_change_free(ins);
  CHECK(stepLen(s) == n + 1);

  BmChange del = bm_session_delete_step(s, 1);
  CHECK(del.refused.len == 0);
  bm_change_free(del);
  CHECK(stepLen(s) == n);

  bm_change_free(bm_session_undo(s));
  CHECK(stepLen(s) == n + 1);
  bm_change_free(bm_session_undo(s));
  CHECK(stepLen(s) == n);
  bm_session_free(s);
}

TEST_CASE("split moves chosen pieces and merge joins two steps") {
  BmSession* s = openMultiStep();
  // Find a step with >= 2 items so splitting one item leaves the step non-empty.
  size_t targetStep = 0;
  std::vector<uint32_t> firstItemPieces;
  size_t totalSteps = stepLen(s);
  for (size_t k = 0; k < totalSteps; ++k) {
    BmItems* it = bm_session_step_items(s, k);
    if (bm_items_len(it) >= 2) {
      targetStep = k;
      size_t pn = bm_item_pieces(it, 0, nullptr, 0);
      firstItemPieces.resize(pn);
      bm_item_pieces(it, 0, firstItemPieces.data(), pn);
      bm_items_free(it);
      break;
    }
    bm_items_free(it);
  }
  REQUIRE(!firstItemPieces.empty());

  BmChange sp = bm_session_split_step(s, targetStep, firstItemPieces.data(), firstItemPieces.size());
  CHECK(sp.refused.len == 0);
  bm_change_free(sp);
  CHECK(stepLen(s) == totalSteps + 1);

  BmChange mg = bm_session_merge_steps(s, targetStep);
  CHECK(mg.refused.len == 0);
  bm_change_free(mg);
  CHECK(stepLen(s) == totalSteps);
  bm_session_free(s);
}

TEST_CASE("fields: typing is one undo step") {
  BmSession* s = openMultiStep();
  BmSteps* before = bm_session_steps(s);
  std::string origTitle = bm_steps_at(before, 0).title;
  bm_steps_free(before);

  bm_session_end_gesture(s);
  BmChange c1 = bm_session_set_step_fields(s, 0, "A", "", 0.0, false, true);
  CHECK(c1.refused.len == 0);
  bm_change_free(c1);
  BmChange c2 = bm_session_set_step_fields(s, 0, "AB", "", 0.0, false, true);
  CHECK(c2.refused.len == 0);
  bm_change_free(c2);
  bm_session_end_gesture(s);

  BmSteps* mid = bm_session_steps(s);
  CHECK(std::string(bm_steps_at(mid, 0).title) == "AB");
  bm_steps_free(mid);

  bm_change_free(bm_session_undo(s));
  CHECK_FALSE(bm_session_can_undo(s));
  BmSteps* after = bm_session_steps(s);
  CHECK(std::string(bm_steps_at(after, 0).title) == origTitle);
  bm_steps_free(after);
  bm_session_free(s);
}

TEST_CASE("move to step and refused empty split") {
  BmSession* s = openMultiStep();
  auto p1 = stepPieces(s, 1);
  REQUIRE(!p1.empty());
  // Pick a whole item from step 1 so it moves cleanly into step 0.
  BmItems* it1 = bm_session_step_items(s, 1);
  REQUIRE(bm_items_len(it1) > 0);
  size_t pn = bm_item_pieces(it1, 0, nullptr, 0);
  std::vector<uint32_t> moveSet(pn);
  bm_item_pieces(it1, 0, moveSet.data(), pn);
  bm_items_free(it1);

  size_t s0Before = stepPieces(s, 0).size();
  BmChange mv = bm_session_move_to_step(s, moveSet.data(), moveSet.size(), 0);
  CHECK(mv.refused.len == 0);
  bm_change_free(mv);
  auto s0After = stepPieces(s, 0);
  CHECK(s0After.size() == s0Before + moveSet.size());

  // Splitting step 0 with all its pieces is refused.
  size_t nBefore = stepLen(s);
  BmChange bad = bm_session_split_step(s, 0, s0After.data(), s0After.size());
  CHECK(bad.refused.len > 0);
  CHECK(stepLen(s) == nBefore);
  bm_change_free(bad);
  bm_session_free(s);
}

TEST_CASE("steps struct sizes") {
  CHECK(bm_struct_size("BmStepRow") == sizeof(BmStepRow));
  CHECK(bm_struct_size("BmItemRow") == sizeof(BmItemRow));
}
