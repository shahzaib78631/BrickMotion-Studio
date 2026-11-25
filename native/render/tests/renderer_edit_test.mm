// The renderer follows edits: a move re-places one instance, a recolour moves it between groups,
// anything else rebuilds the scene and keeps what is selected and hidden.
#include <catch2/catch_test_macros.hpp>
#include <cstring>
#include "bmr/device.h"
#include "bmr/scene.h"
#include "gpu_rig.h"

using namespace bm;
using namespace bmr;
using bmtest::piece;

#define NEED_GPU() \
  if (!gpuAvailable()) SKIP("no Metal device")

namespace {
std::string three() { return piece("3005.dat", -40, 0, 0, 4) + piece("3005.dat", 0, 0, 0, 4) + piece("3001.dat", 40, 0, 0, 1); }

std::vector<size_t> sizes(const Scene& s) {
  std::vector<size_t> out;
  for (const Group& g : s.groups) out.push_back(g.instances.size());
  return out;
}

bool runsInOrder(const Scene& s) {
  bool seenGlass = false;
  for (const Group& g : s.groups) {
    if (g.instances.empty()) continue;
    if (g.material.transparent()) seenGlass = true;
    else if (seenGlass) return false;
  }
  return true;
}
}  // namespace

TEST_CASE("move updates only that instance", "[render][edit][focus]") {
  const ldraw::Library lib = bmtest::fixtureLibrary();
  ldraw::PartCache cache(lib, bmtest::cacheDir());
  Model model = bmtest::modelFrom(three(), lib);
  Scene scene = buildScene(model, cache);
  const std::vector<size_t> before = sizes(scene);
  const auto where = scene.where;
  Xform moved = model.pieces()[1].world;
  moved.t.z += 60;
  model.setPlacement(1, moved);
  const auto changed = applyMoved(scene, model, {1});
  REQUIRE(changed.size() == 1);
  CHECK(changed[0] == scene.where[1]);
  CHECK(sizes(scene) == before);
  CHECK(scene.where == where);
  const Instance& in = scene.groups[scene.where[1].first].instances[scene.where[1].second];
  CHECK(in.model[11] == static_cast<float>(60 - scene.origin.z));
  CHECK(scene.bounds.max.z >= 60);
}

TEST_CASE("recolour moves the instance, no rebuild", "[render][edit]") {
  const ldraw::Library lib = bmtest::fixtureLibrary();
  ldraw::PartCache cache(lib, bmtest::cacheDir());
  Model model = bmtest::modelFrom(three(), lib);
  Scene scene = buildScene(model, cache);
  const auto where = scene.where;
  model.setColor(1, 14);
  applyRecolored(scene, model, {1});
  const Group& g = scene.groups[scene.where[1].first];
  CHECK(g.color == 14);
  CHECK(g.part == "3005.dat");
  CHECK(g.instances[scene.where[1].second].piece == 1);
  CHECK(scene.where[0] == where[0]);
  CHECK(scene.where[2] == where[2]);
  for (uint32_t p = 0; p < 3; p++) CHECK(scene.groups[scene.where[p].first].instances[scene.where[p].second].piece == p);
}

TEST_CASE("recolour to glass moves it to the transparent run", "[render][edit]") {
  const ldraw::Library lib = bmtest::fixtureLibrary();
  ldraw::PartCache cache(lib, bmtest::cacheDir());
  Model model = bmtest::modelFrom(three(), lib);
  Scene scene = buildScene(model, cache);
  model.setColor(0, 36);
  applyRecolored(scene, model, {0});
  CHECK(scene.groups[scene.where[0].first].material.transparent());
  CHECK(runsInOrder(scene));
  for (uint32_t p = 0; p < 3; p++) CHECK(scene.groups[scene.where[p].first].instances[scene.where[p].second].piece == p);
  model.setColor(2, 36);  // a new group of another part, among the glass
  applyRecolored(scene, model, {2});
  CHECK(runsInOrder(scene));
  for (uint32_t p = 0; p < 3; p++) CHECK(scene.groups[scene.where[p].first].instances[scene.where[p].second].piece == p);
}

TEST_CASE("a recoloured picture is the freshly built one", "[gpu][render][edit]") {
  NEED_GPU();
  bmtest::GpuRig rig(three());
  REQUIRE(rig.renderer);
  rig.shot(bmtest::plainOptions());
  rig.model.setColor(1, 14);
  rig.renderer->recolored({1});
  const Image edited = rig.shot(bmtest::plainOptions());
  bmtest::GpuRig fresh(piece("3005.dat", -40, 0, 0, 4) + piece("3005.dat", 0, 0, 0, 14) + piece("3001.dat", 40, 0, 0, 1));
  const Image want = fresh.shot(bmtest::plainOptions());
  REQUIRE(edited.rgba.size() == want.rgba.size());
  CHECK(std::memcmp(edited.rgba.data(), want.rgba.data(), want.rgba.size()) == 0);
}

