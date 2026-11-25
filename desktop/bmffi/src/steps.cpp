// Build steps, step items and step editing commands behind the C interface.
#include "bmffi.h"

#include <vector>

#include "bmapp/session.h"
#include "internal.h"

struct BmSteps {
  std::vector<bmapp::StepRow> rows;
};

struct BmItems {
  std::vector<bmapp::ItemRow> rows;
};

namespace {
using bmffi::change;
using bmffi::guard;
using bmffi::handle;
using bmffi::list;
}  // namespace

extern "C" {

BmSteps* bm_session_steps(const BmSession* s) {
  if (!s) return nullptr;
  return handle<BmSteps>([&] { return new BmSteps{s->s->steps()}; });
}

size_t bm_steps_len(const BmSteps* st) { return st ? st->rows.size() : 0; }

BmStepRow bm_steps_at(const BmSteps* st, size_t i) {
  if (!st || i >= st->rows.size()) return BmStepRow{0, "", "", 0.0, false, false, 0, 0, 0};
  const bmapp::StepRow& r = st->rows[i];
  return BmStepRow{r.index, r.title.c_str(), r.notes.c_str(), r.pauseAfter, r.pinOrder, r.automatic,
                   r.items, r.pieces, r.submodels};
}

void bm_steps_free(BmSteps* st) { delete st; }

BmItems* bm_session_step_items(const BmSession* s, size_t step) {
  if (!s) return nullptr;
  return handle<BmItems>([&] { return new BmItems{s->s->stepItems(step)}; });
}

size_t bm_items_len(const BmItems* it) { return it ? it->rows.size() : 0; }

BmItemRow bm_items_at(const BmItems* it, size_t i) {
  if (!it || i >= it->rows.size()) return BmItemRow{0, "", "", "", "", 16, false, 0, 0, 0};
  const bmapp::ItemRow& r = it->rows[i];
  return BmItemRow{r.item, r.name.c_str(), r.description.c_str(), r.colorName.c_str(), r.group.c_str(),
                   r.color, r.submodel, r.step, r.index, r.pieces.size()};
}

size_t bm_item_pieces(const BmItems* it, size_t i, uint32_t* out, size_t cap) {
  if (!it || i >= it->rows.size()) return 0;
  const auto& p = it->rows[i].pieces;
  for (size_t k = 0; k < p.size() && k < cap && out; ++k) out[k] = p[k];
  return p.size();
}

void bm_items_free(BmItems* it) { delete it; }

size_t bm_session_pieces_of_step(const BmSession* s, size_t step, uint32_t* out, size_t cap) {
  if (!s) return 0;
  return guard<size_t>(0, [&] {
    std::vector<uint32_t> p = s->s->piecesOfStep(step);
    for (size_t k = 0; k < p.size() && k < cap && out; ++k) out[k] = p[k];
    return p.size();
  });
}

BmChange bm_session_insert_step(BmSession* s, size_t at) {
  return change(s, [&] { return s->s->insertStep(at); });
}

BmChange bm_session_delete_step(BmSession* s, size_t at) {
  return change(s, [&] { return s->s->deleteStep(at); });
}

BmChange bm_session_move_step(BmSession* s, size_t from, size_t to) {
  return change(s, [&] { return s->s->moveStep(from, to); });
}

BmChange bm_session_split_step(BmSession* s, size_t at, const uint32_t* pieces, size_t n) {
  return change(s, [&] { return s->s->splitStep(at, list(pieces, n)); });
}

BmChange bm_session_merge_steps(BmSession* s, size_t first) {
  return change(s, [&] { return s->s->mergeSteps(first); });
}

BmChange bm_session_set_step_fields(BmSession* s, size_t at, const char* title, const char* notes, double pause_after,
                                    bool pin_order, bool continuing) {
  return change(s, [&] {
    bmapp::StepFields f;
    f.title = title ? title : "";
    f.notes = notes ? notes : "";
    f.pauseAfter = pause_after;
    f.pinOrder = pin_order;
    return s->s->setStepFields(at, f, continuing);
  });
}

BmChange bm_session_move_to_step(BmSession* s, const uint32_t* pieces, size_t n, size_t step) {
  return change(s, [&] { return s->s->moveToStep(list(pieces, n), step); });
}

BmChange bm_session_reorder_in_step(BmSession* s, size_t step, size_t from, size_t to) {
  return change(s, [&] { return s->s->reorderInStep(step, from, to); });
}

}  // extern "C"
