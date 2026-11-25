// Camera tracks, Auto-direct, scene cameras and the export camera behind the C interface.
#include "bmffi.h"

#include <cmath>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

#include "bmapp/camera_lane.h"
#include "bmapp/session.h"
#include "bmapp/viewport.h"
#include "internal.h"

struct BmCameraKeys {
  std::vector<bmapp::CameraTrackKey> rows;
};
struct BmCameraMoves {
  std::vector<bmapp::CameraMove> rows;
};
struct BmCameraPresets {
  std::vector<bmapp::CameraPreset> rows;
};
struct BmSceneCameras {
  bmapp::SceneCameras cameras;
};

namespace {
using bmffi::change;
using bmffi::from_vec3;
using bmffi::guard;
using bmffi::handle;
using bmffi::make;
using bmffi::to_vec3;

std::string str(const char* s) { return s ? std::string(s) : std::string(); }

bmapp::CameraClock clockOf(int32_t c) { return c == BM_CLOCK_TIMELINE ? bmapp::CameraClock::Timeline : bmapp::CameraClock::Build; }

bmapp::SceneCamera toCamera(const BmSceneCamera& c) {
  bmapp::SceneCamera out;
  out.id = str(c.id), out.name = str(c.name);
  out.position = to_vec3(c.position), out.target = to_vec3(c.target);
  out.fieldOfView = c.field_of_view, out.nearClip = c.near_clip, out.farClip = c.far_clip;
  out.orthographic = c.orthographic;
  return out;
}

BmSceneCamera fromCamera(const bmapp::SceneCamera& c) {
  return BmSceneCamera{c.id.c_str(), c.name.c_str(), from_vec3(c.position), from_vec3(c.target), c.fieldOfView,
                       c.nearClip, c.farClip, c.orthographic};
}

char* dup(const std::string& s) {
  char* out = static_cast<char*>(std::malloc(s.size() + 1));
  if (out) std::memcpy(out, s.c_str(), s.size() + 1);
  return out;
}

BmSceneCamera ownedCamera(const bmapp::SceneCamera& c) {
  BmSceneCamera out = fromCamera(c);
  out.id = dup(c.id);
  out.name = dup(c.name);
  return out;
}

BmSceneCamera emptyCamera() { return BmSceneCamera{nullptr, nullptr, {0, 0, 0}, {0, 0, 0}, 42, 1, 100000, false}; }

bmapp::CameraTrackKey toKey(const BmCameraKey& k) {
  bmapp::CameraTrackKey out;
  out.id = str(k.id), out.seconds = k.seconds, out.target = str(k.target), out.preset = str(k.preset);
  out.azimuth = k.azimuth, out.elevation = k.elevation, out.lensMm = k.lens_mm;
  out.fitted = k.fitted, out.user = k.user, out.margin = k.margin, out.distance = k.distance, out.roll = k.roll;
  out.focusTarget = k.focus_target, out.focus = k.focus, out.blur = k.blur;
  out.point = to_vec3(k.point), out.eye = to_vec3(k.eye);
  return out;
}

BmCameraKey fromKey(const bmapp::CameraTrackKey& k) {
  return BmCameraKey{k.id.c_str(), k.seconds, k.target.c_str(), k.preset.c_str(), k.azimuth, k.elevation, k.lensMm,
                     k.fitted, k.user, k.margin, k.distance, k.roll, k.focusTarget, k.focus, k.blur,
                     from_vec3(k.point), from_vec3(k.eye)};
}

bmapp::CameraMove toMove(const BmCameraMove& m) {
  bmapp::CameraMove out;
  out.from = str(m.from), out.to = str(m.to), out.preset = str(m.preset);
  out.user = m.user, out.cut = m.cut, out.flowThrough = m.flow_through;
  out.curve = str(m.curve), out.strength = m.strength, out.straight = m.straight, out.orbit = str(m.orbit);
  out.extraTurns = m.extra_turns, out.overshoot = m.overshoot, out.motionBlur = m.motion_blur;
  out.shake = m.shake, out.shakeFrequency = m.shake_frequency, out.turnLast = m.turn_last;
  return out;
}

BmCameraMove fromMove(const bmapp::CameraMove& m) {
  return BmCameraMove{m.from.c_str(), m.to.c_str(), m.preset.c_str(), m.user, m.cut, m.flowThrough, m.curve.c_str(),
                      m.strength, m.straight, m.orbit.c_str(), m.extraTurns, m.overshoot, m.motionBlur, m.shake,
                      m.shakeFrequency, m.turnLast};
}

bmapp::CameraClockInfo toInfo(const BmCameraClockInfo& i) {
  bmapp::CameraClockInfo out;
  out.clock = clockOf(i.clock), out.fps = i.fps, out.duration = i.duration, out.ready = i.ready;
  return out;
}
}  // namespace

