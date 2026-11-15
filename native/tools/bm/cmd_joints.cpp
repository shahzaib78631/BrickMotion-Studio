#include <algorithm>
#include <cstdio>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <sstream>
#include <map>
#include "bm/connect/graph.h"
#include "bm/io.h"
#include "bm/connect/studio.h"
#include "commands.h"

namespace bm::cli {
namespace fs = std::filesystem;

int cmdJoints(const Args& args) {
  bool bad = false;
  const std::string why = option(args, "--why", "", bad);
  if (bad || args.empty() || args[0].rfind("--", 0) == 0) {
    std::fprintf(stderr, "usage: bm joints <file> [--why <part>] [--groups] [--no-studio]\n");
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
    const connect::StudioLibrary studio(flag(args, "--no-studio") ? fs::path() : connect::StudioLibrary::defaultDirectory());
    db.setStudio(&studio);
    {
      std::ifstream seats(fs::path(ldraw).parent_path().parent_path() / "native" / "data" / "wheel-seats.json");
      std::stringstream text;
      text << seats.rdbuf();
      connect::loadWheelSeats(text.str(), db);
      std::ifstream joints(fs::path(ldraw).parent_path().parent_path() / "native" / "data" / "bricknet-joints.json");
      std::stringstream jointText;
      jointText << joints.rdbuf();
      connect::loadBricknetJoints(jointText.str(), db);
    }
    ldraw::PartCache cache(library, ldraw::PartCache::defaultDirectory());
    const Model model = io::load(fs::path(std::string(args[0])), library, &cache);
    const connect::Graph g = connect::buildGraph(model, db);
    int kinds[connect::kJointKinds] = {};
    for (const connect::Connection& c : g.connections) kinds[static_cast<int>(c.joint.kind)]++;
    const double n = std::max<size_t>(1, model.pieces().size());
    std::printf("pieces        %zu\nconnections   %zu\n", model.pieces().size(), g.connections.size());
    for (int k = 0; k < connect::kJointKinds; k++) std::printf("  %-12s%d\n", connect::name(static_cast<connect::JointKind>(k)), kinds[k]);
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

    if (flag(args, "--groups")) {
      // The largest groups, what they are made of, and what one of their pieces nearly joined.
      std::map<uint32_t, std::vector<uint32_t>> members;
      for (uint32_t i = 0; i < model.pieces().size(); i++) members[g.group[i]].push_back(i);
      std::vector<const std::vector<uint32_t>*> order;
      for (const auto& [id, list] : members) order.push_back(&list);
      std::sort(order.begin(), order.end(), [](const auto* a, const auto* b) { return a->size() > b->size(); });
      for (size_t k = 0; k < order.size() && k < 8; k++) {
        std::map<std::string, int> parts;
        for (uint32_t i : *order[k]) parts[model.pieces()[i].part]++;
        std::vector<std::pair<int, std::string>> list;
        for (const auto& [part, count] : parts) list.emplace_back(count, part);
        std::sort(list.rbegin(), list.rend());
        std::printf("group %zu: %zu pieces:", k + 1, order[k]->size());
        for (size_t i = 0; i < list.size() && i < 6; i++) std::printf(" %s x%d", list[i].second.c_str(), list[i].first);
        std::printf("\n");
        if (k == 0) continue;
        // Near misses from this group to pieces outside it.
        int shown = 0;
        for (uint32_t i : *order[k]) {
          for (const connect::NearMiss& m : connect::nearMisses(model, db, i, 12.0, 8)) {
            if (g.group[m.other] == g.group[i] || shown >= 4) continue;
            std::printf("    %s nearly joins %s (%.1f away): %s\n", model.pieces()[i].part.c_str(), model.pieces()[m.other].part.c_str(), m.distance, m.reason.c_str());
            shown++;
          }
          if (shown >= 4) break;
        }
      }
    }

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
