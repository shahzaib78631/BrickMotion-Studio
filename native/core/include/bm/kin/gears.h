#pragma once
// Gear teeth on parts, and which placed gears drive each other.
#include <cstdint>
#include <memory>
#include <string>
#include <string_view>
#include <vector>
#include "bm/model.h"

namespace bm::kin {

enum class ToothKind : uint8_t { Spur, Bevel, DoubleBevel, Worm, Rack };

/// One ring (or row) of teeth: in part space as stored, in model space once placed.
struct Toothed {
  ToothKind kind = ToothKind::Spur;
  int teeth = 0;           ///< a worm: its number of starts
  Vec3 axis;               ///< unit: the shaft; a rack: the direction it travels
  Vec3 centre;             ///< middle of the tooth width, on the axis; a rack: middle of its tooth line
  double pitchRadius = 0;  ///< 0 for a rack
  double width = 0;        ///< tooth width along the axis; a rack: across its travel
  Vec3 facing;             ///< bevel: unit, the side of the gear its teeth are on
  double length = 0;       ///< rack: along `axis`
  Vec3 face;               ///< rack: unit, the direction its teeth point
  double lead = 0;         ///< worm: LDU its thread advances per turn
};

/// `t` placed by `xf`.
Toothed placed(const Toothed& t, const Xform& xf);

/// The teeth of each part. Read-only after load(), so it can be shared between threads.
class GearDb {
 public:
  /// Reads native/data/gears.json. Returns the parts added; malformed rows are skipped.
  size_t load(std::string_view json);
  /// The part's teeth (".dat" may be left off); empty when it has none. A variant with no
  /// row of its own ("3648a", "32270p01") uses its base number's.
  const std::vector<Toothed>& get(std::string_view part) const;
  size_t size() const { return parts_.size(); }

 private:
  std::vector<std::pair<std::string, std::vector<Toothed>>> parts_;  ///< sorted by name
};

/// Parallel: side by side on parallel shafts. Crossed: bevels on shafts that meet at a right
/// angle. Worm: a worm (a) driving a gear (b). Rack: a gear (a) on a rack (b).
enum class MeshKind : uint8_t { Parallel, Crossed, Worm, Rack };

/// Two pieces whose teeth are engaged.
///
/// At `point` the two tooth surfaces move together along `tangent`: that one equation is the
/// whole coupling, whatever carries the gears. `point` is placed so that its distances to the
/// two shafts are exactly in the ratio of the tooth counts, which makes every ratio derived
/// from it exact rather than measured.
struct GearMesh {
  uint32_t a = 0, b = 0;  ///< piece indices
  MeshKind kind = MeshKind::Parallel;
  int teethA = 0, teethB = 0;  ///< a rack has 0
  double travel = 0;  ///< rack: LDU it moves per turn of the gear; worm: its lead
  Vec3 point, tangent;
  Vec3 axisA, pointA;  ///< a's shaft line
  Vec3 axisB, pointB;  ///< b's shaft line; a rack: its direction of travel
  double width = 0;    ///< shared tooth width at `point`, along axisA
};

/// A ring of teeth on a piece.
struct PlacedTeeth {
  uint32_t piece = 0;
  Toothed teeth;  ///< model space
  bool besideWorm = false;  ///< the piece also has a worm thread (its "rack" rows are that thread seen side-on)
};

/// Every engaged pair among `teeth`, at most one mesh per pair of pieces, sorted by (a, b).
std::vector<GearMesh> findMeshes(const std::vector<PlacedTeeth>& teeth);
/// Every engaged pair of pieces in the model.
std::vector<GearMesh> findMeshes(const Model& model, const GearDb& gears);

const char* name(MeshKind kind);

}  // namespace bm::kin
