#include <catch2/catch_approx.hpp>
#include <catch2/catch_test_macros.hpp>
#include <chrono>
#include <cmath>
#include <filesystem>
#include <fstream>
#include <thread>
#include <nlohmann/json.hpp>
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

TEST_CASE("Standard Preview uses authored steps and can return to the native planner", "[bmapp][animation][viewport]") {
  bmapp::Session model;
  blankWithParts(model);
  const auto version = model.version();
  bmapp::Viewport viewport(model);
  if (!viewport.ok()) SKIP("no Metal device");
  viewport.resize(200, 150, 1);
  viewport.setPreferences({});
  viewport.regeneratePlan(true);
  finishPlan(viewport);
  const auto preview = viewport.buildTimeline();
  CHECK(preview.standardPreview);
  CHECK_FALSE(preview.notes.empty());
  REQUIRE(preview.flights.size() == model.pieceCount());
  CHECK(preview.flights.front().step < preview.flights.back().step);
  CHECK(model.version() == version);

  viewport.regeneratePlan();
  finishPlan(viewport);
  const auto native = viewport.buildTimeline();
  CHECK_FALSE(native.standardPreview);
  CHECK(native.flights.size() == model.pieceCount());
  CHECK(model.version() == version);
}

TEST_CASE("baking the whole build preserves nested leaf tracks and detaches in one undo", "[bmapp][animation][viewport]") {
  bmapp::Session model;
  blankWithParts(model);
  REQUIRE(model.placePart("3005.dat", 1, {{}, {40, -24, 0}}, 1, model.generation(), model.version()).refused.empty());
  REQUIRE(model.makeSubmodel({1, 2}, "Rotor").refused.empty());
  REQUIRE(model.pieceCount() == 3);
  bmapp::Viewport viewport(model);
  if (!viewport.ok()) SKIP("no Metal device");
  viewport.resize(200, 150, 1);
  viewport.setPreferences({});
  viewport.requestPlan();
  finishPlan(viewport);
  auto scene = model.keyScene();
  scene.buildLinked = true;
  scene.buildStart = scene.first + 5;
  REQUIRE(model.setKeyScene(scene).keyframesOnly);
  using C = bmapp::KeyChannel;
  using I = bmapp::KeyInterpolation;
  const uint32_t nested = model.isLocalPiece(0) ? 1 : 0;
  REQUIRE_FALSE(model.isLocalPiece(nested));
  REQUIRE(model.usePieces(nested).size() == 2);
  REQUIRE(model.setKeys(nested, {{C::PositionX, 51, 7, I::Linear}}, false, true).keyframesOnly);
  CHECK_FALSE(model.hasEditableFlightKeys(nested));
  REQUIRE(model.setKeys(0, {{C::PositionX, 51, 4, I::Linear}}, false).keyframesOnly);

  using Capture = std::unique_ptr<bmapp::FlightBake, decltype(&bmappReleaseFlightBake)>;
  Capture stale(viewport.captureFlightBake({}, true), bmappReleaseFlightBake);
  REQUIRE(stale);
  CHECK(stale->replacesKeys());
  REQUIRE(stale->prepare().error.empty());
  REQUIRE(model.setKeys(0, {{C::PositionX, 51, 5, I::Linear}}, false).keyframesOnly);
  CHECK_FALSE(model.applyFlightBake(stale.get()).refused.empty());
  CHECK(model.keyScene().buildLinked);
  CHECK(model.keyValue(0, C::PositionX, 51) == 5);

  const auto undo = model.undoDepth();
  Capture bake(viewport.captureFlightBake({}, true), bmappReleaseFlightBake);
  REQUIRE(bake);
  const auto result = bake->prepare();
  INFO(result.error);
  REQUIRE(result.error.empty());
  CHECK(result.flights == 3);
  REQUIRE(model.applyFlightBake(bake.get()).keyframesOnly);
  CHECK(model.undoDepth() == undo + 1);
  CHECK_FALSE(model.keyScene().buildLinked);
  const auto baked = model.keyTracks();
  REQUIRE(baked.size() == 4);
  for (const auto& track : baked) {
    if (!track.baked) {
      CHECK(track.object == nested);
      CHECK(track.members == model.usePieces(nested));
      CHECK(bmapp::sampleKeys(track, C::PositionX, 51) == 7);
      continue;
    }
    CHECK(track.members == bmapp::PieceList{track.object});
    CHECK(bmapp::sampleKeys(track, C::Visibility, scene.first) == 0);
    CHECK(bmapp::sampleKeys(track, C::Visibility, model.keyScene().last) == 1);
  }

  bmapp::Session loaded;
  REQUIRE(loaded.openBytes(model.projectBytes(), "Test.brickmotion").ok);
  CHECK_FALSE(loaded.keyScene().buildLinked);
  REQUIRE(loaded.keyTracks().size() == 4);
  REQUIRE_FALSE(loaded.isLocalPiece(nested));
  CHECK(loaded.hasEditableFlightKeys(nested));
  REQUIRE(loaded.setKeys(nested, {{C::PositionX, 51, 9, I::Linear}}, false).keyframesOnly);
  CHECK(loaded.keyValue(nested, C::PositionX, 51) == 9);
  REQUIRE(loaded.setKeys(nested, {{C::PositionX, 51, 8, I::Linear}}, false, true).keyframesOnly);
  CHECK(loaded.keyValue(nested, C::PositionX, 51, true) == 8);
  CHECK(loaded.keyValue(nested, C::PositionX, 51) == 9);
  const bmapp::KeyRowPicks rows{{nested, 51, true}, {nested, 51, false}};
  REQUIRE(loaded.moveKeyRows(rows, 4).keyframesOnly);
  CHECK(loaded.keyValue(nested, C::PositionX, 55, true) == 8);
  CHECK(loaded.keyValue(nested, C::PositionX, 55) == 9);
  REQUIRE(loaded.returnFlightToPlanner(nested).keyframesOnly);
  CHECK_FALSE(loaded.hasEditableFlightKeys(nested));
  CHECK(loaded.keyScene().buildLinked);
  CHECK(loaded.keyTracks().size() == 3);
  CHECK(loaded.keyValue(nested, C::PositionX, 55, true) == 8);
  loaded.undo();
  CHECK(loaded.hasEditableFlightKeys(nested));
  CHECK_FALSE(loaded.keyScene().buildLinked);

  model.undo();
  CHECK(model.keyScene().buildLinked);
  REQUIRE(model.keyTracks().size() == 2);
  CHECK(model.keyValue(nested, C::PositionX, 51, true) == 7);
  CHECK(model.keyValue(0, C::PositionX, 51) == 5);
}

