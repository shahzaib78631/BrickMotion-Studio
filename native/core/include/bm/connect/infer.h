#pragma once
// Joints the connector data does not give. A piece the connector pass joins to nothing is often
// held all the same: placed a little off its connector by the file's author (a clip a few
// degrees off its bar, a tube pushed past the end of its bar), or held by a feature no connector
// describes (a blade in a holder's slot). Its joint is inferred here, after buildGraph, from
// the geometry: an ordinary Connection, so the planner, the certifier and the play checks treat
// it like any other. Only pieces with no connection at all are looked at, so a model whose
// every piece is joined comes out exactly as buildGraph made it.
#include <cstdint>
#include <string>
#include <utility>
#include <vector>
#include "bm/collide/world.h"
#include "bm/connect/graph.h"

namespace bm::connect {

/// A piece the file places a little off what holds it, and where it belongs: set exactly onto
/// that connector's line it mates. Recorded whether or not it is applied (plan::correctPlacements).
struct Correction {
  uint32_t piece = 0, onto = 0;  ///< indices into Model::pieces()
  Xform from, to;                ///< the piece's placement in the file, and set exactly in place
  double offset = 0;             ///< LDU its connector is off the line it belongs on
  double along = 0;              ///< LDU it moves along that line to seat (pushed past, or short of, its stop)
  double angle = 0;              ///< degrees it turns
  bool applied = false;
  std::string note;              ///< why it was not applied, when it was not
};

struct Inferred {
  uint32_t relaxed = 0;  ///< pieces joined by a connector pair once set exactly in place
  uint32_t dropped = 0;  ///< joints taken out again: the plan left their piece stuck (plan::planInferred)
  std::vector<Correction> corrections;  ///< one per piece joined here: where it belongs
};

/// A connector of the piece within 12 degrees and 4 LDU of another piece's line, and up to 6 LDU
/// along it, mates once the piece is set exactly onto that line (Found::Relaxed); the joint is that
/// mate's, its zone that mate's grown by how far off the piece was. Re-groups the graph when
/// anything was added.
/// `settle`: pieces joined already, each to be set exactly onto the one given when a little off it
/// (what a corrected piece holds: plan::correctPlacements); a correction only, when not exact.
Inferred inferJoints(Graph& graph, const Model& model, ConnectorDb& connectors, const collide::World& world,
                     const std::vector<std::pair<uint32_t, uint32_t>>& settle = {});

}  // namespace bm::connect
