#include <algorithm>
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <filesystem>
#include "bm/connect/graph.h"
#include "bm/connect/studio.h"
#include "bm/io.h"
#include <map>
#include "bm/kin/mobility.h"
#include "bm/kin/system.h"
#include "bm/kin/truth.h"
#include <fstream>
#include "commands.h"

namespace bm::cli {
namespace fs = std::filesystem;

int cmdMechanisms(const Args& args) {
  bool bad = false;
  const std::string truthPath = option(args, "--truth", "", bad);
  if (bad || args.empty() || args[0].rfind("--", 0) == 0) {
    std::fprintf(stderr, "usage: bm mechanisms <file> [--truth <expected.json>] [--no-travel] [--links] [--all] [--no-studio]\n");
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
    const auto solveStart = std::chrono::steady_clock::now();
    const kin::Mobility mob = kin::mobility(sys);
    const double solveMs = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - solveStart).count();
    size_t locals = 0;
    for (const kin::Freedom& f : mob.freedoms) locals += f.local;
    std::printf("freedoms      %zu (%zu of single bodies on one link, %zu others)\nsolved        %zu bodies in %.0f ms%s%s\n", mob.freedoms.size(), locals, mob.freedoms.size() - locals, mob.solvedBodies, solveMs,
                mob.solved ? "" : "; NOT SOLVED: ", mob.reason.c_str());
    auto describe = [&](uint32_t body) {
      std::string text = model.pieces()[sys.pieces[body].front()].part;
      if (text.size() > 4) text.resize(text.size() - 4);
      if (sys.size[body] > 1) text += "+" + std::to_string(sys.size[body] - 1);
      return text;
    };
    if (!truthPath.empty()) {
      std::ifstream in(truthPath);
      const nlohmann::json expected = nlohmann::json::parse(in, nullptr, false);
      if (!expected.is_object()) {
        std::fprintf(stderr, "bm: cannot read %s\n", truthPath.c_str());
        return kFailure;
      }
      const kin::TruthScore score = kin::score(model, graph, sys, mob, cache, expected);
      std::printf("truth         %d of %d scored checks (%d not scored, %d unresolved)\n", score.hit, score.scored(), score.notScored, score.unresolved);
      for (const kin::TruthLine& line : score.lines)
        std::printf("  %-10s %-11s %s%s%s\n", kin::name(line.result), line.type.c_str(), line.label.c_str(), line.detail.empty() ? "" : "  -- ", line.detail.c_str());
      return 0;
    }
    size_t shown = 0;
    for (size_t i = 0; i < mob.freedoms.size(); i++) {
      const kin::Freedom& f = mob.freedoms[i];
      if (f.local && !flag(args, "--all")) continue;
      if (shown++ >= 40) break;
      size_t pieces = 0;
      for (uint32_t b : f.bodies) pieces += sys.size[b];
      std::printf("  #%zu moves %zu bodies (%zu pieces):", i, f.bodies.size(), pieces);
      // The bodies with the most pieces say most about what it is.
      std::vector<uint32_t> order = f.bodies;
      std::sort(order.begin(), order.end(), [&](uint32_t x, uint32_t y) { return sys.size[x] > sys.size[y]; });
      for (size_t k = 0; k < order.size() && k < 6; k++) std::printf(" %s", describe(order[k]).c_str());
      std::printf("%s\n", order.size() > 6 ? " ..." : "");
      for (const kin::Gearing& g : sys.gearings) {
        const auto r = kin::ratio(f, g.a, g.b);
        if (!r || !mob.moves[g.b] || kin::twistOf(f, g.b).angular == Vec3{}) continue;
        if (r->exact) std::printf("      %s %dT : %s %dT   %d/%d\n", describe(g.a).c_str(), g.mesh.teethA, describe(g.b).c_str(), g.mesh.teethB, r->num, r->den);
        else std::printf("      %s %dT : %s %dT   %.4f\n", describe(g.a).c_str(), g.mesh.teethA, describe(g.b).c_str(), g.mesh.teethB, r->value);
      }
    }
    return 0;
  } catch (const std::exception& e) {
    std::fprintf(stderr, "bm: %s\n", e.what());
    return kFailure;
  }
}

}  // namespace bm::cli
