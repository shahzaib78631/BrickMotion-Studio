#pragma once
// A part's connectors: every place another part can attach, as a frame in the part's space.
#include <memory>
#include <string>
#include <string_view>
#include <vector>
#include "bm/connect/shadow.h"
#include "bm/ldraw/library.h"

namespace bm::connect {

/// Where a connector's data came from.
enum class Source : uint8_t { Shadow, Studio, BrickNet, Kinebrick, Geometry, Override };

/// One stretch of a cylinder connector, measured from the connector's start along its axis.
struct ProfileSection {
  char shape = 'R';  ///< 'R' round, 'A' axle, 'S' square, 'L' flexible lip, 'T' tyre seat
  double radius = 0, start = 0, length = 0;
};

struct Connector {
  SnapKind kind = SnapKind::Cyl;
  Gender gender = Gender::Female;
  Source source = Source::Shadow;
  Vec3 start;  ///< where its sections begin, LDU
  Vec3 axis;   ///< unit: the direction its sections run in
  Vec3 side;   ///< unit, perpendicular to `axis`: fixes the roll about it
  double length = 0;
  double radius = 0;  ///< the widest section; a ball's radius
  std::vector<ProfileSection> profile;  ///< Cyl
  bool slide = false;
  bool openStart = true, openEnd = false;  ///< Cyl: which ends a mate can pass through
  std::string id, group, match, placement, bounding;
  /// Finger: alternating widths from `start`; the first is a finger when `gender` is Male,
  /// a gap when Female.
  std::vector<double> seq;
};

/// The connector placed by `xf`. Lengths follow the scale along the axis, radii the scale
/// across it, so a stretched or mirrored reference gives a correct connector.
Connector transformed(const Connector& c, const Xform& xf);

/// Connectors per part, from every source. Thread-safe; a library part is computed once.
class ConnectorDb {
 public:
  /// Both must outlive the database.
  ConnectorDb(const ldraw::Library& library, const ShadowLibrary& shadow);
  ~ConnectorDb();
  ConnectorDb(const ConnectorDb&) = delete;
  ConnectorDb& operator=(const ConnectorDb&) = delete;

  /// The part's connectors in part space (".dat" may be left off). A part's connectors are
  /// its own plus those of every subfile it is made of, unless its shadow clears them.
  /// Pass the model's library to resolve parts defined inside a model file; those are
  /// computed on each call and not shared. Never null; unknown parts have none.
  std::shared_ptr<const std::vector<Connector>> get(std::string_view partName, const ldraw::Library* modelLibrary = nullptr);

  /// Adds BrickLink Studio's connectivity as a second source (must outlive the database).
  /// A Studio connector is added only where the part has no connector already doing the same
  /// job at that place, so the shadow library stays the primary source. Call before get().
  void setStudio(const class StudioLibrary* studio);

  /// Registers connectors for a part from a source other than the shadow library. They are
  /// added to whatever the part already has. Call before the first get().
  void add(std::string_view partName, std::vector<Connector> connectors);

 private:
  struct State;
  std::unique_ptr<State> state_;
};

/// Reads measured tyre bores and wheel-rim seats (native/data/wheel-seats.json) into `db`
/// as connectors of shape 'T', centred on the part's origin. Returns how many were added;
/// malformed entries are skipped.
size_t loadWheelSeats(std::string_view json, ConnectorDb& db);

/// Reads hinge and ball joints from BrickNet's catalogue (native/data/bricknet-joints.json).
/// A hinge half turns about its axis; halves of one type mate ("in" with "on"). Returns how
/// many connectors were added; malformed rows are skipped.
size_t loadBricknetJoints(std::string_view json, ConnectorDb& db);

}  // namespace bm::connect
