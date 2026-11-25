// Edits, camera queries and arrow-axis maths behind the C interface.
#include "bmffi.h"

#include "bmapp/keys.h"
#include "bmapp/session.h"
#include "bmapp/viewport.h"
#include "internal.h"

namespace {

using bmffi::change;
using bmffi::from_camera;
using bmffi::from_mat3;
using bmffi::from_vec3;
using bmffi::guard;
using bmffi::guardVoid;
using bmffi::list;
using bmffi::make;
using bmffi::to_camera;
using bmffi::to_vec3;

bmapp::Arrow to_arrow(BmArrow a) {
  switch (a) {
    case BM_ARROW_RIGHT: return bmapp::Arrow::Right;
    case BM_ARROW_UP: return bmapp::Arrow::Up;
    case BM_ARROW_DOWN: return bmapp::Arrow::Down;
    default: return bmapp::Arrow::Left;
  }
}

}  // namespace

extern "C" {

BmChange bm_session_move(BmSession* s, const uint32_t* pieces, size_t n, BmVec3 delta, bool continuing) {
  return change(s, [&] { return s->s->move(list(pieces, n), to_vec3(delta), continuing); });
}

BmChange bm_session_rotate(BmSession* s, const uint32_t* pieces, size_t n, BmVec3 axis, double degrees,
                           BmVec3 pivot, bool continuing) {
  return change(s, [&] {
    return s->s->rotate(list(pieces, n), to_vec3(axis), degrees, to_vec3(pivot), continuing);
  });
}

BmChange bm_session_recolor(BmSession* s, const uint32_t* pieces, size_t n, int32_t code) {
  return change(s, [&] { return s->s->recolor(list(pieces, n), code); });
}

BmChange bm_session_duplicate(BmSession* s, const uint32_t* pieces, size_t n, BmVec3 offset) {
  return change(s, [&] { return s->s->duplicate(list(pieces, n), to_vec3(offset)); });
}

BmChange bm_session_replace_part(BmSession* s, const uint32_t* pieces, size_t n, const char* part) {
  return change(s, [&] { return s->s->replacePart(list(pieces, n), part ? part : ""); });
}

void bm_session_end_gesture(BmSession* s) {
  if (s) guardVoid([&] { s->s->endGesture(); });
}

BmMat3 bm_session_axes_of(const BmSession* s, uint32_t piece) {
  BmMat3 identity{{1, 0, 0, 0, 1, 0, 0, 0, 1}};
  if (!s) return identity;
  return guard(identity, [&] { return from_mat3(s->s->axesOf(piece)); });
}

BmString bm_session_copy(const BmSession* s, const uint32_t* pieces, size_t n) {
  if (!s) return BmString{nullptr, 0};
  return guard(BmString{nullptr, 0}, [&] { return make(s->s->copy(list(pieces, n))); });
}

BmChange bm_session_paste(BmSession* s, const char* ldraw_text, BmVec3 offset) {
  if (!ldraw_text || ldraw_text[0] == '\0') {
    BmChange out{false, s ? bm_session_version(s) : 0, make("nothing to paste")};
    return out;
  }
  return change(s, [&] { return s->s->paste(ldraw_text, to_vec3(offset)); });
}

BmCamera bm_viewport_camera(const BmViewport* v) {
  BmCamera empty{0, 0, 0, {0, 0, 0}, false, 0.6};
  if (!v) return empty;
  return guard(empty, [&] { return from_camera(v->v->camera()); });
}

BmVec3 bm_viewport_selection_center(BmViewport* v) {
  BmVec3 zero{0, 0, 0};
  if (!v) return zero;
  return guard(zero, [&] { return from_vec3(v->v->selectionCenter()); });
}

BmVec3 bm_arrow_axis(BmCamera camera, BmArrow arrow) {
  BmVec3 zero{0, 0, 0};
  return guard(zero, [&] { return from_vec3(bmapp::arrowAxis(to_camera(camera), to_arrow(arrow))); });
}

}  // extern "C"
