// Edits, camera queries, arrow-axis and gizmo maths behind the C interface.
#include "bmffi.h"

#include <cmath>

#include "bmapp/gizmo.h"
#include "bmapp/keys.h"
#include "bmapp/session.h"
#include "bmapp/viewport.h"
#include "internal.h"

struct BmGizmo {
  bmapp::GizmoShape shape;
};

namespace {

using bmffi::change;
using bmffi::from_camera;
using bmffi::from_mat3;
using bmffi::from_vec2;
using bmffi::from_vec3;
using bmffi::guard;
using bmffi::guardVoid;
using bmffi::handle;
using bmffi::list;
using bmffi::make;
using bmffi::to_camera;
using bmffi::to_mat3;
using bmffi::to_vec2;
using bmffi::to_vec3;

bmapp::Arrow to_arrow(BmArrow a) {
  switch (a) {
    case BM_ARROW_RIGHT: return bmapp::Arrow::Right;
    case BM_ARROW_UP: return bmapp::Arrow::Up;
    case BM_ARROW_DOWN: return bmapp::Arrow::Down;
    default: return bmapp::Arrow::Left;
  }
}

bmapp::GizmoKind to_gizmo_kind(BmGizmoKind k) {
  switch (k) {
    case BM_GIZMO_MOVE: return bmapp::GizmoKind::Move;
    case BM_GIZMO_ROTATE: return bmapp::GizmoKind::Rotate;
    default: return bmapp::GizmoKind::None;
  }
}

bmapp::Handle to_handle(BmHandle h) {
  switch (h) {
    case BM_HANDLE_X: return bmapp::Handle::X;
    case BM_HANDLE_Y: return bmapp::Handle::Y;
    case BM_HANDLE_Z: return bmapp::Handle::Z;
    case BM_HANDLE_XY: return bmapp::Handle::XY;
    case BM_HANDLE_YZ: return bmapp::Handle::YZ;
    case BM_HANDLE_XZ: return bmapp::Handle::XZ;
    case BM_HANDLE_VIEW: return bmapp::Handle::View;
    default: return bmapp::Handle::None;
  }
}

BmHandle from_handle(bmapp::Handle h) {
  switch (h) {
    case bmapp::Handle::X: return BM_HANDLE_X;
    case bmapp::Handle::Y: return BM_HANDLE_Y;
    case bmapp::Handle::Z: return BM_HANDLE_Z;
    case bmapp::Handle::XY: return BM_HANDLE_XY;
    case bmapp::Handle::YZ: return BM_HANDLE_YZ;
    case bmapp::Handle::XZ: return BM_HANDLE_XZ;
    case bmapp::Handle::View: return BM_HANDLE_VIEW;
    default: return BM_HANDLE_NONE;
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

BmGizmo* bm_gizmo_shape(BmCamera camera, BmVec2 view_points, BmVec3 origin, BmMat3 axes, BmGizmoKind kind) {
  return handle<BmGizmo>([&] {
    return new BmGizmo{bmapp::gizmoShape(to_camera(camera), to_vec2(view_points), to_vec3(origin), to_mat3(axes),
                                         to_gizmo_kind(kind))};
  });
}

void bm_gizmo_free(BmGizmo* g) { delete g; }

size_t bm_gizmo_line_len(const BmGizmo* g) { return g ? g->shape.lines.size() : 0; }

void bm_gizmo_line(const BmGizmo* g, size_t i, BmVec2* a, BmVec2* b, BmHandle* h) {
  if (!g || i >= g->shape.lines.size()) {
    if (a) *a = BmVec2{0, 0};
    if (b) *b = BmVec2{0, 0};
    if (h) *h = BM_HANDLE_NONE;
    return;
  }
  const bmapp::GizmoSeg& seg = g->shape.lines[i];
  if (a) *a = from_vec2(seg.a);
  if (b) *b = from_vec2(seg.b);
  if (h) *h = from_handle(seg.h);
}

size_t bm_gizmo_ring_len(const BmGizmo* g) { return g ? g->shape.rings.size() : 0; }

BmHandle bm_gizmo_ring_handle(const BmGizmo* g, size_t i) {
  if (!g || i >= g->shape.ringHandles.size()) return BM_HANDLE_NONE;
  return from_handle(g->shape.ringHandles[i]);
}

size_t bm_gizmo_ring(const BmGizmo* g, size_t i, BmVec2* out, size_t cap) {
  if (!g || i >= g->shape.rings.size()) return 0;
  const auto& pts = g->shape.rings[i];
  for (size_t k = 0; k < pts.size() && k < cap && out; ++k) out[k] = from_vec2(pts[k]);
  return pts.size();
}

BmHandle bm_gizmo_hit(const BmGizmo* g, BmVec2 point, double tolerance) {
  if (!g) return BM_HANDLE_NONE;
  return guard(BM_HANDLE_NONE, [&] { return from_handle(bmapp::hitGizmo(g->shape, to_vec2(point), tolerance)); });
}

BmVec3 bm_handle_axis(BmCamera camera, BmMat3 axes, BmHandle h) {
  BmVec3 zero{0, 0, 0};
  return guard(zero, [&] { return from_vec3(bmapp::handleAxis(to_camera(camera), to_mat3(axes), to_handle(h))); });
}

BmVec3 bm_drag_move(BmCamera camera, BmVec2 view, BmVec3 origin, BmMat3 axes, BmHandle h, BmVec2 a, BmVec2 b,
                    BmVec3 snap) {
  BmVec3 zero{0, 0, 0};
  return guard(zero, [&] {
    return from_vec3(bmapp::dragMove(to_camera(camera), to_vec2(view), to_vec3(origin), to_mat3(axes), to_handle(h),
                                     to_vec2(a), to_vec2(b), to_vec3(snap)));
  });
}

double bm_drag_rotate(BmCamera camera, BmVec2 view, BmVec3 origin, BmMat3 axes, BmHandle h, BmVec2 a, BmVec2 b,
                      bool free) {
  return guard(0.0, [&] {
    return bmapp::dragRotate(to_camera(camera), to_vec2(view), to_vec3(origin), to_mat3(axes), to_handle(h),
                             to_vec2(a), to_vec2(b), free);
  });
}

bool bm_project_point(BmCamera camera, BmVec2 view, BmVec3 p, BmVec2* out) {
  if (out) *out = BmVec2{0, 0};
  return guard(false, [&] {
    bmapp::Vec2 pt = bmapp::projectPoint(to_camera(camera), to_vec2(view), to_vec3(p));
    if (!std::isfinite(pt.x) || !std::isfinite(pt.y)) return false;
    if (out) *out = from_vec2(pt);
    return true;
  });
}

}  // extern "C"
