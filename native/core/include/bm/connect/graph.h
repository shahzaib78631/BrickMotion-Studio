#pragma once
// Every joint in a model: which pieces are connected, how, and which move as one body.
#include <cstdint>
#include <string>
#include <vector>
#include "bm/connect/mate.h"
#include "bm/kin/gears.h"
#include "bm/model.h"

namespace bm::connect {

/// The volume of one mate, in model space: a capsule (a sphere when a == b). Inside it the
/// two joined pieces are allowed to cross, which is how a stud sits in its socket and a bar
/// in its clip without counting as a collision.
struct MateZone {
  Vec3 a, b;
  double radius = 0;
};

/// The joint between two pieces (indices into Model::pieces(), a < b).
struct Connection {
  uint32_t a = 0, b = 0;
  Joint joint;
  uint16_t mates = 0;  ///< connector pairs it is made of
  bool friction = false;  ///< one of its mates grips (see Freedom::friction)
  /// Other places it clicks home: piece b moved by this much along joint.axis (see Freedom::seats).
  std::vector<double> seats = {};
  double grip = 0;     ///< total engaged length, LDU
  uint32_t firstZone = 0, zoneCount = 0;  ///< its mates' zones in Graph::zones
};

struct Graph {
  std::vector<Connection> connections;  ///< sorted by (a, b)
  std::vector<MateZone> zones;          ///< see Connection::firstZone
  /// Gears whose teeth are engaged, sorted by (lower piece, higher piece). A mesh is a coupling,
  /// not a joint: each gear is held by its own shaft, so meshed gears are not thereby in one
  /// group. `meshZones[i]` is where the teeth of `meshes[i]` interleave.
  std::vector<kin::GearMesh> meshes;
  std::vector<MateZone> meshZones;
  /// Screws: an input and a piston held in one housing (kin::MeshKind::Screw). Not in `meshes`:
  /// they are joined to the housing already and need no zone.
  std::vector<kin::GearMesh> screws;
  /// Constant-velocity joints (kin::MeshKind::Cv): a and b are also joined by a ball; this is
  /// the turning it passes. axisA and axisB are the two shafts.
  std::vector<kin::GearMesh> shafts;
  std::vector<uint32_t> group;  ///< per piece: id of the connected group it is in (any joint)
  std::vector<uint32_t> body;   ///< per piece: id of its rigid body (fixed joints only)
  std::vector<uint8_t> hasConnectors;  ///< per piece: its part has at least one connector
  /// Per piece: it is a stretch of a flexible element (hose, cable, string) or a bare
  /// primitive placed in the model, not a part that connects by itself.
  std::vector<uint8_t> isSegment;
  uint32_t segments = 0;
  uint32_t flexibleRuns = 0;  ///< flexible elements made of two or more segments
  uint32_t groups = 0, bodies = 0;
  uint32_t largestGroup = 0;       ///< pieces in the largest group
  uint32_t largestGroupParts = 0;  ///< the most non-segment pieces any one group holds
  uint32_t attached = 0;           ///< pieces with at least one connection
  uint32_t withoutConnectors = 0;  ///< pieces whose part has no connector at all
};

/// Finds every mated connector pair with a spatial hash (time roughly linear in pieces),
/// combines the mates of each piece pair into one joint, and groups the pieces.
/// Pieces at an identical pose with the same part (duplicates) are not paired with each other.
/// With `gears`, also finds the gear meshes.
Graph buildGraph(const Model& model, ConnectorDb& connectors, const kin::GearDb* gears = nullptr);

/// For a piece that joined nothing: its closest connector pairs with other pieces and why
/// each did not mate.
struct NearMiss {
  uint32_t other = 0;    ///< the other piece
  double distance = 0;   ///< between the two connectors' starts, LDU
  std::string reason;    ///< from whyNot()
};
std::vector<NearMiss> nearMisses(const Model& model, ConnectorDb& connectors, uint32_t piece, double within = 30.0, size_t limit = 5);

}  // namespace bm::connect
