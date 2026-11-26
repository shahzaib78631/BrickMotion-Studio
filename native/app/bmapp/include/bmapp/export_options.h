#pragma once
// What the export windows offer and the arguments the render helper takes for it. Both app
// shells (Swift and Rust) call these, so a video or still made from either is the same file.
#include <string>
#include <vector>
#include "bmapp/movie_export.h"
#include "bmapp/types.h"
#include "bmapp/viewport.h"

namespace bmapp {

class Session;

enum class FrameShape { Landscape, Vertical, Portrait, Square };  ///< 1920×1080, 1080×1920, 1080×1350, 1080×1080
enum class MovieResolution { Small, Standard, Large };            ///< ×2/3, ×1, ×2
enum class MovieQuality { Compact, Standard, High };              ///< bit-rate factor 0.6, 1, 1.6
enum class StillQuality { Draft = 32, Standard = 128, Final = 512 };  ///< path-traced samples a pixel
/// Who films a video: the automatic camera, the project's Camera track, the viewport's own
/// heading, or one of the scene's saved cameras.
enum class MovieCamera { Director, Track, Viewport, Saved };

struct FrameSize { int width = 0, height = 0; };
FrameSize frameSize(FrameShape shape);
const char* frameName(FrameShape shape);   ///< "Landscape", "Vertical", "Portrait", "Square"
const char* frameRatio(FrameShape shape);  ///< "16:9", "9:16", "4:5", "1:1"
FrameSize movieSize(FrameShape shape, MovieResolution resolution);
FrameSize stillSize(FrameShape shape, bool large);
/// min(240 000 000, max(800 000, w·h·fps/5) · factor), bits a second.
int movieBitRate(int width, int height, int fps, MovieQuality quality);

/// The viewport's heading in degrees, as the helper's --azimuth/--elevation/--fov take it.
struct ViewAngles {
  bool present = false;
  double yawDeg = 0, pitchDeg = 0, fovDeg = 0;
  bool orthographic = false;
};
ViewAngles viewAngles(const CameraState& camera);

struct MovieChoice {
  MovieSource source = MovieSource::Build;
  FrameShape shape = FrameShape::Landscape;
  MovieResolution resolution = MovieResolution::Standard;
  MovieQuality quality = MovieQuality::Standard;
  int fps = 30;
  int turntableSeconds = 8;
  /// Already resolved by the caller: Track only when movieAllowsTrack, Saved only when saved
  /// cameras are offered (not a turntable, a focused model or a batch).
  MovieCamera camera = MovieCamera::Director;
  std::string sceneCameraId;
  bool snapAudio = false, standardPreview = false;
  ViewAngles angles;
  StringList modelPath;
  std::string logo;  ///< "" draws none
  LogoCorner logoCorner = LogoCorner::BottomRight;
};

const char* movieSourceTitle(MovieSource source);  ///< "Build", "Keyframes", "Turntable"
/// The camera a new export window starts with: the active saved camera when the scene films
/// videos with it (Saved; its id is sceneCameras().activeId), else the project's exportCamera.
MovieCamera defaultMovieCamera(const Session& session, bool batch, bool hasViewportAngle);
/// The Camera track keys belong to one video of the focused model: its Build or its Keyframes.
bool movieAllowsTrack(const Session& session, const MovieChoice& choice, bool batch, bool focusedModelChosen);
StringList movieArguments(const MovieChoice& choice);
std::string movieSummary(const MovieChoice& choice);  ///< "Build · 1920 × 1080 · 30 fps"

struct StillChoice {
  FrameShape shape = FrameShape::Landscape;
  bool large = false;
  StillQuality quality = StillQuality::Standard;
  bool viewportAngle = true;  ///< film from the viewport's heading (when angles.present)
  ViewAngles angles;
};
const char* stillQualityTitle(StillQuality quality);  ///< "Draft", "Standard", "Final"
/// The path tracer's arguments, then the look's: the light rig and the scene's backdrop.
StringList stillArguments(const StillChoice& choice, const RenderLook& look);
std::string stillSummary(const StillChoice& choice, bool logo);  ///< "Still · 1920 × 1080 · Standard"

/// One video of a submodel: its name to show and the focus path that opens it.
struct VideoTarget {
  std::string title;
  StringList path;
};
/// A video for each submodel with parts, once for a shared definition, in outline order.
std::vector<VideoTarget> submodelVideoTargets(const Session& session);
/// The same, of the outline rows named in `ids` only.
std::vector<VideoTarget> submodelVideoTargets(const Session& session, const StringList& ids);
/// A model name as the app shows it: without .ldr/.dat/.mpd, runs of spaces made one.
std::string displayName(const std::string& raw);
/// A file name for a batch movie: no control characters or / : \, trimmed, at most 60
/// characters and 200 bytes; "Submodel" when nothing is left.
std::string safeFileStem(const std::string& name);

}  // namespace bmapp
