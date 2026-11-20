#pragma once
// The web app's Standard ("legacy") animation planner, ported as it is: it derives its own units
// and order, lays them on the web's floor, and flies each one in along a way its connectors allow,
// over a single ceiling that clears what stands. Selected with Style::planner == Planner::Legacy.
#include "bm/plan/timeline.h"

namespace bm::plan::legacy {

/// bm::plan::Timeline as the web's src/anim/timeline.ts buildTimeline (the legacy path) makes it.
Timeline buildLegacyTimeline(const Model& model, ldraw::PartCache& parts, connect::ConnectorDb& connectors,
                             connect::Graph& graph, const Plan& authored, const Style& style, Vec3 down = {0, 1, 0});

}  // namespace bm::plan::legacy
