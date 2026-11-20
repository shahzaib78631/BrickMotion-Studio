#include <catch2/catch_approx.hpp>
#include <catch2/catch_test_macros.hpp>
#include <chrono>
#include <filesystem>
#include <fstream>
#include <thread>
#include "animation_authoring.h"
#include "animation_keys.h"
#include "bmapp/assembly_inspection.h"
#include "bmapp/viewport.h"
#include "session_impl.h"

namespace {

void blankWithParts(bmapp::Session& session) {
  REQUIRE(session.newBlank().ok);
  REQUIRE(session.placePart("3005.dat", 4, {{}, {0, -24, 0}}, 0, session.generation(), session.version()).refused.empty());
  REQUIRE(session.insertStep(1).refused.empty());
  REQUIRE(session.placePart("3024.dat", 14, {{}, {0, -32, 0}}, 1, session.generation(), session.version()).refused.empty());
  REQUIRE(session.pieceCount() == 2);
}

void finishPlan(bmapp::Viewport& viewport) {
  const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(25);
  while (viewport.planState() == bmapp::PlanState::Planning && std::chrono::steady_clock::now() < deadline) {
    viewport.draw(nullptr);
    std::this_thread::sleep_for(std::chrono::milliseconds(5));
  }
  INFO(viewport.planError());
  REQUIRE(viewport.planState() == bmapp::PlanState::Ready);
}
}  // namespace

TEST_CASE("authored keys round-trip independently of geometry and remain a single gesture", "[bmapp][animation]") {
  bmapp::Session model;
  blankWithParts(model);
  const auto version = model.version();
  const auto placement = model.impl().model->pieces()[0].world;
  const auto previous = model.undoDepth();
  using C = bmapp::KeyChannel;
  using I = bmapp::KeyInterpolation;
  CHECK(model.setKeys(0, {{C::PositionX, 1, 0, I::Linear}}, false).keyframesOnly);
  CHECK(model.setKeys(0, {{C::PositionX, 25, 2, I::Linear}}, true).keyframesOnly);
  CHECK(model.setKeys(0, {{C::PositionX, 25, 4, I::Linear}}, true).keyframesOnly);
  model.endGesture();
  REQUIRE(model.keyTracks().size() == 1);
  CHECK(model.keyValue(0, C::PositionX, 13) == Catch::Approx(2));
  CHECK(model.impl().model->pieces()[0].world.t == placement.t);
  CHECK(model.undoDepth() == previous + 2);
  CHECK(model.version() == version + 3);
  model.undo();
  REQUIRE(model.keyTracks().front().keys.size() == 1);
  model.redo();
  CHECK(model.keyValue(0, C::PositionX, 13) == Catch::Approx(2));
  const auto path = std::filesystem::temp_directory_path() /
    ("bmapp-keys-" + std::to_string(std::chrono::steady_clock::now().time_since_epoch().count()) + ".brickmotion");
  std::ofstream(path) << model.projectBytes();
  bmapp::Session reopened;
  const auto opened = reopened.open(path.string());
  INFO(opened.error);
  REQUIRE(opened.ok);
  std::filesystem::remove(path);
  REQUIRE(reopened.keyTracks().size() == 1);
  CHECK(reopened.keyValue(0, C::PositionX, 13) == Catch::Approx(2));
  CHECK(reopened.impl().model->pieces()[0].world.t == placement.t);
}

TEST_CASE("build playback keeps its paths through a timing edit and retains hand keys", "[bmapp][animation][viewport]") {
  bmapp::Session model;
  blankWithParts(model);
  bmapp::Viewport viewport(model);
  if (!viewport.ok()) SKIP("no Metal device");
  viewport.resize(200, 150, 1);
  viewport.setPreferences({});
  viewport.requestPlan();
  finishPlan(viewport);
  const auto initial = viewport.buildTimeline();
  REQUIRE(initial.flights.size() == 2);
  CHECK(initial.buildStart > 0);
  CHECK(initial.duration > initial.buildEnd);
  const auto step = initial.flights.front().step;
  auto fields = model.stepFields(step);
  fields.pauseAfter = 2;
  const auto change = model.setStepFields(step, fields, false);
  CHECK_FALSE(change.structure);
  viewport.draw(nullptr);
  finishPlan(viewport);
  CHECK(viewport.buildTimeline().duration >= initial.duration + 1.9);
  auto scene = model.keyScene();
  scene.buildLinked = true;
  REQUIRE(model.setKeyScene(scene).keyframesOnly);
  viewport.draw(nullptr);
  CHECK(viewport.planState() == bmapp::PlanState::Ready);
  viewport.useKeyframes(true);
  const auto keys = viewport.bakeFlight(0);
  REQUIRE_FALSE(keys.empty());
  REQUIRE(model.setBakedKeys(0, keys).keyframesOnly);
  viewport.draw(nullptr);
  CHECK(viewport.planState() == bmapp::PlanState::Ready);
  CHECK(model.keyTracks().front().baked);
  CHECK(viewport.length() == Catch::Approx(static_cast<double>(scene.last - scene.first) / scene.fps));
  model.undo();
  CHECK(model.keyTracks().empty());
}

