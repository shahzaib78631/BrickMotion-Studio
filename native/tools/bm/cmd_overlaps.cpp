#include <cstdio>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <sstream>
#include "bm/collide/world.h"
#include "bm/connect/studio.h"
#include "bm/io.h"
#include "commands.h"

namespace bm::cli {
namespace fs = std::filesystem;

int cmdOverlaps(const Args& args) {
  if (args.empty() || args[0].rfind("--", 0) == 0) {
    std::fprintf(stderr, "usage: bm overlaps <file> [--part <part>] [--no-studio]\n");
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
    const collide::Report report = collide::findOverlaps(model, graph, cache, shapes);
    std::printf("pieces    %zu\ntested    %u pairs whose boxes meet\noverlaps  %zu\n", model.pieces().size(), report.tested, report.overlaps.size());
    size_t shown = 0;
    bool bad = false;
    std::string only = option(args, "--part", "", bad);
    if (!only.empty() && only.find('.') == std::string::npos) only += ".dat";
    for (const collide::Overlap& o : report.overlaps) {
      if (!only.empty() && model.pieces()[o.a].part != only && model.pieces()[o.b].part != only) continue;
      if (shown++ >= 60) {
        std::printf("  ... and %zu more\n", report.overlaps.size() - 60);
        break;
      }
      const Piece& a = model.pieces()[o.a];
      const Piece& b = model.pieces()[o.b];
      // How the two are joined, if they are, and where the crossing is in each piece's own space.
      std::string joint = "not joined";
      for (const connect::Connection& c : graph.connections)
        if (c.a == o.a && c.b == o.b) joint = std::string(connect::name(c.joint.kind)) + ", " + std::to_string(c.mates) + " mates";
      const Vec3 la = a.world.inverse().apply(o.point), lb = b.world.inverse().apply(o.point);
      std::printf("  %-16s %-16s %-22s crossing at (%.1f %.1f %.1f) in the first, (%.1f %.1f %.1f) in the second%s\n", a.part.c_str(), b.part.c_str(), joint.c_str(), la.x, la.y, la.z, lb.x, lb.y, lb.z, o.duplicate ? "  duplicate" : "");
    }
    if (flag(args, "--triangles") && !report.overlaps.empty()) {
      // The two crossing triangles of the first listed overlap, each in its own part's space.
      for (const collide::Overlap& o : report.overlaps) {
        if (o.duplicate || (!only.empty() && model.pieces()[o.a].part != only && model.pieces()[o.b].part != only)) continue;
        const auto sa = shapes.get(model.mesh(model.pieces()[o.a].part, cache)), sb = shapes.get(model.mesh(model.pieces()[o.b].part, cache));
        auto show = [](const char* what, const std::string& part, const collide::Shape& s, uint32_t t, bool inner) {
          std::printf("  %s surface of %s:", inner ? "inner" : "true", part.c_str());
          for (uint32_t k = 0; k < 3; k++) {
            const auto& p = inner ? s.inner[t * 3 + k] : s.outer[s.triangles[t * 3 + k]];
            std::printf(" (%.2f %.2f %.2f)", p.x, p.y, p.z);
          }
          std::printf("%s\n", what);
        };
        show("", model.pieces()[o.a].part, *sa, o.hit.triangleA, o.hit.innerOfA);
        show("", model.pieces()[o.b].part, *sb, o.hit.triangleB, !o.hit.innerOfA);
        const Xform rel = model.pieces()[o.a].world.inverse() * model.pieces()[o.b].world;
        std::printf("  second in the first's space: t (%.3f %.3f %.3f) r", rel.t.x, rel.t.y, rel.t.z);
        for (double v : rel.r.m) std::printf(" %.3f", v);
        std::printf("\n");
        break;
      }
    }
    return 0;
  } catch (const std::exception& e) {
    std::fprintf(stderr, "bm: %s\n", e.what());
    return kFailure;
  }
}

}  // namespace bm::cli