extern "C" {

BmCameraKeys* bm_session_camera_keys(const BmSession* s, int32_t clock) {
  if (!s) return nullptr;
  return handle<BmCameraKeys>([&] { return new BmCameraKeys{s->s->cameraKeys(clockOf(clock))}; });
}
size_t bm_camera_keys_len(const BmCameraKeys* k) { return k ? k->rows.size() : 0; }
BmCameraKey bm_camera_keys_at(const BmCameraKeys* k, size_t i) {
  static const bmapp::CameraTrackKey none;
  return fromKey(k && i < k->rows.size() ? k->rows[i] : none);
}
int64_t bm_camera_key_at(const BmCameraKeys* k, double now, double fps) {
  if (!k) return -1;
  std::string id;
  if (!bmapp::cameraKeyAt(k->rows, now, fps, &id)) return -1;
  for (size_t i = 0; i < k->rows.size(); ++i)
    if (k->rows[i].id == id) return int64_t(i);
  return -1;
}
void bm_camera_keys_free(BmCameraKeys* k) { delete k; }

BmCameraMoves* bm_session_camera_moves(const BmSession* s, int32_t clock) {
  if (!s) return nullptr;
  return handle<BmCameraMoves>([&] { return new BmCameraMoves{s->s->cameraMoves(clockOf(clock))}; });
}
size_t bm_camera_moves_len(const BmCameraMoves* m) { return m ? m->rows.size() : 0; }
BmCameraMove bm_camera_moves_at(const BmCameraMoves* m, size_t i) {
  static const bmapp::CameraMove none;
  return fromMove(m && i < m->rows.size() ? m->rows[i] : none);
}
void bm_camera_moves_free(BmCameraMoves* m) { delete m; }

BmCameraPresets* bm_camera_presets(void) {
  return handle<BmCameraPresets>([] { return new BmCameraPresets{bmapp::Session::cameraPresets()}; });
}
size_t bm_camera_presets_len(const BmCameraPresets* p) { return p ? p->rows.size() : 0; }
BmCameraPreset bm_camera_presets_at(const BmCameraPresets* p, size_t i) {
  if (!p || i >= p->rows.size()) return BmCameraPreset{"", "", ""};
  const auto& r = p->rows[i];
  return BmCameraPreset{r.id.c_str(), r.label.c_str(), r.hint.c_str()};
}
void bm_camera_presets_free(BmCameraPresets* p) { delete p; }

BmString bm_session_camera_director_style(const BmSession* s, int32_t clock) {
  if (!s) return make("");
  return guard<BmString>(make(""), [&] { return make(s->s->cameraDirectorStyle(clockOf(clock))); });
}

BmChange bm_session_add_camera_key(BmSession* s, int32_t clock, double seconds, BmSceneCamera view, double fps,
                                   double duration) {
  return change(s, [&] { return s->s->addCameraKey(clockOf(clock), seconds, toCamera(view), fps, duration); });
}
BmChange bm_session_set_camera_key_view(BmSession* s, int32_t clock, const char* id, BmSceneCamera view) {
  return change(s, [&] { return s->s->setCameraKeyView(clockOf(clock), str(id), toCamera(view)); });
}
BmChange bm_session_move_camera_key(BmSession* s, int32_t clock, const char* id, double seconds, double fps,
                                    double duration) {
  return change(s, [&] { return s->s->moveCameraKey(clockOf(clock), str(id), seconds, fps, duration); });
}
BmChange bm_session_remove_camera_key(BmSession* s, int32_t clock, const char* id) {
  return change(s, [&] { return s->s->removeCameraKey(clockOf(clock), str(id)); });
}
BmChange bm_session_set_camera_key_target(BmSession* s, int32_t clock, const char* id, const char* target) {
  return change(s, [&] { return s->s->setCameraKeyTarget(clockOf(clock), str(id), str(target)); });
}
BmChange bm_session_set_camera_key(BmSession* s, int32_t clock, BmCameraKey key, bool continuing) {
  return change(s, [&] { return s->s->setCameraKey(clockOf(clock), toKey(key), continuing); });
}
BmChange bm_session_set_camera_move(BmSession* s, int32_t clock, BmCameraMove move, bool continuing) {
  return change(s, [&] { return s->s->setCameraMove(clockOf(clock), toMove(move), continuing); });
}
BmChange bm_session_choose_camera_preset(BmSession* s, int32_t clock, const char* from, const char* preset,
                                         double distance) {
  return change(s, [&] { return s->s->chooseCameraPreset(clockOf(clock), str(from), str(preset), distance); });
}
BmChange bm_session_clear_camera_track(BmSession* s, int32_t clock) {
  return change(s, [&] { return s->s->clearCameraTrack(clockOf(clock)); });
}
BmString bm_session_export_camera(const BmSession* s) {
  if (!s) return make("");
  return guard<BmString>(make(""), [&] { return make(s->s->exportCamera()); });
}
BmChange bm_session_set_export_camera(BmSession* s, const char* camera) {
  return change(s, [&] { return s->s->setExportCamera(str(camera)); });
}

BmSceneCameras* bm_session_scene_cameras(const BmSession* s) {
  if (!s) return nullptr;
  return handle<BmSceneCameras>([&] { return new BmSceneCameras{s->s->sceneCameras()}; });
}
size_t bm_scene_cameras_len(const BmSceneCameras* c) { return c ? c->cameras.cameras.size() : 0; }
BmSceneCamera bm_scene_cameras_at(const BmSceneCameras* c, size_t i) {
  if (!c || i >= c->cameras.cameras.size()) return emptyCamera();
  return fromCamera(c->cameras.cameras[i]);
}
const char* bm_scene_cameras_active_id(const BmSceneCameras* c) { return c ? c->cameras.activeId.c_str() : ""; }
bool bm_scene_cameras_use_for_video(const BmSceneCameras* c) { return c && c->cameras.useForVideo; }
void bm_scene_cameras_free(BmSceneCameras* c) { delete c; }
BmChange bm_session_save_scene_camera(BmSession* s, BmSceneCamera camera) {
  return change(s, [&] { return s->s->saveSceneCamera(toCamera(camera)); });
}
BmChange bm_session_remove_scene_camera(BmSession* s, const char* id) {
  return change(s, [&] { return s->s->removeSceneCamera(str(id)); });
}
BmChange bm_session_activate_scene_camera(BmSession* s, const char* id) {
  return change(s, [&] { return s->s->activateSceneCamera(str(id)); });
}

BmSceneCamera bm_viewport_capture_scene_camera(const BmViewport* v) {
  if (!v) return emptyCamera();
  return guard<BmSceneCamera>(emptyCamera(), [&] { return ownedCamera(v->v->captureSceneCamera()); });
}
BmSceneCamera bm_viewport_camera_track_view(BmViewport* v, double seconds) {
  if (!v) return emptyCamera();
  return guard<BmSceneCamera>(emptyCamera(), [&] { return ownedCamera(v->v->cameraTrackView(seconds)); });
}
void bm_scene_camera_free(BmSceneCamera camera) {
  std::free(const_cast<char*>(camera.id));
  std::free(const_cast<char*>(camera.name));
}
bool bm_viewport_recall_scene_camera(BmViewport* v, const char* id) {
  return v && guard<bool>(false, [&] { return v->v->recallSceneCamera(str(id)); });
}
bool bm_viewport_follows_camera_track(BmViewport* v) {
  return v && guard<bool>(false, [&] { return v->v->followsCameraTrack(); });
}
void bm_viewport_set_director_preview(BmViewport* v, bool directed) {
  if (v) bmffi::guardVoid([&] { v->v->setDirectorPreview(directed); });
}

BmCameraClockInfo bm_camera_clock_info(int32_t clock, const BmSession* s, double build_fps, double build_duration,
                                       bool build_ready) {
  const bmapp::CameraClockInfo i =
      guard<bmapp::CameraClockInfo>({}, [&] { return bmapp::cameraClockInfo(clockOf(clock), s ? s->s : nullptr, build_fps, build_duration, build_ready); });
  return BmCameraClockInfo{i.clock == bmapp::CameraClock::Timeline ? BM_CLOCK_TIMELINE : BM_CLOCK_BUILD, i.fps,
                           i.duration, i.ready};
}
bool bm_can_auto_direct(int32_t clock, const BmSession* s, bool build_ready) {
  return guard<bool>(false, [&] { return bmapp::canAutoDirect(clockOf(clock), s ? s->s : nullptr, build_ready); });
}
BmChange bm_add_camera_key_from_view(BmSession* s, BmViewport* v, int32_t clock, double now, BmCameraClockInfo info,
                                     BmString* id, bool* added) {
  if (id) *id = make("");
  if (added) *added = false;
  if (!v) return change(nullptr, [] { return bmapp::Changed{}; });
  return change(s, [&] {
    const bmapp::CameraKeyResult r = bmapp::addCameraKeyFromView(*s->s, *v->v, clockOf(clock), now, toInfo(info));
    if (id) {
      bm_string_free(*id);
      *id = make(r.id);
    }
    if (added) *added = r.added;
    return r.changed;
  });
}
BmChange bm_aim_camera_key(BmSession* s, BmViewport* v, int32_t clock, BmCameraKey key, const char* target) {
  if (!v) return change(nullptr, [] { return bmapp::Changed{}; });
  return change(s, [&] { return bmapp::aimCameraKey(*s->s, *v->v, clockOf(clock), toKey(key), str(target)); });
}
BmChange bm_auto_direct(BmSession* s, BmViewport* v, int32_t clock, const char* style) {
  if (!v) return change(nullptr, [] { return bmapp::Changed{}; });
  return change(s, [&] { return bmapp::autoDirect(*s->s, *v->v, clockOf(clock), str(style)); });
}

}  // extern "C"
