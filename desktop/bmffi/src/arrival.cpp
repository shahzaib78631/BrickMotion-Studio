// Arrivals, sequence timing, step regeneration and undo depth over bmapp::Session.
#include <algorithm>
#include <cstring>
#include <vector>

#include "bmffi.h"
#include "internal.h"

namespace {

bmapp::SequenceSegment toSegment(BmSegment s) {
  switch (s) {
    case BM_SEGMENT_INTRO: return bmapp::SequenceSegment::Intro;
    case BM_SEGMENT_BUILD: return bmapp::SequenceSegment::Build;
    case BM_SEGMENT_HERO: return bmapp::SequenceSegment::Hero;
  }
  return bmapp::SequenceSegment::Intro;
}

}  // namespace

extern "C" {

BmChange bm_session_move_arrival(BmSession* s, const uint32_t* pieces, size_t n, size_t step,
                                 size_t before, bool force) {
  return bmffi::change(s, [&] { return s->s->moveArrival(bmffi::list(pieces, n), step, before, force); });
}

BmChange bm_session_reorder_arrival(BmSession* s, size_t step, size_t from, size_t to) {
  return bmffi::change(s, [&] { return s->s->reorderArrival(step, from, to); });
}

BmChange bm_session_set_arrival_pinned(BmSession* s, const uint32_t* pieces, size_t n, bool pinned) {
  return bmffi::change(s, [&] { return s->s->setArrivalPinned(bmffi::list(pieces, n), pinned); });
}

size_t bm_session_arrival_pins(const BmSession* s, uint32_t* out, size_t cap) {
  if (!s) return 0;
  return bmffi::guard<size_t>(0, [&] {
    const std::vector<uint32_t> pins = s->s->arrivalPins();
    if (out && cap > 0 && !pins.empty()) {
      const size_t n = std::min(pins.size(), cap);
      std::memcpy(out, pins.data(), n * sizeof(uint32_t));
    }
    return pins.size();
  });
}

BmChange bm_session_set_sequence_duration(BmSession* s, BmSegment segment, double seconds) {
  return bmffi::change(s, [&] { return s->s->setSequenceDuration(toSegment(segment), seconds); });
}

BmChange bm_session_regenerate_steps(BmSession* s, const uint32_t* order, size_t n) {
  return bmffi::change(s, [&] { return s->s->regenerateSteps(bmffi::list(order, n)); });
}

BmChange bm_session_move_to_new_step(BmSession* s, const uint32_t* pieces, size_t n, size_t index) {
  return bmffi::change(s, [&] { return s->s->moveToNewStep(bmffi::list(pieces, n), index); });
}

size_t bm_session_undo_depth(const BmSession* s) {
  if (!s) return 0;
  return bmffi::guard<size_t>(0, [&] { return s->s->undoDepth(); });
}

}  // extern "C"
