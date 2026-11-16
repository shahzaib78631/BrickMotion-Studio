#pragma once
// Scoring a plan against a hand-checked list of how particular pieces go in.
#include <nlohmann/json.hpp>
#include <string>
#include <vector>
#include "bm/plan/plan.h"

namespace bm::plan {

struct InsertionLine {
  std::string id, why, detail;
  enum class Result : uint8_t { Hit, Missing, Unresolved } result = Result::Missing;
};
struct InsertionScore {
  int hit = 0, missing = 0, unresolved = 0;
  std::vector<InsertionLine> lines;
};

/// `cases` is the "cases" array of native/corpus/insertion-truth.json, already narrowed to this
/// model: each `{ "id", "piece": { "part", "at": [x, y, z] }, "axis": [x, y, z], "either": bool, "why" }`.
/// A piece is named by its part and the centre of its box in the model, to within 12 LDU. `axis`
/// is the way the piece travels into its seat; `either` allows the opposite. A case is a hit when
/// the move that places the piece (alone or in a unit) is unflagged and goes in along that axis,
/// to within kReleaseAgree.
InsertionScore scoreInsertion(const Model& model, ldraw::PartCache& parts, const Plan& plan, const nlohmann::json& cases);

}  // namespace bm::plan
