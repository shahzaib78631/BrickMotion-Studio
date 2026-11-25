// Arrival moves, pins, step regeneration and the undo depth over bmffi.
#include <catch2/catch_test_macros.hpp>

#include <algorithm>
#include <vector>

#include "bmffi.h"

namespace {

BmSession* openHeli() {
  BmSession* s = bm_session_new();
  BmOpenResult r = bm_session_open(s, BM_REPO "/samples/helicopter/helicopter.mpd");
  REQUIRE(r.ok);
  bm_open_result_free(r);
  return s;
}

// A step with at least `n` items, and its items' first pieces.
size_t stepWith(BmSession* s, size_t n, std::vector<std::vector<uint32_t>>* pieces) {
  BmSteps* steps = bm_session_steps(s);
  const size_t count = bm_steps_len(steps);
  bm_steps_free(steps);
  for (size_t step = 0; step < count; ++step) {
    BmItems* items = bm_session_step_items(s, step);
    if (bm_items_len(items) >= n) {
      pieces->clear();
      for (size_t i = 0; i < bm_items_len(items); ++i) {
        std::vector<uint32_t> p(bm_item_pieces(items, i, nullptr, 0));
        bm_item_pieces(items, i, p.data(), p.size());
        pieces->push_back(p);
      }
      bm_items_free(items);
      return step;
    }
    bm_items_free(items);
  }
  FAIL("no step with enough items");
  return 0;
}

std::vector<uint32_t> pins(BmSession* s) {
  std::vector<uint32_t> out(bm_session_arrival_pins(s, nullptr, 0));
  bm_session_arrival_pins(s, out.data(), out.size());
  return out;
}

}  // namespace

TEST_CASE("move arrival is one undo step") {
  BmSession* s = openHeli();
  std::vector<std::vector<uint32_t>> items;
  const size_t step = stepWith(s, 3, &items);
  BmItems* before = bm_session_step_items(s, step);
  const uint64_t movedId = bm_items_at(before, bm_items_len(before) - 1).item;
  bm_items_free(before);
  const size_t depth = bm_session_undo_depth(s);
  const std::vector<uint32_t>& last = items.back();
  BmChange c = bm_session_move_arrival(s, last.data(), last.size(), step, 0, false);
  CHECK(c.refused.len == 0);
  bm_string_free(c.refused);
  CHECK(bm_session_undo_depth(s) == depth + 1);
  BmItems* after = bm_session_step_items(s, step);
  CHECK(bm_items_at(after, 0).item == movedId);
  bm_items_free(after);
  bm_session_free(s);
}

TEST_CASE("forced move pins the arrival") {
  BmSession* s = openHeli();
  std::vector<std::vector<uint32_t>> items;
  const size_t step = stepWith(s, 3, &items);
  const std::vector<uint32_t>& last = items.back();
  BmChange c = bm_session_move_arrival(s, last.data(), last.size(), step, 0, true);
  CHECK(c.refused.len == 0);
  bm_string_free(c.refused);
  BmItems* after = bm_session_step_items(s, step);
  std::vector<uint32_t> moved(bm_item_pieces(after, 0, nullptr, 0));
  bm_item_pieces(after, 0, moved.data(), moved.size());
  bm_items_free(after);
  REQUIRE(moved.size() == last.size());
  const std::vector<uint32_t> pinned = pins(s);
  CHECK(std::find(pinned.begin(), pinned.end(), moved[0]) != pinned.end());
  bm_session_free(s);
}

TEST_CASE("pins round trip") {
  BmSession* s = openHeli();
  std::vector<std::vector<uint32_t>> items;
  stepWith(s, 2, &items);
  const std::vector<uint32_t>& p = items[0];
  BmChange c = bm_session_set_arrival_pinned(s, p.data(), p.size(), true);
  bm_string_free(c.refused);
  std::vector<uint32_t> now = pins(s);
  CHECK(std::find(now.begin(), now.end(), p[0]) != now.end());
  c = bm_session_set_arrival_pinned(s, p.data(), p.size(), false);
  bm_string_free(c.refused);
  now = pins(s);
  CHECK(std::find(now.begin(), now.end(), p[0]) == now.end());
  bm_session_free(s);
}

TEST_CASE("reorder arrival and move to new step") {
  BmSession* s = openHeli();
  std::vector<std::vector<uint32_t>> items;
  const size_t step = stepWith(s, 3, &items);
  const size_t depth = bm_session_undo_depth(s);
  BmChange c = bm_session_reorder_arrival(s, step, 0, 2);
  bm_string_free(c.refused);
  CHECK(bm_session_undo_depth(s) == depth + 1);
  BmSteps* before = bm_session_steps(s);
  const size_t count = bm_steps_len(before);
  bm_steps_free(before);
  c = bm_session_move_to_new_step(s, items[1].data(), items[1].size(), step + 1);
  CHECK(c.refused.len == 0);
  bm_string_free(c.refused);
  BmSteps* after = bm_session_steps(s);
  CHECK(bm_steps_len(after) == count + 1);
  bm_steps_free(after);
  bm_session_free(s);
}

TEST_CASE("undo depth counts edits") {
  BmSession* s = openHeli();
  CHECK(bm_session_undo_depth(s) == 0);
  BmChange c = bm_session_set_sequence_duration(s, BM_SEGMENT_HERO, 3.0);
  bm_string_free(c.refused);
  CHECK(bm_session_undo_depth(s) == 1);
  c = bm_session_undo(s);
  bm_string_free(c.refused);
  CHECK(bm_session_undo_depth(s) == 0);
  CHECK(bm_session_undo_depth(nullptr) == 0);
  bm_session_free(s);
}
