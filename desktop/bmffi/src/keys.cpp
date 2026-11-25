// Keyframes: the key scene, key objects, keys, key rows and flight paths behind the C interface.
#include "bmffi.h"

#include <vector>

#include "bmapp/key_tracks.h"
#include "bmapp/session.h"
#include "bmapp/viewport.h"
#include "internal.h"

struct BmKeyObjects {
  bmapp::KeyObjectList rows;
};

struct BmFlightPath {
  bmapp::FlightPath path;
};

namespace {
using bmffi::change;
using bmffi::from_vec3;
using bmffi::guard;
using bmffi::handle;
using bmffi::to_vec3;

bmapp::Keyframe toKey(const BmKeyframe& k) {
  bmapp::Keyframe out;
  out.channel = static_cast<bmapp::KeyChannel>(k.channel);
  out.frame = k.frame;
  out.value = k.value;
  out.interpolation = static_cast<bmapp::KeyInterpolation>(k.interpolation);
  return out;
}

BmKeyframe fromKey(const bmapp::Keyframe& k) {
  return BmKeyframe{static_cast<int32_t>(k.channel), k.frame, k.value, static_cast<int32_t>(k.interpolation)};
}

bmapp::KeyList keyList(const BmKeyframe* keys, size_t n) {
  bmapp::KeyList out;
  for (size_t i = 0; keys && i < n; ++i) out.push_back(toKey(keys[i]));
  return out;
}

bmapp::KeyRowPicks pickList(const BmKeyRowPick* picks, size_t n) {
  bmapp::KeyRowPicks out;
  for (size_t i = 0; picks && i < n; ++i) out.push_back(bmapp::KeyRowPick{picks[i].piece, picks[i].frame, picks[i].submodel});
  return out;
}

bmapp::KeyScene toScene(const BmKeyScene& s) {
  bmapp::KeyScene out;
  out.fps = s.fps, out.first = s.first, out.last = s.last;
  out.buildLinked = s.build_linked;
  out.buildStart = s.build_start;
  out.buildSpeed = s.build_speed;
  return out;
}

BmKeyScene fromScene(const bmapp::KeyScene& s) {
  return BmKeyScene{s.fps, s.first, s.last, s.buildLinked, s.buildStart, s.buildSpeed};
}

size_t copyPoints(const bmapp::FlightPathPoints& points, BmFlightPathPoint* out, size_t cap) {
  for (size_t i = 0; out && i < points.size() && i < cap; ++i) out[i] = BmFlightPathPoint{points[i].frame, from_vec3(points[i].at)};
  return points.size();
}

bool validChannel(int32_t c) { return c >= 0 && c <= static_cast<int32_t>(bmapp::KeyChannel::Visibility); }
}  // namespace

