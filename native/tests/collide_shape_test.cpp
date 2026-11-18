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

TEST_CASE("triangles whose edges pass each other only touch, however near a corner is to the other's plane", "[collide][tritri]") {
  // a's top edge and b's bottom edge both lie at z = 0 and cross each other: they meet at a
  // point. a's corner at y = 7.5 is 0.036 from b's plane, within a touch of it, yet the ends of
  // a's crossing are still where b's plane cuts a's sides, not at that corner.
  const Vec3f a[3] = {{0, 7.5f, 0}, {0, 0.5f, 0}, {0, 0.5f, -19}};
  const Vec3f b[3] = {{10.5f, 11.42f, 2}, {10.5f, 7.42f, 0}, {-49.5f, 7.42f, 0}};
  REQUIRE_FALSE(trianglesCross(a, b));
  REQUIRE_FALSE(trianglesCross(b, a));
  // Half a unit further down, b's foot is inside a: they cross.
  const Vec3f into[3] = {{10.5f, 8, 1.5f}, {10.5f, 4, -0.5f}, {-49.5f, 4, -0.5f}};
  REQUIRE(trianglesCross(a, into));
  REQUIRE(trianglesCross(into, a));
}

namespace {
/// A closed convex mesh from outward-wound triangles over `points`.
ldraw::Mesh meshOf(std::vector<Vec3> points, std::vector<uint32_t> triangles) {
  ldraw::Mesh m;
  for (const Vec3& p : points) m.positions.insert(m.positions.end(), {static_cast<float>(p.x), static_cast<float>(p.y), static_cast<float>(p.z)});
  m.triangles = std::move(triangles);
  m.triColor.assign(m.triangles.size() / 3, 16);
  return m;
}
bool kept(const Shape& s, size_t t) { return !(s.inner[t * 3].x == s.inner[t * 3 + 1].x && s.inner[t * 3].y == s.inner[t * 3 + 1].y && s.inner[t * 3].z == s.inner[t * 3 + 1].z); }

/// For a convex solid: every point of the inner surface is at least the skin inside every face.
void requireInsideBySkin(const Shape& s) {
  for (size_t f = 0; f < s.triangles.size() / 3; f++) {
    const Vec3f& a = s.outer[s.triangles[f * 3]];
    const Vec3f& b = s.outer[s.triangles[f * 3 + 1]];
    const Vec3f& c = s.outer[s.triangles[f * 3 + 2]];
    const Vec3 n = normalized(cross(Vec3{b.x - a.x, b.y - a.y, b.z - a.z}, Vec3{c.x - a.x, c.y - a.y, c.z - a.z}));
    for (size_t t = 0; t < s.triangles.size() / 3; t++) {
      if (!kept(s, t)) continue;
      for (size_t k = 0; k < 3; k++) {
        const Vec3f& p = s.inner[t * 3 + k];
        INFO("face " << f << " normal " << n.x << " " << n.y << " " << n.z << "; inner triangle " << t << " corner " << k << " at " << p.x << " " << p.y << " " << p.z << " from "
                     << s.outer[s.triangles[t * 3 + k]].x << " " << s.outer[s.triangles[t * 3 + k]].y << " " << s.outer[s.triangles[t * 3 + k]].z);
        REQUIRE(dot(Vec3{p.x - a.x, p.y - a.y, p.z - a.z}, n) <= -kSkin + 1e-3);
      }
    }
  }
}
}  // namespace

TEST_CASE("a brick's inner surface is the brick, one skin smaller", "[collide][shape]") {
  const ldraw::Library library = lib();
  const Shape shape = buildShape(ldraw::flatten("3005.dat", library));  // a 20 x 24 x 20 box
  REQUIRE(shape.outer.size() == 8);
  REQUIRE(shape.triangles.size() == 36);
  REQUIRE(shape.inner.size() == 36);
  REQUIRE((shape.bounds.min == Vec3{-10, 0, -10} && shape.bounds.max == Vec3{10, 24, 10}));
  Box inner;
  for (size_t t = 0; t < 12; t++) {
    REQUIRE(kept(shape, t));
    for (size_t k = 0; k < 3; k++) inner.grow({shape.inner[t * 3 + k].x, shape.inner[t * 3 + k].y, shape.inner[t * 3 + k].z});
  }
  REQUIRE_THAT(inner.min.x, WithinAbs(-10 + kSkin, 1e-5));
  REQUIRE_THAT(inner.max.x, WithinAbs(10 - kSkin, 1e-5));
  REQUIRE_THAT(inner.min.y, WithinAbs(kSkin, 1e-5));
  REQUIRE_THAT(inner.max.y, WithinAbs(24 - kSkin, 1e-5));
  REQUIRE_THAT(inner.max.z, WithinAbs(10 - kSkin, 1e-5));
  requireInsideBySkin(shape);
}

