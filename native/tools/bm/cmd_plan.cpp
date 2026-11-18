#include <algorithm>
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <functional>
#include <map>
#include "bm/connect/graph.h"
#include "bm/connect/studio.h"
#include "bm/io.h"
#include "bm/plan/certify.h"
#include "bm/plan/plan.h"
#include "bm/plan/timeline.h"
#include "bm/plan/truth.h"
#include "commands.h"

namespace bm::cli {
namespace fs = std::filesystem;

int cmdPlan(const Args& args) {
  bool bad = false;
  const std::string explain = option(args, "--explain", "", bad);
  const std::string outPath = option(args, "--out", "", bad);
  const std::string budget = option(args, "--budget", "0", bad);
  const std::string threads = option(args, "--threads", "0", bad);
  const std::string truthPath = option(args, "--truth", "", bad);
  if (bad || args.empty() || args[0].rfind("--", 0) == 0) {
    std::fprintf(stderr, "usage: bm plan <file> [--truth <insertion-truth.json>] [--explain <part>] [--out <plan.json>] [--json] [--budget <seconds>] [--threads N] [--no-certify] [--no-studio]\n");
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
    JobPool pool(static_cast<unsigned>(std::max(0, std::atoi(threads.c_str()))));
    plan::Options options;
    options.pool = &pool;
    options.budgetSeconds = std::atof(budget.c_str());
    const plan::Plan plan = plan::plan(model, graph, cache, shapes, options);

    std::map<std::string, int> flags;
    int subMoves = 0, units = 0;
    std::function<void(const plan::Plan&, bool)> count = [&](const plan::Plan& p, bool top) {
      for (const plan::Move& m : p.moves) {
        flags[plan::name(m.flag)]++;
        if (!top) subMoves++;
        if (m.unit.pieces.size() > 1) units++;
      }
      for (const plan::Plan& s : p.subs) count(s, false);
    };
    count(plan, true);
    std::printf("pieces        %zu\ngroups        %u\nmoves         %zu (and %d inside %d units built first)\nplan          %.0f ms, %zu extractions%s\n", model.pieces().size(), graph.groups, plan.moves.size(), subMoves, units, plan.planMs, plan.extractions,
                plan.complete ? "" : "; NOT COMPLETE");
    for (const auto& [name, n] : flags) std::printf("  %-18s%d\n", name.c_str(), n);
    plan::Certificate certificate;
    const bool certifyIt = !flag(args, "--no-certify");
    if (certifyIt) {
      const auto started = std::chrono::steady_clock::now();
      certificate = plan::certify(model, graph, cache, shapes, plan);
      std::printf("certified     %d of %d moves (%.0f ms; flights checked along their length)\n  floating    %d\n  crossings   %d\n  off axis    %d\n  flagged     %d (of them unjoined in the file: %d)\n", certificate.certified, certificate.total,
                  std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - started).count(), certificate.floating, certificate.crossings, certificate.offAxis, certificate.flagged, certificate.unjoined);
      const plan::Timeline played = plan::buildTimeline(model, cache, plan);
      const plan::PlayCheck play = plan::certifyPlay(model, graph, cache, shapes, plan, played);
      std::printf("played        %d flights: crossings %d, under floor %d\n  upward      %d\n  inversions  %d\n  strict      %d (every frame shown, turns included, nothing let off but a piece's own mates at its seat)\n", play.flights, play.crossings, play.underFloor, play.upward, play.inversions, play.strictCrossings);
      for (uint32_t fi : play.crossed) {
        const plan::Flight& f = played.flights[fi];
        const Piece& a = model.pieces()[f.pieces.empty() ? plan.moves[f.move].unit.pieces.front() : f.pieces.front()];
        std::printf("    crossing: %s %s%s depth %d\n", a.part.c_str(), a.id.c_str(), f.pieces.size() > 1 ? " (+more)" : "", f.depth);
      }
      for (uint32_t fi : play.under) {
        const plan::Flight& f = played.flights[fi];
        const Piece& a = model.pieces()[f.pieces.empty() ? plan.moves[f.move].unit.pieces.front() : f.pieces.front()];
        std::printf("    under floor: %s %s depth %d insertion %.2f %.2f %.2f\n", a.part.c_str(), a.id.c_str(), f.depth, f.insertion.x, f.insertion.y, f.insertion.z);
      }
      {
        int byLeg[3] = {0, 0, 0};
        for (const plan::PlayCheck::Strict& c : play.strict) byLeg[static_cast<int>(c.leg)]++;
        std::printf("  strict by leg: transit %d, path %d, seat %d\n", byLeg[0], byLeg[1], byLeg[2]);
      }
      for (size_t k = 0; k < play.strict.size() && k < 20; k++) {
        const plan::PlayCheck::Strict& c = play.strict[k];
        const Piece& a = model.pieces()[c.piece];
        const Piece& b = model.pieces()[c.other];
        static const char* legs[] = {"transit", "path", "seat"};
        std::printf("    frame %.2f %s: %s %s through %s %s%s\n", c.at, legs[static_cast<int>(c.leg)], a.part.c_str(), a.id.c_str(), b.part.c_str(), b.id.c_str(), played.flights[c.flight].depth > 0 ? " (in a unit's own build)" : "");
      }
    }
    // The first moves that are not certified, with why.
    int shown = 0;
    for (size_t i = 0; i < plan.moves.size() && shown < 20; i++) {
      const plan::Move& m = plan.moves[i];
      const bool fine = certifyIt ? certificate.moves[i].certified() : m.flag == plan::Flag::None;
      if (fine) continue;
      const Piece& p = model.pieces()[m.unit.pieces.front()];
      std::string why = plan::name(m.flag);
      if (m.flag == plan::Flag::None && certifyIt) {
        const plan::MoveCheck& c = certificate.moves[i];
        why = std::string(c.joined ? "" : "floating ") + (c.clear ? "" : "crossing ") + (c.alongConnector ? "" : "off-axis");
        if (c.crossed != UINT32_MAX) why += " (" + model.pieces()[c.crossed].part + ")";
      }
      std::printf("  #%zu %s%s at %.0f %.0f %.0f: %s%s%s\n", i, p.part.c_str(), m.unit.pieces.size() > 1 ? (" +" + std::to_string(m.unit.pieces.size() - 1)).c_str() : "", p.world.t.x, p.world.t.y, p.world.t.z, why.c_str(),
                  m.blocker != UINT32_MAX ? ", in the way: " : "", m.blocker != UINT32_MAX ? model.pieces()[m.blocker].part.c_str() : "");
      shown++;
    }
    if (!truthPath.empty()) {
      std::ifstream in(truthPath);
      const nlohmann::json doc = nlohmann::json::parse(in, nullptr, false);
      nlohmann::json mine = nlohmann::json::array();
      const std::string file = fs::path(std::string(args[0])).filename().string();
      if (doc.is_object() && doc.contains("cases") && doc["cases"].is_array())
        for (const nlohmann::json& c : doc["cases"])
          if (c.is_object() && c.contains("file") && c["file"].is_string() && fs::path(c["file"].get<std::string>()).filename().string() == file) mine.push_back(c);
      const plan::InsertionScore score = plan::scoreInsertion(model, cache, plan, mine);
      std::printf("insertion     %d of %d hand-checked cases (%d unresolved)\n", score.hit, score.hit + score.missing, score.unresolved);
      for (const plan::InsertionLine& line : score.lines)
        std::printf("  %-10s %s%s%s\n", line.result == plan::InsertionLine::Result::Hit ? "hit" : line.result == plan::InsertionLine::Result::Missing ? "missing" : "unresolved", line.id.c_str(), line.detail.empty() ? "" : "  -- ", line.detail.c_str());
    }
    if (!explain.empty()) {
      std::string part = ldraw::normalizeName(explain);
      if (part.size() < 4 || part.compare(part.size() - 4, 4, ".dat") != 0) part += ".dat";
      const collide::World world(model, cache, shapes);
      const plan::Context ctx(model, graph, world);
      Box bounds;
      for (uint32_t i = 0; i < model.pieces().size(); i++) bounds.merge(world.box(i));
      for (uint32_t i = 0; i < model.pieces().size(); i++) {
        if (model.pieces()[i].part != part) continue;
        const Vec3 at = model.pieces()[i].world.t;
        std::printf("explain %s at %.0f %.0f %.0f, with everything else in place:\n", part.c_str(), at.x, at.y, at.z);
        for (uint32_t ci : ctx.connectionsOf[i]) {
          const connect::Connection& c = graph.connections[ci];
          const uint32_t other = c.a == i ? c.b : c.a;
          for (uint32_t k = 0; k < c.zoneCount; k++) {
            connect::Release r = graph.releases[c.firstZone + k];
            if (c.a == i) r.axis = -r.axis;
            static const char* kinds[] = {"along", "either way along", "across", "any way"};
            std::printf("  held by %-14s leaves %s %.2f %.2f %.2f, travel %.1f%s\n", model.pieces()[other].part.c_str(), kinds[static_cast<int>(r.kind)], r.axis.x, r.axis.y, r.axis.z, r.travel, r.orAlong ? " (or along the bar)" : "");
          }
        }
        const std::vector<plan::Leave> leaves = plan::leaveDirections(ctx, plan::Unit{{i}}, nullptr);
        for (const plan::Leave& l : leaves) std::printf("  may leave along %.2f %.2f %.2f (travel %.1f)\n", l.direction.x, l.direction.y, l.direction.z, l.travel);
        const plan::Extraction e = plan::extract(ctx, plan::Unit{{i}}, nullptr, bounds);
        std::printf("  now: %s%s%s\n", e.ok ? "leaves" : plan::name(e.why), e.blocker != UINT32_MAX ? ", in the way: " : "", e.blocker != UINT32_MAX ? model.pieces()[e.blocker].part.c_str() : "");
      }
    }
    if (flag(args, "--json") || !outPath.empty()) {
      const nlohmann::json j = plan::toJson(plan, certifyIt ? &certificate : nullptr, model);
      if (!outPath.empty()) {
        std::ofstream out(outPath);
        out << j.dump(1) << "\n";
        std::printf("wrote         %s\n", outPath.c_str());
      } else {
        std::printf("%s\n", j.dump(1).c_str());
      }
    }
    return 0;
  } catch (const std::exception& e) {
    std::fprintf(stderr, "bm: %s\n", e.what());
    return kFailure;
  }
}

}  // namespace bm::cli
