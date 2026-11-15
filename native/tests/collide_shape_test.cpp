#include <catch2/catch_test_macros.hpp>
#include <catch2/matchers/catch_matchers_floating_point.hpp>
#include <cmath>
#include <filesystem>
#include <set>
#include <thread>
#include "bm/collide/shape.h"
#include "bm/ldraw/mesh.h"

using namespace bm;
using namespace bm::collide;
using Catch::Matchers::WithinAbs;

namespace {
ldraw::Library lib() { return ldraw::Library(std::filesystem::path(BM_FIXTURES) / "lib"); }
}  // namespace

TEST_CASE("triangles that cross are found, with a point on the crossing", "[collide][tritri]") {
  const Vec3f a[3] = {{0, 0, 0}, {10, 0, 0}, {0, 10, 0}};      // in the z=0 plane
  const Vec3f b[3] = {{2, 2, -5}, {2, 2, 5}, {8, 2, 5}};       // a vertical triangle through it
  Vec3f where{};
  REQUIRE(trianglesCross(a, b, &where));
  REQUIRE_THAT(where.z, WithinAbs(0, 1e-4));  // on a's plane
  REQUIRE_THAT(where.y, WithinAbs(2, 1e-4));  // on b's plane
  REQUIRE(trianglesCross(b, a));
}

TEST_CASE("triangles that only touch, or do not meet, do not cross", "[collide][tritri]") {
  const Vec3f a[3] = {{0, 0, 0}, {10, 0, 0}, {0, 10, 0}};
  const Vec3f coplanar[3] = {{1, 1, 0}, {5, 1, 0}, {1, 5, 0}};
  const Vec3f above[3] = {{0, 0, 1}, {10, 0, 1}, {0, 10, 1}};
  const Vec3f touchesWithVertex[3] = {{2, 2, 0}, {2, 2, 5}, {8, 2, 5}};       // one corner on a's surface
  const Vec3f touchesWithEdge[3] = {{1, 1, 0}, {5, 1, 0}, {3, 1, 5}};         // one edge lying on a
  const Vec3f besideInPlane[3] = {{20, 20, -5}, {20, 20, 5}, {26, 20, 5}};    // crosses a's plane, away from a
  const Vec3f sharesEdge[3] = {{0, 0, 0}, {10, 0, 0}, {0, 0, 10}};            // a fold along a's edge
  REQUIRE_FALSE(trianglesCross(a, coplanar));
  REQUIRE_FALSE(trianglesCross(a, above));
  REQUIRE_FALSE(trianglesCross(a, touchesWithVertex));
  REQUIRE_FALSE(trianglesCross(a, touchesWithEdge));
  REQUIRE_FALSE(trianglesCross(a, besideInPlane));
  REQUIRE_FALSE(trianglesCross(a, sharesEdge));
  REQUIRE_FALSE(trianglesCross(a, a));
  const Vec3f sliver[3] = {{0, 0, 0}, {0, 0, 0}, {0, 0, 0}};
  REQUIRE_FALSE(trianglesCross(a, sliver));
}

TEST_CASE("a part's shape keeps its true surface and one pulled inward by the skin", "[collide][shape]") {
  const ldraw::Library library = lib();
  const ldraw::Mesh mesh = ldraw::flatten("3005.dat", library);  // a 20 x 24 x 20 box
  const Shape shape = buildShape(mesh);
  REQUIRE(shape.outer.size() == 8);
  REQUIRE(shape.inner.size() == 8);
  REQUIRE(shape.triangles.size() == 36);
  REQUIRE((shape.bounds.min == Vec3{-10, 0, -10} && shape.bounds.max == Vec3{10, 24, 10}));
  for (size_t i = 0; i < 8; i++) {
    REQUIRE_THAT(std::abs(shape.outer[i].x), WithinAbs(10, 1e-5));
    REQUIRE_THAT(std::abs(shape.inner[i].x), WithinAbs(10 - kSkin, 1e-5));
    REQUIRE_THAT(std::abs(shape.inner[i].z), WithinAbs(10 - kSkin, 1e-5));
    REQUIRE_THAT(std::abs(shape.inner[i].y - 12), WithinAbs(12 - kSkin, 1e-5));
  }
}

TEST_CASE("the tree reaches every triangle and its boxes contain them", "[collide][shape]") {
  const ldraw::Library library = lib();
  const Shape shape = buildShape(ldraw::flatten("inv.dat", library));  // three boxes
  REQUIRE(shape.triangles.size() == 3 * 36);
  REQUIRE_FALSE(shape.nodes.empty());
  std::set<uint32_t> seen;
  for (const Node& n : shape.nodes) {
    if (n.count == 0) {
      REQUIRE(n.left + 1 < shape.nodes.size());
      continue;
    }
    REQUIRE(n.count <= 4);
    for (uint32_t t = n.left; t < n.left + n.count; t++) {
      REQUIRE(seen.insert(t).second);  // each triangle in exactly one leaf
      for (int k = 0; k < 3; k++) {
        for (const std::vector<Vec3f>* surface : {&shape.outer, &shape.inner}) {
          const Vec3f& p = (*surface)[shape.triangles[t * 3 + static_cast<uint32_t>(k)]];
          REQUIRE((p.x >= n.min[0] - 1e-4 && p.x <= n.max[0] + 1e-4 && p.y >= n.min[1] - 1e-4 && p.y <= n.max[1] + 1e-4 && p.z >= n.min[2] - 1e-4 && p.z <= n.max[2] + 1e-4));
        }
      }
    }
  }
  REQUIRE(seen.size() == shape.triangles.size() / 3);
}

TEST_CASE("empty and degenerate meshes give an empty shape", "[collide][shape][focus]") {
  REQUIRE(buildShape(ldraw::Mesh{}).nodes.empty());
  ldraw::Mesh flat;
  flat.positions = {0, 0, 0, 1, 0, 0, 2, 0, 0};  // three points on a line
  flat.triangles = {0, 1, 2, 0, 0, 0};
  flat.triColor = {16, 16};
  const Shape s = buildShape(flat);
  REQUIRE(s.triangles.empty());
  REQUIRE(s.nodes.empty());
  REQUIRE(s.bounds.empty());
  ldraw::Mesh broken;
  broken.positions = {0, 0, 0};
  broken.triangles = {0, 5, 9};  // indices past the end
  REQUIRE(buildShape(broken).triangles.empty());
}

TEST_CASE("two-sided geometry is not pulled anywhere", "[collide][shape]") {
  const ldraw::Library library = lib();
  const ldraw::Mesh mesh = ldraw::flatten("uncertified.dat", library);  // one triangle, both windings
  const Shape shape = buildShape(mesh);
  REQUIRE(shape.inner.size() == 3);
  for (size_t i = 0; i < 3; i++) REQUIRE_THAT(shape.inner[i].y, WithinAbs(mesh.positions[i * 3 + 1], 1e-6));
}

TEST_CASE("the cache builds one shape per mesh, from any thread", "[collide][shape]") {
  const ldraw::Library library = lib();
  const auto mesh = std::make_shared<const ldraw::Mesh>(ldraw::flatten("3001.dat", library));
  ShapeCache cache;
  std::vector<std::shared_ptr<const Shape>> got(8);
  std::vector<std::thread> threads;
  for (int t = 0; t < 8; t++) threads.emplace_back([&, t] { got[static_cast<size_t>(t)] = cache.get(mesh); });
  for (auto& th : threads) th.join();
  for (int t = 1; t < 8; t++) REQUIRE(got[static_cast<size_t>(t)] == got[0]);
  REQUIRE(got[0]->triangles.size() == mesh->triangles.size());
}
