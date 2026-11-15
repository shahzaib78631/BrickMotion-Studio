#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <filesystem>
#include <nlohmann/json.hpp>
#include "bm/io.h"
#include "commands.h"

namespace bm::cli {
namespace fs = std::filesystem;

std::string option(const Args& args, std::string_view name, std::string fallback, bool& bad) {
  for (size_t i = 0; i < args.size(); i++)
    if (args[i] == name) {
      if (i + 1 >= args.size()) {
        bad = true;
        return fallback;
      }
      return std::string(args[i + 1]);
    }
  return fallback;
}

bool flag(const Args& args, std::string_view name) {
  for (std::string_view a : args)
    if (a == name) return true;
  return false;
}

std::string defaultLDrawDir() {
  if (const char* dir = std::getenv("BM_LDRAW_DIR")) return dir;
  std::error_code ec;
  for (fs::path at = fs::current_path(ec); !at.empty(); at = at.parent_path()) {
    if (fs::exists(at / "public" / "ldraw" / "LDConfig.ldr", ec)) return (at / "public" / "ldraw").string();
    if (at == at.root_path()) break;
  }
  return "";
}

int cmdLoad(const Args& args) {
  if (args.empty() || args[0].rfind("--", 0) == 0) {
    std::fprintf(stderr, "usage: bm load <file> [--json]\n");
    return kUsage;
  }
  const std::string ldraw = defaultLDrawDir();
  if (ldraw.empty()) {
    std::fprintf(stderr, "bm: no LDraw library found; set BM_LDRAW_DIR\n");
    return kFailure;
  }
  try {
    const auto t0 = std::chrono::steady_clock::now();
    const ldraw::Library library(ldraw);
    ldraw::PartCache cache(library, ldraw::PartCache::defaultDirectory());
    const auto t1 = std::chrono::steady_clock::now();
    const Model model = io::load(fs::path(std::string(args[0])), library, &cache);
    const Box b = model.bounds(cache);
    const auto t2 = std::chrono::steady_clock::now();
    const double indexMs = std::chrono::duration<double, std::milli>(t1 - t0).count();
    const double loadMs = std::chrono::duration<double, std::milli>(t2 - t1).count();
    const auto stats = cache.stats();
    if (flag(args, "--json")) {
      nlohmann::json j;
      j["file"] = std::string(args[0]);
      j["pieces"] = model.pieces().size();
      j["steps"] = model.stepCount();
      j["submodels"] = model.submodels().size();
      j["bounds"] = b.empty() ? nlohmann::json(nullptr) : nlohmann::json{{"min", {b.min.x, b.min.y, b.min.z}}, {"max", {b.max.x, b.max.y, b.max.z}}};
      j["missing"] = model.report().missing;
      j["cycles"] = model.report().cycles;
      j["skippedLines"] = model.report().skippedLines;
      j["indexMs"] = indexMs;
      j["loadMs"] = loadMs;
      j["cache"] = {{"disk", stats.diskHits}, {"flattened", stats.flattened}, {"rebuilt", stats.rebuilt}};
      std::printf("%s\n", j.dump(2).c_str());
    } else {
      std::printf("pieces     %zu\nsteps      %d\nsubmodels  %zu\n", model.pieces().size(), model.stepCount(), model.submodels().size());
      if (!b.empty()) std::printf("size       %.0f x %.0f x %.0f LDU\n", b.max.x - b.min.x, b.max.y - b.min.y, b.max.z - b.min.z);
      std::printf("missing    %zu%s\n", model.report().missing.size(), model.report().missing.empty() ? "" : ":");
      for (const std::string& name : model.report().missing) std::printf("  %s\n", name.c_str());
      for (const std::string& loop : model.report().cycles) std::printf("loop       %s\n", loop.c_str());
      if (model.report().skippedLines) std::printf("bad lines  %d\n", model.report().skippedLines);
      std::printf("library    %.0f ms to index\nload       %.0f ms (parts: %zu from cache, %zu built)\n", indexMs, loadMs, stats.diskHits, stats.flattened + stats.rebuilt);
    }
    return 0;
  } catch (const std::exception& e) {
    std::fprintf(stderr, "bm: %s\n", e.what());
    return kFailure;
  }
}

}  // namespace bm::cli
