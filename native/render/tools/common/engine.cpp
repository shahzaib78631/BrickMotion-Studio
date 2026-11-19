#include "engine.h"

#include <cstdio>
#include <cstdlib>
#include "bm/collide/world.h"
#include "bm/connect/graph.h"
#include "bm/connect/infer.h"
#include "bm/connect/studio.h"
#include "bmf/director.h"
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

void reportCorrections(const char* tool, const Model& model, const std::vector<connect::Correction>& corrections) {
  for (const connect::Correction& c : corrections)
    std::fprintf(stderr, "%s: %s %s is %.1f LDU off its line on %s %s, %+.0f along, %.1f deg: %s\n", tool, model.pieces()[c.piece].part.c_str(), model.pieces()[c.piece].id.c_str(), c.offset,
                 model.pieces()[c.onto].part.c_str(), model.pieces()[c.onto].id.c_str(), c.along, c.angle, c.applied ? "set in place" : c.note.empty() ? "--correct sets it in place" : c.note.c_str());
}

Planned planModel(Model& model, const ldraw::Library& library, ldraw::PartCache& full, const fs::path& ldraw, const plan::Options& options, const plan::Style& style, double aspect) {
  const fs::path repo = ldraw.parent_path().parent_path();
  const char* shadowEnv = std::getenv("BM_SHADOW_DIR");
  const connect::ShadowLibrary shadow(shadowEnv ? fs::path(shadowEnv) : repo / "vendor" / "LDCadShadowLibrary");
  connect::ConnectorDb db(library, shadow);
  const connect::StudioLibrary studio(connect::StudioLibrary::defaultDirectory());
  db.setStudio(&studio);
  kin::GearDb gears;
  cli::loadEngineData(repo, db, gears);
  collide::ShapeCache shapes;
  Planned out;
  out.plan = plan::planModel(model, out.graph, db, &gears, full, shapes, options, nullptr, &out.corrections);
  out.timeline = plan::buildTimeline(model, full, out.plan, style);
  const collide::World world(model, full, shapes);
  const film::Beats beats = film::beatsOf(out.timeline, out.plan, model, world);
  out.shots = film::direct(beats, out.timeline, out.plan, world, film::referenceStyle(), style.fps);
  film::FrameShape shape;
  shape.aspect = aspect > 0 ? aspect : 16.0 / 9;
  out.track = film::shoot(out.shots, beats, out.timeline, out.plan, world, shape, style.fps);
  return out;
}

bmr::Camera toCamera(const film::Frame& frame, double aspect, const Box& scene) {
  const film::Rig rig = film::rigOf(frame);
  bmr::OrbitCamera orbit;
  orbit.target = rig.target, orbit.distance = rig.distance, orbit.azimuth = rig.azimuth, orbit.elevation = rig.elevation, orbit.fovY = frame.fovY;
  bmr::Camera c = orbit.camera(aspect, scene);
  c.eye = frame.eye, c.target = frame.target, c.up = frame.up;
  return c;
}

void keysFromTrack(const film::Track& track, plan::Timeline& timeline) {
  if (track.frames.empty()) return;
  timeline.camera.clear();
  for (size_t f = 0; f < track.frames.size(); f++) {
    const film::Rig rig = film::rigOf(track.frames[f]);
    timeline.camera.push_back({static_cast<int>(f), rig.target, rig.distance, rig.azimuth, rig.elevation});
  }
}

}  // namespace bmtools
