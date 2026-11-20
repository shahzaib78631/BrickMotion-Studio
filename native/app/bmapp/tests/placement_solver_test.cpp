#include <catch2/catch_approx.hpp>
#include <catch2/catch_test_macros.hpp>
#include <array>
#include <chrono>
#include <filesystem>
#include "bmapp/session.h"
#include "placement_solver.h"
#include "session_impl.h"
#include "structure_fixture.h"

namespace {

using namespace bmapp;
using bm::Vec3;

bm::Piece brick(const char* id, Vec3 at) {
  bm::Piece piece;
  piece.id = id;
  piece.part = "3005.dat";
  piece.world.t = at;
  return piece;
}

struct Library {
  std::filesystem::path directory = Session::ldrawDirectory();
  bm::ldraw::Library ldraw{directory};
  bm::ldraw::PartCache parts{ldraw, bm::ldraw::PartCache::defaultDirectory()};
  bm::connect::ShadowLibrary shadow{std::filesystem::path(BM_REPO) / "vendor" / "LDCadShadowLibrary"};
  bm::connect::ConnectorDb connectors{ldraw, shadow};
  bm::collide::ShapeCache shapes;

  bm::Model model(std::vector<bm::Piece> pieces) const {
    return bm::Model({std::move(pieces), {}, {}, ldraw, {}});
  }
};

PlacementRequest plate(Vec3 aim = {}) {
  return {.part = "3024.dat", .freePose = {{}, {aim.x, aim.y - 8, aim.z}}, .point = aim, .reach = 10,
          .grip = {}, .retainedSite = {}, .moving = {}};
}

}  // namespace

TEST_CASE("placement seats a plate on a stud and preserves a mirrored pose", "[bmapp][placement]") {
  Library lib;
  const auto model = lib.model({brick("base", {})});
  PlacementSolver solver(model, lib.parts, lib.connectors, lib.shapes);
  REQUIRE(solver.gripCount("3024.dat") > 1);
  const auto at = solver.surface(0, {0.7, -100, 1.6}, {0.7, 100, 1.6});
  REQUIRE(at);
  CHECK(at->y == Catch::Approx(-4).margin(0.01));
  CHECK_FALSE(solver.surface(0, {100, -100, 0}, {100, 100, 0}));

  auto request = plate(*at);
  const auto placement = solver.solve(request);
  REQUIRE(placement);
  const auto* snap = std::get_if<PlacedOnConnector>(&*placement);
  REQUIRE(snap);
  CHECK(snap->pose.t.y == Catch::Approx(-8));
  CHECK(snap->site.piece == 0);
  CHECK(snap->pose.t.x == Catch::Approx(0).margin(1e-6));
  CHECK(snap->pose.t.z == Catch::Approx(0).margin(1e-6));

  request.freePose.r.m[0] = -1;
  const auto mirrored = solver.solve(request);
  REQUIRE(mirrored);
  REQUIRE(std::holds_alternative<PlacedOnConnector>(*mirrored));
  CHECK(bm::determinant(std::get<PlacedOnConnector>(*mirrored).pose.r) == Catch::Approx(-1));
}

TEST_CASE("placement refuses an occupied seat and skips the moving piece", "[bmapp][placement]") {
  Library lib;
  const auto model = lib.model({brick("base", {}), brick("top", {0, -24, 0})});
  PlacementSolver solver(model, lib.parts, lib.connectors, lib.shapes);
  auto request = plate();
  request.part = "3005.dat";
  request.freePose.t = {0, -24, 0};
  request.reach = 2;
  const auto occupied = solver.solve(request);
  REQUIRE(occupied);
  REQUIRE(std::holds_alternative<PlacementBlocked>(*occupied));
  CHECK(std::get<PlacementBlocked>(*occupied).blocker == 1);

  const std::array<uint32_t, 1> moving{1};
  request.moving = moving;
  const auto moved = solver.solve(request);
  REQUIRE(moved);
  REQUIRE(std::holds_alternative<PlacedOnConnector>(*moved));
  CHECK(std::get<PlacedOnConnector>(*moved).site.piece == 0);

  request.snap = false;
  request.moving = {};
  const auto bypass = solver.solve(request);
  REQUIRE(bypass);
  CHECK(std::holds_alternative<PlacementBlocked>(*bypass));

  request.freePose.t.x = 80;
  const auto free = solver.solve(request);
  REQUIRE(free);
  CHECK(std::holds_alternative<PlacedFreely>(*free));
}

TEST_CASE("placement holds its target until the pointer leaves the release radius", "[bmapp][placement]") {
  Library lib;
  const auto model = lib.model({brick("left", {}), brick("right", {20, 0, 0})});
  PlacementSolver solver(model, lib.parts, lib.connectors, lib.shapes);
  const auto left = solver.solve(plate());
  REQUIRE(left);
  REQUIRE(std::holds_alternative<PlacedOnConnector>(*left));
  const auto site = std::get<PlacedOnConnector>(*left).site;
  REQUIRE(site.piece == 0);

  auto request = plate({12, 0, 0});
  request.retainedSite = site;
  const auto held = solver.solve(request);
  REQUIRE(held);
  REQUIRE(std::holds_alternative<PlacedOnConnector>(*held));
  CHECK(std::get<PlacedOnConnector>(*held).site == site);
  request.point.x = 16;
  const auto released = solver.solve(request);
  REQUIRE(released);
  REQUIRE(std::holds_alternative<PlacedOnConnector>(*released));
  CHECK(std::get<PlacedOnConnector>(*released).site.piece == 1);
}

