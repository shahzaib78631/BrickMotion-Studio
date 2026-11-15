#pragma once
// Every joint in a model: which pieces are connected, how, and which move as one body.
#include <cstdint>
#include <vector>
#include "bm/connect/mate.h"
#include "bm/model.h"

namespace bm::connect {

/// The joint between two pieces (indices into Model::pieces(), a < b).
struct Connection {
  uint32_t a = 0, b = 0;
  Joint joint;
  uint16_t mates = 0;  ///< connector pairs it is made of
  double grip = 0;     ///< total engaged length, LDU
};

struct Graph {
  std::vector<Connection> connections;  ///< sorted by (a, b)
  std::vector<uint32_t> group;  ///< per piece: id of the connected group it is in (any joint)
  std::vector<uint32_t> body;   ///< per piece: id of its rigid body (fixed joints only)
  std::vector<uint8_t> hasConnectors;  ///< per piece: its part has at least one connector
  uint32_t groups = 0, bodies = 0;
  uint32_t largestGroup = 0;       ///< pieces in the largest group
  uint32_t attached = 0;           ///< pieces with at least one connection
  uint32_t withoutConnectors = 0;  ///< pieces whose part has no connector at all
};

/// Finds every mated connector pair with a spatial hash (time roughly linear in pieces),
/// combines the mates of each piece pair into one joint, and groups the pieces.
/// Pieces at an identical pose with the same part (duplicates) are not paired with each other.
Graph buildGraph(const Model& model, ConnectorDb& connectors);

}  // namespace bm::connect
