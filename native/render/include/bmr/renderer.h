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
  /// Glass ray-traced through every wall, cavity and neighbour (glass_transport.metal).
  /// On by default: uses hardware/Metal ray queries for path-traced refraction, internal
  /// reflection and wall absorption; off falls back to the fast OIT preview.
  bool refractiveGlass = true;
  bool cull = true;      ///< leave out what is not in view
  bool lightsFollowCamera = false;  ///< the light rig stays fixed to the model, as EyeSight's BUILD_FL does, or turns with the camera's heading
  int forceDetail = -1;  ///< -1: by size on screen; 0, 1, 2: that level of detail for everything (tests, benchmark)
  /// 0: a stale shadow or height map is drawn again whole before the frame. Otherwise it is
  /// drawn again over frames, about this many triangles of it a frame, the last one complete
  /// still shown meanwhile, with what moved since it was begun drawn over it (for a viewer:
  /// tolerances.h kMapTrianglesPerFrame). FrameStats::settling says when to draw again.
  uint64_t mapTrianglesPerFrame = 0;
  float background[3] = {1, 1, 1};  ///< linear
};

struct FrameStats {
  double cpuMs = 0;  ///< building and sending the frame
  double gpuMs = 0;  ///< the GPU's own time for it; 0 until the frame has finished
  uint32_t drawCalls = 0, instances = 0, culled = 0;
  uint64_t triangles = 0;
  uint32_t byDetail[3] = {0, 0, 0};  ///< instances drawn at Full, Low, Box
  bool shadowDrawn = false;          ///< something was drawn into the key light's shadow map this frame (it is kept while nothing moves)
  uint64_t shadowTriangles = 0;      ///< drawn into it, when something was
  bool submitted = false;            ///< the frame went to the GPU: false with nothing to draw into (no size, or a drawable that has not caught up with a resize)
  bool mapWhole = false;             ///< a shadow or height map was drawn whole before this frame (not over frames)
  bool settling = false;             ///< a map is being drawn over frames (FrameOptions::mapTrianglesPerFrame): draw again, even with nothing changed
};

struct PlacementGhost {
  std::string part;
  int color;
  bm::Xform pose;
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
  void setFrame(const bm::plan::Plan& plan, const bm::plan::Timeline& timeline, double frame,
                const std::vector<PiecePose>& keyed = {});
  /// Every piece back where the model has it, shown.
  void setRest();
  /// The model changed. With `moved` and the same piece count, only those instances are
  /// re-placed (no scene rebuild); otherwise the scene is rebuilt, meshes already loaded are
  /// reused, and what is selected and hidden is kept (by piece index). `model` replaces the one
  /// given to create() and must outlive the renderer. Pieces are shown at rest after it.
  void modelChanged(const bm::Model& model, const std::vector<uint32_t>* moved = nullptr);
  /// These pieces' colours changed in the model: each moves to its new (part, colour) group,
  /// without rebuilding the scene.
  void recolored(const std::vector<uint32_t>& pieces);
  /// Exactly these pieces are hidden while editing (view state, apart from the timeline's own
  /// hiding of pieces before their turn). Unknown pieces are ignored.
  void setHidden(const std::vector<uint32_t>& pieces);
  /// The piece under pixel (x, y) of the last frame drawn (row 0 at the top), or UINT32_MAX for
  /// none, outside the picture, or before any frame. The first call after a frame draws the
  /// pieces' numbers once; later calls read them.
  uint32_t pick(int x, int y);
  /// Exactly these pieces are selected (outlined in the accent colour, even where hidden
  /// behind others). Unknown pieces are ignored.
  void select(const std::vector<uint32_t>& pieces);
  /// Transient parts with depth-tested translucency or a refused-pose outline. Drawn outside
  /// the scene, so they cannot affect picking, framing, shadows, or the model.
  void setPlacementPreview(const std::vector<PlacementGhost>& ghosts, bool refused);
  void clearPlacementPreview();
  /// World space: the selected pieces where they are shown now (as the last setFrame or
  /// setRest put them), hidden ones left out. Empty when none is shown.
  bm::Box selectionBounds() const;

 private:
  Renderer();
  struct Impl;
  std::unique_ptr<Impl> impl_;
};

}  // namespace bmr
