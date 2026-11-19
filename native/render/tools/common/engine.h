#pragma once
// What the render tools share with `bm`: finding the LDraw library, and planning a model as
// `bm plan` plans it.
#include <filesystem>
#include <string>
#include "bm/connect/graph.h"
#include "bm/ldraw/part_cache.h"
#include "bm/model.h"
#include "bm/plan/plan.h"
#include "bm/plan/timeline.h"
#include "bmf/body.h"
#include "bmf/shots.h"
#include "bmr/camera.h"

namespace bmtools {

/// BM_LDRAW_DIR, else public/ldraw in the working directory or one above it; "" if none.
std::string ldrawDir();

struct Planned {
  bm::plan::Plan plan;
  bm::plan::Timeline timeline;
  bm::connect::Graph graph;  ///< the joints the plan was made from
  /// Pieces drawn a little off what holds them, each applied or why not (connect::Correction).
  std::vector<bm::connect::Correction> corrections;
  /// The director's shot list for the build, and its camera filmed at the aspect planned for.
  std::vector<bm::film::Shot> shots;
  bm::film::Track track;
};
/// Planned as `bm plan` plans it, with the engine data beside the LDraw library's repository.
/// With options.correctPlacements, `model` is changed: its pieces drawn a little off what holds
/// them are set in place (those the plan keeps there). Plan before building what is drawn, so
/// what is drawn is what was planned and certified.
/// Tells stderr which pieces were drawn a little off what holds them, and what became of each.
void reportCorrections(const char* tool, const bm::Model& model, const std::vector<bm::connect::Correction>& corrections);

/// The director films it too, for a picture `aspect` wide over high.
Planned planModel(bm::Model& model, const bm::ldraw::Library& library, bm::ldraw::PartCache& full, const std::filesystem::path& ldraw,
                  const bm::plan::Options& options = {}, const bm::plan::Style& style = {}, double aspect = 16.0 / 9);

/// A frame of the director's track as the renderer's camera; near and far fitted to `scene`
/// (left wide if it is empty).
bmr::Camera toCamera(const bm::film::Frame& frame, double aspect, const bm::Box& scene = {});
/// timeline.camera replaced by one key a frame from the track, so what plays the timeline's
/// camera (bmview) plays the director's. The lens stays the player's.
void keysFromTrack(const bm::film::Track& track, bm::plan::Timeline& timeline);

}  // namespace bmtools
