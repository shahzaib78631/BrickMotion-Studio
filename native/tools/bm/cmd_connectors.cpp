#include <cstdio>
#include <cstdlib>
#include <filesystem>
#include "bm/connect/connectors.h"
#include "bm/connect/studio.h"
#include "bm/kin/gears.h"
#include "commands.h"

namespace bm::cli {
namespace fs = std::filesystem;

int cmdConnectors(const Args& args) {
  if (args.empty() || args[0].rfind("--", 0) == 0) {
    std::fprintf(stderr, "usage: bm connectors <part> [--no-studio]\n");
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
    const auto connectors = db.get(args[0]);
    static const char* kinds[] = {"cyl", "clip", "finger", "generic"};
    static const char* sources[] = {"shadow", "studio", "override", "?"};
    std::printf("%zu connectors\n", connectors->size());
    for (const connect::Connector& c : *connectors) {
      std::string profile;
      for (const connect::ProfileSection& s : c.profile) {
        char buf[48];
        std::snprintf(buf, sizeof buf, " %c%gx%g", s.shape, s.radius, s.length);
        profile += buf;
      }
      const int source = std::min(static_cast<int>(c.source), 3);
      std::printf("  %-7s %s %-8s at %7.1f %7.1f %7.1f  along %5.2f %5.2f %5.2f  length %5.1f radius %4.1f%s%s%s%s\n", kinds[static_cast<int>(c.kind)], c.gender == connect::Gender::Male ? "M" : "F", sources[source], c.start.x, c.start.y, c.start.z, c.axis.x,
                  c.axis.y, c.axis.z, c.length, c.radius, c.slide ? " slide" : "", c.group.empty() ? "" : " group ", c.group.c_str(), profile.c_str());
    }
    return 0;
  } catch (const std::exception& e) {
    std::fprintf(stderr, "bm: %s\n", e.what());
    return kFailure;
  }
}

}  // namespace bm::cli
