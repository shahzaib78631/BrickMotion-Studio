#pragma once
// A model as lists to draw: one group per part and colour, one instance per piece.
#include <cstdint>
#include <string>
#include <utility>
#include <vector>
#include "bm/math.h"
#include "bm/model.h"
#include "bm/plan/plan.h"
#include "bm/plan/timeline.h"
#include "bmr/material.h"

namespace bmr {

/// Bits of Instance::flags.
inline constexpr uint32_t kMirrored = 1;  ///< its placement turns it inside out (determinant < 0)
inline constexpr uint32_t kSelected = 2;
inline constexpr uint32_t kHidden = 4;    ///< not in the build yet: a piece that does not fly, before its turn

/// One piece as drawn. The layout is what the GPU reads.
struct Instance {
  float model[12];  ///< rows of a 3x4 matrix: part space to world space less Scene::origin, LDU
  uint32_t piece;   ///< index into Model::pieces()
  uint32_t flags;
};

/// Everything drawn with one mesh and one material.
struct Group {
  std::string part;
  int color = 16;            ///< LDraw colour code
  Material material;
  bool placeholder = false;  ///< the part has no geometry: drawn as bm::kPlaceholderBox
  std::vector<Instance> instances;
  std::vector<bm::Box> restBoxes;  ///< per instance, world space, where the model has it
};

struct Scene {
  bm::Vec3 origin;  ///< centre of the model's bounds; taken off every position sent to the GPU, so far-off models keep their precision
  bm::Box bounds;   ///< world space, at rest
  /// Opaque groups first, then transparent; within each, by part name, then colour code.
  std::vector<Group> groups;
  std::vector<std::pair<uint32_t, uint32_t>> where;  ///< per piece: (group, instance); (UINT32_MAX, UINT32_MAX) if left out
};

/// Groups the model's pieces by part and colour. A piece whose part has no geometry goes in a
/// placeholder group. A piece whose placement is not finite or squashes it flat is left out
/// and counted in `skipped`. A colour code not in the table is drawn mid grey. Never throws.
Scene buildScene(const bm::Model& model, bm::ldraw::PartCache& parts, size_t* skipped = nullptr);

/// Puts every instance where its piece is at `frame`: its flight's pose after its rest
/// placement; pieces of no flight stay at rest. A unit that does not fly (a flagged move) is
/// hidden until its turn comes. The result depends only on (timeline, frame), whatever frame
/// was applied before. Returns the (group, instance) pairs that changed, for partial uploads.
std::vector<std::pair<uint32_t, uint32_t>> applyFrame(Scene& scene, const bm::Model& model, const bm::plan::Plan& plan, const bm::plan::Timeline& timeline, int frame);

/// Every instance back where the model has it, nothing hidden. Returns what changed.
std::vector<std::pair<uint32_t, uint32_t>> applyRest(Scene& scene, const bm::Model& model);

/// Marks exactly these pieces selected. Returns what changed. Unknown pieces are ignored.
std::vector<std::pair<uint32_t, uint32_t>> applySelection(Scene& scene, const std::vector<uint32_t>& pieces);

}  // namespace bmr
