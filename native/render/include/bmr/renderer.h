#pragma once
// Draws a model with Metal. No Apple type appears here: what must cross is a void*.
#include <cstdint>
#include <memory>
#include <vector>
#include "bm/ldraw/part_cache.h"
#include "bm/model.h"
#include "bm/plan/plan.h"
#include "bm/plan/timeline.h"
#include "bmr/camera.h"
#include "bmr/image.h"
#include "bmr/scene.h"

namespace bmr {

struct FrameOptions {
  bool edges = true, shadows = true, ambientOcclusion = true, floor = true;
  bool cull = true;      ///< leave out what is not in view
  bool lightsFollowCamera = true;  ///< the light rig turns with the camera's heading (EyeSight's BUILD_FL), or stays fixed to the model
  int forceDetail = -1;  ///< -1: by size on screen; 0, 1, 2: that level of detail for everything (tests, benchmark)
  float background[3] = {1, 1, 1};  ///< linear
};

struct FrameStats {
  double cpuMs = 0;  ///< building and sending the frame
  double gpuMs = 0;  ///< the GPU's own time for it; 0 until the frame has finished
  uint32_t drawCalls = 0, instances = 0, culled = 0;
  uint64_t triangles = 0;
  uint32_t byDetail[3] = {0, 0, 0};  ///< instances drawn at Full, Low, Box
  bool shadowDrawn = false;          ///< the key light's shadow map was drawn again this frame (it is kept while nothing moves)
  uint64_t shadowTriangles = 0;      ///< drawn into it, when it was
  bool submitted = false;            ///< the frame went to the GPU: false with nothing to draw into (no size, or a drawable that has not caught up with a resize)
};

class Renderer {
 public:
  /// nullptr when drawing is not possible here (see bmr::gpuAvailable). `low` is a part cache
  /// with FlattenOptions::lowResPrimitives set. The model and both caches must outlive the
  /// renderer, which only reads them.
  static std::unique_ptr<Renderer> create(const bm::Model& model, bm::ldraw::PartCache& full, bm::ldraw::PartCache& low);
  ~Renderer();
  Renderer(const Renderer&) = delete;
  Renderer& operator=(const Renderer&) = delete;

  const Scene& scene() const;
  /// The size of the picture, in pixels. A size under 1 either way is remembered and nothing is drawn.
  void resize(int width, int height);
  /// Draws one frame: into `drawable` (an id<CAMetalDrawable>, passed as void*, presented when
  /// done) or, when null, into the renderer's own picture, waiting until it is finished.
  /// Never throws; with nothing to draw into it returns stats of zero (submitted false), and
  /// the caller should draw again once there is.
  FrameStats draw(const Camera& camera, const FrameOptions& options = {}, void* drawable = nullptr);
  /// The last frame drawn without a drawable. Empty if there is none.
  Image readback();
  /// The GPU time of the most recent frame that has finished (frames drawn into a drawable finish later).
  double lastGpuMs() const;

  /// Poses the pieces as the timeline has them at `frame` (clamped to the timeline); only the
  /// instances that change are sent to the GPU. The plan and timeline are read, not kept.
  void setFrame(const bm::plan::Plan& plan, const bm::plan::Timeline& timeline, int frame);
  /// Every piece back where the model has it, shown.
  void setRest();
  /// The piece under pixel (x, y) of the last frame drawn (row 0 at the top), or UINT32_MAX for
  /// none, outside the picture, or before any frame. The first call after a frame draws the
  /// pieces' numbers once; later calls read them.
  uint32_t pick(int x, int y);
  /// Exactly these pieces are selected (outlined in the accent colour, even where hidden
  /// behind others). Unknown pieces are ignored.
  void select(const std::vector<uint32_t>& pieces);

 private:
  Renderer();
  struct Impl;
  std::unique_ptr<Impl> impl_;
};

}  // namespace bmr
