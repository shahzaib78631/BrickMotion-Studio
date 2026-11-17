#pragma once
// Collision over a whole model: every overlap in it, and checks for one more shape.
#include <memory>
#include <optional>
#include <vector>
#include "bm/collide/pair.h"
#include "bm/connect/graph.h"
#include "bm/ldraw/part_cache.h"
#include "bm/model.h"

namespace bm::collide {

struct Overlap {
  uint32_t a = 0, b = 0;   ///< piece indices, a < b
  Vec3 point;              ///< where their surfaces cross, model space
  bool duplicate = false;  ///< the same part at the same pose: one piece placed twice
  Hit hit;                 ///< the crossing triangles, for diagnosis
};

struct Report {
  std::vector<Overlap> overlaps;  ///< sorted by (a, b)
  uint32_t tested = 0;            ///< piece pairs whose boxes met and were tested
};

/// Every overlapping pair of pieces in the model.
/// - Joined pieces may cross inside their mates' zones (a stud in its socket).
/// - Stretches of flexible elements are not rigid and are not tested.
/// - Pieces whose part has no geometry cannot overlap.
/// - An exact duplicate is reported with `duplicate` set, without a surface test.
Report findOverlaps(const Model& model, const connect::Graph& graph, ldraw::PartCache& parts, ShapeCache& shapes);

/// A model's pieces, ready to be asked about one more shape. Read-only once built, so it
/// can be queried from many threads.
class World {
 public:
  World(const Model& model, ldraw::PartCache& parts, ShapeCache& shapes);
  ~World();
  World(const World&) = delete;
  World& operator=(const World&) = delete;

  /// The first piece `shape` placed by `xf` interpenetrates, or nullopt. Pieces listed in
  /// `ignore` are skipped; crossings inside `zones` are exempt. `shape` is none of the model's
  /// pieces: a zone that names two pieces does not count, one that names only `first` counts
  /// against that piece (see Zone).
  std::optional<uint32_t> hits(const Shape& shape, const Xform& xf, const std::vector<uint32_t>& ignore = {}, const std::vector<Zone>& zones = {}) const;

  /// Checks the move from `from` to `to` (a straight line, turning by the shortest way) at
  /// poses no more than kSweepStep apart. Returns how far along (0..1) the first hit is, or
  /// nullopt if every pose is clear. Sampled, not continuous: something thinner than the
  /// skin can be missed.
  std::optional<double> sweep(const Shape& shape, const Xform& from, const Xform& to, const std::vector<uint32_t>& ignore = {}, const std::vector<Zone>& zones = {}) const;

  size_t size() const;

  /// Which pieces are there, indexed like Model::pieces(). Null means all of them.
  using Present = std::vector<uint8_t>;
  /// The model's own piece `piece`: its shape (never null; empty if it has no geometry), its
  /// box in the model, and its placement.
  const Shape& shape(uint32_t piece) const;
  const Box& box(uint32_t piece) const;
  const Xform& pose(uint32_t piece) const;
  /// Present pieces whose boxes meet `box`, ascending.
  void near(const Box& box, const Present* present, std::vector<uint32_t>& out) const;
  /// How far (LDU, up to `distance`) the pieces of `unit`, moving as one from where the model has
  /// them, can travel along unit vector `direction` before any of them interpenetrates a present
  /// piece outside the unit; `distance` if nothing stops them. Sampled every kSweepStep and, at
  /// the first hit, bisected back to the last clear pose within `tolerance`. Crossings inside
  /// `zones` (fixed in the model) are exempt, each only between the pieces it names (Zone). A
  /// pair that already overlaps where the model has it is not this move's doing and is left
  /// out. `blocker` receives what stopped it.
  /// `start` moves the whole unit first (a later leg of a flight). With `enough` set, the search
  /// stops at the first obstacle that holds it short of that: the answer is then some travel
  /// under `enough`, not necessarily the least. A point a skin inside a moving piece that
  /// passes through an obstacle's surface also counts as stopped there, and is looked for
  /// first: it is exact, where the sampled poses can step over a graze thinner than their
  /// spacing, and it is cheap. Thread-safe.
  double clearTravel(const std::vector<uint32_t>& unit, Vec3 direction, double distance, const Present* present, const std::vector<Zone>& zones = {}, uint32_t* blocker = nullptr,
                     const Xform& start = {}, double tolerance = 0.05, double enough = 0) const;

 private:
  struct State;
  std::unique_ptr<State> state_;
  double pairTravel(uint32_t p, const Xform& from, const Box& fromBox, uint32_t q, Vec3 direction, double distance, const std::vector<Zone>& zones, double tolerance) const;
  bool restCrossing(uint32_t p, uint32_t q, const std::vector<Zone>& zones) const;
};

}  // namespace bm::collide
