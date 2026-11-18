#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <filesystem>
#include <optional>
#include "bm/collide/geometry_audit.h"
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
    std::fprintf(stderr, "usage: bm load <file> [--json] [--check-geometry] [--strict-geometry]\n");
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
    // Collision completeness is expensive on large models, so opt in explicitly.
    // Strict mode is meant for test automation; it does not change normal loads.
    const bool strict = flag(args, "--strict-geometry");
    const bool checkGeometry = strict || flag(args, "--check-geometry");
    std::optional<collide::GeometryAudit> geometry;
    if (checkGeometry) {
      collide::ShapeCache shapes;
      geometry = collide::auditGeometry(model, cache, shapes);
    }
    const auto t3 = std::chrono::steady_clock::now();
    const double auditMs = geometry ? std::chrono::duration<double, std::milli>(t3 - t2).count() : 0;
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
      if (model.report().studioCustomPartsAvailable)
        j["studioCustomPartSkippedLines"] = model.report().studioCustomPartSkippedLines;
      if (model.report().studioCustomPartsAvailable)
        j["studioCustomParts"] = {{"available", model.report().studioCustomPartsAvailable},
                                  {"loaded", model.report().studioCustomPartsLoaded}};
      if (geometry) {
        nlohmann::json issues = nlohmann::json::array();
        for (const auto& issue : geometry->issues)
          issues.push_back({{"part", issue.part}, {"instances", issue.instances},
                            {"triangles", issue.triangles}, {"modelScoped", issue.modelScoped},
                            {"noCollisionShape", issue.noCollisionShape},
                            {"missingDependencies", issue.missing}});
        j["geometryAudit"] = {{"structurallyComplete", geometry->structurallyComplete()},
                               {"distinctParts", geometry->distinctParts},
                               {"modelScopedParts", geometry->modelScopedParts},
                               {"partsWithoutCollisionShapes", geometry->partsWithoutCollisionShapes},
                               {"partsWithMissingDependencies", geometry->partsWithMissingDependencies},
                               {"malformedEmbeddedLines", geometry->malformedEmbeddedLines},
                               {"instantiatedTriangles", geometry->instantiatedTriangles},
                               {"issues", std::move(issues)}};
      }
      j["indexMs"] = indexMs;
      j["loadMs"] = loadMs;
      if (geometry) j["geometryAuditMs"] = auditMs;
      j["cache"] = {{"disk", stats.diskHits}, {"flattened", stats.flattened}, {"rebuilt", stats.rebuilt}};
      std::printf("%s\n", j.dump(2).c_str());
    } else {
      std::printf("pieces     %zu\nsteps      %d\nsubmodels  %zu\n", model.pieces().size(), model.stepCount(), model.submodels().size());
      if (!b.empty()) std::printf("size       %.0f x %.0f x %.0f LDU\n", b.max.x - b.min.x, b.max.y - b.min.y, b.max.z - b.min.z);
      std::printf("missing    %zu%s\n", model.report().missing.size(), model.report().missing.empty() ? "" : ":");
      for (const std::string& name : model.report().missing) std::printf("  %s\n", name.c_str());
      for (const std::string& loop : model.report().cycles) std::printf("loop       %s\n", loop.c_str());
      if (model.report().skippedLines) std::printf("bad lines  %d\n", model.report().skippedLines);
      if (model.report().studioCustomPartsAvailable) {
        std::printf("Studio ZIP %zu/%zu custom parts loaded\n", model.report().studioCustomPartsLoaded, model.report().studioCustomPartsAvailable);
        if (model.report().studioCustomPartSkippedLines)
          std::printf("Studio ZIP %zu malformed lines in imported custom parts\n", model.report().studioCustomPartSkippedLines);
      }
      if (geometry) {
        std::printf("geometry   %zu distinct parts, %zu model-scoped, %llu placed triangles\n",
                    geometry->distinctParts, geometry->modelScopedParts,
                    static_cast<unsigned long long>(geometry->instantiatedTriangles));
        std::printf("            %zu part types with missing dependencies; %zu without collision shapes\n",
                    geometry->partsWithMissingDependencies, geometry->partsWithoutCollisionShapes);
        if (geometry->malformedEmbeddedLines) std::printf("            %zu malformed embedded geometry lines\n", geometry->malformedEmbeddedLines);
        size_t shown = 0;
        for (const auto& issue : geometry->issues) {
          if (shown++ >= 30) { std::printf("  ... further geometry issues omitted; use --json\n"); break; }
          std::printf("  %s (%zu placements):%s", issue.part.c_str(), issue.instances,
                      issue.noCollisionShape ? " no collision triangles" : "");
          if (!issue.missing.empty()) {
            std::printf(" missing");
            for (const std::string& dep : issue.missing) std::printf(" %s", dep.c_str());
          }
          std::printf("\n");
        }
      }
      std::printf("library    %.0f ms to index\nload       %.0f ms\n", indexMs, loadMs);
      if (geometry) std::printf("geom audit %.0f ms\n", auditMs);
      std::printf("cache      %zu from disk, %zu flattened/builds (including audit if enabled)\n", stats.diskHits, stats.flattened + stats.rebuilt);
    }
    if (strict && !geometry->structurallyComplete()) {
      std::fprintf(stderr, "bm: strict geometry check failed; inspect geometryAudit issues and malformed embedded lines\n");
      return kFailure;
    }
    return 0;
  } catch (const std::exception& e) {
    std::fprintf(stderr, "bm: %s\n", e.what());
    return kFailure;
  }
}

}  // namespace bm::cli
