// The movie helper: a subprocess that renders one movie while the editor stays free. Ported
// from the Swift app's EditorMovieCommand; both shells start it with the same arguments.
#include <cmath>
#include <cstdio>
#include <filesystem>
#include <random>
#include <string>
#include <vector>
#include "bmapp/movie_export.h"
#include "bmapp/session.h"
#include "bmapp/viewport.h"

namespace bmapp {
namespace {

int fail(const std::string& message) {
  std::fprintf(stderr, "%s\n", message.c_str());
  return 1;
}

bool parseInt(const std::string& text, int& out) {
  if (text.empty()) return false;
  size_t used = 0;
  try {
    const long long value = std::stoll(text, &used);
    if (used != text.size() || value < INT32_MIN || value > INT32_MAX) return false;
    out = static_cast<int>(value);
    return true;
  } catch (...) {
    return false;
  }
}

bool parseDouble(const std::string& text, double& out) {
  if (text.empty()) return false;
  size_t used = 0;
  try {
    out = std::stod(text, &used);
    return used == text.size();
  } catch (...) {
    return false;
  }
}

std::string randomName() {
  std::random_device device;
  char buffer[40];
  std::snprintf(buffer, sizeof buffer, "%08X-%04X-%04X", device(), device() & 0xFFFF, device() & 0xFFFF);
  return buffer;
}

}  // namespace

int runEditorMovie(const std::vector<std::string>& args) {
  if (args.empty()) return fail("No project was supplied.");
  const std::string& input = args.front();
  MovieSettings spec;
  std::string output;
  bool audio = false;
  StringList focus;
  for (size_t i = 1; i < args.size(); ++i) {
    const std::string& option = args[i];
    if (option == "--snap-audio") audio = true;
    else if (option == "--orthographic") spec.orthographic = true;
    else if (option == "--standard-preview") spec.standardPreview = true;
    else if (option == "--camera-track") spec.cameraTrack = true;
    else {
      if (i + 1 >= args.size()) return fail("Missing value for " + option + ".");
      const std::string& value = args[++i];
      if (option == "--out") output = value;
      else if (option == "--recordings") spec.snapRecordings = value;
      else if (option == "--size") {
        const auto x = value.find('x');
        if (x == std::string::npos || value.find('x', x + 1) != std::string::npos ||
            !parseInt(value.substr(0, x), spec.width) || !parseInt(value.substr(x + 1), spec.height))
          return fail("The output size is invalid.");
      } else if (option == "--fps") {
        if (!parseInt(value, spec.fps)) return fail("The frame rate is invalid.");
      } else if (option == "--bitrate") {
        if (!parseInt(value, spec.bitRate) || spec.bitRate < 100'000 || spec.bitRate > 240'000'000)
          return fail("The video bitrate is invalid.");
      } else if (option == "--model") focus.push_back(value);
      else if (option == "--logo") spec.logo = value;
      else if (option == "--logo-corner") {
        if (value == "tl") spec.logoCorner = LogoCorner::TopLeft;
        else if (value == "tr") spec.logoCorner = LogoCorner::TopRight;
        else if (value == "bl") spec.logoCorner = LogoCorner::BottomLeft;
        else if (value == "br") spec.logoCorner = LogoCorner::BottomRight;
        else return fail("The logo corner is invalid.");
      } else if (option == "--scene-camera") spec.sceneCameraId = value;
      else if (option == "--source") {
        if (value == "build") spec.source = MovieSource::Build;
        else if (value == "keyframes") spec.source = MovieSource::Keyframes;
        else if (value == "turntable") spec.source = MovieSource::Turntable;
        else return fail("The video source is invalid.");
      } else if (option == "--azimuth" || option == "--elevation" || option == "--fov") {
        double angle = 0;
        if (!parseDouble(value, angle) || !std::isfinite(angle)) return fail("The camera is invalid.");
        spec.viewportAngle = true;
        const double radians = angle * M_PI / 180;
        if (option == "--azimuth") spec.yaw = radians;
        else if (option == "--elevation") spec.pitch = radians;
        else spec.fieldOfView = radians;
      } else if (option == "--duration") {
        if (!parseDouble(value, spec.turntableSeconds)) return fail("The turntable duration is invalid.");
      } else return fail("Unknown movie option " + option + ".");
    }
  }
  if (output.empty()) return fail("No video destination was supplied.");
  Session session;
  const auto opened = session.open(input);
  if (!opened.ok) return fail(opened.error);
  if (!focus.empty()) {
    const auto changed = session.focus(focus);
    if (!changed.refused.empty() || session.focusPath().size() != focus.size())
      return fail("The selected submodel could not be opened.");
  }
  if (!Viewport::metalDevice()) return fail("Metal could not start the video renderer.");
  Viewport viewport(session);
  if (!audio) {
    const auto failure = viewport.exportMovie(spec, output);
    return failure.empty() ? 0 : fail(failure);
  }
  if (spec.source != MovieSource::Build || spec.standardPreview || session.buildSettings().standardPlanner)
    return fail("Snap audio requires a native Build video.");
  namespace fs = std::filesystem;
  const fs::path destination(output);
  const fs::path temp = destination.parent_path() / ("Tracks-" + randomName());
  std::error_code code;
  if (!fs::create_directory(temp, code)) return fail(code ? code.message() : "The snap track folder already exists.");
  const auto picture = temp / "Picture.mp4";
  spec.snapWave = (temp / "Snaps.wav").string();
  auto failure = viewport.exportMovie(spec, picture.string());
  if (failure.empty()) failure = muxSnapAudio(picture.string(), spec.snapWave, output);
  fs::remove_all(temp, code);
  return failure.empty() ? 0 : fail(failure);
}

}  // namespace bmapp