TEST_CASE("motion review groups sampled crossings into independently navigable intervals", "[bmapp][animation][viewport]") {
  bmapp::Session model;
  REQUIRE(model.newBlank().ok);
  for (const double x : {-60.0, 0.0, 60.0})
    REQUIRE(model.placePart("3005.dat", 4, {{}, {x, -24, 0}}, 0, model.generation(), model.version()).refused.empty());
  REQUIRE(model.pieceCount() == 3);
  auto scene = model.keyScene();
  scene.last = 10;
  REQUIRE(model.setKeyScene(scene).keyframesOnly);
  using C = bmapp::KeyChannel;
  using I = bmapp::KeyInterpolation;
  REQUIRE(model.setKeys(0, {
    {C::PositionX, 1, 0, I::Hold}, {C::PositionX, 2, 2.5, I::Hold}, {C::PositionX, 4, 0, I::Hold},
    {C::PositionX, 5, 5.5, I::Hold}, {C::PositionX, 7, 0, I::Hold},
    {C::PositionY, 1, -0.25, I::Hold}, {C::PositionZ, 1, -0.25, I::Hold}
  }, false).keyframesOnly);
  bmapp::Viewport viewport(model);
  if (!viewport.ok()) SKIP("no Metal device");
  viewport.resize(200, 150, 1);
  viewport.useKeyframes(true);
  const std::unique_ptr<bmapp::MotionAudit, decltype(&bmappReleaseMotionAudit)>
      audit(viewport.auditMotion(0), bmappReleaseMotionAudit);
  REQUIRE(audit);
  const auto result = audit->check();
  INFO(result.error);
  REQUIRE(result.error.empty());
  CHECK(result.testedFrames == 10);
  CHECK(result.intervals == 2);
  REQUIRE(result.contacts.size() == 2);
  CHECK(result.contacts[0].b == 1);
  CHECK(result.contacts[0].firstFrame == 2);
  CHECK(result.contacts[0].lastFrame == 3);
  CHECK(result.contacts[1].b == 2);
  CHECK(result.contacts[1].firstFrame == 5);
  CHECK(result.contacts[1].lastFrame == 6);
}

