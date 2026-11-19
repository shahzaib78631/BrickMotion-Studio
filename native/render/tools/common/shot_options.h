#pragma once
// What bmshot and bmexport share: the picture's size, the frame, the camera, the rig's heading,
// the background and repeating the model for benchmarks.
#include <cmath>
#include <filesystem>
#include <string>
#include <string_view>
#include <vector>
#include "bm/math.h"
#include "bm/plan/timeline.h"
#include "bmr/camera.h"

namespace bmtools {

struct ShotOptions {
  std::string out;
  int width = 1600, height = 1000;
  int frame = -1;  ///< -1: the model as it is, not a moment of its build
  double azimuth = NAN, elevation = NAN, fovDegrees = NAN;
  bool explicitCamera = false;  ///< --eye and --target given (LDraw space, y down)
  bm::Vec3 eye, target;
  int columns = 1, rows = 1;    ///< --repeat
  bool lightsFollow = false;    ///< --lights-follow; --lights-fixed (the default) sets it false
  bool backgroundSet = false;
  float background[3] = {1, 1, 1};  ///< linear
  /// --correct: pieces drawn a little off what holds them are set in place before anything is
  /// drawn or planned (bm::plan::Options::correctPlacements), as bm plan --correct does.
  bool correct = false;
  /// --flight web|arc: the flight's shape (bm::plan::Style::shape).
  bm::plan::FlightShape flight = bm::plan::FlightShape::Web;
  /// --strip N: N frames of the build, evenly from the first to the last, as one contact sheet.
  int strip = 0;
  /// A frame of the build with no camera of the caller's: the director's camera films it.
  bool directorFilms() const { return (frame >= 0 || strip > 0) && !explicitCamera && std::isnan(azimuth) && std::isnan(elevation); }
};

/// The project's style (bm::plan::styleOf) with the shot's --flight.
inline bm::plan::Style styleWith(const std::filesystem::path& project, const ShotOptions& o) {
  bm::plan::Style style = bm::plan::styleOf(project);
  style.shape = o.flight;
  return style;
}

/// Reads the option at args[i] (and its value, moving `i` past it). 1: it was one of these; 0:
/// it is not, `i` unchanged; -1: it was, with a bad value.
int parseShotOption(ShotOptions& options, const std::vector<std::string_view>& args, size_t& i);

/// The camera of a still: fitted to `bounds` from the given or default heading; or at --eye
/// looking at --target; or, at a frame of a build with no heading given, the timeline's camera
/// there. --fov sets the lens (not of the timeline's camera). False only if --eye is --target.
bool shotCamera(const ShotOptions& options, const bm::Box& bounds, const bm::plan::Timeline* timeline, bmr::OrbitCamera& out);

}  // namespace bmtools
