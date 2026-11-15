#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <sstream>
#include "bm/audit.h"
#include "bm/jobs.h"
#include "commands.h"

namespace bm::cli {
namespace fs = std::filesystem;

int cmdAudit(const Args& args) {
  bool bad = false;
  const std::string manifestPath = option(args, "--manifest", "", bad);
  const std::string tier = option(args, "--tier", "smoke", bad);
  const std::string outDir = option(args, "--out", "", bad);
  const std::string threadsText = option(args, "--threads", "0", bad);
  const std::string cacheDir = option(args, "--cache", ldraw::PartCache::defaultDirectory().string(), bad);
  char* end = nullptr;
  const long threads = std::strtol(threadsText.c_str(), &end, 10);
  if (bad || manifestPath.empty() || (tier != "smoke" && tier != "full") || *end || threads < 0 || threads > 1024) {
    std::fprintf(stderr, "usage: bm audit --manifest <manifest.json> [--tier smoke|full] [--out <dir>] [--threads N] [--cache <dir>]\n");
    return kUsage;
  }

  nlohmann::json manifest;
  try {
    std::ifstream in(manifestPath);
    if (!in) throw std::runtime_error("cannot open it");
    in >> manifest;
    if (!manifest.is_array()) throw std::runtime_error("it is not a list");
  } catch (const std::exception& e) {
    std::fprintf(stderr, "bm: cannot read manifest %s: %s\n", manifestPath.c_str(), e.what());
    return kFailure;
  }

  // The manifest lives at <repo>/native/corpus/manifest.json; its paths are relative to the
  // repository, or to BM_DATA_DIR for the corpora kept outside it.
  std::error_code ec;
  const fs::path repo = fs::weakly_canonical(fs::path(manifestPath), ec).parent_path().parent_path().parent_path();
  const char* dataEnv = std::getenv("BM_DATA_DIR");
  const fs::path dataDir = dataEnv ? dataEnv : "/Users/mac/Projects/BrickMotion-Data";
  const char* ldrawEnv = std::getenv("BM_LDRAW_DIR");
  const fs::path ldrawDir = ldrawEnv ? fs::path(ldrawEnv) : repo / "public" / "ldraw";
  if (!fs::exists(ldrawDir / "LDConfig.ldr", ec)) {
    std::fprintf(stderr, "bm: no LDraw library at %s; set BM_LDRAW_DIR\n", ldrawDir.c_str());
    return kFailure;
  }

  const char* shadowEnv = std::getenv("BM_SHADOW_DIR");
  const fs::path shadowDir = shadowEnv ? fs::path(shadowEnv) : repo / "vendor" / "LDCadShadowLibrary";

  struct Entry {
    std::string id;
    fs::path file;
  };
  std::vector<Entry> entries;
  for (const auto& e : manifest) {
    if (!e.is_object() || !e.contains("id") || !e.contains("path") || !e["id"].is_string() || !e["path"].is_string()) continue;
    if (tier == "smoke" && e.value("tier", "full") != "smoke") continue;
    const std::string source = e.value("source", "");
    const bool external = source == "omr" || source == "bricknet" || source == "moc";
    entries.push_back({e["id"].get<std::string>(), (external ? dataDir : repo) / e["path"].get<std::string>()});
  }

  const auto started = std::chrono::steady_clock::now();
  const ldraw::Library library(ldrawDir);
  ldraw::PartCache cache(library, cacheDir);
  const connect::ShadowLibrary shadow(shadowDir);
  connect::ConnectorDb connectors(library, shadow);
  {
    std::ifstream seats(repo / "native" / "data" / "wheel-seats.json");
    std::stringstream text;
    text << seats.rdbuf();
    connect::loadWheelSeats(text.str(), connectors);
  }
  if (shadow.size() == 0) std::fprintf(stderr, "bm: no shadow library at %s; no joints will be found (set BM_SHADOW_DIR)\n", shadowDir.c_str());
  std::vector<audit::Row> rows(entries.size());
  JobPool pool(static_cast<unsigned>(threads));
  size_t printed = 0;
  pool.parallelFor(
      entries.size(), [&](size_t i) { rows[i] = audit::loadRow(entries[i].file, entries[i].id, library, cache, &connectors); }, nullptr,
      [&](size_t done, size_t total) {
        if (done != printed) {
          printed = done;
          std::printf("::progress %zu/%zu\n", done, total);
          std::fflush(stdout);
        }
      });
  const double seconds = std::chrono::duration<double>(std::chrono::steady_clock::now() - started).count();

  nlohmann::json summary = audit::summarize(rows);
  summary["tier"] = tier;
  summary["threads"] = pool.threads();
  summary["wallSeconds"] = seconds;
  const auto stats = cache.stats();
  summary["parts"] = {{"fromCache", stats.diskHits}, {"flattened", stats.flattened}, {"rebuilt", stats.rebuilt}};
  if (!outDir.empty()) {
    fs::create_directories(outDir, ec);
    std::ofstream rowsOut(fs::path(outDir) / "rows.jsonl");
    for (const audit::Row& r : rows) rowsOut << audit::toJson(r).dump() << "\n";
    std::ofstream(fs::path(outDir) / "summary.json") << summary.dump(2) << "\n";
    // Which parts account for the pieces that joined nothing: the work list for connector data.
    auto ranked = [&](std::map<std::string, int> audit::Row::*field) {
      std::map<std::string, int> total;
      for (const audit::Row& r : rows)
        for (const auto& [part, count] : r.*field) total[part] += count;
      std::vector<std::pair<std::string, int>> list(total.begin(), total.end());
      std::sort(list.begin(), list.end(), [](const auto& a, const auto& b) { return a.second != b.second ? a.second > b.second : a.first < b.first; });
      long pieces = 0;
      for (const auto& e : list) pieces += e.second;
      nlohmann::json j;
      j["parts"] = list.size();
      j["pieces"] = pieces;
      j["top"] = nlohmann::json::array();
      for (size_t i = 0; i < list.size() && i < 400; i++) j["top"].push_back({list[i].first, list[i].second});
      return j;
    };
    nlohmann::json unjoined;
    unjoined["noConnectors"] = ranked(&audit::Row::noConnectorParts);
    unjoined["connectorsButNothingMated"] = ranked(&audit::Row::unmatedParts);
    std::ofstream(fs::path(outDir) / "unjoined-parts.json") << unjoined.dump(1) << "\n";
    if (!rowsOut) {
      std::fprintf(stderr, "bm: cannot write to %s\n", outDir.c_str());
      return kFailure;
    }
  }
  std::printf("%s\n", summary.dump(2).c_str());
  for (const audit::Row& r : rows)
    if (!r.ok) std::printf("failed  %s: %s\n", r.id.c_str(), r.error.c_str());
  return 0;
}

}  // namespace bm::cli