TEST_CASE("selected keyframes move together as one edit without overwriting each other", "[bmapp][animation]") {
  bmapp::Session model;
  blankWithParts(model);
  using C = bmapp::KeyChannel;
  using I = bmapp::KeyInterpolation;
  const bmapp::KeyList keys{{C::PositionX, 10, 2, I::Linear}, {C::PositionX, 15, 4, I::Smooth},
                            {C::RotationY, 10, 25, I::Hold}};
  REQUIRE(model.setKeys(0, keys, false).refused.empty());
  const size_t depth = model.undoDepth();
  CHECK_FALSE(model.moveKeys(0, keys, -40).refused.empty());
  CHECK(model.undoDepth() == depth);
  REQUIRE(model.moveKeys(0, keys, 5).refused.empty());
  CHECK(model.undoDepth() == depth + 1);
  CHECK(model.keyValue(0, C::PositionX, 15) == 2);
  CHECK(model.keyValue(0, C::PositionX, 20) == 4);
  CHECK(model.keyValue(0, C::RotationY, 15) == 25);
  model.undo();
  CHECK(model.keyValue(0, C::PositionX, 10) == 2);
  CHECK(model.keyValue(0, C::PositionX, 15) == 4);
}

TEST_CASE("keyframe columns can be moved or deleted across objects in a single edit", "[bmapp][animation]") {
  bmapp::Session model;
  blankWithParts(model);
  using C = bmapp::KeyChannel;
  using I = bmapp::KeyInterpolation;
  REQUIRE(model.setKeys(0, {{C::PositionX, 19, 4, I::Linear}, {C::PositionY, 19, 6, I::Hold}}, false).keyframesOnly);
  REQUIRE(model.setKeys(1, {{C::PositionZ, 23, 3, I::Linear}, {C::Visibility, 23, 0, I::Hold}}, false).keyframesOnly);
  const auto previous = model.undoDepth();
  CHECK_FALSE(model.moveKeyRows({{0, 19}, {1, 24}}, 12).refused.empty());
  CHECK(model.undoDepth() == previous);
  REQUIRE(model.moveKeyRows({{0, 19}, {1, 23}}, 12).keyframesOnly);
  CHECK(model.undoDepth() == previous + 1);
  for (const auto& track : model.keyTracks())
    for (const auto& key : track.keys) CHECK(key.frame == (track.object == 0 ? 31 : 35));
  REQUIRE(model.removeKeyRows({{0, 31}, {1, 35}}).keyframesOnly);
  CHECK(model.keyTracks().empty());
  model.undo();
  CHECK(model.keyTracks().size() == 2);
  model.undo();
  for (const auto& track : model.keyTracks())
    for (const auto& key : track.keys) CHECK(key.frame == (track.object == 0 ? 19 : 23));
}

