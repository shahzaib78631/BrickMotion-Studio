#include <cstdio>
#include <cstdlib>
#include <filesystem>
#include <map>
#include "bm/connect/graph.h"
#include "bm/connect/studio.h"
#include "bm/io.h"
#include "bm/stable/stability.h"
#include "commands.h"

namespace bm::cli {
namespace fs = std::filesystem;

int cmdStability(const Args& args) {
  if (args.empty() || args[0].rfind("--", 0) == 0) {
    std::fprintf(stderr, "usage: bm stability <file> [--no-studio]\n");
    return kUsage;
  }
  const std::string ldraw = defaultLDrawDir();
  if (ldraw.empty()) {
    std::fprintf(stderr, "bm: no LDraw library found; set BM_LDRAW_DIR\n");
    return kFailure;
  }
  const fs::path repo = fs::path(ldraw).parent_path().parent_path();
  const char* shadowEnv = std::getenv("BM_SHADOW_DIR");
  try {
    const ldraw::Library library(ldraw);
    const connect::ShadowLibrary shadow(shadowEnv ? fs::path(shadowEnv) : repo / "vendor" / "LDCadShadowLibrary");
    connect::ConnectorDb db(library, shadow);
    const connect::StudioLibrary studio(flag(args, "--no-studio") ? fs::path() : connect::StudioLibrary::defaultDirectory());
    db.setStudio(&studio);
    kin::GearDb gears;
    loadEngineData(repo, db, gears);
    ldraw::PartCache cache(library, ldraw::PartCache::defaultDirectory());
    const Model model = io::load(fs::path(std::string(args[0])), library, &cache);
    const connect::Graph graph = connect::buildGraph(model, db, &gears);
    const stable::Result r = stable::check(model, graph, cache);
    std::printf("pieces        %zu\nweight        %.0f g\ngroups        %zu\nstands        %s\n", model.pieces().size(), r.mass, r.groups.size(), r.stands ? "yes" : "no");
    std::printf("margin        %.1f LDU from the centre of mass to the edge of the footprint\n", r.margin);
    for (uint32_t gi : r.tipping) {
      const stable::Group& g = r.groups[gi];
      std::printf("  tips        %zu pieces (%.0f g), first %s: centre of mass %.1f LDU outside what it stands on\n", g.pieces.size(), g.mass, model.pieces()[g.pieces.front()].part.c_str(), -g.margin);
    }
    if (!r.unsupported.empty()) {
      std::map<std::string, int> parts;
      for (uint32_t i : r.unsupported) parts[model.pieces()[i].part]++;
      std::printf("unsupported   %zu pieces reach the floor through no joint:\n", r.unsupported.size());
      int shown = 0;
      for (const auto& [part, count] : parts) {
        if (shown++ >= 20) break;
        std::printf("  %5d  %s\n", count, part.c_str());
      }
    }
    return 0;
  } catch (const std::exception& e) {
    std::fprintf(stderr, "bm: %s\n", e.what());
    return kFailure;
  }
}

}  // namespace bm::cli
