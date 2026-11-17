#pragma once
// What the render tools share with `bm`: finding the LDraw library, and planning a model as
// `bm plan` plans it.
#include <filesystem>
#include <string>
#include "bm/ldraw/part_cache.h"
#include "bm/model.h"
#include "bm/plan/plan.h"
#include "bm/plan/timeline.h"

namespace bmtools {

/// BM_LDRAW_DIR, else public/ldraw in the working directory or one above it; "" if none.
std::string ldrawDir();

struct Planned {
  bm::plan::Plan plan;
  bm::plan::Timeline timeline;
};
/// Planned as `bm plan` plans it, with the engine data beside the LDraw library's repository.
Planned planModel(const bm::Model& model, const bm::ldraw::Library& library, bm::ldraw::PartCache& full, const std::filesystem::path& ldraw,
                  const bm::plan::Options& options = {});

}  // namespace bmtools
