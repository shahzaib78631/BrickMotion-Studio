#pragma once
// Scoring what the engine finds in a model against a hand-checked list of its mechanisms.
#include <string>
#include <vector>
#include <nlohmann/json.hpp>
#include "bm/connect/graph.h"
#include "bm/kin/mobility.h"
#include "bm/kin/shift.h"
#include "bm/kin/system.h"
#include "bm/ldraw/part_cache.h"
#include "bm/model.h"

namespace bm::kin {

enum class TruthResult : uint8_t {
  Hit,         ///< the engine finds what the list says
  Missing,     ///< it does not
  NotScored,   ///< a kind of check this scorer does not judge
  Unresolved,  ///< the list names a piece that is not in the model: the list is wrong
};

struct TruthLine {
  std::string mechanism, type, label, detail;
  TruthResult result = TruthResult::Missing;
};

struct TruthScore {
  int hit = 0, missing = 0, notScored = 0, unresolved = 0;
  std::vector<TruthLine> lines;
  int scored() const { return hit + missing; }
};

/// Scores a model against an expected-mechanisms file (benchmarks/mechanisms/*.expected.json;
/// a piece is named by its part number and the centre of its box in the model, to within 12
/// LDU unless the file sets "toleranceLdu"). Judged from the freedoms as they are in the
/// model's own pose:
/// - `rotates` / `slides`: some freedom turns the piece about, or moves it along, the axis.
///   `slides` is also met when the piece stands and what it slides in moves along that axis.
/// - `gearMesh` / `rackPinion`: the two pieces are meshed, in the stated ratio if one is given.
/// - `fourBar`: some freedom moves the coupler while turning every arm about the axis.
/// - `function`: some freedom moves the driver and every piece listed as moving, and none
///   listed as staying; if not as the model stands, then with one of `shifts` made.
/// - `shifts`: the ring, slid to its seats, turns with each of the listed gears.
/// - `shiftMode`: with one of `shifts` made, the input turns `ratio` times for each turn of
///   the output; a null ratio means that as the model stands nothing turns both.
/// Other check types are reported as not scored. Never throws on a malformed file: a check
/// that cannot be read is unresolved.
TruthScore score(const Model& model, const connect::Graph& graph, const System& sys, const Mobility& mob, ldraw::PartCache& parts, const nlohmann::json& expected, const std::vector<Shift>* shifts = nullptr);

const char* name(TruthResult result);

}  // namespace bm::kin