TEST_CASE("a part moved onto one built later is not reused where it would float", "[bmapp][animation][viewport]") {
  bmapp::Session model;
  blankWithParts(model);
  REQUIRE(model.placePart("3005.dat", 1, {{}, {80, -24, 0}}, 0, model.generation(), model.version()).refused.empty());
  REQUIRE(model.placePart("3005.dat", 2, {{}, {200, -24, 0}}, 1, model.generation(), model.version()).refused.empty());
  const auto& pieces = model.impl().model->pieces();
  const auto early = static_cast<uint32_t>(std::find_if(pieces.begin(), pieces.end(), [](const auto& p) {
    return p.world.t.x == 80; }) - pieces.begin());
  REQUIRE(early < pieces.size());
  REQUIRE(pieces[early].step == 0);
  bmapp::Viewport viewport(model);
  if (!viewport.ok()) SKIP("no Metal device");
  viewport.resize(200, 150, 1);
  viewport.setPreferences({});
  viewport.requestPlan();
  finishPlan(viewport);
  // Onto the step-1 brick: in its old place in the order nothing would hold it up.
  model.move({early}, {120, -24, 0}, false);
  viewport.draw(nullptr);
  finishPlan(viewport);
  const auto after = viewport.buildTimeline();
  CHECK(after.version == model.version());
  CHECK(after.reusedMoves == 0);
}

TEST_CASE("sequence trims persist as project settings and retime the existing paths", "[bmapp][animation][viewport]") {
  bmapp::Session model;
  blankWithParts(model);
  bmapp::Viewport viewport(model);
  if (!viewport.ok()) SKIP("no Metal device");
  viewport.resize(200, 150, 1);
  viewport.setPreferences({});
  viewport.requestPlan();
  finishPlan(viewport);
  const auto initial = viewport.buildTimeline();
  using Segment = bmapp::SequenceSegment;
  CHECK_FALSE(model.setSequenceDuration(Segment::Intro, 2.2).structure);
  CHECK_FALSE(model.setSequenceDuration(Segment::Build, 8.5).structure);
  CHECK_FALSE(model.setSequenceDuration(Segment::Hero, 0.7).structure);
  viewport.draw(nullptr);
  finishPlan(viewport);
  const auto result = viewport.buildTimeline();
  CHECK(result.buildStart == Catch::Approx(2.2));
  CHECK(result.buildEnd - result.buildStart == Catch::Approx(8.5));
  CHECK(result.duration - result.buildEnd == Catch::Approx(0.7));
  CHECK(result.flights.size() == initial.flights.size());
  CHECK(result.reusedMoves > 0);
  bmapp::Session reopened;
  REQUIRE(reopened.openBytes(model.projectBytes(), "trimmed.brickmotion").ok);
  const auto style = bmapp::animationAuthoring(reopened).style;
  CHECK(style.introSeconds == 2.2);
  CHECK(style.buildSeconds == 8.5);
  CHECK(style.outroSeconds == 0.7);
  model.undo();
  CHECK(bmapp::animationAuthoring(model).style.outroSeconds == -1);
}

TEST_CASE("opening a build flight adds editable keys and links the build in one undo", "[bmapp][animation][viewport]") {
  bmapp::Session model;
  blankWithParts(model);
  bmapp::Viewport viewport(model);
  if (!viewport.ok()) SKIP("no Metal device");
  viewport.resize(200, 150, 1);
  viewport.setPreferences({});
  viewport.requestPlan();
  finishPlan(viewport);
  auto scene = model.keyScene();
  CHECK_FALSE(scene.buildLinked);
  scene.buildLinked = true;
  scene.buildStart = scene.first;
  scene.last += 20;
  const auto keys = viewport.bakeFlightInScene(0, scene);
  REQUIRE_FALSE(keys.empty());
  const auto depth = model.undoDepth();
  REQUIRE(model.editBuildFlight(0, keys, scene).keyframesOnly);
  CHECK(model.undoDepth() == depth + 1);
  CHECK(model.keyScene().buildLinked);
  CHECK(model.keyScene().last == scene.last);
  REQUIRE(model.keyTracks().size() == 1);
  CHECK(model.keyTracks().front().baked);
  model.undo();
  CHECK_FALSE(model.keyScene().buildLinked);
  CHECK(model.keyTracks().empty());
  model.redo();
  REQUIRE(model.returnFlightToPlanner(0).keyframesOnly);
  CHECK(model.keyTracks().empty());
  model.undo();
  REQUIRE(model.keyTracks().size() == 1);
  CHECK(model.keyTracks().front().baked);
}

