// Snapping part placement preview and commit behind the C interface.
#include "bmffi.h"

#include "bmapp/session.h"
#include "bmapp/viewport.h"
#include "internal.h"

namespace {

using bmffi::change;
using bmffi::from_mat3;
using bmffi::from_vec3;
using bmffi::guard;
using bmffi::guardVoid;
using bmffi::list;
using bmffi::make;
using bmffi::to_mat3;
using bmffi::to_vec2;
using bmffi::to_vec3;

BmPlacementState from_state(bmapp::PlacementState s) {
  switch (s) {
    case bmapp::PlacementState::Preparing: return BM_PLACE_PREPARING;
    case bmapp::PlacementState::Free: return BM_PLACE_FREE;
    case bmapp::PlacementState::Snapped: return BM_PLACE_SNAPPED;
    case bmapp::PlacementState::Reference: return BM_PLACE_REFERENCE;
    case bmapp::PlacementState::Blocked: return BM_PLACE_BLOCKED;
    case bmapp::PlacementState::Unavailable: return BM_PLACE_UNAVAILABLE;
    default: return BM_PLACE_INACTIVE;
  }
}

BmPlacementPreview empty_preview() {
  return BmPlacementPreview{
      BM_PLACE_INACTIVE,
      BmMat3{{1, 0, 0, 0, 1, 0, 0, 0, 1}},
      BmVec3{0, 0, 0},
      BmVec3{0, 0, 0},
      0,
      0,
      0,
      0,
      0,
      BmString{nullptr, 0},
  };
}

}  // namespace

extern "C" {

void bm_placement_preview_free(BmPlacementPreview p) { bm_string_free(p.reason); }

uint64_t bm_viewport_preview_part(BmViewport* v, const BmPlacementInput* input, BmVec2 point) {
  if (!v || !input) return 0;
  return guard<uint64_t>(0, [&] {
    bmapp::PlacementInput in;
    in.part = input->part ? input->part : "";
    in.color = input->color;
    in.grip = input->grip;
    in.turns = input->turns;
    in.mirrored = input->mirrored;
    in.snap = input->snap;
    in.reference = input->reference;
    in.collision = input->collision;
    in.anchor = input->anchor;
    in.grab = to_vec2(input->grab);
    in.selection = list(input->selection, input->selection_len);
    return v->v->previewPart(in, to_vec2(point));
  });
}

BmPlacementPreview bm_viewport_placement_preview(const BmViewport* v) {
  if (!v) return empty_preview();
  return guard(empty_preview(), [&] {
    bmapp::PlacementPreview p = v->v->placementPreview();
    return BmPlacementPreview{
        from_state(p.state),
        from_mat3(p.pose.rotation),
        from_vec3(p.pose.position),
        from_vec3(p.contact),
        p.grip,
        p.gripCount,
        p.generation,
        p.version,
        p.request,
        make(p.reason),
    };
  });
}

void bm_viewport_clear_placement_preview(BmViewport* v) {
  if (v) guardVoid([&] { v->v->clearPlacementPreview(); });
}

void bm_viewport_show_rest(BmViewport* v) {
  if (v) guardVoid([&] { v->v->showRest(); });
}

BmChange bm_session_place_part(BmSession* s, const char* part, int32_t color, BmMat3 rotation, BmVec3 position,
                               int32_t step, int32_t before, uint64_t generation, uint64_t version) {
  return change(s, [&] {
    bmapp::PartPose pose;
    pose.rotation = to_mat3(rotation);
    pose.position = to_vec3(position);
    return s->s->placePartBefore(part ? part : "", color, pose, step, before, generation, version);
  });
}

}  // extern "C"
