// Ported from the Swift export sheets (VideoExportSheet, StillExportSheet, VideoLogo.options,
// DocumentModel.submodelVideoTargets, RenderQueue.enqueueMovies) so both shells share them.
#include "bmapp/export_options.h"

#include <algorithm>
#include <charconv>
#include <cmath>
#include <cstdint>
#include <set>
#include <utility>
#include "bmapp/session.h"

namespace bmapp {
namespace {

std::string number(double value) {
  char buffer[64];
  const auto result = std::to_chars(buffer, buffer + sizeof buffer, value);
  return std::string(buffer, result.ptr);
}

std::string sizeText(FrameSize size) { return std::to_string(size.width) + "x" + std::to_string(size.height); }

std::string sizeLabel(FrameSize size) {
  return std::to_string(size.width) + " \xC3\x97 " + std::to_string(size.height);  // ×
}

void appendAngles(StringList& out, const ViewAngles& angles, bool orthographic) {
  out.insert(out.end(), {"--azimuth", number(angles.yawDeg), "--elevation", number(angles.pitchDeg), "--fov",
                         number(angles.fovDeg)});
  if (orthographic && angles.orthographic) out.push_back("--orthographic");
}

const char* qualityTitle(MovieQuality quality) {
  switch (quality) {
    case MovieQuality::Compact: return "Compact";
    case MovieQuality::Standard: return "Standard";
    case MovieQuality::High: return "High";
  }
  return "Standard";
}

double qualityFactor(MovieQuality quality) {
  switch (quality) {
    case MovieQuality::Compact: return 0.6;
    case MovieQuality::Standard: return 1;
    case MovieQuality::High: return 1.6;
  }
  return 1;
}

/// One UTF-8 code point starting at `i`: its length in bytes (1 for a stray byte).
size_t codePointLength(const std::string& s, size_t i) {
  const auto c = static_cast<unsigned char>(s[i]);
  const size_t n = c < 0x80 ? 1 : (c >> 5) == 0x6 ? 2 : (c >> 4) == 0xE ? 3 : (c >> 3) == 0x1E ? 4 : 1;
  return std::min(n, s.size() - i);
}

/// The code point of the `length` bytes at `i` (a stray byte reads as itself).
uint32_t codePoint(const std::string& s, size_t i, size_t length) {
  const auto b = [&](size_t k) { return static_cast<uint32_t>(static_cast<unsigned char>(s[i + k])); };
  switch (length) {
    case 2: return ((b(0) & 0x1F) << 6) | (b(1) & 0x3F);
    case 3: return ((b(0) & 0x0F) << 12) | ((b(1) & 0x3F) << 6) | (b(2) & 0x3F);
    case 4: return ((b(0) & 0x07) << 18) | ((b(1) & 0x3F) << 12) | ((b(2) & 0x3F) << 6) | (b(3) & 0x3F);
    default: return b(0);
  }
}

/// Unicode White_Space: Swift's `.whitespacesAndNewlines`.
bool isWhiteSpace(uint32_t c) {
  return (c >= 0x09 && c <= 0x0D) || c == 0x20 || c == 0x85 || c == 0xA0 || c == 0x1680 ||
         (c >= 0x2000 && c <= 0x200A) || c == 0x2028 || c == 0x2029 || c == 0x202F || c == 0x205F || c == 0x3000;
}

/// Swift's `.controlCharacters`: general categories Cc and Cf.
bool isControl(uint32_t c) {
  if (c < 0x20 || (c >= 0x7F && c <= 0x9F)) return true;  // Cc
  static constexpr std::pair<uint32_t, uint32_t> format[] = {
      {0x00AD, 0x00AD}, {0x0600, 0x0605}, {0x061C, 0x061C}, {0x06DD, 0x06DD}, {0x070F, 0x070F},
      {0x0890, 0x0891}, {0x08E2, 0x08E2}, {0x180E, 0x180E}, {0x200B, 0x200F}, {0x202A, 0x202E},
      {0x2060, 0x2064}, {0x2066, 0x206F}, {0xFEFF, 0xFEFF}, {0xFFF9, 0xFFFB}, {0x110BD, 0x110BD},
      {0x110CD, 0x110CD}, {0x13430, 0x1343F}, {0x1BCA0, 0x1BCA3}, {0x1D173, 0x1D17A}, {0xE0001, 0xE0001},
      {0xE0020, 0xE007F},
  };
  for (const auto& [lo, hi] : format)
    if (c >= lo && c <= hi) return true;
  return false;
}

bool isTrimmed(const std::string& s, size_t i, size_t length, bool dots) {
  const uint32_t c = codePoint(s, i, length);
  return isWhiteSpace(c) || (dots && c == '.');
}

std::string trim(const std::string& s, bool dots) {
  std::vector<std::pair<size_t, size_t>> points;
  for (size_t i = 0; i < s.size(); i += codePointLength(s, i)) points.emplace_back(i, codePointLength(s, i));
  size_t first = 0, last = points.size();
  while (first < last && isTrimmed(s, points[first].first, points[first].second, dots)) ++first;
  while (last > first && isTrimmed(s, points[last - 1].first, points[last - 1].second, dots)) --last;
  if (first == last) return "";
  return s.substr(points[first].first, points[last - 1].first + points[last - 1].second - points[first].first);
}

}  // namespace

FrameSize frameSize(FrameShape shape) {
  switch (shape) {
    case FrameShape::Landscape: return {1920, 1080};
    case FrameShape::Vertical: return {1080, 1920};
    case FrameShape::Portrait: return {1080, 1350};
    case FrameShape::Square: return {1080, 1080};
  }
  return {1920, 1080};
}

const char* frameName(FrameShape shape) {
  switch (shape) {
    case FrameShape::Landscape: return "Landscape";
    case FrameShape::Vertical: return "Vertical";
    case FrameShape::Portrait: return "Portrait";
    case FrameShape::Square: return "Square";
  }
  return "Landscape";
}

const char* frameRatio(FrameShape shape) {
  switch (shape) {
    case FrameShape::Landscape: return "16:9";
    case FrameShape::Vertical: return "9:16";
    case FrameShape::Portrait: return "4:5";
    case FrameShape::Square: return "1:1";
  }
  return "16:9";
}

FrameSize movieSize(FrameShape shape, MovieResolution resolution) {
  const auto size = frameSize(shape);
  switch (resolution) {
    case MovieResolution::Small: return {size.width * 2 / 3, size.height * 2 / 3};
    case MovieResolution::Standard: return size;
    case MovieResolution::Large: return {size.width * 2, size.height * 2};
  }
  return size;
}

FrameSize stillSize(FrameShape shape, bool large) {
  const auto size = frameSize(shape);
  return large ? FrameSize{size.width * 2, size.height * 2} : size;
}

int movieBitRate(int width, int height, int fps, MovieQuality quality) {
  const int64_t base = std::max<int64_t>(800'000, int64_t(width) * height * fps / 5);
  return static_cast<int>(std::min(240'000'000.0, static_cast<double>(base) * qualityFactor(quality)));
}

ViewAngles viewAngles(const CameraState& camera) {
  const double degrees = 180 / M_PI;
  return {true, camera.yaw * degrees, camera.pitch * degrees, camera.verticalFOV * degrees, camera.orthographic};
}

const char* movieSourceTitle(MovieSource source) {
  switch (source) {
    case MovieSource::Build: return "Build";
    case MovieSource::Keyframes: return "Keyframes";
    case MovieSource::Turntable: return "Turntable";
  }
  return "Build";
}

MovieCamera defaultMovieCamera(const Session& session, bool batch, bool hasViewportAngle) {
  if (!batch) {
    const auto scene = session.sceneCameras();
    if (scene.useForVideo && std::any_of(scene.cameras.begin(), scene.cameras.end(),
                                         [&](const SceneCamera& c) { return c.id == scene.activeId; }))
      return MovieCamera::Saved;
  }
  const auto camera = session.exportCamera();
  if (camera == "buildView") return hasViewportAngle ? MovieCamera::Viewport : MovieCamera::Director;
  if (camera == "automatic") return MovieCamera::Director;
  const bool keyed = !session.cameraKeys(CameraClock::Build).empty() || !session.cameraKeys(CameraClock::Timeline).empty();
  return keyed && !batch ? MovieCamera::Track : MovieCamera::Director;
}

bool movieAllowsTrack(const Session& session, const MovieChoice& choice, bool batch, bool focusedModelChosen) {
  const bool keyed = choice.source == MovieSource::Build       ? !session.cameraKeys(CameraClock::Build).empty()
                     : choice.source == MovieSource::Keyframes ? !session.cameraKeys(CameraClock::Timeline).empty()
                                                               : false;
  return keyed && !batch && (session.focusPath().empty() || focusedModelChosen);
}

StringList movieArguments(const MovieChoice& choice) {
  const auto size = movieSize(choice.shape, choice.resolution);
  const char* source = choice.source == MovieSource::Build       ? "build"
                       : choice.source == MovieSource::Keyframes ? "keyframes"
                                                                 : "turntable";
  StringList out{"--size", sizeText(size), "--fps", std::to_string(choice.fps), "--source", source};
  if (choice.quality != MovieQuality::Standard)
    out.insert(out.end(), {"--bitrate", std::to_string(movieBitRate(size.width, size.height, choice.fps, choice.quality))});
  if (choice.source == MovieSource::Turntable) out.insert(out.end(), {"--duration", std::to_string(choice.turntableSeconds)});
  if (choice.standardPreview) out.push_back("--standard-preview");
  if (choice.source == MovieSource::Build && !choice.standardPreview && choice.snapAudio) out.push_back("--snap-audio");
  if (choice.camera == MovieCamera::Saved && !choice.sceneCameraId.empty())
    out.insert(out.end(), {"--scene-camera", choice.sceneCameraId});
  if (choice.camera == MovieCamera::Track) out.push_back("--camera-track");
  if (!choice.logo.empty()) {
    static const char* corners[] = {"tl", "tr", "bl", "br"};
    out.insert(out.end(), {"--logo", choice.logo, "--logo-corner", corners[static_cast<int>(choice.logoCorner)]});
  }
  for (const auto& model : choice.modelPath) out.insert(out.end(), {"--model", model});
  if (choice.camera == MovieCamera::Viewport && choice.angles.present) appendAngles(out, choice.angles, true);
  return out;
}

std::string movieSummary(const MovieChoice& choice) {
  std::string out = std::string(movieSourceTitle(choice.source)) + " \xC2\xB7 " +
                    sizeLabel(movieSize(choice.shape, choice.resolution)) + " \xC2\xB7 " + std::to_string(choice.fps) + " fps";
  if (choice.quality != MovieQuality::Standard) out += std::string(" \xC2\xB7 ") + qualityTitle(choice.quality);
  if (!choice.logo.empty()) out += " \xC2\xB7 Logo";
  return out;
}

const char* stillQualityTitle(StillQuality quality) {
  switch (quality) {
    case StillQuality::Draft: return "Draft";
    case StillQuality::Standard: return "Standard";
    case StillQuality::Final: return "Final";
  }
  return "Standard";
}

StringList stillArguments(const StillChoice& choice, const RenderLook& look) {
  StringList out{"--size", sizeText(stillSize(choice.shape, choice.large)), "--samples",
                 std::to_string(static_cast<int>(choice.quality)), "--no-denoise"};
  if (choice.viewportAngle && choice.angles.present) appendAngles(out, choice.angles, false);
  out.push_back(look.lightsFollowCamera ? "--lights-follow" : "--lights-fixed");
  for (const auto& scene : Session::scenes()) {
    if (scene.id != look.scene) continue;
    auto byte = [](double v) { return std::to_string(static_cast<int>(std::lround(v * 255))); };
    out.insert(out.end(), {"--background", byte(scene.background.x) + "," + byte(scene.background.y) + "," +
                                               byte(scene.background.z)});
    break;
  }
  return out;
}

std::string stillSummary(const StillChoice& choice, bool logo) {
  return "Still \xC2\xB7 " + sizeLabel(stillSize(choice.shape, choice.large)) + " \xC2\xB7 " +
         stillQualityTitle(choice.quality) + (logo ? " \xC2\xB7 Logo" : "");
}

std::string displayName(const std::string& raw) {
  std::string s = raw;
  for (const char* ext : {".ldr", ".dat", ".mpd"}) {
    if (s.size() < 4) continue;
    std::string tail = s.substr(s.size() - 4);
    std::transform(tail.begin(), tail.end(), tail.begin(), [](unsigned char c) { return std::tolower(c); });
    if (tail == ext) s.resize(s.size() - 4);
  }
  std::string out;
  bool space = false;
  for (char c : s) {
    if (c == ' ') {
      space = true;
      continue;
    }
    if (space && !out.empty()) out += ' ';
    space = false;
    out += c;
  }
  return out;
}

namespace {
std::vector<VideoTarget> targets(const Session& session, const StringList* ids) {
  const auto rows = session.outline();
  std::set<std::string> definitions;
  std::vector<VideoTarget> out;
  for (size_t index = 0; index < rows.size(); ++index) {
    const auto& row = rows[index];
    if (row.def.empty() || row.pieces == 0) continue;
    if (ids && std::find(ids->begin(), ids->end(), row.id) == ids->end()) continue;
    if (!definitions.insert(row.def).second) continue;
    StringList path;
    for (int k = static_cast<int>(index); k >= 0; k = rows[static_cast<size_t>(k)].parent)
      if (!rows[static_cast<size_t>(k)].def.empty()) path.insert(path.begin(), rows[static_cast<size_t>(k)].def);
    out.push_back({displayName(row.name), path});
  }
  return out;
}
}  // namespace

std::vector<VideoTarget> submodelVideoTargets(const Session& session) { return targets(session, nullptr); }
std::vector<VideoTarget> submodelVideoTargets(const Session& session, const StringList& ids) {
  return targets(session, &ids);
}

std::string safeFileStem(const std::string& name) {
  // Control characters and / : \ become spaces (each one a separator, as Swift's components).
  std::string safe;
  for (size_t i = 0; i < name.size();) {
    const size_t n = codePointLength(name, i);
    const uint32_t c = codePoint(name, i, n);
    const bool control = isControl(c) || c == '/' || c == ':' || c == '\\';
    safe += control ? std::string(" ") : name.substr(i, n);
    i += n;
  }
  safe = trim(safe, true);
  std::string prefix;
  size_t count = 0;
  for (size_t i = 0; i < safe.size() && count < 60; ++count) {
    const size_t n = codePointLength(safe, i);
    prefix += safe.substr(i, n);
    i += n;
  }
  prefix = trim(prefix, false);
  while (prefix.size() > 200) {
    size_t last = prefix.size() - 1;
    while (last > 0 && (static_cast<unsigned char>(prefix[last]) & 0xC0) == 0x80) --last;
    prefix.resize(last);
  }
  return prefix.empty() ? "Submodel" : prefix;
}

}  // namespace bmapp
