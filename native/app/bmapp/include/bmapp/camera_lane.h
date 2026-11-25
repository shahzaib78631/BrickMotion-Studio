#pragma once
// A Camera lane's rules, shared by both app shells: each clock's length, the key at the
// playhead, when Auto-direct can run, a key from the view, aiming a key, and Auto-direct itself
// (which reads the viewport's Build, so the director's input never leaves C++).

#include <string>
#include <vector>

#include "bmapp/types.h"

namespace bmapp {

class Session;
class Viewport;

struct CameraClockInfo {
  CameraClock clock = CameraClock::Build;
  double fps = 30, duration = 0;
  bool ready = false;
};

/// The Build clock is the planned Build's; the Timeline clock is the key scene's, inclusive:
/// (last - first + 1) / fps, always ready.
CameraClockInfo cameraClockInfo(CameraClock clock, const Session* session, double buildFps, double buildDuration,
                                bool buildReady);

/// The key within half a frame of `now`. False when there is none.
bool cameraKeyAt(const std::vector<CameraTrackKey>& keys, double now, double fps, std::string* id);

/// Auto-direct reads where the Build's pieces land: it needs the planned Build (linked to the
/// timeline, for the timeline's track).
bool canAutoDirect(CameraClock clock, const Session* session, bool buildReady);

struct CameraKeyResult {
  Changed changed;
  std::string id;  ///< the key to select: the one that took the view, or the new key
  bool added = false;
};
/// A key filming the viewport's view at `now`; a key already within half a frame takes the view.
CameraKeyResult addCameraKeyFromView(Session& session, Viewport& viewport, CameraClock clock, double now,
                                     const CameraClockInfo& info);

/// Look At: "point" fixes the key where it looks now; "model", "build", "piece" follow that.
Changed aimCameraKey(Session& session, Viewport& viewport, CameraClock clock, const CameraTrackKey& key,
                     const std::string& target);

/// Writes the clock's track in `style` from the viewport's planned Build, at a 50 mm lens.
Changed autoDirect(Session& session, Viewport& viewport, CameraClock clock, const std::string& style);

}  // namespace bmapp
