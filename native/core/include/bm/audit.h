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
#include "bm/plan/timeline.h"

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

  // The build plan (present when a plan budget was given).
  bool planned = false;
  bool planOk = false;        ///< every move certified
  bool planComplete = false;  ///< the planner finished inside its budget
  int moves = 0;              ///< sub-plans included
  int certifiedMoves = 0;
  int planFlagged = 0;        ///< moves the planner could not show (unjoined ones included)
  int unjoinedMoves = 0;      ///< of those, pieces joined to nothing in the file
  int corrections = 0, correctionsApplied = 0;  ///< pieces placed a little off what holds them; of them, set in place
  int inferredDocumented = 0, inferredRelaxed = 0, inferredDropped = 0;  ///< pieces given a joint by connect::inferJoints: in documented seats, set in place; taken out again (plan::planInferred)
  int buildFloating = 0;      ///< unflagged moves that land joined to nothing built (must be 0)
  int buildCrossings = 0;     ///< unflagged moves whose flight passes through a placed piece (must be 0)
  int offAxis = 0;            ///< unflagged moves whose last leg is not along their connectors (must be 0)
  int playedCrossings = 0, playedStrict = 0, playedStrictTransit = 0, playedStrictPath = 0, playedStrictSeat = 0, transitFloor = 0, transitFallback = 0, transitMissed = 0, fallbackNoJoin = 0, fallbackAcross = 0, fallbackBelow = 0, playedUnder = 0, playedUpward = 0, playedInversions = 0;  ///< certifyPlay on the timeline
  int unitPieces = 0;         ///< pieces built in a unit of more than one (not counting the author's submodels)
  int largestUnit = 0;        ///< pieces in the largest such unit
  std::map<std::string, int> planFlags;  ///< flag name -> moves
  double planMs = 0, certifyMs = 0;

  std::map<std::string, int> noConnectorParts;  ///< part -> pieces, for parts with no connectors
  std::map<std::string, int> unmatedParts;      ///< part -> pieces that have connectors but joined nothing
};

/// Loads one model and every distinct part it uses. Never throws: a failure is a row.
/// `planBudget` (seconds) plans and certifies the build when it is positive and shapes are given;
/// `kinematics` false leaves the mechanism columns out. `correct` sets pieces placed a little
/// off what holds them in place before planning (plan::Options::correctPlacements).
Row loadRow(const std::filesystem::path& file, std::string id, const ldraw::Library& library, ldraw::PartCache& cache, connect::ConnectorDb* connectors = nullptr, collide::ShapeCache* shapes = nullptr, const kin::GearDb* gears = nullptr,
            double planBudget = 0, bool kinematics = true, bool correct = false, plan::FlightShape shape = plan::FlightShape::Web);

nlohmann::json toJson(const Row& row);

/// Totals and load-time percentiles over the rows that loaded.
nlohmann::json summarize(const std::vector<Row>& rows);

}  // namespace bm::audit
