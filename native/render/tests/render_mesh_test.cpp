#include <catch2/catch_test_macros.hpp>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <unistd.h>
#include "bm/io.h"
#include "bmr/render_mesh.h"

using namespace bm;
using namespace bmr;
namespace fs = std::filesystem;

namespace {
Vec3 P(const Vertex& v) { return {v.px, v.py, v.pz}; }
Vec3 N(const Vertex& v) { return {v.nx, v.ny, v.nz}; }
ldraw::Library fixtureLib() { return ldraw::Library(fs::path(BM_FIXTURES) / "lib"); }

/// Every triangle's corners carry a normal within `cosine` of the triangle's own, and the
/// triangle faces away from `centre`.
void requireFlatAndOutward(const RenderMesh& m, Vec3 centre) {
  for (size_t i = 0; i + 2 < m.indices.size(); i += 3) {
    const Vertex &a = m.vertices[m.indices[i]], &b = m.vertices[m.indices[i + 1]], &c = m.vertices[m.indices[i + 2]];
    const Vec3 face = normalized(cross(P(b) - P(a), P(c) - P(a)));
    for (const Vertex* v : {&a, &b, &c}) REQUIRE(dot(N(*v), face) > 0.999);
    REQUIRE(dot(face, (P(a) + P(b) + P(c)) * (1.0 / 3) - centre) > 0);
  }
}
}  // namespace

TEST_CASE("a brick's faces are flat and its normals point outward", "[mesh]") {
  const ldraw::Library lib = fixtureLib();
  const RenderMesh m = buildRenderMesh(ldraw::flatten("3005.dat", lib), lib.colors());  // the 20 x 24 x 20 body
  REQUIRE_FALSE(m.empty());
  REQUIRE(m.indices.size() % 3 == 0);
  requireFlatAndOutward(m, (m.bounds.min + m.bounds.max) * 0.5);
  REQUIRE(m.vertices.size() == 24);  // eight corners, each split three ways
}

TEST_CASE("a cylinder is smooth around and sharp at its rim", "[mesh][data]") {
  const char* dir = std::getenv("BM_LDRAW_DIR");
  if (!dir) SKIP("BM_LDRAW_DIR is not set");
  const ldraw::Library lib(dir);
  const RenderMesh m = buildRenderMesh(ldraw::flatten("4-4cyli.dat", lib), lib.colors());  // radius 1, y from 0 to 1, no caps
  REQUIRE_FALSE(m.empty());
  // Smooth: every corner's normal points straight out from the axis, whichever facet it belongs to.
  for (const Vertex& v : m.vertices) {
    const Vec3 radial = normalized(Vec3{v.px, 0, v.pz});
    REQUIRE(std::abs(v.ny) < 1e-3);
    REQUIRE(dot(N(v), radial) > 0.999);
  }
  REQUIRE(m.vertices.size() == 32);  // 16 around, top and bottom: no corner was split
  // Sharp: with its end discs on (a stud), the rim's corners are split between wall and top.
  const RenderMesh stud = buildRenderMesh(ldraw::flatten("stud.dat", lib), lib.colors());
  int up = 0, sideways = 0;
  for (const Vertex& v : stud.vertices) {
    if (std::abs(v.ny) > 0.999) up++;
    else if (std::abs(v.ny) < 1e-3) sideways++;
  }
  REQUIRE(up >= 16);
  REQUIRE(sideways >= 32);
  REQUIRE(up + sideways == static_cast<int>(stud.vertices.size()));  // nothing in between: no normal leans over the rim
}

TEST_CASE("fixed colours are carried per vertex; the piece's own colour is 0", "[mesh]") {
  const ldraw::Library lib = fixtureLib();
  ldraw::Mesh mesh;
  mesh.positions = {0, 0, 0, 10, 0, 0, 0, 0, 10, 0, 10, 0};
  mesh.triangles = {0, 1, 2, 0, 1, 3, 0, 2, 3, 1, 2, 3};
  mesh.triColor = {16, 4, 9999, 24};
  const RenderMesh m = buildRenderMesh(mesh, lib.colors());
  REQUIRE(m.indices.size() == 12);
  const uint32_t red = 0xFF000000u | lib.colors().at(4).rgb;
  REQUIRE(m.vertices[m.indices[0]].color == 0);
  REQUIRE(m.vertices[m.indices[3]].color == red);
  REQUIRE(m.vertices[m.indices[6]].color == 0xFF888888u);
  REQUIRE(m.vertices[m.indices[9]].color == 0);
}