TEST_CASE("placing a part is one undoable edit in the focused build step", "[bmapp][placement]") {
  Session session;
  REQUIRE(session.open(structure::fixture().string()).ok);
  const auto root = session.impl().model->pieces();
  const auto beforeFocus = session.version();
  session.focus({"Pair"});
  REQUIRE(session.pieceCount() == 2);

  PartPose pose;
  pose.position = {34, -64, 3};
  pose.rotation.m[0] = -1;
  CHECK_FALSE(session.placePart("3024.dat", 4, pose, 0, session.generation(), beforeFocus).refused.empty());
  REQUIRE(session.placePart("3024.dat", 4, pose, 0, session.generation(), session.version()).refused.empty());
  CHECK(session.pieceCount() == 3);
  REQUIRE(session.selection().size() == 1);
  const auto& placed = session.impl().model->pieces()[session.selection().front()];
  CHECK(placed.part == "3024.dat");
  CHECK(placed.color == 4);
  CHECK(placed.step == 0);
  CHECK(placed.world.t.x == 34);
  CHECK(bm::determinant(placed.world.r) == -1);
  CHECK(session.undoDepth() == 1);
  CHECK(session.undoName() == "Place Part");
  session.undo();
  CHECK(session.pieceCount() == 2);
  session.redo();
  CHECK(session.pieceCount() == 3);

  Session reopened;
  REQUIRE(reopened.openBytes(session.projectBytes(), "placed.brickmotion").ok);
  CHECK(reopened.pieceCount() == root.size() + 2);
  for (const auto& old : root) {
    const auto& pieces = reopened.impl().model->pieces();
    const auto kept = std::find_if(pieces.begin(), pieces.end(), [&](const auto& piece) { return piece.id == old.id; });
    REQUIRE(kept != pieces.end());
    CHECK(bm::length(kept->world.t - old.world.t) < 1e-6);
  }
}

TEST_CASE("the first placement makes an untitled model editable", "[bmapp][placement]") {
  Session session;
  REQUIRE(session.newBlank().ok);
  CHECK(session.pieceCount() == 0);
  CHECK(session.stepCount() == 1);
  CHECK_FALSE(session.dirty());
  REQUIRE(session.placePart("3024.dat", 4, {}, -1, session.generation(), session.version()).refused.empty());
  CHECK(session.pieceCount() == 1);
  CHECK(session.dirty());
  session.undo();
  CHECK(session.pieceCount() == 0);
  CHECK_FALSE(session.dirty());
  REQUIRE(session.placePart("missing.dat", 4, {}, -1, session.generation(), session.version()).refused.size() > 0);
  CHECK(session.pieceCount() == 0);
}

TEST_CASE("a drag preview matches the committed move in rotated shared uses", "[bmapp][placement]") {
  Session session;
  REQUIRE(session.open(structure::fixture().string()).ok);
  const auto repeated = structure::pieces(session, "p1");
  REQUIRE(repeated.size() == 2);
  session.rotate(session.usePieces(repeated.back()), {0, 1, 0}, 90, {}, false);
  const auto source = session.impl().model->pieces();
  const auto anchor = repeated.front();
  const auto moving = piecesAfterMove(session.impl(), {anchor}, anchor);
  REQUIRE(moving.size() == 2);

  const bm::Xform delta{{}, {18, -1, 4}};
  const auto pose = delta * source[anchor].world;
  PartPose out;
  out.position = {pose.t.x, pose.t.y, pose.t.z};
  std::copy_n(pose.r.m, 9, out.rotation.m);
  const auto before = session.undoDepth();
  REQUIRE(session.placeMoved({anchor}, anchor, out, session.generation(), session.version()).refused.empty());
  CHECK(session.undoDepth() == before + 1);
  CHECK(session.undoName() == "Move Piece");
  for (const auto& occurrence : moving) {
    const auto p = occurrence.piece;
    const auto expected = occurrence.apply(delta, source[p].world);
    CHECK(bm::length(session.impl().model->pieces()[p].world.t - expected.t) < 1e-6);
  }
  session.undo();
  for (auto p : repeated) CHECK(session.impl().model->pieces()[p].world.t == source[p].world.t);
}

TEST_CASE("placement index and queries on 10030 x4", "[bmapp][placement][.slow]") {
  const auto modelPath = std::filesystem::temp_directory_path() / "bmapp_rows_big" / "10030-x4.ldr";
  if (!std::filesystem::exists(modelPath)) SKIP("Run the 10030 x4 rows benchmark to build the reference model.");
  Library lib;
  Session session;
  REQUIRE(session.open(modelPath.string()).ok);
  const auto& model = *session.impl().model;
  REQUIRE(model.pieces().size() > 12000);
  using Clock = std::chrono::steady_clock;
  const auto t0 = Clock::now();
  PlacementSolver solver(model, lib.parts, lib.connectors, lib.shapes);
  const auto built = Clock::now();
  std::vector<double> queries;
  for (size_t p = 0; p < model.pieces().size(); p += 97) {
    const auto start = Clock::now();
    (void)solver.solve(plate(model.pieces()[p].world.t));
    queries.push_back(std::chrono::duration<double, std::milli>(Clock::now() - start).count());
  }
  std::sort(queries.begin(), queries.end());
  const double p95 = queries[queries.size() * 95 / 100];
  const double buildMs = std::chrono::duration<double, std::milli>(built - t0).count();
  WARN("index " << buildMs << " ms, candidate p95 " << p95 << " ms");
  CHECK(p95 < 8.33);
}
