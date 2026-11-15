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
  char shape = 'R';  ///< 'R' round, 'A' axle, 'S' square, 'L' flexible lip
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
  std::vector<double> seq;  ///< Finger: widths of fingers and gaps, from `start`
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

 private:
  struct State;
  std::unique_ptr<State> state_;
};

}  // namespace bm::connect
