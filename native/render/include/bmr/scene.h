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
inline constexpr uint32_t kUserHidden = 8;  ///< hidden by the person editing (view state, not the timeline's)
/// Either way not drawn.
inline constexpr uint32_t kNotShown = kHidden | kUserHidden;

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
  bm::Box partBox;           ///< the part's box in its own space (the placeholder's when it has none)
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
struct PiecePose {
  uint32_t piece;
  bm::Xform world;
  bool hidden = false;
};
std::vector<std::pair<uint32_t, uint32_t>> applyFrame(Scene& scene, const bm::Model& model, const bm::plan::Plan& plan,
                                                     const bm::plan::Timeline& timeline, double frame,
                                                     const std::vector<PiecePose>& keyed = {});

/// Every instance back where the model has it, nothing hidden. Returns what changed.
std::vector<std::pair<uint32_t, uint32_t>> applyRest(Scene& scene, const bm::Model& model);

/// These pieces' placements changed in the model (the same pieces, the same count): each one's
/// instance and rest box are set again where the model has it now; nothing else changes. The
/// scene's bounds grow to hold them; its origin stays. Returns what changed.
std::vector<std::pair<uint32_t, uint32_t>> applyMoved(Scene& scene, const bm::Model& model, const std::vector<uint32_t>& pieces);

/// Moves each piece's instance to the group of its part and new colour, making the group at the
/// end of its opaque or transparent run if it does not exist (order inside a run is not kept).
enum class RecolorResult { Unchanged, OpaqueColors, Transparency };
RecolorResult applyRecolored(Scene& scene, const bm::Model& model, const std::vector<uint32_t>& pieces);

/// Marks exactly these pieces hidden by the person editing. Returns what changed.
std::vector<std::pair<uint32_t, uint32_t>> applyUserHidden(Scene& scene, const std::vector<uint32_t>& pieces);

/// Marks exactly these pieces selected. Returns what changed. Unknown pieces are ignored.
std::vector<std::pair<uint32_t, uint32_t>> applySelection(Scene& scene, const std::vector<uint32_t>& pieces);

/// For benchmarks: `columns` x `rows` copies of a model on a grid in x and z, each copy one
/// model's width (or depth) plus `gapLdu` from the next. Piece ids are prefixed "r<copy>/".
/// The copies are measured with `parts`; missing parts count as their placeholder box.
bm::Model repeated(const bm::Model& model, bm::ldraw::PartCache& parts, int columns, int rows, double gapLdu);

}  // namespace bmr
