#pragma once

#include <optional>
#include "engine.h"

namespace bmapp {

struct IncrementalPlan {
  bmtools::Planned planned;
  size_t reused = 0;
};

/// Reuse insertion paths whose seats, constraints and swept bounds are unaffected by one
/// moved part. Return no result when the previous order or subplans require a wider solve.
std::optional<IncrementalPlan> replanMove(const bm::Model& before, const bm::Model& after,
    uint32_t piece, const bmtools::Planned& previous, bm::ldraw::PartCache& parts,
    bmtools::ConnectorSources& sources, bm::collide::ShapeCache& shapes,
    const bm::plan::Style& style, const bm::plan::Options& options);

}  // namespace bmapp
