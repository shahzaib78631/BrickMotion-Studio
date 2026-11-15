#include "bm/audit.h"

#include <algorithm>
#include <chrono>
#include <ctime>
#include <set>
#include <unordered_set>
#include "bm/io.h"

namespace bm::audit {

Row loadRow(const std::filesystem::path& file, std::string id, const ldraw::Library& library, ldraw::PartCache& cache) {
  Row row;
  row.id = std::move(id);
  const auto started = std::chrono::steady_clock::now();
  try {
    const Model model = io::load(file, library, &cache);
    std::unordered_set<std::string> seen;
    for (const Piece& p : model.pieces())
      if (seen.insert(p.part).second) model.mesh(p.part, cache);
    row.pieces = static_cast<int>(model.pieces().size());
    for (const std::string& name : model.report().missing) {
      const bool part = name.size() > 4 && name.compare(name.size() - 4, 4, ".dat") == 0;
      if (part) row.unknownParts.push_back(name.substr(0, name.size() - 4));
      else row.missingSubmodels.push_back(name);
    }
    std::sort(row.unknownParts.begin(), row.unknownParts.end());
    std::sort(row.missingSubmodels.begin(), row.missingSubmodels.end());
    row.ok = true;
  } catch (const std::exception& e) {
    row.error = e.what();
    if (row.error.empty()) row.error = "error";
  } catch (...) {
    row.error = "unknown error";
  }
  row.loadMs = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - started).count();
  return row;
}

nlohmann::json toJson(const Row& row) {
  nlohmann::json j;
  j["id"] = row.id;
  j["engine"] = "native";
  j["ok"] = row.ok;
  j["error"] = row.ok ? nlohmann::json(nullptr) : nlohmann::json(row.error);
  j["pieces"] = row.pieces;
  j["unknownParts"] = row.unknownParts;
  j["missingSubmodels"] = row.missingSubmodels;
  j["loadMs"] = row.loadMs;
  return j;
}

nlohmann::json summarize(const std::vector<Row>& rows) {
  long pieces = 0, unknown = 0, missingSubs = 0, failed = 0;
  std::set<std::string> distinct;
  std::vector<double> times;
  for (const Row& r : rows) {
    if (!r.ok) {
      failed++;
      continue;
    }
    pieces += r.pieces;
    unknown += static_cast<long>(r.unknownParts.size());
    missingSubs += static_cast<long>(r.missingSubmodels.size());
    distinct.insert(r.unknownParts.begin(), r.unknownParts.end());
    times.push_back(r.loadMs);
  }
  std::sort(times.begin(), times.end());
  auto quantile = [&](double q) -> nlohmann::json {
    if (times.empty()) return nullptr;
    return times[std::min(times.size() - 1, static_cast<size_t>(q * static_cast<double>(times.size())))];
  };
  char date[16] = "";
  const std::time_t now = std::time(nullptr);
  std::strftime(date, sizeof date, "%Y-%m-%d", std::gmtime(&now));
  nlohmann::json s;
  s["engine"] = "native";
  s["date"] = date;
  s["models"] = rows.size();
  s["failed"] = failed;
  s["totals"] = {{"pieces", pieces}, {"unknownParts", unknown}, {"distinctUnknownParts", distinct.size()}, {"missingSubmodels", missingSubs}};
  s["p50"] = {{"loadMs", quantile(0.5)}};
  s["p95"] = {{"loadMs", quantile(0.95)}};
  return s;
}

}  // namespace bm::audit
