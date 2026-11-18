// The path tracer's scene: instances of part meshes, the parts' structures built once a run.
#include <catch2/catch_test_macros.hpp>
#include <set>
#include "bmr/device.h"
#include "bmr/path_scene.h"
#include "bmr/render_mesh.h"
#include "helpers.h"

using namespace bm;
using namespace bmr;
using bmtest::piece;

#define NEED_GPU() \
  if (!gpuAvailable()) SKIP("no Metal device")

namespace {
/// Four bricks stacked: three units fly in one after another (the second a pair), and the
/// fourth does not fly (it appears at frame 60).
struct Build {
  plan::Plan plan;
  plan::Timeline timeline;
  Build() {
    plan.moves.resize(3);
    plan.moves[0].unit.pieces = {0};
    plan.moves[1].unit.pieces = {1, 2};
    plan.moves[2].unit.pieces = {3};
    for (uint32_t i = 0; i < 2; i++) {
      plan::Flight f;
      f.move = i, f.startFrame = static_cast<int>(i) * 30, f.frames = 30;
      f.staging.t = {120, 0, 40.0 * i};
      f.waypoints = {f.staging, Xform{}};
      f.at = {0, 1};
      timeline.flights.push_back(f);
    }
    plan::Flight still;
    still.move = 2, still.startFrame = 60, still.frames = 0;
    timeline.flights.push_back(still);
    timeline.frames = 60;
  }
};
const std::string kStack = piece("3005.dat", 0, 0, 0, 4) + piece("3005.dat", 0, -24, 0, 0) + piece("3005.dat", 0, -48, 0, 4) + piece("3001.dat", 0, -72, 0, 0);

struct Rig {
  ldraw::Library lib = bmtest::fixtureLibrary();
  ldraw::PartCache full{lib, bmtest::cacheDir()};
  ldraw::PartCache low{lib, bmtest::cacheDir() / "low", lowOptions()};
  Model model;
  Scene scene;
  MeshLibrary meshes;
  explicit Rig(const std::string& text) : model(bmtest::modelFrom(text, lib)), scene(buildScene(model, full)), meshes(model, full, low) {}
  static ldraw::FlattenOptions lowOptions() {
    ldraw::FlattenOptions o;
    o.lowResPrimitives = true;
    return o;
  }
};
}  // namespace

TEST_CASE("path instances leave out hidden pieces", "[path]") {
  Rig rig(kStack);
  const Build b;
  applyFrame(rig.scene, rig.model, b.plan, b.timeline, 10);  // the 1x1 brick does not fly: hidden until frame 60
  const PathInstances in = pathInstances(rig.scene);
  REQUIRE(in.instances.size() == 3);
  for (const PathInstance& i : in.instances) REQUIRE(i.mesh < in.parts.size());
  REQUIRE(in.parts.size() == 2);  // 3005 and 3001, each once
  applyRest(rig.scene, rig.model);
  REQUIRE(pathInstances(rig.scene).instances.size() == 4);
}

TEST_CASE("a part with no geometry is its placeholder box", "[path]") {
  Rig rig(piece("3005.dat", 0, 0, 0, 4) + piece("nosuchpart.dat", 40, 0, 0, 4));
  const PathInstances in = pathInstances(rig.scene);
  REQUIRE(in.instances.size() == 2);
  std::set<std::string> parts(in.parts.begin(), in.parts.end());
  REQUIRE(parts.count(kPlaceholderPart) == 1);
}

TEST_CASE("a mirrored piece is marked so", "[path]") {
  Rig rig("1 4 0 0 0 -1 0 0 0 1 0 0 0 1 3005.dat\n");
  const PathInstances in = pathInstances(rig.scene);
  REQUIRE(in.instances.size() == 1);
  REQUIRE(in.instances[0].mirrored);
}

TEST_CASE("a part structure is built once per part per run", "[gpu][path]") {
  NEED_GPU();
  Rig rig(kStack);
  const Build b;
  std::string error;
  auto path = PathScene::create(&error);
  REQUIRE(path);
  REQUIRE(error.empty());
  applyFrame(rig.scene, rig.model, b.plan, b.timeline, 0);
  path->prepare(rig.scene, rig.meshes);
  applyFrame(rig.scene, rig.model, b.plan, b.timeline, 40);
  path->prepare(rig.scene, rig.meshes);
  applyRest(rig.scene, rig.model);
  path->prepare(rig.scene, rig.meshes);
  REQUIRE(path->stats().partStructuresBuilt == 2);
  REQUIRE(path->stats().instances == 4);
}

TEST_CASE("nothing built is an empty instance structure", "[gpu][path]") {
  NEED_GPU();
  Rig rig(piece("3001.dat", 0, 0, 0, 4));
  plan::Plan plan;
  plan.moves.resize(1);
  plan.moves[0].unit.pieces = {0};
  plan::Timeline timeline;
  plan::Flight still;
  still.move = 0, still.startFrame = 10, still.frames = 0;
  timeline.flights.push_back(still);
  timeline.frames = 10;
  applyFrame(rig.scene, rig.model, plan, timeline, 0);
  auto path = PathScene::create(nullptr);
  REQUIRE(path);
  REQUIRE_NOTHROW(path->prepare(rig.scene, rig.meshes));
  REQUIRE(path->stats().instances == 0);
}
