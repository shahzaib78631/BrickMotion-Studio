#pragma once
// Corpus audit: one scoreboard row per model, in the format shared with the web baseline.
#include <filesystem>
#include <string>
#include <vector>
#include <nlohmann/json.hpp>
#include <map>
#include "bm/collide/world.h"
#include "bm/connect/graph.h"
#include "bm/ldraw/library.h"
#include "bm/ldraw/part_cache.h"

namespace bm::audit {

struct Row {
  std::string id;
  bool ok = false;      ///< the model loaded
  std::string error;    ///< why not, when !ok
  int pieces = 0;
  std::vector<std::string> unknownParts;      ///< part ids (no ".dat") that are not in the library, sorted
  std::vector<std::string> missingSubmodels;  ///< sorted
  double loadMs = 0;    ///< parse, expand and fetch every distinct part's mesh

  // Joints (present when a connector database was given).
  bool hasGraph = false;
  int joined = 0;             ///< pieces in the largest connected group
  int groups = 0;
  int attached = 0;           ///< pieces with at least one connection
  int bodies = 0;             ///< rigid bodies
  int withoutConnectors = 0;  ///< pieces whose part has no connector data
  int segments = 0;           ///< flexible-element segments and bare primitives placed as pieces
  int partsAttached = 0;      ///< non-segment pieces with at least one connection
  int partsJoined = 0;        ///< the most non-segment pieces in any one group
  int joints[connect::kJointKinds] = {};         ///< connections per connect::JointKind
  int meshes = 0;             ///< engaged gear pairs
  double graphMs = 0;
  // Collision (present when a shape cache was given too).
  bool hasCollision = false;
  int overlaps = 0;        ///< piece pairs that interpenetrate (duplicates not included)
  int overlapsJoined = 0;  ///< of those, pairs that are also joined to each other
  int overlapPieces = 0;   ///< pieces in at least one such pair
  int duplicates = 0;      ///< pairs that are the same part at the same pose
  double collisionMs = 0;
  std::map<std::string, int> overlapPairs;  ///< "partA + partB" -> overlapping pairs
  // Kinematics (present when a shape cache was given).
  bool hasKinematics = false;
  int movingBodies = 0;    ///< bodies after slides that do not move are removed
  int links = 0;           ///< joints between those bodies
  int freedoms = 0;        ///< independent ways the model can move
  int mechanisms = 0;      ///< of those, the ones that move more than one body about one link
  bool solved = false;     ///< the freedoms were found (false: too large, see kin::Mobility::reason)
  double kinMs = 0;
  // Stability (present with the graph).
  bool stands = false;        ///< nothing unsupported, nothing tipping
  int unsupportedPieces = 0;  ///< pieces that reach the floor through no joint
  int tippingGroups = 0;      ///< groups on the floor whose weight is outside their footprint
  double massGrams = 0;
  double stableMs = 0;

  std::map<std::string, int> noConnectorParts;  ///< part -> pieces, for parts with no connectors
  std::map<std::string, int> unmatedParts;      ///< part -> pieces that have connectors but joined nothing
};

/// Loads one model and every distinct part it uses. Never throws: a failure is a row.
Row loadRow(const std::filesystem::path& file, std::string id, const ldraw::Library& library, ldraw::PartCache& cache, connect::ConnectorDb* connectors = nullptr, collide::ShapeCache* shapes = nullptr, const kin::GearDb* gears = nullptr);

nlohmann::json toJson(const Row& row);

/// Totals and load-time percentiles over the rows that loaded.
nlohmann::json summarize(const std::vector<Row>& rows);

}  // namespace bm::audit
