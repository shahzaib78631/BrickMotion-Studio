#include <cstdio>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <nlohmann/json.hpp>
#include <string>
#include "bm/collide/shape.h"
#include "bm/connect/graph.h"
#include "bm/connect/studio.h"
#include "bm/io.h"
#include "bm/kin/system.h"
#include "bm/physics/builder.h"
#include "commands.h"

namespace bm::cli {
namespace fs = std::filesystem;

int cmdPhysics(const Args& args) {
  if (args.empty() || args[0].rfind("--", 0) == 0) {
    std::fprintf(stderr,
                 "usage: bm physics <file> [--mode mechanism|destructible|free] [--duration 1.5] [--fps 60]\n"
                 "                  [--substeps 8] [--drop <ldu>] [--lock-ground] [--clutch <scale>]\n"
                 "                  [--stress] [--json] [--out trajectory.json] [--no-studio]\n");
    return kUsage;
  }

  bool bad = false;
  const std::string modeStr = option(args, "--mode", "mechanism", bad);
  const double duration = std::strtod(option(args, "--duration", "1.5", bad).c_str(), nullptr);
  const double fps = std::strtod(option(args, "--fps", "60", bad).c_str(), nullptr);
  const int substeps = std::atoi(option(args, "--substeps", "8", bad).c_str());
  const double dropLdu = std::strtod(option(args, "--drop", "0", bad).c_str(), nullptr);
  const double clutchScale = std::strtod(option(args, "--clutch", "1.0", bad).c_str(), nullptr);
  const std::string outPath = option(args, "--out", "", bad);
  const bool stressMode = flag(args, "--stress");
  const bool jsonOut = flag(args, "--json");
  const bool lockGround = flag(args, "--lock-ground");
  const bool noStudio = flag(args, "--no-studio");
  if (bad) return kUsage;

  physics::SimMode mode = physics::SimMode::Mechanism;
  if (modeStr == "destructible") mode = physics::SimMode::Destructible;
  else if (modeStr == "free") mode = physics::SimMode::FreePieces;
  else if (modeStr != "mechanism") {
    std::fprintf(stderr, "bm: unknown --mode '%s' (expected mechanism, destructible, or free)\n", modeStr.c_str());
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
    const connect::StudioLibrary studio(noStudio ? fs::path() : connect::StudioLibrary::defaultDirectory());
    db.setStudio(&studio);
    kin::GearDb gears;
    loadEngineData(repo, db, gears);
    ldraw::PartCache parts(library, ldraw::PartCache::defaultDirectory());
    collide::ShapeCache shapes;

    const Model model = io::load(fs::path(std::string(args[0])), library, &parts);
    const connect::Graph graph = connect::buildGraph(model, db, &gears);

    if (stressMode) {
      physics::StructuralOptions sopt;
      sopt.clutchStrengthScale = clutchScale;
      sopt.substeps = std::max(4, substeps);
      const physics::StructuralReport rep = physics::analyzeStructure(model, graph, parts, sopt);
      if (jsonOut) {
        nlohmann::json j;
        j["structurallySound"] = rep.structurallySound;
        j["totalMassGrams"] = rep.totalMassGrams;
        j["maxStressRatio"] = rep.maxStressRatio;
        j["maxDisplacementLdu"] = rep.maxDisplacementLdu;
        j["failedJoints"] = rep.failedJoints;
        j["unsupportedPieces"] = rep.unsupportedPieces;
        j["settleTimeMs"] = rep.settleTimeMs;
        nlohmann::json top = nlohmann::json::array();
        for (size_t i = 0; i < std::min<size_t>(20, rep.joints.size()); i++) {
          const auto& js = rep.joints[i];
          top.push_back({{"connection", js.connectionIndex}, {"pieceA", js.pieceA}, {"pieceB", js.pieceB},
                         {"partA", model.pieces()[js.pieceA].part}, {"partB", model.pieces()[js.pieceB].part},
                         {"pullN", js.pullForce}, {"shearN", js.shearForce}, {"bendNm", js.bendTorque},
                         {"stressRatio", js.stressRatio}, {"failed", js.failed}});
        }
        j["hotspots"] = std::move(top);
        std::printf("%s\n", j.dump(2).c_str());
      } else {
        std::printf("pieces         %zu\nweight         %.1f g\nsound          %s\nmax stress     %.2fx clutch capacity\nmax sag        %.2f LDU\nfailed joints  %u\nfalling pieces %u\nsolve time     %.1f ms\n",
                    model.pieces().size(), rep.totalMassGrams, rep.structurallySound ? "yes" : "no",
                    rep.maxStressRatio, rep.maxDisplacementLdu, rep.failedJoints, rep.unsupportedPieces, rep.settleTimeMs);
        const size_t show = std::min<size_t>(10, rep.joints.size());
        if (show > 0) {
          std::printf("highest-loaded connections:\n");
          for (size_t i = 0; i < show; i++) {
            const auto& js = rep.joints[i];
            std::printf("  #%-4u %s <-> %s  stress=%.2fx  pull=%.2fN  shear=%.2fN  bend=%.4fNm%s\n",
                        js.connectionIndex, model.pieces()[js.pieceA].part.c_str(),
                        model.pieces()[js.pieceB].part.c_str(), js.stressRatio, js.pullForce,
                        js.shearForce, js.bendTorque, js.failed ? "  [BROKEN]" : "");
          }
        }
      }
      return 0;
    }

    physics::BuildOptions bopt;
    bopt.mode = mode;
    bopt.dropHeightLdu = dropLdu;
    bopt.lockGroundBody = lockGround;
    bopt.clutchStrengthScale = clutchScale;
    bopt.worldConfig.substeps = std::max(1, substeps);

    physics::BuiltWorld built = physics::buildWorld(model, graph, nullptr, parts, &shapes, bopt);
    const physics::Trajectory traj = physics::bakeTrajectory(built, duration, fps);

    if (!outPath.empty()) {
      std::ofstream f(outPath);
      if (!f) {
        std::fprintf(stderr, "bm: cannot write '%s'\n", outPath.c_str());
        return kFailure;
      }
      f << traj.toJson(true);
    }

    if (jsonOut) {
      std::printf("%s\n", traj.toJson(false).c_str());
    } else {
      const auto& last = traj.frames.back();
      std::printf("mode           %s\npieces         %zu\nbodies         %zu\njoints         %zu\nweight         %.1f g\nfloor Y        %.1f LDU\nduration       %.2f s (%zu frames @ %.0f fps, %d substeps)\nimpacts        %zu\nbroken joints  %zu\nfinal KE / PE  %.5f J / %.5f J (awake: %u)\nwall time      %.1f ms (%.1fx realtime)\n",
                  modeStr.c_str(), model.pieces().size(), built.world.bodyCount(), built.world.jointCount(),
                  traj.totalMassGrams, traj.floorYLdu, traj.duration, traj.frames.size(), traj.fps,
                  bopt.worldConfig.substeps, traj.impacts.size(), traj.breaks.size(),
                  last.kineticEnergy, last.potentialEnergy, last.awakeBodies,
                  traj.wallMs, traj.wallMs > 0.0 ? (traj.duration * 1000.0 / traj.wallMs) : 0.0);
    }
    return 0;
  } catch (const std::exception& e) {
    std::fprintf(stderr, "bm: %s\n", e.what());
    return kFailure;
  }
}

}  // namespace bm::cli
