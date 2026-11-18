#include <catch2/catch_test_macros.hpp>

#include <algorithm>
#include <array>
#include <cmath>
#include "bmr/render_mesh.h"

using namespace bmr;
using bm::Vec3;

namespace {
constexpr double pi = 3.14159265358979323846;

Vec3 position(const Vertex& v) { return {v.px, v.py, v.pz}; }
Vec3 normal(const Vertex& v) { return {v.nx, v.ny, v.nz}; }

void triangle(RenderMesh& m, const std::array<Vertex, 3>& v) {
  const uint32_t start = static_cast<uint32_t>(m.vertices.size());
  m.vertices.insert(m.vertices.end(), v.begin(), v.end());
  m.indices.insert(m.indices.end(), {start, start + 1, start + 2});
}

void outline(RenderMesh& m, Vec3 a, Vec3 b) {
  for (const double value : {a.x, a.y, a.z, b.x, b.y, b.z}) m.edges.push_back(static_cast<float>(value));
}

// A stud's cylindrical side and a brick's solid upper plane meet without
// shared mesh edges, just as in the standard LDraw stud.dat primitive.
RenderMesh studFixture(bool deck = true, int studs = 1, double radius = 6, bool rings = true) {
  RenderMesh m;
  if (deck) {
    m = boxMesh(bm::Box{{-12, 0, -12}, {12.0 + 20.0 * (studs - 1), 24, 12}});
  }
  constexpr int steps = 32;
  for (int s = 0; s < studs; ++s) {
    const double cx = 20.0 * s;
    for (int i = 0; i < steps; ++i) {
      const double a = 2 * pi * i / steps, b = 2 * pi * (i + 1) / steps;
      const Vec3 pa{cx + radius * std::cos(a), 0, radius * std::sin(a)};
      const Vec3 pb{cx + radius * std::cos(b), 0, radius * std::sin(b)};
      const Vec3 qa{pa.x, -4, pa.z}, qb{pb.x, -4, pb.z};
      auto v = [&](Vec3 p) {
        const Vec3 n = normalized(Vec3{p.x - cx, 0, p.z});
        return Vertex{static_cast<float>(p.x), static_cast<float>(p.y), static_cast<float>(p.z),
                      static_cast<float>(n.x), static_cast<float>(n.y), static_cast<float>(n.z), 0};
      };
      triangle(m, {v(pa), v(qb), v(qa)});
      triangle(m, {v(pa), v(pb), v(qb)});
      if (rings) {
        outline(m, pa, pb);  // base ring: should disappear
        outline(m, qa, qb);  // top rim: should survive
      }
    }
  }
  m.topIndices = static_cast<uint32_t>(m.indices.size());
  return m;
}

double surfaceArea(const RenderMesh& m) {
  double area = 0;
  for (size_t i = 0; i + 2 < m.indices.size(); i += 3) {
    const Vec3 a = position(m.vertices[m.indices[i]]);
    const Vec3 b = position(m.vertices[m.indices[i + 1]]);
    const Vec3 c = position(m.vertices[m.indices[i + 2]]);
    area += length(cross(b - a, c - a)) / 2;
  }
  return area;
}
} // namespace

TEST_CASE("stud roots get narrow moulded shading without a dark base outline", "[mesh][stud]") {
  RenderMesh m = studFixture();
  const double area = surfaceArea(m);
  const size_t oldCount = m.indices.size();
  softenStudRoots(m, 0.45);
  REQUIRE(m.indices.size() > oldCount); // wall band tessellation, not a screen-space blur
  REQUIRE(m.edges.size() == 32 * 6);    // only top rim retained
  REQUIRE(m.topIndices == m.indices.size());
  REQUIRE(std::abs(surfaceArea(m) - area) < 0.005);

  int smoothlyJoined = 0, vertical = 0, deck = 0;
  for (size_t i = 0; i + 2 < m.indices.size(); i += 3) {
    const Vertex& va = m.vertices[m.indices[i]];
    const Vertex& vb = m.vertices[m.indices[i + 1]];
    const Vertex& vc = m.vertices[m.indices[i + 2]];
    const Vec3 geometric = normalized(cross(position(vb) - position(va), position(vc) - position(va)));
    for (const Vertex* v : {&va, &vb, &vc}) {
      REQUIRE(std::abs(length(normal(*v)) - 1.0) < 1e-5);
      if (std::abs(v->py) < 1e-5 && std::abs(std::hypot(v->px, v->pz) - 6.0) < 0.16 &&
          std::abs(geometric.y) < 0.1) {
        REQUIRE(v->ny < -0.99f); // wall normal matches the horizontal deck at its root
        ++smoothlyJoined;
      }
      if (v->py < -3.9 && std::abs(geometric.y) < 0.1) {
        REQUIRE(std::abs(v->ny) < 0.01f); // top of the wall stays cylindrical
        ++vertical;
      }
      if (v->py == 0 && v->px > 8 && v->pz > 8 && geometric.y < -0.9) {
        REQUIRE(v->ny < -0.999f); // deck is not softened away
        ++deck;
      }
    }
  }
  REQUIRE(smoothlyJoined > 30);
  REQUIRE(vertical > 30);
  REQUIRE(deck > 0);
}

TEST_CASE("stud joint softening is conservative and scales to a multi-stud brick", "[mesh][stud]") {
  SECTION("base detection still works after the existing convex edge rounds") {
    RenderMesh m = studFixture();
    roundRenderEdges(m, 0.45);
    softenStudRoots(m, 0.45);
    REQUIRE(m.edges.size() == 32 * 6);
    REQUIRE(m.topIndices == m.indices.size());
  }
  SECTION("two independent base rings are removed, top rims remain") {
    RenderMesh m = studFixture(true, 2);
    softenStudRoots(m, 0.45);
    REQUIRE(m.edges.size() == 2 * 32 * 6);
  }
  SECTION("an unsupported cylinder is not a stud joint") {
    RenderMesh m = studFixture(false);
    const size_t count = m.indices.size(), edges = m.edges.size();
    softenStudRoots(m, 0.45);
    REQUIRE(m.indices.size() == count);
    REQUIRE(m.edges.size() == edges);
  }
  SECTION("a different sized round part is left alone") {
    RenderMesh m = studFixture(true, 1, 5.3);
    const size_t count = m.indices.size(), edges = m.edges.size();
    softenStudRoots(m, 0.45);
    REQUIRE(m.indices.size() == count);
    REQUIRE(m.edges.size() == edges);
  }
  SECTION("without a base outline there is no inferred fillet") {
    RenderMesh m = studFixture(true, 1, 6, false);
    const size_t count = m.indices.size();
    softenStudRoots(m, 0.45);
    REQUIRE(m.indices.size() == count);
  }
  SECTION("zero band width disables this optional display treatment") {
    RenderMesh m = studFixture();
    const size_t count = m.indices.size(), edges = m.edges.size();
    softenStudRoots(m, 0);
    REQUIRE(m.indices.size() == count);
    REQUIRE(m.edges.size() == edges);
  }
}