TEST_CASE("edited flight poses hand back to Build and preserve the installed seat", "[bmapp][animation][viewport]") {
  bmapp::Session model;
  blankWithParts(model);
  bmapp::Viewport viewport(model);
  if (!viewport.ok()) SKIP("no Metal device");
  using C = bmapp::KeyChannel;
  using I = bmapp::KeyInterpolation;
  REQUIRE(model.setBakedKeys(0, {{C::PositionX, 10, 3, I::Linear}, {C::PositionX, 40, 0, I::Linear}}).keyframesOnly);
  const auto route = viewport.editedFlightRoute(0);
  REQUIRE(route.size() >= 2);
  CHECK(route.front().position.x == Catch::Approx(60));
  CHECK(route.back().position.x == 0);
  const auto depth = model.undoDepth();
  REQUIRE(model.useFlightInBuild(0, route).refused.empty());
  CHECK(model.undoDepth() == depth + 1);
  CHECK(model.keyTracks().empty());
  CHECK_FALSE(bmapp::animationAuthoring(model).constraints.flight[0].empty());
  model.undo();
  REQUIRE(model.keyTracks().size() == 1);
  CHECK(model.keyTracks().front().baked);
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
  model.undo();
  viewport.draw(nullptr);
  finishPlan(viewport);
  const auto restored = viewport.buildTimeline();
  CHECK(restored.reusedSnapshot);
  CHECK(restored.duration == Catch::Approx(before.duration));
}

TEST_CASE("project staging is persisted and undo restores the earlier layout", "[bmapp][animation]") {
  bmapp::Session session;
  blankWithParts(session);
  const auto original = session.stagingSettings();
  CHECK(original.layout == "packed");
  auto next = original;
  next.layout = "camera-frame";
  next.group = "colour";
  next.sides = "around";
  next.match = "nearest";
  next.aspect = 9.0 / 16;
  REQUIRE(session.setStagingSettings(next).refused.empty());
  CHECK(session.undoName() == "Change Staging");
  REQUIRE(session.undo().refused.empty());
  CHECK(session.stagingSettings().layout == original.layout);
  REQUIRE(session.redo().refused.empty());
  bmapp::Session reopened;
  REQUIRE(reopened.openBytes(session.projectBytes(), "stage.brickmotion").ok);
  const auto saved = reopened.stagingSettings();
  CHECK(saved.layout == next.layout);
  CHECK(saved.group == next.group);
  CHECK(saved.sides == next.sides);
  CHECK(saved.match == next.match);
  CHECK(saved.aspect == next.aspect);

  // Other layouts have no frame shape: the project's video format stays in charge.
  auto grid = saved;
  grid.layout = "grid";
  grid.aspect = 1;
  REQUIRE(reopened.setStagingSettings(grid).refused.empty());
  const auto video = nlohmann::ordered_json::parse(reopened.projectBytes())["settings"]["video"];
  CHECK(video["floorStyle"] == "grid");
  CHECK_FALSE(video.contains("floorAspect"));
  CHECK(reopened.stagingSettings().aspect == 9.0 / 16);
}