TEST_CASE("triangles of one flat face but two colours do not share corners", "[mesh]") {
  const ldraw::Library lib = fixtureLib();
  ldraw::Mesh mesh;
  mesh.positions = {0, 0, 0, 10, 0, 0, 10, 0, 10, 0, 0, 10};
  mesh.triangles = {0, 1, 2, 0, 2, 3};
  mesh.triColor = {16, 4};
  const RenderMesh m = buildRenderMesh(mesh, lib.colors());
  REQUIRE(m.vertices.size() == 6);
}

TEST_CASE("empty and degenerate meshes give an empty render mesh", "[mesh]") {
  const ldraw::Library lib = fixtureLib();
  REQUIRE(buildRenderMesh(ldraw::Mesh{}, lib.colors()).empty());
  ldraw::Mesh flat;
  flat.positions = {0, 0, 0, 1, 0, 0, 2, 0, 0};  // three points on a line
  flat.triangles = {0, 1, 2, 0, 0, 0, 0, 1, 77};   // no area, no area, an index out of range
  flat.edges = {0, 0, 0, 1, 0, 0};
  const RenderMesh m = buildRenderMesh(flat, lib.colors());
  REQUIRE(m.empty());
  REQUIRE(m.vertices.empty());
  REQUIRE(m.edges.empty());
  REQUIRE(m.bounds.empty());
  ldraw::Mesh odd;
  odd.positions = {0, 0, 0, 1, 0};   // not a multiple of three
  odd.triangles = {0, 1};            // nor is this
  REQUIRE(buildRenderMesh(odd, lib.colors()).empty());
}

TEST_CASE("a box mesh has 12 triangles, 24 vertices and outward flat normals", "[mesh]") {
  const Box box{{-10, 0, -20}, {10, 24, 20}};
  const RenderMesh m = boxMesh(box);
  REQUIRE(m.indices.size() == 36);
  REQUIRE(m.vertices.size() == 24);
  requireFlatAndOutward(m, {0, 12, 0});
  REQUIRE(boxMesh(Box{}).empty());
}

TEST_CASE("low detail has fewer triangles for a round part and nearly the same bounds", "[mesh][data]") {
  const char* dir = std::getenv("BM_LDRAW_DIR");
  if (!dir) SKIP("BM_LDRAW_DIR is not set");
  const ldraw::Library lib(dir);
  const fs::path file = fs::temp_directory_path() / ("bmr_mesh_test_" + std::to_string(::getpid()) + ".ldr");
  { std::ofstream out(file); out << "1 4 0 0 0 1 0 0 0 1 0 0 0 1 3941.dat\n1 4 0 -24 0 1 0 0 0 1 0 0 0 1 3005.dat\n1 4 0 -48 0 1 0 0 0 1 0 0 0 1 nosuchpart.dat\n"; }
  const Model model = io::load(file, lib);
  fs::remove(file);
  const fs::path cacheDir = fs::temp_directory_path() / "bmr_mesh_test_cache";
  ldraw::FlattenOptions lowOptions;
  lowOptions.lowResPrimitives = true;
  ldraw::PartCache full(lib, cacheDir), low(lib, cacheDir, lowOptions);
  MeshLibrary meshes(model, full, low);
  const auto round = meshes.get("3941.dat", Detail::Full), roundLow = meshes.get("3941.dat", Detail::Low);
  REQUIRE(roundLow->indices.size() < round->indices.size());
  // Low detail still saves triangles after adding the same moulded edge bands.
  REQUIRE(meshes.get("3001.dat", Detail::Low)->indices.size() < meshes.get("3001.dat", Detail::Full)->indices.size() * 85 / 100);
  for (double d : {roundLow->bounds.min.x - round->bounds.min.x, roundLow->bounds.max.x - round->bounds.max.x, roundLow->bounds.min.y - round->bounds.min.y, roundLow->bounds.max.y - round->bounds.max.y,
                   roundLow->bounds.min.z - round->bounds.min.z, roundLow->bounds.max.z - round->bounds.max.z})
    REQUIRE(std::abs(d) < 1.0);
  // A square brick's only curve is its stud: low is never more than full.
  REQUIRE(meshes.get("3005.dat", Detail::Low)->indices.size() <= meshes.get("3005.dat", Detail::Full)->indices.size());
  REQUIRE(meshes.get("3005.dat", Detail::Box)->indices.size() == 36);
  REQUIRE(meshes.get("3941.dat", Detail::Full).get() == round.get());  // built once
  // A part that does not exist is empty at every level, and is still an answer.
  for (Detail d : {Detail::Full, Detail::Low, Detail::Box}) {
    REQUIRE(meshes.get("nosuchpart.dat", d) != nullptr);
    REQUIRE(meshes.get("nosuchpart.dat", d)->empty());
  }
}