TEST_CASE("opaque recolour keeps a ready shadow map until transparency changes", "[gpu][render][edit]") {
  NEED_GPU();
  bmtest::GpuRig rig(three());
  REQUIRE(rig.renderer);
  auto options = bmtest::plainOptions();
  options.shadows = true;
  REQUIRE(rig.renderer->draw(rig.camera, options).shadowDrawn);
  rig.model.setColor(1, 14);
  rig.renderer->recolored({1});
  const auto opaque = rig.renderer->draw(rig.camera, options);
  CHECK(opaque.submitted);
  CHECK_FALSE(opaque.shadowDrawn);
  rig.model.setColor(1, 36);
  rig.renderer->recolored({1});
  CHECK(rig.renderer->draw(rig.camera, options).shadowDrawn);
}

TEST_CASE("a moved picture is the freshly built one", "[gpu][render][edit]") {
  NEED_GPU();
  bmtest::GpuRig rig(three());
  REQUIRE(rig.renderer);
  rig.shot(bmtest::plainOptions());
  Xform w = rig.model.pieces()[1].world;
  w.t.z += 20;
  rig.model.setPlacement(1, w);
  const std::vector<uint32_t> moved{1};
  rig.renderer->modelChanged(rig.model, &moved);
  const Image edited = rig.shot(bmtest::plainOptions());
  bmtest::GpuRig fresh(piece("3005.dat", -40, 0, 0, 4) + piece("3005.dat", 0, 0, 20, 4) + piece("3001.dat", 40, 0, 0, 1));
  fresh.camera = rig.camera;  // the same view: the moved model's bounds frame differently
  const Image want = fresh.shot(bmtest::plainOptions());
  REQUIRE(edited.rgba.size() == want.rgba.size());
  size_t differ = 0;
  for (size_t i = 0; i < want.rgba.size(); i++) differ += edited.rgba[i] != want.rgba[i];
  CHECK(differ < want.rgba.size() / 1000);  // the scene origin differs, so float rounding may move an edge pixel
}

TEST_CASE("delete then draw", "[gpu][render][edit]") {
  NEED_GPU();
  bmtest::GpuRig rig(three());
  REQUIRE(rig.renderer);
  rig.shot(bmtest::plainOptions());
  rig.model = bmtest::modelFrom(piece("3005.dat", -40, 0, 0, 4) + piece("3001.dat", 40, 0, 0, 1), rig.lib);
  rig.renderer->modelChanged(rig.model);
  const Image after = rig.shot(bmtest::plainOptions());
  CHECK_FALSE(after.rgba.empty());
  CHECK(rig.renderer->scene().where.size() == 2);
  CHECK(rig.renderer->pick(1, 1) == UINT32_MAX);
}

TEST_CASE("selection survives a rebuild", "[gpu][render][edit]") {
  NEED_GPU();
  bmtest::GpuRig rig(three());
  REQUIRE(rig.renderer);
  rig.renderer->select({0});
  rig.renderer->setHidden({2});
  rig.model = bmtest::modelFrom(three() + piece("3005.dat", 0, -24, 0, 2), rig.lib);
  rig.renderer->modelChanged(rig.model);
  const Scene& s = rig.renderer->scene();
  REQUIRE(s.where.size() == 4);
  CHECK(s.groups[s.where[0].first].instances[s.where[0].second].flags & kSelected);
  CHECK_FALSE(s.groups[s.where[1].first].instances[s.where[1].second].flags & kSelected);
  CHECK(s.groups[s.where[2].first].instances[s.where[2].second].flags & kUserHidden);
  CHECK_FALSE(rig.shot(bmtest::plainOptions()).rgba.empty());
}

TEST_CASE("hidden pieces stay hidden at rest and are left out of the selection's bounds", "[gpu][render][edit]") {
  NEED_GPU();
  bmtest::GpuRig rig(three());
  REQUIRE(rig.renderer);
  rig.renderer->setHidden({0});
  rig.renderer->select({0});
  CHECK(rig.renderer->selectionBounds().empty());
  rig.renderer->setRest();
  const Scene& s = rig.renderer->scene();
  CHECK(s.groups[s.where[0].first].instances[s.where[0].second].flags & kUserHidden);
  rig.renderer->setHidden({});
  CHECK_FALSE(rig.renderer->selectionBounds().empty());
}
