#pragma once
// Whether moving some pieces of a model makes them run into the others.
#include <memory>
#include <unordered_map>
#include <vector>
#include "bm/collide/pair.h"
#include "bm/connect/graph.h"
#include "bm/ldraw/part_cache.h"
#include "bm/model.h"

namespace bm::kin {

/// A model's pieces and their shapes, asked about moved poses. Not thread-safe: it remembers
/// which pairs overlap at rest. Make one per solve.
class Contact {
 public:
  Contact(const Model& model, const connect::Graph& graph, ldraw::PartCache& parts, collide::ShapeCache& shapes);

  /// Whether, with each piece i moved by `motion[bodyOf[i]]` (a model-space transform applied
  /// after its placement), some piece of `moved` overlaps a piece of another body that it does
  /// not already overlap at rest. A pair's mate and mesh zones are exempt only if the pair
  /// needs them at rest; they move with the lower-numbered piece of the pair. Segments and pieces without geometry never
  /// collide. If `who` is given it receives the two pieces.
  bool blocked(const std::vector<uint32_t>& moved, const std::vector<uint32_t>& bodyOf, const std::vector<Xform>& motion, std::pair<uint32_t, uint32_t>* who = nullptr);

 private:
  const Model& model_;
  const connect::Graph& graph_;
  std::vector<std::shared_ptr<const collide::Shape>> shapes_;
  std::vector<Box> restBox_;
  std::unordered_map<uint64_t, uint8_t> restOverlap_;  ///< 0 clean, 1 clean only inside its zones, 2 overlapping
  void zonesFor(uint32_t lo, uint32_t hi, std::vector<collide::Zone>& out, bool& joined) const;
};

}  // namespace bm::kin
