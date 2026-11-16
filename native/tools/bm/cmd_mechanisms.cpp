#include <algorithm>
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <filesystem>
#include "bm/connect/graph.h"
#include "bm/connect/studio.h"
#include "bm/io.h"
#include "bm/kin/system.h"
#include "commands.h"

namespace bm::cli {
namespace fs = std::filesystem;

int cmdMechanisms(const Args& args) {
  if (args.empty() || args[0].rfind("--", 0) == 0) {
    std::fprintf(stderr, "usage: bm mechanisms <file> [--no-travel] [--links] [--no-studio]\n");
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
    collide::ShapeCache shapes;
    const Model model = io::load(fs::path(std::string(args[0])), library, &cache);
    const connect::Graph graph = connect::buildGraph(model, db, &gears);
    const auto started = std::chrono::steady_clock::now();
    kin::SystemOptions options;
    options.testTravel = !flag(args, "--no-travel");
    const kin::System sys = kin::buildSystem(model, graph, &cache, &shapes, options);
    const double systemMs = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - started).count();

    int kinds[connect::kJointKinds] = {};
    for (const kin::Link& l : sys.links) kinds[static_cast<int>(l.kind)]++;
    std::printf("pieces        %zu\nbodies        %u (the graph's fixed joints alone give %u)\nground        %u pieces\nlinks         %zu\n", model.pieces().size(), sys.bodies, graph.bodies, sys.bodies ? sys.size[sys.ground] : 0,
                sys.links.size());
    for (int k = 0; k < connect::kJointKinds; k++)
      if (kinds[k]) std::printf("  %-12s%d\n", connect::name(static_cast<connect::JointKind>(k)), kinds[k]);
    std::printf("gearings      %zu (of %zu meshes)\nheld slides   %zu\nsystem        %.0f ms\n", sys.gearings.size(), graph.meshes.size(), sys.heldSlides.size(), systemMs);
    if (flag(args, "--links")) {
      auto label = [&](uint32_t body) {
        std::string text = model.pieces()[sys.pieces[body].front()].part;
        if (sys.size[body] > 1) text += " +" + std::to_string(sys.size[body] - 1);
        return text;
      };
      for (const kin::Link& l : sys.links)
        std::printf("  %-12s %-22s %-22s at %.0f %.0f %.0f along %.2f %.2f %.2f\n", connect::name(l.kind), label(l.a).c_str(), label(l.b).c_str(), l.point.x, l.point.y, l.point.z, l.axis.x, l.axis.y, l.axis.z);
    }
    return 0;
  } catch (const std::exception& e) {
    std::fprintf(stderr, "bm: %s\n", e.what());
    return kFailure;
  }
}

}  // namespace bm::cli
