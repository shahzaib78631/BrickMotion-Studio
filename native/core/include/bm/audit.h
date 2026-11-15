#pragma once
// Corpus audit: one scoreboard row per model, in the format shared with the web baseline.
#include <filesystem>
#include <string>
#include <vector>
#include <nlohmann/json.hpp>
#include "bm/ldraw/library.h"
#include "bm/ldraw/part_cache.h"

namespace bm::audit {

struct Row {
  std::string id;
  bool ok = false;      ///< the model loaded
  std::string error;    ///< why not, when !ok
  int pieces = 0;
  std::vector<std::string> unknownParts;      ///< part ids (no ".dat") that are not in the library, sorted
  std::vector<std::string> missingSubmodels;  ///< sorted
  double loadMs = 0;    ///< parse, expand and fetch every distinct part's mesh
};

/// Loads one model and every distinct part it uses. Never throws: a failure is a row.
Row loadRow(const std::filesystem::path& file, std::string id, const ldraw::Library& library, ldraw::PartCache& cache);

nlohmann::json toJson(const Row& row);

/// Totals and load-time percentiles over the rows that loaded.
nlohmann::json summarize(const std::vector<Row>& rows);

}  // namespace bm::audit