TEST_CASE("waiting orientation round-trips without changing the seated transform", "[bmapp][animation]") {
  bmapp::Session session;
  blankWithParts(session);
  const auto before = session.impl().model->pieces()[0].world;
  const auto version = session.version();
  REQUIRE(session.turnWaitingPart(0, 90).version == version + 1);
  CHECK(session.undoName() == "Turn Waiting Part");
  CHECK(session.impl().model->pieces()[0].world.t == before.t);
  CHECK(session.impl().model->pieces()[0].world.r.m[0] == before.r.m[0]);

  bmapp::Session copy;
  REQUIRE(copy.openBytes(session.projectBytesWithPreview(""), "waiting.brickmotion").ok);
  const auto authored = bmapp::animationAuthoring(copy);
  REQUIRE(authored.waitingTurns.size() == 1);
  CHECK(authored.waitingTurns.front().second == 90);
  session.undo();
  CHECK(bmapp::animationAuthoring(session).waitingTurns.empty());

  bm::plan::Plan plan;
  bm::plan::Timeline timeline;
  auto& flight = timeline.flights.emplace_back();
  flight.pieces = {0};
  flight.startFrame = 30;
  flight.frames = 50;
  flight.liftAt = 10;
  flight.pathAt = 30;
  flight.staging.t = {120, 0, 0};
  flight.route = {{120, 0, 0}, {120, -40, 0}, {0, -40, 0}, {0, 0, 0}};
  flight.routeAt = {0, 40, 160, 200};
  flight.waypoints = {flight.staging, {}};
  flight.phases = {{0, 10, 0, 40}, {10, 20, 40, 160}, {30, 20, 160, 200}};
  bm::collide::ShapeCache shapes;
  bm::CancelToken cancel;
  std::vector<std::string> notes;
  auto& state = copy.impl();
  bmapp::orientWaitingParts(*state.model, plan, timeline, authored, *state.full, shapes, notes, cancel);
  REQUIRE(notes.empty());
  CHECK(bm::plan::poseAt(flight, 5).r.m[2] == Catch::Approx(1));
  CHECK(bm::plan::poseAt(flight, 60).r.m[0] == Catch::Approx(1));
  CHECK(bm::plan::poseAt(flight, 80).t == bm::Vec3{});
}

TEST_CASE("assembly connections can detach along the allowed release in one edit", "[bmapp][placement][joints]") {
  bmapp::Session model;
  blankWithParts(model);
  const std::unique_ptr<bmapp::AssemblyInspection> reader(bmapp::AssemblyInspection::capture(&model));
  REQUIRE(reader);
  const auto report = reader->inspect({1}, false, true);
  REQUIRE(report.error.empty());
  REQUIRE(report.joints.size() == 1);
  CHECK(report.overlaps.empty());
  const auto action = reader->changeJoint(0, 1, 0, true);
  INFO(action.error);
  REQUIRE(action.error.empty());
  CHECK(action.pieces == bmapp::PieceList{1});
  CHECK(action.pose.position.y < -36);
  const auto applied = model.placeMoved(action.pieces, action.pivot, action.pose, model.generation(), model.version());
  REQUIRE(applied.refused.empty());
  CHECK(model.impl().model->pieces()[1].world.t.y == Catch::Approx(action.pose.position.y));
  model.undo();
  CHECK(model.impl().model->pieces()[1].world.t.y == -32);
}

TEST_CASE("moving a single leaf reuses the other independent insertion paths", "[bmapp][animation][viewport]") {
  bmapp::Session model;
  blankWithParts(model);
  REQUIRE(model.placePart("3005.dat", 1, {{}, {160, -24, 0}}, 1, model.generation(), model.version()).refused.empty());
  bmapp::Viewport viewport(model);
  if (!viewport.ok()) SKIP("no Metal device");
  viewport.resize(200, 150, 1);
  viewport.setPreferences({});
  viewport.requestPlan();
  finishPlan(viewport);
  const auto before = viewport.buildTimeline();
  REQUIRE(before.flights.size() == 3);
  model.move({2}, {2, 0, 0}, false);
  viewport.draw(nullptr);
  finishPlan(viewport);
  const auto after = viewport.buildTimeline();
  CHECK(after.version == model.version());
  CHECK(after.flights.size() == before.flights.size());
  CHECK(after.reusedMoves >= 1);
}
