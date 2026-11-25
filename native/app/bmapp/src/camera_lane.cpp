#include "bmapp/camera_lane.h"

#include <algorithm>
#include <cmath>

#include "bmapp/session.h"
#include "bmapp/viewport.h"

namespace bmapp {

CameraClockInfo cameraClockInfo(CameraClock clock, const Session* session, double buildFps, double buildDuration,
                                bool buildReady) {
  CameraClockInfo info;
  info.clock = clock;
  if (clock == CameraClock::Build || !session) {
    info.fps = buildFps, info.duration = buildDuration, info.ready = buildReady;
    return info;
  }
  const KeyScene scene = session->keyScene();
  info.fps = double(std::max(1, scene.fps));
  info.duration = double(scene.last - scene.first + 1) / info.fps;
  info.ready = true;
  return info;
}

bool cameraKeyAt(const std::vector<CameraTrackKey>& keys, double now, double fps, std::string* id) {
  const double halfFrame = 0.5 / std::max(1.0, fps);
  for (const CameraTrackKey& key : keys) {
    if (std::abs(key.seconds - now) < halfFrame) {
      if (id) *id = key.id;
      return true;
    }
  }
  return false;
}

bool canAutoDirect(CameraClock clock, const Session* session, bool buildReady) {
  return buildReady && (clock == CameraClock::Build || (session && session->keyScene().buildLinked));
}

CameraKeyResult addCameraKeyFromView(Session& session, Viewport& viewport, CameraClock clock, double now,
                                     const CameraClockInfo& info) {
  CameraKeyResult result;
  const SceneCamera view = viewport.captureSceneCamera();
  std::string id;
  if (cameraKeyAt(session.cameraKeys(clock), now, info.fps, &id)) {
    result.changed = session.setCameraKeyView(clock, id, view);
    result.id = id;
    return result;
  }
  result.changed = session.addCameraKey(clock, now, view, info.fps, info.duration);
  if (!result.changed.refused.empty()) return result;
  result.added = true;
  const std::vector<CameraTrackKey> keys = session.cameraKeys(clock);
  const auto nearest = std::min_element(keys.begin(), keys.end(), [now](const CameraTrackKey& a, const CameraTrackKey& b) {
    return std::abs(a.seconds - now) < std::abs(b.seconds - now);
  });
  if (nearest != keys.end()) result.id = nearest->id;
  return result;
}

Changed aimCameraKey(Session& session, Viewport& viewport, CameraClock clock, const CameraTrackKey& key,
                     const std::string& target) {
  if (target == key.target) return {};
  if (target == "point") return session.setCameraKeyView(clock, key.id, viewport.cameraTrackView(key.seconds));
  return session.setCameraKeyTarget(clock, key.id, target);
}

Changed autoDirect(Session& session, Viewport& viewport, CameraClock clock, const std::string& style) {
  return session.autoDirectCamera(clock, viewport.cameraDirectorInput(), style, 50);
}

}  // namespace bmapp
