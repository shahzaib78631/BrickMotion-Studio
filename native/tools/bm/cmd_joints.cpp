#include <algorithm>
#include <cstdio>
#include <cstdlib>
#include <filesystem>
#include <map>
#include "bm/connect/graph.h"
#include "bm/io.h"
#include "commands.h"

namespace bm::cli {
namespace fs = std::filesystem;

int cmdJoints(const Args& args) {
  bool bad = false;
  const std::string why = option(args, "--why", "", bad);
  if (bad || args.empty() || args[0].rfind("--", 0) == 0) {
    std::fprintf(stderr, "usage: bm joints <file> [--why <part>]\n");
    return kUsage;
  }
  const std::string ldraw = defaultLDrawDir();
  if (ldraw.empty()) {
    std::fprintf(stderr, "bm: no LDraw library found; set BM_LDRAW_DIR\n");
    return kFailure;
  }
  const char* shadowEnv = std::getenv("BM_SHADOW_DIR");
  const fs::path shadowDir = shadowEnv ? fs::path(shadowEnv) : fs::path(ldraw).parent_path().parent_path() / "vendor" / "LDCadShadowLibrary";
  try {
    const ldraw::Library library(ldraw);
    const connect::ShadowLibrary shadow(shadowDir);
    connect::ConnectorDb db(library, shadow);
    ldraw::PartCache cache(library, ldraw::PartCache::defaultDirectory());
    const Model model = io::load(fs::path(std::string(args[0])), library, &cache);
    const connect::Graph g = connect::buildGraph(model, db);
    int kinds[5] = {};
    for (const connect::Connection& c : g.connections) kinds[static_cast<int>(c.joint.kind)]++;
    const double n = std::max<size_t>(1, model.pieces().size());
    std::printf("pieces        %zu\nconnections   %zu\n", model.pieces().size(), g.connections.size());
    for (int k = 0; k < 5; k++) std::printf("  %-12s%d\n", connect::name(static_cast<connect::JointKind>(k)), kinds[k]);
    std::printf("groups        %u (largest holds %u pieces, %.1f%%)\nrigid bodies  %u\nattached      %u (%.1f%%)\nno connectors %u\n", g.groups, g.largestGroup, 100.0 * g.largestGroup / n, g.bodies, g.attached,
                100.0 * g.attached / n, g.withoutConnectors);

    std::vector<uint8_t> connected(model.pieces().size(), 0);
    for (const connect::Connection& c : g.connections) connected[c.a] = connected[c.b] = 1;
    std::map<std::string, int> none, unmated;
    for (size_t i = 0; i < model.pieces().size(); i++)
      if (!connected[i]) (g.hasConnectors[i] ? unmated : none)[model.pieces()[i].part]++;
    auto top = [](const char* title, const std::map<std::string, int>& table) {
      std::vector<std::pair<int, std::string>> list;
      for (const auto& [part, count] : table) list.emplace_back(count, part);
      std::sort(list.rbegin(), list.rend());
      if (list.empty()) return;
      std::printf("%s\n", title);
      for (size_t i = 0; i < list.size() && i < 20; i++) std::printf("  %5d  %s\n", list[i].first, list[i].second.c_str());
    };
    top("unjoined, part has no connector data:", none);
    top("unjoined, has connectors but nothing mated:", unmated);

    if (!why.empty()) {
      std::string part = ldraw::normalizeName(why);
      if (part.find('.') == std::string::npos) part += ".dat";
      int shown = 0;
      for (uint32_t i = 0; i < model.pieces().size() && shown < 6; i++) {
        if (connected[i] || model.pieces()[i].part != part) continue;
        shown++;
        std::printf("why %s (%s) joined nothing:\n", part.c_str(), model.pieces()[i].id.c_str());
        const auto misses = connect::nearMisses(model, db, i);
        if (misses.empty()) std::printf("  nothing with connectors within 30 LDU\n");
        for (const connect::NearMiss& m : misses) std::printf("  %-22s %5.1f away: %s\n", model.pieces()[m.other].part.c_str(), m.distance, m.reason.c_str());
      }
      if (!shown) std::printf("no unjoined piece of %s\n", part.c_str());
    }
    return 0;
  } catch (const std::exception& e) {
    std::fprintf(stderr, "bm: %s\n", e.what());
    return kFailure;
  }
}

}  // namespace bm::cli