TEST_CASE("rounded shading stays within a narrow edge band and preserves surface area", "[mesh]") {
  RenderMesh m = boxMesh(Box{{-10, 0, -10}, {10, 24, 10}});
  const auto bounds = m.bounds;
  roundRenderEdges(m, 0.45);
  REQUIRE(m.topIndices == m.indices.size());
  double area = 0;
  size_t bent = 0, flat = 0;
  for (size_t i = 0; i < m.indices.size(); i += 3) {
    const Vertex &a = m.vertices[m.indices[i]], &b = m.vertices[m.indices[i + 1]], &c = m.vertices[m.indices[i + 2]];
    const Vec3 cross0 = cross(P(b) - P(a), P(c) - P(a));
    const Vec3 face = normalized(cross0);
    area += length(cross0) / 2;
    REQUIRE(dot(face, (P(a) + P(b) + P(c)) * (1.0 / 3) - Vec3{0, 12, 0}) > 0);
    for (const Vertex* v : {&a, &b, &c}) {
      REQUIRE(std::abs(length(N(*v)) - 1) < 1e-5);
      REQUIRE(dot(N(*v), face) > 0.7);
      if (dot(N(*v), face) < 0.99) ++bent; else ++flat;
      REQUIRE(v->px >= bounds.min.x); REQUIRE(v->px <= bounds.max.x);
      REQUIRE(v->py >= bounds.min.y); REQUIRE(v->py <= bounds.max.y);
      REQUIRE(v->pz >= bounds.min.z); REQUIRE(v->pz <= bounds.max.z);
    }
  }
  REQUIRE(std::abs(area - 2720) < 0.01);
  REQUIRE(bent > 0); REQUIRE(flat > 0);
}

TEST_CASE("each rounding switch changes a brick's mesh, and all on is the default", "[mesh][data]") {
  const char* dir = std::getenv("BM_LDRAW_DIR");
  if (!dir) SKIP("BM_LDRAW_DIR is not set");
  const ldraw::Library lib(dir);
  const fs::path file = fs::temp_directory_path() / ("bmr_rounding_test_" + std::to_string(::getpid()) + ".ldr");
  { std::ofstream out(file); out << "1 4 0 0 0 1 0 0 0 1 0 0 0 1 3001.dat\n"; }
  const Model model = io::load(file, lib);
  fs::remove(file);
  const fs::path cacheDir = fs::temp_directory_path() / "bmr_mesh_test_cache";
  ldraw::FlattenOptions lowOptions;
  lowOptions.lowResPrimitives = true;
  ldraw::PartCache full(lib, cacheDir), low(lib, cacheDir, lowOptions);
  const auto meshOf = [&](Rounding r) {
    MeshLibrary meshes(model, full, low, r);
    const auto m = meshes.get("3001.dat", Detail::Full);
    return std::make_pair(m->vertices.size(), m->indices.size());
  };
  const auto standard = meshOf({});
  MeshLibrary defaults(model, full, low);
  const auto plain = defaults.get("3001.dat", Detail::Full);
  CHECK(std::make_pair(plain->vertices.size(), plain->indices.size()) == standard);  // all on is today's mesh
  CHECK(meshOf({.smoothCurves = false}).second < standard.second);   // 16-sided studs: fewer triangles
  CHECK(meshOf({.roundedEdges = false}).second < standard.second);   // no edge fillets
  CHECK(meshOf({.softStudRoots = false}) != standard);               // the stud base ring stays
  const auto bare = meshOf({false, false, false});
  CHECK(bare.second < meshOf({.smoothCurves = false}).second);
}
