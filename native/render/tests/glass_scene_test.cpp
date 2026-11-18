#include <catch2/catch_test_macros.hpp>
#include "bmr/glass_scene.h"
#include "helpers.h"

TEST_CASE("glass traversal retains offscreen geometry and omits hidden pieces", "[mesh][glass]") {
  const auto lib = bmtest::fixtureLibrary();
  bm::ldraw::PartCache full(lib, bmtest::cacheDir()), low(lib, bmtest::cacheDir());
  auto model = bmtest::modelFrom(bmtest::piece("3005.dat", 0, 0, 0, 36) + bmtest::piece("3005.dat", 10000, 0, 0, 4), lib);
  bmr::MeshLibrary meshes(model, full, low);
  auto scene = bmr::buildScene(model, full);
  const auto whole = bmr::buildGlassScene(scene, meshes);
  REQUIRE_FALSE(whole.nodes.empty());
  REQUIRE(whole.nodes[0].range[2] == whole.nodes.size());
  REQUIRE(whole.nodes[0].hi[0] - whole.nodes[0].lo[0] > 10000);
  size_t opaque = 0, glass = 0;
  for (const auto& t : whole.triangles) (t.base[3] > 0 ? glass : opaque)++;
  REQUIRE(opaque > 0); REQUIRE(glass > 0);
  for (auto& group : scene.groups) if (!group.material.transparent()) for (auto& in : group.instances) in.flags |= bmr::kHidden;
  const auto hidden = bmr::buildGlassScene(scene, meshes);
  REQUIRE(hidden.triangles.size() == glass);
  for (const auto& node : hidden.nodes) {
    REQUIRE(node.range[2] <= hidden.nodes.size());
    REQUIRE(node.range[0] + node.range[1] <= hidden.triangles.size());
  }
}
