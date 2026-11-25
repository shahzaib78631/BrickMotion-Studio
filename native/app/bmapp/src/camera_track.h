#pragma once
// The Build video's Camera track, as the web app keeps it (plan.cameraTracks[model].build) and
// samples it (src/anim/cameraTrack). Keys hold a rig (what it looks at, the angle round and
// above it, how far, the lens), not a raw position, so a move swings round the model.
//
// Everything here is in the web's world: studs, +Y up (worldBox3: LDU (x, y, z) is
// (x/20, -y/20, -z/20)), degrees. Only the edges convert to LDraw units.
//
// A shot's roll turns the camera's up (upLdu) and its focus and blur drive the renderer's depth
// of field (bmr::FrameOptions::lensBlur, focusDistance). Not sampled natively (kept in the file
// as written, so the web still has them): motion blur and the shutter.
#include <algorithm>
#include <functional>
#include <optional>
#include <string>
#include <vector>
#include <nlohmann/json.hpp>
#include "bm/math.h"
#include "bmapp/types.h"

namespace bmapp::camtrack {

using Json = nlohmann::ordered_json;

/// The web app's default sensor (AppSettings.camera.sensorWidthMm), read as the vertical gate.
constexpr double kSensorMm = 36;

/// What the sampler needs to know about the scene at a time, in web space.
struct Context {
  double aspect = 1;
  double sensorMm = kSensorMm;
  bm::Box model;
  std::function<bm::Box(double seconds)> build;
  std::function<std::optional<bm::Box>(double seconds)> piece;
};

struct Shot {
  bm::Vec3 eye, target;  ///< web space
  double fovDegrees = 40;
  double roll = 0;       ///< degrees, the Dutch roll about the view axis (context.ts applyShot)
  double focus = 0.5;    ///< 0 the model's nearest point along the view, 1 its farthest ('target' samples as 0.5)
  double blur = 0;       ///< 0..1 of the strongest lens blur (context.ts shotLens)
};

/// One thing being assembled, in web space: the main model (first) or a unit built on its own
/// spot on the floor. `lands`: where each of its pieces (or units) lands, and when (seconds).
struct Landing {
  double start = 0, end = 0;
  bm::Box box;
};
struct Assembly {
  bm::Box finished;  ///< empty: the union of its landings
  std::vector<Landing> lands;
};

/// The web's buildCameraContext: "what is being built" holds steady on a unit while it is built
/// on its spot (focusPlan's close-ups), otherwise follows the main model's landings so far and
/// those due within 1.2 s, grown towards 0.6 of the model per side (never past its bounds) and
/// to at least 0.35 of its longest side, smoothed over ±0.6 s; "the landing piece" is whatever
/// is in the air.
Context buildContext(std::vector<Assembly> assemblies, bm::Box model, double aspect);
/// The unsmoothed focus box at `seconds` (camera.ts buildFocusBox), for tests.
bm::Box focusBox(const std::vector<Assembly>& assemblies, const bm::Box& model, double seconds);

/// The camera at `seconds`, or nothing when the track has no keys.
std::optional<Shot> sample(const Json& track, double seconds, const Context& context);

/// The keys of a track, sorted by time; malformed ones are skipped.
std::vector<CameraTrackKey> keysOf(const Json& track);

/// The moves of a track, in key order (the web's transitions).
std::vector<CameraMove> movesOf(const Json& track);

/// The built-in transition presets, the glide first.
const std::vector<CameraPreset>& presets();

/// A key that reproduces a view exactly: aimed at a fixed point, at a fixed distance, the lens
/// worked back from the field of view (web cameraPoseToKey). `eye` and `target` in web space.
Json keyFromView(bm::Vec3 eye, bm::Vec3 target, double fovDegrees, double seconds);
/// Web space from LDraw units, and back.
bm::Vec3 toWeb(bm::Vec3 ldu);
bm::Vec3 toLdu(bm::Vec3 web);
/// The camera's up for a shot, in LDU: web +Y turned `roll` degrees about the view axis, as
/// three.js camera.rotateZ after lookAt (context.ts applyShot).
bm::Vec3 upLdu(const Shot& shot);
/// depthOfField.ts focusDistance: how far from `eye` along the view the plane in focus lies,
/// `focus` 0 at the nearest corner of `box`, 1 at its farthest, never nearer than `near`.
/// Any one space (the viewport passes LDU).
double focusDistance(bm::Vec3 eye, bm::Vec3 target, const bm::Box& box, double focus, double near);
/// shotLens: the largest blur as a share of the frame's height (LENS_BLUR_PX.strong of 1080).
inline double lensBlurShare(const Shot& shot) { return std::clamp(shot.blur, 0.0, 1.0) * 18.0 / 1080.0; }
bm::Box toWeb(const bm::Box& ldu);

// Edits: each returns the whole new track; the input is never changed. Keys stay sorted by
// unique time with exactly one move between neighbours (web relink).
Json addKey(const Json& track, Json key, double fps, double duration);
/// The key's view (target, offset, angles, distance, lens) set from `view`; its time stays.
Json setKeyView(const Json& track, const std::string& id, const Json& view);
Json moveKey(const Json& track, const std::string& id, double seconds, double fps, double duration);
Json removeKey(const Json& track, const std::string& id);
/// The move leaving `fromId` takes the preset; a preset that is a move (Orbit, Push in…) also
/// sets the end key from the start key. `distance`: about how far the camera is, in studs.
Json choosePreset(const Json& track, const std::string& fromId, const std::string& presetId, double distance);
/// The key's angles, distance, roll, lens, focus and blur from `fields` (its id, time and what it
/// looks at stay; a fixed point may move, and a fixed camera's `eye` is worked into the angles
/// and distance), held to the web inspector's ranges. Marks the key hand-made.
Json setKeyFields(const Json& track, const CameraTrackKey& fields);
/// The settings of the move leaving `fields.from` (its preset name stays), held to the web
/// inspector's ranges. Marks the move hand-made.
Json setMoveFields(const Json& track, const CameraMove& fields);
/// What the key looks at: "model", "build" or "piece", its distance fitted and its angles kept.
/// (A fixed point is a view: setKeyView with keyFromView.)
Json setKeyTarget(const Json& track, const std::string& id, const std::string& target);

/// What Auto-direct reads of a Build, in web space: every landing (flat, any unit), the model,
/// and the clock (seconds from the video's start).
struct DirectorBuild {
  std::vector<Landing> lands;
  bm::Box model;
  double intro = 0, buildEnd = 0, duration = 0;
};
/// The web's DirectorOptions. `style`: "reference" (Speed build), "showcase", "turntable",
/// "calm", "energetic" or "overhead"; anything else is "reference".
struct DirectorOptions {
  std::string style = "reference";
  double swings = 0.5, lensMm = 50, shutter = 0.5;
};
/// The web's Auto-direct (autoDirect.ts): a track written from the build in a director style,
/// ordinary keys and moves marked origin "auto".
Json autoDirect(const DirectorBuild& build, const DirectorOptions& options);
/// autoDirect.ts mergeAuto: the fresh automatic track with the hand-made keys (kept, held
/// inside the video) and moves of `existing`; automatic keys within 0.4 s of one make way.
Json mergeAuto(const Json& existing, const Json& autoTrack, double duration);

}  // namespace bmapp::camtrack
