// bm film: the camera. The director's shot list for a build, the camera body that films it, and
// how well it does.
#include <algorithm>
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include "bm/collide/world.h"
#include "bm/connect/infer.h"
#include "bm/connect/graph.h"
#include "bm/connect/studio.h"
#include "bm/io.h"
#include "bm/jobs.h"
#include "bm/plan/plan.h"
#include "bm/plan/timeline.h"
#include "bmf/body.h"
#include "bmf/director.h"
#include "bmf/measure.h"
#include "commands.h"

namespace bm::cli {
namespace fs = std::filesystem;

int cmdFilm(const Args& args) {
  bool bad = false;
  const std::string aspectText = option(args, "--aspect", "16:9", bad);
  const std::string fpsText = option(args, "--fps", "30", bad);
  const std::string outPath = option(args, "--out", "", bad);
  const std::string threads = option(args, "--threads", "0", bad);
  double aw = 0, ah = 0;
  if (std::sscanf(aspectText.c_str(), "%lf:%lf", &aw, &ah) != 2 || !(aw > 0) || !(ah > 0)) bad = true;
  const double fps = std::atof(fpsText.c_str());
  if (!(fps > 0)) bad = true;
  if (bad || args.empty() || args[0].rfind("--", 0) == 0) {
    std::fprintf(stderr, "usage: bm film <file> [--aspect W:H] [--fps N] [--out <shots.json>] [--correct] [--threads N]\n");
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
    const connect::StudioLibrary studio(connect::StudioLibrary::defaultDirectory());
    db.setStudio(&studio);
    kin::GearDb gears;
    loadEngineData(repo, db, gears);
    ldraw::PartCache cache(library, ldraw::PartCache::defaultDirectory());
    collide::ShapeCache shapes;
    const fs::path file{std::string(args[0])};
    Model model = io::load(file, library, &cache);
    // Planned as bm plan plans it, --correct included.
    std::vector<connect::Correction> corrections;
    connect::Graph graph;
    connect::Inferred inferred;
    JobPool pool(static_cast<unsigned>(std::max(0, std::atoi(threads.c_str()))));
    plan::Options options;
    options.pool = &pool;
    options.correctPlacements = flag(args, "--correct");
    const plan::Plan plan = plan::planModel(model, graph, db, &gears, cache, shapes, options, &inferred, &corrections);
    const plan::Timeline timeline = plan::buildTimeline(model, cache, plan, plan::styleOf(file));
    const collide::World world(model, cache, shapes);

    const auto started = std::chrono::steady_clock::now();
    const film::Beats beats = film::beatsOf(timeline, plan, model, world);
    const std::vector<film::Shot> shots = film::direct(beats, timeline, plan, world, film::referenceStyle(), fps);
    film::FrameShape shape;
    shape.aspect = aw / ah;
    const film::Track track = film::shoot(shots, beats, timeline, plan, world, shape, fps);
    const double ms = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - started).count();
    film::Report report = film::measure(track, shots, beats, timeline, plan, world);
    report.ms = ms, report.planMs = plan.planMs;

    const nlohmann::json list = film::toJson(shots);
    std::printf("shots         %zu for %.1f s at %s, %.0f fps\n", shots.size(), beats.frames / fps, aspectText.c_str(), fps);
    for (const nlohmann::json& s : list) {
      std::string subject = s["subject"].get<std::string>();
      if (s.contains("flight")) subject += " " + std::to_string(s["flight"].get<int>());
      std::printf("  %6.2f–%-6.2f  %-6s  %-10s  %4.0f/%-3.0f  %-10s %5.1f  %s\n", s["start"].get<double>(), s["end"].get<double>(), s["size"].get<std::string>().c_str(), subject.c_str(), s["azimuth"].get<double>(),
                  s["elevation"].get<double>(), s["move"].get<std::string>().c_str(), s["amount"].get<double>(), s["enter"].get<std::string>().c_str());
    }
    std::printf("landings in frame %d of %d; seen as they land %d (%zu hidden behind what is built)\n", report.landingsInFrame, report.landings, report.landingsSeen, report.hidden.size());
    std::vector<int> misses = report.missed;
    misses.insert(misses.end(), report.hidden.begin(), report.hidden.end());
    for (size_t k = 0; k < misses.size() && k < 20; k++) {
      const plan::Flight& f = timeline.flights[static_cast<size_t>(misses[k])];
      const auto& own = plan::piecesOf(f, plan);
      if (own.empty()) continue;
      const Piece& p = model.pieces()[own.front()];
      const bool hidden = k >= report.missed.size();
      std::printf("  missed: %s %s%s at %.1f s, %s\n", p.part.c_str(), p.id.c_str(), own.size() > 1 ? (" (+" + std::to_string(own.size() - 1) + ")").c_str() : "", (f.startFrame + f.frames) / fps,
                  hidden ? "hidden behind what is built" : "out of the safe frame");
    }
    auto shotAt = [&](int f) { return f >= 0 && static_cast<size_t>(f) < track.frames.size() ? track.frames[static_cast<size_t>(f)].shot : -1; };
    std::printf("inside        %d\njerk          %.2f rad/s³ at %.2f s (shot %d); target step %.1f LDU at %.2f s (shot %d)\ncuts/min      %.1f\nshortest      %.2f s\ncamera        %.0f ms (director and body); plan %.0f ms\n", report.insideFrames, report.maxJerk,
                report.jerkFrame / fps, shotAt(report.jerkFrame), report.maxTargetJump, report.jumpFrame / fps, shotAt(report.jumpFrame), report.cutsPerMinute, report.shortestShot, report.ms, report.planMs);
    std::printf("rules         %zu broken\n", report.rules.size());
    for (const film::RuleMiss& m : report.rules) std::printf("  %s: shot %s at %.2f s: %s\n", m.rule.c_str(), m.shot.c_str(), m.at, m.detail.c_str());

    if (!outPath.empty()) {
      nlohmann::json j;
      j["shots"] = list;
      nlohmann::json& r = j["report"];
      r["landings"] = report.landings, r["landingsInFrame"] = report.landingsInFrame, r["landingsSeen"] = report.landingsSeen, r["missed"] = report.missed, r["hidden"] = report.hidden;
      r["jerkFrame"] = report.jerkFrame, r["jumpFrame"] = report.jumpFrame, r["planMs"] = report.planMs;
      r["insideFrames"] = report.insideFrames, r["maxJerk"] = report.maxJerk, r["maxTargetJump"] = report.maxTargetJump;
      r["cutsPerMinute"] = report.cutsPerMinute, r["shortestShot"] = report.shortestShot, r["ms"] = report.ms;
      r["rules"] = nlohmann::json::array();
      for (const film::RuleMiss& m : report.rules) r["rules"].push_back({{"rule", m.rule}, {"shot", m.shot}, {"at", m.at}, {"detail", m.detail}});
      std::ofstream out(outPath);
      out << j.dump(1) << "\n";
    }
    return 0;
  } catch (const std::exception& e) {
    std::fprintf(stderr, "bm film: %s\n", e.what());
    return kFailure;
  }
}

}  // namespace bm::cli
