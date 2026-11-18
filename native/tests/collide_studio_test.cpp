#include <catch2/catch_test_macros.hpp>

#include <algorithm>
#include <memory>
#include <thread>
#include <filesystem>
#include <vector>
#include "bm/collide/geometry_audit.h"
#include "bm/collide/world.h"
#include "bm/io.h"
#include "bm/plan/certify.h"

using namespace bm;
namespace fs = std::filesystem;

namespace {
fs::path studioFixture(const char* name) {
  return fs::path(BM_FIXTURES) / "studio" / name;
}

Xform at(double x) { return {Mat3::identity(), {x, 0, 0}}; }

struct Rig {
  ldraw::Library library{fs::path(BM_FIXTURES) / "lib"};
  ldraw::PartCache cache{library, fs::temp_directory_path() / "bm_studio_collision_cache"};
  collide::ShapeCache shapes;
};
}  // namespace

TEST_CASE("Studio custom subparts create real collider triangles", "[studio][collide][embedded]") {
  Rig r;
  const Model model = io::load(studioFixture("collision_clear.io"), r.library);
  REQUIRE(model.pieces().size() == 2);
  REQUIRE(model.report().missing.empty());
  REQUIRE(model.report().studioCustomPartsLoaded == 2);
  const auto mesh = model.mesh("validation-cube.dat", r.cache);
  REQUIRE(mesh->missing.empty());
  REQUIRE(mesh->triangles.size() == 36); // 6 quads, triangulated
  REQUIRE(model.library().isInline("s/cube_skin.dat"));

  const auto audit = collide::auditGeometry(model, r.cache, r.shapes);
  REQUIRE(audit.structurallyComplete());
  REQUIRE(audit.modelScopedParts == 1);
  REQUIRE(audit.instantiatedTriangles == 24);
  REQUIRE(audit.issues.empty());

  // A collision world must use the imported mesh, not a placeholder or an
  // empty global-library part. The free endpoints bracket a crossing.
  const collide::World world(model, r.cache, r.shapes);
  REQUIRE_FALSE(world.shape(0).nodes.empty());
  REQUIRE_FALSE(world.hits(world.shape(0), at(60)).has_value());
  REQUIRE(world.hits(world.shape(0), at(30)) == std::optional<uint32_t>{0});
  REQUIRE_FALSE(world.hits(world.shape(0), at(-160)).has_value());
  const auto crossing = world.sweep(world.shape(0), at(-160), at(60));
  REQUIRE(crossing.has_value());
  REQUIRE(*crossing > 0.4);
  REQUIRE(*crossing < 0.8);

  // The same continuous translation primitive used by the planner must stop
  // a placed piece before it travels through another imported custom part.
  uint32_t blocker = UINT32_MAX;
  const double clear = world.clearTravel({1}, {-1, 0, 0}, 120, nullptr, {}, &blocker);
  REQUIRE(clear > 75);
  REQUIRE(clear < 85);
  REQUIRE(blocker == 0);
}

TEST_CASE("Studio geometry participates in pair-overlap detection", "[studio][collide][embedded]") {
  Rig r;
  const Model model = io::load(studioFixture("collision_overlap.io"), r.library);
  connect::Graph emptyGraph;
  emptyGraph.isSegment.resize(model.pieces().size());
  const auto report = collide::findOverlaps(model, emptyGraph, r.cache, r.shapes);
  REQUIRE(report.tested == 1);
  REQUIRE(report.overlaps.size() == 1);
  REQUIRE(report.overlaps.front().a == 0);
  REQUIRE(report.overlaps.front().b == 1);
  REQUIRE_FALSE(report.overlaps.front().duplicate);
}

TEST_CASE("incomplete custom collision geometry is explicitly diagnosed", "[studio][collide][audit]") {
  Rig r;
  const Model model = io::load(studioFixture("collision_partial.io"), r.library);
  // The missing file is nested inside a .dat. Top-level expansion cannot
  // detect this, so a geometry audit must catch it before planner validation.
  REQUIRE(model.report().missing.empty());
  const auto audit = collide::auditGeometry(model, r.cache, r.shapes);
  REQUIRE_FALSE(audit.structurallyComplete());
  REQUIRE(audit.partsWithMissingDependencies == 1);
  REQUIRE(audit.partsWithoutCollisionShapes == 0); // partial shapes are dangerous
  REQUIRE(audit.issues.size() == 1);
  REQUIRE(audit.issues[0].modelScoped);
  REQUIRE(audit.issues[0].instances == 2);
  REQUIRE((audit.issues[0].missing == std::vector<std::string>{"missing-nested-part.dat"}));

  // The importer must expose parse errors inside embedded files as well,
  // without penalizing ordinary loads that do not request an audit.
  const Model malformed = io::load(studioFixture("collision_malformed.io"), r.library);
  REQUIRE(malformed.report().studioCustomPartSkippedLines == 1);
}

TEST_CASE("the independent plan certifier rejects flights through embedded geometry", "[studio][collide][certify]") {
  Rig r;
  const Model model = io::load(studioFixture("collision_clear.io"), r.library);
  connect::Graph graph;
  graph.groups = 2;
  graph.group = {0, 1};
  graph.isSegment = {0, 0};

  // Both pieces start from open air, with one placed before the other.
  // A safe second-piece flight stays on the far side of the first cube.
  bm::plan::Plan safe;
  bm::plan::Move first, second;
  first.unit.pieces = {0};
  first.path = {Xform::identity(), at(-280)};
  second.unit.pieces = {1};
  second.path = {Xform::identity(), at(280)};
  safe.moves = {first, second};
  const auto good = bm::plan::certify(model, graph, r.cache, r.shapes, safe);
  REQUIRE(good.ok());
  REQUIRE(good.certified == 2);

  // The same assembled model, but the second piece now travels *through*
  // the imported custom cube. Changing its flight must fail rule 2.
  bm::plan::Plan through = safe;
  through.moves[1].path[1] = at(-280);
  const auto bad = bm::plan::certify(model, graph, r.cache, r.shapes, through);
  REQUIRE_FALSE(bad.ok());
  REQUIRE(bad.crossings == 1);
  REQUIRE_FALSE(bad.moves[1].clear);
  REQUIRE(bad.moves[1].crossed == 0);
}

TEST_CASE("Studio model-scoped mesh and shape reuse is safe under concurrent reads", "[studio][collide][threads]") {
  Rig r;
  const Model model = io::load(studioFixture("collision_clear.io"), r.library);
  constexpr size_t workers = 8;
  std::vector<std::shared_ptr<const ldraw::Mesh>> meshes(workers);
  std::vector<std::shared_ptr<const collide::Shape>> shapes(workers);
  std::vector<std::thread> threads;
  for (size_t i = 0; i < workers; ++i)
    threads.emplace_back([&, i] {
      meshes[i] = model.mesh("validation-cube.dat", r.cache);
      shapes[i] = r.shapes.get(meshes[i]);
    });
  for (auto& thread : threads) thread.join();
  REQUIRE_FALSE(shapes.front()->nodes.empty());
  for (size_t i = 1; i < workers; ++i) {
    REQUIRE(meshes[i] == meshes.front());
    REQUIRE(shapes[i] == shapes.front());
  }
}