TEST_CASE("project checks identify overlaps, floating groups and missing parts from their captured revision", "[bmapp][checks]") {
  bmapp::Session session;
  const auto path = std::filesystem::temp_directory_path() /
    ("bmapp-checks-" + std::to_string(std::chrono::steady_clock::now().time_since_epoch().count()) + ".ldr");
  std::ofstream(path) << R"(
0 Check Study
1 4 0 0 0 1 0 0 0 1 0 0 0 1 3001.dat
1 1 0 0 0 1 0 0 0 1 0 0 0 1 3001.dat
1 15 140 -120 0 1 0 0 0 1 0 0 0 1 3003.dat
1 7 -100 0 0 1 0 0 0 1 0 0 0 1 test-missing-detail.dat
)";
  const auto opened = session.open(path.string());
  std::filesystem::remove(path);
  INFO(opened.error);
  REQUIRE(opened.ok);
  std::unique_ptr<bmapp::AssemblyInspection> captured(bmapp::AssemblyInspection::capture(&session));
  REQUIRE(captured);
  session.remove({1});
  const auto report = captured->checkModel();
  REQUIRE(report.error.empty());
  const auto found = [&](bmapp::ModelCheckKind kind, const bmapp::PieceList& pieces) {
    return std::any_of(report.findings.begin(), report.findings.end(),
                       [&](const auto& row) { return row.kind == kind && row.pieces == pieces; });
  };
  CHECK(found(bmapp::ModelCheckKind::Overlap, {0, 1}));
  CHECK(found(bmapp::ModelCheckKind::Unsupported, {2}));
  CHECK(found(bmapp::ModelCheckKind::MissingDefinition, {3}));
}