extern "C" {

BmKeyScene bm_session_key_scene(const BmSession* s) {
  return guard<BmKeyScene>(fromScene({}), [&] { return fromScene(s ? s->s->keyScene() : bmapp::KeyScene{}); });
}

BmChange bm_session_set_key_scene(BmSession* s, BmKeyScene scene) {
  return change(s, [&] { return s->s->setKeyScene(toScene(scene)); });
}

BmKeyObjects* bm_session_key_objects(const BmSession* s) {
  if (!s) return nullptr;
  return handle<BmKeyObjects>([&] { return new BmKeyObjects{bmapp::keyObjects(s->s)}; });
}

size_t bm_key_objects_len(const BmKeyObjects* o) { return o ? o->rows.size() : 0; }

BmKeyObjectRow bm_key_objects_at(const BmKeyObjects* o, size_t i) {
  if (!o || i >= o->rows.size()) return BmKeyObjectRow{BM_NO_PIECE, false, "", false, false, 0, 0, 0};
  const bmapp::KeyObject& r = o->rows[i];
  return BmKeyObjectRow{r.piece, r.submodel, r.name.c_str(), r.baked, r.keyed, r.keys.size(), r.members.size(),
                        r.markers.size()};
}

size_t bm_key_objects_keys(const BmKeyObjects* o, size_t i, BmKeyframe* out, size_t cap) {
  if (!o || i >= o->rows.size()) return 0;
  const auto& keys = o->rows[i].keys;
  for (size_t k = 0; out && k < keys.size() && k < cap; ++k) out[k] = fromKey(keys[k]);
  return keys.size();
}

size_t bm_key_objects_members(const BmKeyObjects* o, size_t i, uint32_t* out, size_t cap) {
  if (!o || i >= o->rows.size()) return 0;
  const auto& m = o->rows[i].members;
  for (size_t k = 0; out && k < m.size() && k < cap; ++k) out[k] = m[k];
  return m.size();
}

size_t bm_key_objects_markers(const BmKeyObjects* o, size_t i, int32_t* frames, size_t* channels, size_t cap) {
  if (!o || i >= o->rows.size()) return 0;
  const auto& m = o->rows[i].markers;
  for (size_t k = 0; k < m.size() && k < cap; ++k) {
    if (frames) frames[k] = m[k].frame;
    if (channels) channels[k] = m[k].channels;
  }
  return m.size();
}

void bm_key_objects_free(BmKeyObjects* o) { delete o; }

bool bm_key_adjacent_frame(const int32_t* frames, size_t n, int32_t frame, bool after, int32_t* out) {
  return guard<bool>(false, [&] {
    bmapp::FrameList list(frames, frames + (frames ? n : 0));
    int found = 0;
    if (!bmapp::adjacentKeyFrame(list, frame, after, &found)) return false;
    if (out) *out = found;
    return true;
  });
}

double bm_session_key_value(const BmSession* s, uint32_t piece, int32_t channel, double frame, bool submodel) {
  if (!s || !validChannel(channel)) return 0;
  return guard<double>(0, [&] { return s->s->keyValue(piece, static_cast<bmapp::KeyChannel>(channel), frame, submodel); });
}

BmChange bm_session_set_keys(BmSession* s, uint32_t piece, const BmKeyframe* keys, size_t n, bool continuing,
                             bool submodel) {
  return change(s, [&] { return s->s->setKeys(piece, keyList(keys, n), continuing, submodel); });
}

BmChange bm_session_remove_keys(BmSession* s, uint32_t piece, const BmKeyframe* keys, size_t n, bool submodel) {
  return change(s, [&] { return s->s->removeKeys(piece, keyList(keys, n), submodel); });
}

BmChange bm_session_move_keys(BmSession* s, uint32_t piece, const BmKeyframe* keys, size_t n, int32_t offset,
                              bool submodel) {
  return change(s, [&] { return s->s->moveKeys(piece, keyList(keys, n), offset, submodel); });
}

BmChange bm_session_move_key_rows(BmSession* s, const BmKeyRowPick* picks, size_t n, int32_t offset) {
  return change(s, [&] { return s->s->moveKeyRows(pickList(picks, n), offset); });
}

BmChange bm_session_remove_key_rows(BmSession* s, const BmKeyRowPick* picks, size_t n) {
  return change(s, [&] { return s->s->removeKeyRows(pickList(picks, n)); });
}

BmChange bm_session_set_baked_keys(BmSession* s, uint32_t piece, const BmKeyframe* keys, size_t n) {
  return change(s, [&] { return s->s->setBakedKeys(piece, keyList(keys, n)); });
}

bool bm_session_has_editable_flight_keys(const BmSession* s, uint32_t piece) {
  return s && guard<bool>(false, [&] { return s->s->hasEditableFlightKeys(piece); });
}

BmChange bm_session_add_flight_path_point(BmSession* s, uint32_t piece, int32_t frame) {
  return change(s, [&] { return s->s->addFlightPathPoint(piece, frame); });
}

BmChange bm_session_set_flight_path_point(BmSession* s, uint32_t piece, int32_t frame, BmVec3 at, bool continuing) {
  return change(s, [&] { return s->s->setFlightPathPoint(piece, frame, to_vec3(at), continuing); });
}

BmChange bm_session_delete_flight_path_point(BmSession* s, uint32_t piece, int32_t frame) {
  return change(s, [&] { return s->s->deleteFlightPathPoint(piece, frame); });
}

BmChange bm_session_return_flight_to_planner(BmSession* s, uint32_t piece) {
  return change(s, [&] { return s->s->returnFlightToPlanner(piece); });
}

BmChange bm_session_use_flight_in_build(BmSession* s, uint32_t piece, const BmFlightPose* route, size_t n) {
  return change(s, [&] {
    bmapp::FlightPoseList poses;
    for (size_t i = 0; route && i < n; ++i)
      poses.push_back(bmapp::FlightPose{to_vec3(route[i].position), route[i].qx, route[i].qy, route[i].qz, route[i].qw});
    return s->s->useFlightInBuild(piece, poses);
  });
}

void bm_viewport_use_keyframes(BmViewport* v, bool enabled) {
  if (v) bmffi::guardVoid([&] { v->v->useKeyframes(enabled); });
}

BmFlightPath* bm_viewport_flight_path(BmViewport* v, uint32_t piece) {
  if (!v) return nullptr;
  return handle<BmFlightPath>([&]() -> BmFlightPath* {
    bmapp::FlightPath path = v->v->flightPath(piece);
    if (path.empty()) return nullptr;
    return new BmFlightPath{std::move(path)};
  });
}

size_t bm_flight_path_line(const BmFlightPath* p, BmFlightPathPoint* out, size_t cap) {
  return p ? copyPoints(p->path.line, out, cap) : 0;
}

size_t bm_flight_path_keys(const BmFlightPath* p, BmFlightPathPoint* out, size_t cap) {
  return p ? copyPoints(p->path.keys, out, cap) : 0;
}

void bm_flight_path_free(BmFlightPath* p) { delete p; }

BmVec3 bm_viewport_drag_facing_view(const BmViewport* v, BmVec3 through, double x0, double y0, double x1, double y1) {
  if (!v) return BmVec3{0, 0, 0};
  return guard<BmVec3>(BmVec3{0, 0, 0}, [&] { return from_vec3(v->v->dragFacingView(to_vec3(through), x0, y0, x1, y1)); });
}

size_t bm_viewport_edited_flight_route(BmViewport* v, uint32_t piece, BmFlightPose* out, size_t cap) {
  if (!v) return 0;
  return guard<size_t>(0, [&] {
    const bmapp::FlightPoseList route = v->v->editedFlightRoute(piece);
    for (size_t i = 0; out && i < route.size() && i < cap; ++i)
      out[i] = BmFlightPose{from_vec3(route[i].position), route[i].qx, route[i].qy, route[i].qz, route[i].qw};
    return route.size();
  });
}

void bm_key_offset_limits(BmKeyScene scene, int32_t earliest, int32_t latest, int32_t* lower, int32_t* upper) {
  const bmapp::OffsetLimits l = bmapp::keyOffsetLimits(toScene(scene), earliest, latest);
  if (lower) *lower = l.lower;
  if (upper) *upper = l.upper;
}

BmKeyScene bm_linked_key_scene(BmKeyScene scene, bool enabled, double build_duration) {
  return fromScene(bmapp::linkedKeyScene(toScene(scene), enabled, build_duration));
}

double bm_flight_keys_start(BmKeyScene scene, double flight_start) {
  return bmapp::flightKeysStart(toScene(scene), flight_start);
}

size_t bm_auto_key_values(int32_t tool, BmVec3 origin, BmVec3 change, int32_t frame, BmKeyframe* out, size_t cap) {
  if (tool < 0 || tool > 2) return 0;
  const bmapp::KeyList keys =
      bmapp::autoKeyValues(static_cast<bmapp::GizmoTool>(tool), to_vec3(origin), to_vec3(change), frame);
  for (size_t i = 0; out && i < keys.size() && i < cap; ++i) out[i] = fromKey(keys[i]);
  return keys.size();
}

bool bm_auto_key_target(const BmSession* s, const uint32_t* selection, size_t n, bool auto_key, int64_t key_submodel,
                        uint32_t* piece, bool* submodel) {
  if (!s) return false;
  return guard<bool>(false, [&] {
    const bmapp::AutoKeyTarget t = bmapp::autoKeyTarget(s->s, bmffi::list(selection, n), auto_key, key_submodel);
    if (!t.ok) return false;
    if (piece) *piece = t.piece;
    if (submodel) *submodel = t.submodel;
    return true;
  });
}

}  // extern "C"
