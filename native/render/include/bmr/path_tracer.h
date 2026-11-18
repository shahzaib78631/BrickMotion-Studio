#pragma once
// A path tracer of the studio (EyeSight's BUILD_FL rig, plastic, metal, glass, a shadow-catching
// floor) over a PathScene: noisy beauty, and the albedo and normal a denoiser is guided by.
#include <cstdint>
#include <memory>
#include <string>
#include <vector>
#include "bmr/camera.h"
#include "bmr/image.h"
#include "bmr/path_scene.h"

namespace bmr {

struct PathOptions {
  int width = 0, height = 0;
  int samples = 64;  ///< a pixel
  /// The picture depends only on (scene, camera, options): every random number comes from
  /// (seed, pixel, sample, bounce). Films use the frame number.
  uint64_t seed = 0;
  bool floor = true;   ///< the shadow catcher under the model
  bool lights = true;  ///< false: the white world alone
  bool lightsFollowCamera = false;  ///< as FrameOptions: the rig turns with the camera's heading
  float background[3] = {1, 1, 1};  ///< linear: what the camera sees where there is no model
};

/// Linear RGB, three floats a pixel, row 0 at the top.
struct PathImage {
  int width = 0, height = 0;
  std::vector<float> beauty;
  std::vector<float> albedo;  ///< of the first surface that is not glass; the background where none
  std::vector<float> normal;  ///< world, unit, of that surface; 0 where none
};

class PathTracer {
 public:
  /// Null, with `error` set if given, when there is no Metal device or the kernel cannot be made.
  static std::unique_ptr<PathTracer> create(std::string* error);
  ~PathTracer();
  PathTracer(const PathTracer&) = delete;
  PathTracer& operator=(const PathTracer&) = delete;
  /// Traces the scene as last prepared. Waits for the GPU.
  PathImage render(PathScene& scene, const Camera& camera, const PathOptions& options);

  struct Impl;

 private:
  explicit PathTracer(std::unique_ptr<Impl> impl);
  std::unique_ptr<Impl> impl_;
};

/// The picture as the viewport writes it: each channel clamped to 0..1 and sRGB-encoded,
/// rounded; alpha 255. Never throws.
Image toImage(const PathImage& image);

}  // namespace bmr
