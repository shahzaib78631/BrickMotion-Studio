#include "engine.h"

#include <cstdlib>
#include "bm/collide/world.h"
#include "bm/connect/graph.h"
#include "bm/connect/studio.h"
#include "commands.h"

namespace fs = std::filesystem;
using namespace bm;

namespace bmtools {

std::string ldrawDir() {
  if (const char* dir = std::getenv("BM_LDRAW_DIR")) return dir;
  std::error_code ec;
  for (fs::path at = fs::current_path(ec); !at.empty(); at = at.parent_path()) {
    if (fs::exists(at / "public" / "ldraw" / "LDConfig.ldr", ec)) return (at / "public" / "ldraw").string();
    if (at == at.root_path()) break;
  }
  return "";
}

Planned planModel(const Model& model, const ldraw::Library& library, ldraw::PartCache& full, const fs::path& ldraw, const plan::Options& options) {
  const fs::path repo = ldraw.parent_path().parent_path();
  const char* shadowEnv = std::getenv("BM_SHADOW_DIR");
  const connect::ShadowLibrary shadow(shadowEnv ? fs::path(shadowEnv) : repo / "vendor" / "LDCadShadowLibrary");
  connect::ConnectorDb db(library, shadow);
  const connect::StudioLibrary studio(connect::StudioLibrary::defaultDirectory());
  db.setStudio(&studio);
  kin::GearDb gears;
  cli::loadEngineData(repo, db, gears);
  collide::ShapeCache shapes;
  const connect::Graph graph = connect::buildGraph(model, db, &gears);
  Planned out;
  out.plan = plan::plan(model, graph, full, shapes, options);
  out.timeline = plan::buildTimeline(model, full, out.plan);
  return out;
}

}  // namespace bmtools