TEST_CASE("a sloped face stays inside: its inner surface never comes out past its own edges", "[collide][shape][review]") {
  // A wedge: a right-triangle prism with a 45 degree slope resting on its base (y = 0).
  const ldraw::Mesh wedge = meshOf({{0, 0, 0}, {10, 0, 0}, {0, -10, 0}, {0, 0, 10}, {10, 0, 10}, {0, -10, 10}},
                                   {0, 1, 2,  3, 5, 4,          // the two triangular ends (z = 0 facing -z, z = 10 facing +z)
                                    0, 3, 4,  0, 4, 1,          // base, facing +y
                                    0, 2, 5,  0, 5, 3,          // back (x = 0), facing -x
                                    1, 4, 5,  1, 5, 2});        // the slope
  const Shape s = buildShape(wedge);
  size_t keptCount = 0;
  for (size_t t = 0; t < 8; t++) keptCount += kept(s, t);
  REQUIRE(keptCount == 8);
  requireInsideBySkin(s);
  // A much shallower slope (about 6 degrees), where moving shared corners goes wrong.
  const ldraw::Mesh shallow = meshOf({{0, 0, 0}, {100, 0, 0}, {0, -10, 0}, {0, 0, 10}, {100, 0, 10}, {0, -10, 10}}, wedge.triangles);
  requireInsideBySkin(buildShape(shallow));
}

TEST_CASE("the facets of a round part are not trimmed away", "[collide][shape][review]") {
  // A 16-sided prism of radius 6 and height 4: a stud.
  std::vector<Vec3> pts;
  std::vector<uint32_t> tris;
  const int n = 16;
  for (int i = 0; i < n; i++) {
    const double a = 2 * 3.14159265358979 * i / n;
    pts.push_back({6 * std::cos(a), 0, 6 * std::sin(a)});
    pts.push_back({6 * std::cos(a), -4, 6 * std::sin(a)});
  }
  pts.push_back({0, 0, 0});
  pts.push_back({0, -4, 0});
  for (uint32_t i = 0; i < n; i++) {
    const uint32_t a = i * 2, b = ((i + 1) % n) * 2;
    tris.insert(tris.end(), {a, b + 1, a + 1, a, b, b + 1});        // side, facing outward
    tris.insert(tris.end(), {static_cast<uint32_t>(2 * n), b, a});          // bottom cap (y = 0), facing +y
    tris.insert(tris.end(), {static_cast<uint32_t>(2 * n + 1), a + 1, b + 1});  // top cap (y = -4), facing -y
  }
  const Shape s = buildShape(meshOf(pts, tris));
  REQUIRE(s.triangles.size() == tris.size());
  size_t sides = 0, caps = 0;
  for (size_t t = 0; t < s.triangles.size() / 3; t++) {
    if (!kept(s, t)) continue;
    const Vec3f& a = s.outer[s.triangles[t * 3]];
    const Vec3f& b = s.outer[s.triangles[t * 3 + 1]];
    const Vec3f& c = s.outer[s.triangles[t * 3 + 2]];
    (a.y == b.y && b.y == c.y ? caps : sides)++;
  }
  REQUIRE(sides == 32);  // every side facet survives
  REQUIRE(caps >= 16);   // the caps' thin wedges may be trimmed away near the rim
  requireInsideBySkin(s);
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
      // The true surface is in one box, the inner surface in the other; an inner triangle with
      // no area is in neither.
      const Vec3f &i0 = shape.inner[t * 3], &i1 = shape.inner[t * 3 + 1];
      const bool flat = i0.x == i1.x && i0.y == i1.y && i0.z == i1.z;
      for (uint32_t k = 0; k < 3; k++) {
        const Vec3f& p = shape.outer[shape.triangles[t * 3 + k]];
        REQUIRE((p.x >= n.min[0] - 1e-4 && p.x <= n.max[0] + 1e-4 && p.y >= n.min[1] - 1e-4 && p.y <= n.max[1] + 1e-4 && p.z >= n.min[2] - 1e-4 && p.z <= n.max[2] + 1e-4));
        if (flat) continue;
        const Vec3f& q = shape.inner[t * 3 + k];
        REQUIRE((q.x >= n.imin[0] - 1e-4 && q.x <= n.imax[0] + 1e-4 && q.y >= n.imin[1] - 1e-4 && q.y <= n.imax[1] + 1e-4 && q.z >= n.imin[2] - 1e-4 && q.z <= n.imax[2] + 1e-4));
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

TEST_CASE("a lone two-sided triangle has no inside, so no inner surface", "[collide][shape]") {
  const ldraw::Library library = lib();
  const Shape shape = buildShape(ldraw::flatten("uncertified.dat", library));  // one small triangle, both windings
  REQUIRE(shape.triangles.size() == 6);
  REQUIRE_FALSE(kept(shape, 0));
  REQUIRE_FALSE(kept(shape, 1));
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