TEST_CASE("a waiting spot dragged across the floor: the web's floorShift, laid on the plan without replanning", "[bmapp][animation][staging]") {
  // The flight itself: the drag holds while it waits, eases out by the seat, never moves the seat.
  {
    bm::plan::Flight flight;
    flight.pieces = {0};
    flight.startFrame = 30, flight.frames = 50, flight.seatAt = 40;
    flight.staging.t = {120, 0, 0};
    flight.waypoints = {flight.staging, {}};
    flight.shift = {40, 0, -20};
    CHECK(bm::plan::poseAt(flight, 10).t == bm::Vec3{160, 0, -20});
    CHECK(bm::plan::poseAt(flight, 30).t == bm::Vec3{160, 0, -20});
    CHECK(bm::plan::poseAt(flight, 80).t == bm::Vec3{});
    const auto half = bm::plan::poseAt(flight, 50).t;  // half way to the seat: half the drag left
    bm::plan::Flight plain = flight;
    plain.shift = {};
    const auto unshifted = bm::plan::poseAt(plain, 50).t;
    CHECK(half.x - unshifted.x == Catch::Approx(20));
    CHECK(half.z - unshifted.z == Catch::Approx(-10));
  }

  bmapp::Session session;
  blankWithParts(session);
  // Saved as the web keeps it: studs of the web's x and z (LDU z is the web's -z), added up.
  const auto depth = session.undoDepth();
  REQUIRE(session.shiftWaitingPart(0, {40, 0, 20}).refused.empty());
  CHECK(session.undoName() == "Move Waiting Part");
  CHECK(session.undoDepth() == depth + 1);
  REQUIRE(session.shiftWaitingPart(0, {20, -99, 0}).refused.empty());  // height ignored
  CHECK(session.waitingShift(0).x == Catch::Approx(60));
  CHECK(session.waitingShift(0).y == 0);
  CHECK(session.waitingShift(0).z == Catch::Approx(20));
  const auto saved = nlohmann::ordered_json::parse(session.projectBytes());
  CHECK(saved.dump().find("\"floorShift\":[3.0,-1.0]") != std::string::npos);
  const auto authored = bmapp::animationAuthoring(session);
  REQUIRE(authored.waitingShifts.size() == 1);
  CHECK(authored.waitingShifts.front().second.x == Catch::Approx(60));
  REQUIRE(session.shiftWaitingPart(0, {-60, 0, -20}).refused.empty());  // back: the field goes
  CHECK(nlohmann::ordered_json::parse(session.projectBytes()).dump().find("floorShift") == std::string::npos);
  // put back with the turned ones, as one step (Build Staging's Apply, or alone)
  REQUIRE(session.turnWaitingPart(1, 90).refused.empty());
  REQUIRE(session.shiftWaitingPart(0, {20, 0, 0}).refused.empty());
  CHECK(session.movedWaitingParts() == 2);
  REQUIRE(session.putBackWaitingParts().refused.empty());
  CHECK(session.undoName() == "Put Back Waiting Parts");
  CHECK(session.waitingShift(0).x == 0);
  CHECK(session.movedWaitingParts() == 0);
  CHECK(bmapp::animationAuthoring(session).waitingTurns.empty());
  CHECK(session.putBackWaitingParts().version == session.version());  // nothing left to put back

  // In the viewport: dragged live, saved as one step, laid on without planning again.
  bmapp::Viewport viewport(session);
  if (!viewport.ok()) SKIP("no Metal device");
  viewport.resize(320, 180, 1);
  viewport.setPreferences({});
  viewport.requestPlan();
  finishPlan(viewport);
  viewport.seek(0);
  int waiting = -1;
  for (double t = 0; t < viewport.length() && waiting < 0; t += 0.1) {
    viewport.seek(t);
    for (uint32_t p = 0; p < 2 && waiting < 0; p++)
      if (viewport.canMoveWaitingPart(p)) waiting = static_cast<int>(p);
  }
  REQUIRE(waiting >= 0);
  const uint32_t piece = static_cast<uint32_t>(waiting);
  const auto before = viewport.buildTimeline();
  REQUIRE(viewport.beginWaitingDrag(piece, 160, 120));
  const auto partWay = viewport.dragWaitingPart(190, 120);
  CHECK(std::hypot(partWay.x, partWay.z) > 1);
  CHECK(partWay.y == 0);
  const auto moved = viewport.capture();
  const auto drag = viewport.endWaitingDrag();
  CHECK(drag.x == partWay.x);
  CHECK(viewport.endWaitingDrag().x == 0);  // over
  const auto back = viewport.capture();
  CHECK(moved.rgba != back.rgba);  // it moved while dragged, and went back when let go

  REQUIRE(session.shiftWaitingPart(piece, drag).refused.empty());
  viewport.draw(nullptr);
  CHECK(viewport.planState() == bmapp::PlanState::Ready);  // not replanned
  CHECK(viewport.buildTimeline().planningMilliseconds == before.planningMilliseconds);
  CHECK(viewport.capture().rgba != back.rgba);  // and shown where it was dragged
  CHECK(viewport.canMoveWaitingPart(piece));
  session.undo();
  viewport.draw(nullptr);
  CHECK(viewport.planState() == bmapp::PlanState::Ready);
  CHECK(viewport.capture().rgba == back.rgba);
}

TEST_CASE("a flight open as keys is a path: a point a frame, and one at each key", "[bmapp][animation][flight-path]") {
  bmapp::Session model;
  blankWithParts(model);
  bmapp::Viewport viewport(model);
  if (!viewport.ok()) SKIP("no Metal device");
  CHECK(viewport.flightPath(0).empty());  // no keys: no path
  using C = bmapp::KeyChannel;
  using I = bmapp::KeyInterpolation;
  REQUIRE(model.setBakedKeys(0, {{C::PositionX, 10, 3, I::Linear}, {C::PositionY, 10, 0, I::Linear}, {C::PositionY, 25, 2, I::Linear},
                                 {C::PositionX, 40, 0, I::Linear}, {C::PositionY, 40, 0, I::Linear}}).keyframesOnly);
  const auto path = viewport.flightPath(0);
  REQUIRE_FALSE(path.empty());
  CHECK(path.piece == 0);
  REQUIRE(path.line.size() == 31);
  CHECK(path.line.front().frame == 10);
  CHECK(path.line.back().frame == 40);
  REQUIRE(path.keys.size() == 3);
  CHECK(path.keys[1].frame == 25);
  // 3 studs along the web's x is 60 LDU; 2 studs up is 40 LDU less y
  CHECK(path.keys[0].at.x - path.keys[2].at.x == Catch::Approx(60));
  CHECK(path.keys[1].at.y - path.keys[2].at.y == Catch::Approx(-40));
  CHECK(path.line[15].frame == 25);
  CHECK(path.line[15].at.y == Catch::Approx(path.keys[1].at.y));
  CHECK(viewport.flightPath(1).empty());  // the other piece has no flight open
}

