#pragma once
// The editable document: a model as its file holds it (steps, submodels, every field), from
// which the flat Model the planner and renderer read is made again after each edit.
#include <cstdint>
#include <filesystem>
#include <string>
#include <unordered_map>
#include <utility>
#include <vector>
#include <nlohmann/json.hpp>
#include "bm/io.h"
#include "bm/model.h"

namespace bm::doc {

/// Unique in a Source for its life; never reused.
using ItemId = uint64_t;

/// Where an item sits in its def. grid: the plan's x and z in studs, y in plates, rot in
/// degrees (0, 90, 180, 270); otherwise `exact` (LDU and a matrix).
struct Placement {
  bool grid = false;
  double x = 0, y = 0, z = 0;
  int rot = 0;
  Xform exact;
};

/// The colour a plan item has with no "color" key, or with 16.
inline constexpr int kPlanDefaultColor = 71;
/// An item whose colour is a name, resolved against the library's colour table when flattened.
inline constexpr int kColorByName = -1;

struct Item {
  ItemId id = 0;
  bool submodel = false;
  std::string name;       ///< part file ("3001.dat") or submodel name
  std::string colorText;  ///< as the file had it (code or name), verbatim; "" = default
  int color = 16;         ///< resolved code; 16 takes the colour of what holds it; kColorByName
  Placement at;
  nlohmann::ordered_json extra;  ///< the item's object as read, every key in its place
};

struct Step {
  std::vector<Item> items;
  nlohmann::ordered_json extra;  ///< the step's object as read (title, notes, pause...)
};

struct Def {
  std::vector<Step> steps;
  nlohmann::ordered_json extra;  ///< a submodel's object as read
};

/// Which file form the document came from: piece ids, the colour 16 and loop reports follow it,
/// so a model flattens exactly as io::load would have read it.
enum class Origin { Plan, LDraw };

struct Source {
  Origin origin = Origin::Plan;
  Def root;
  std::vector<std::pair<std::string, Def>> submodels;  ///< file order kept
  std::vector<ldraw::File> inlineParts;               ///< part files that came inside the model file
  nlohmann::ordered_json extra;  ///< the plan's object as read (its other top-level keys in place)
  std::string rootName;          ///< LDraw: the first file's name
  LoadReport carried;            ///< what reading the file found (malformed lines, Studio parts)
  ItemId next = 1;

  /// A fresh id, never used in this Source before.
  ItemId newId() { return next++; }
  /// "" is the root; null when there is no such submodel.
  const Def* def(const std::string& submodel) const;
  Def* def(const std::string& submodel);
};

Source fromPlan(const io::PlanDoc& plan);
/// The plan, with the same key order as read; grid placements stay grid.
io::PlanDoc toPlan(const Source& source);
/// The first file is the root; the other model files (not .dat) are submodels, .dat files are
/// inline parts. Each `0 STEP` closes a step; an empty trailing step is dropped.
Source fromLDraw(const std::vector<ldraw::File>& files);
/// Any format bm::io reads; a .brickmotion project gives its plan. Throws io::Error.
Source fromFile(const std::filesystem::path& path);

/// The grid rule: x and z in studs, y in plates, the minimum corner of the turned footprint,
/// bottom of the piece. `body` is the piece's box in its own space.
Xform placeOnGrid(const Placement& at, const Box& body);

/// Which items made a piece: the root's item first, the part's own item last.
struct PieceRef {
  std::vector<ItemId> chain;
};
/// The Model the planner and renderer read; refs[i] belongs to model.pieces()[i].
struct Flat {
  Model model;
  std::vector<PieceRef> refs;
};
Flat flatten(const Source& source, const ldraw::Library& library, ldraw::PartCache& cache);

/// Each item's placement in its own def, as flatten puts it (grid placements need part sizes).
/// Items flatten leaves out (a missing submodel, a loop) are not in it.
std::unordered_map<ItemId, Xform> placements(const Source& source, const ldraw::Library& library, ldraw::PartCache& cache);

}  // namespace bm::doc