TEST_CASE("a flight path's points are added, moved and deleted as the web's", "[bmapp][animation][flight-path]") {
  bmapp::Session model;
  blankWithParts(model);
  using C = bmapp::KeyChannel;
  using I = bmapp::KeyInterpolation;
  CHECK_FALSE(model.addFlightPathPoint(0, 20).refused.empty());  // no flight open as keys
  REQUIRE(model.setBakedKeys(0, {{C::PositionX, 10, 3, I::Linear}, {C::PositionY, 10, 2, I::Linear},
                                 {C::PositionX, 40, 0, I::Linear}, {C::PositionY, 40, 0, I::Linear}}).keyframesOnly);
  // added where the path runs: it keeps its shape, every location channel keyed there
  const double before = model.keyValue(0, C::PositionX, 25);
  const auto depth = model.undoDepth();
  REQUIRE(model.addFlightPathPoint(0, 25).refused.empty());
  CHECK(model.undoName() == "Add Path Point");
  CHECK(model.undoDepth() == depth + 1);
  CHECK(model.keyValue(0, C::PositionX, 25) == Catch::Approx(before));
  CHECK(model.keyValue(0, C::PositionX, 20) == Catch::Approx(2));  // still the straight line
  const auto keys = model.keyTracks().front().keys;
  const auto keyedAt = [&](C channel, int frame) {
    return std::any_of(keys.begin(), keys.end(), [&](const auto& k) { return k.channel == channel && k.frame == frame; });
  };
  CHECK(keyedAt(C::PositionX, 25));
  CHECK(keyedAt(C::PositionY, 25));
  CHECK(keyedAt(C::PositionZ, 25));
  CHECK(model.keyTracks().front().baked);  // still the flight
  CHECK(model.addFlightPathPoint(0, 25).version == model.version());  // already a point
  CHECK_FALSE(model.addFlightPathPoint(0, 50).refused.empty());  // past the seat

  // moved: one step for the whole drag, the rest of the path as it was
  REQUIRE(model.setFlightPathPoint(0, 25, {1.5, 4, -2}, true).refused.empty());
  REQUIRE(model.setFlightPathPoint(0, 25, {1.5, 5, -2}, true).refused.empty());
  CHECK(model.undoName() == "Move Path Point");
  CHECK(model.undoDepth() == depth + 2);
  CHECK(model.keyValue(0, C::PositionY, 25) == Catch::Approx(5));
  CHECK(model.keyValue(0, C::PositionZ, 25) == Catch::Approx(-2));
  CHECK(model.keyValue(0, C::PositionX, 10) == Catch::Approx(3));
  CHECK(model.keyValue(0, C::PositionX, 40) == Catch::Approx(0));

  // deleted, but never the start or the seat
  CHECK_FALSE(model.deleteFlightPathPoint(0, 10).refused.empty());
  CHECK_FALSE(model.deleteFlightPathPoint(0, 40).refused.empty());
  REQUIRE(model.deleteFlightPathPoint(0, 25).refused.empty());
  CHECK(model.undoName() == "Delete Path Point");
  CHECK(model.keyValue(0, C::PositionY, 25) == Catch::Approx(1));
  model.undo();
  CHECK(model.keyValue(0, C::PositionY, 25) == Catch::Approx(5));
}
