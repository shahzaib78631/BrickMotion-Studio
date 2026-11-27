// The project's look and build settings: saved with the web's keys where it has them, undone as
// one step, drawn by the viewport and read by the planner.
#include <catch2/catch_approx.hpp>
#include <catch2/catch_test_macros.hpp>
#include <algorithm>
#include <array>
#include <chrono>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <nlohmann/json.hpp>
#include <thread>
#include "bmapp/session.h"
#include "bmapp/viewport.h"

namespace {

void blankWithParts(bmapp::Session& session) {
  REQUIRE(session.newBlank().ok);
  REQUIRE(session.placePart("3005.dat", 4, {{}, {0, -24, 0}}, 0, session.generation(), session.version()).refused.empty());
  REQUIRE(session.insertStep(1).refused.empty());
  REQUIRE(session.placePart("3024.dat", 14, {{}, {0, -32, 0}}, 1, session.generation(), session.version()).refused.empty());
  REQUIRE(session.insertStep(2).refused.empty());
  REQUIRE(session.placePart("3005.dat", 1, {{}, {60, -24, 0}}, 2, session.generation(), session.version()).refused.empty());
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

nlohmann::json settingsOf(const bmapp::Session& session) {
  const auto project = nlohmann::json::parse(session.projectBytes());
  return project.contains("settings") ? project["settings"] : nlohmann::json::object();
}

}  // namespace

TEST_CASE("the look is saved with the web's keys and undoes as one step", "[bmapp][look]") {
  bmapp::Session session;
  blankWithParts(session);
  const auto original = session.renderLook();
  CHECK(original.scene.empty());
  CHECK(original.shading == bmapp::Shading::Standard);
  CHECK(original.edges);
  CHECK(original.floor);

  auto look = original;
  look.scene = "graphite";
  look.shading = bmapp::Shading::Studio;
  look.edges = false;
  look.ambientOcclusion = false;
  look.raytracedGlass = true;
  look.pathSamples = 128;
  REQUIRE(session.setRenderLook(look).refused.empty());
  CHECK(session.undoName() == "Change Look");
  const auto settings = settingsOf(session);
  CHECK(settings["video"]["studioLook"] == "graphite");
  CHECK(settings["video"]["edgeLines"] == false);
  CHECK(settings["video"]["materials"]["ao"]["enabled"] == false);
  CHECK(settings["video"]["pathSamples"] == 128);
  CHECK(settings["native"]["look"]["shading"] == "studio");
  CHECK(settings["native"]["look"]["raytracedGlass"] == true);
  CHECK_FALSE(settings["native"]["look"].contains("shadows"));  // unchanged values are not written

  bmapp::Session reopened;
  REQUIRE(reopened.openBytes(session.projectBytes(), "look.brickmotion").ok);
  const auto saved = reopened.renderLook();
  CHECK(saved.scene == "graphite");
  CHECK(saved.shading == bmapp::Shading::Studio);
  CHECK_FALSE(saved.edges);
  CHECK_FALSE(saved.ambientOcclusion);
  CHECK(saved.raytracedGlass);
  CHECK(saved.pathSamples == 128);

  REQUIRE(session.undo().refused.empty());
  CHECK(session.renderLook().scene.empty());
  CHECK(session.renderLook().edges);
  CHECK(session.setRenderLook(session.renderLook()).version == session.version());  // no change, no step

  auto unknown = original;
  unknown.scene = "not-a-scene";
  CHECK_FALSE(session.setRenderLook(unknown).refused.empty());
  unknown = original;
  unknown.pathSamples = 2;
  CHECK_FALSE(session.setRenderLook(unknown).refused.empty());
}

TEST_CASE("rounding is on by default, saved under the native look, and reopened", "[bmapp][look]") {
  bmapp::Session session;
  blankWithParts(session);
  const auto original = session.renderLook();
  CHECK(original.smoothCurves);
  CHECK(original.roundedEdges);
  CHECK(original.softStudRoots);
  CHECK_FALSE(settingsOf(session)["native"]["look"].contains("smoothCurves"));  // old projects read as all on

  auto look = original;
  look.smoothCurves = false;
  look.roundedEdges = false;
  look.softStudRoots = false;
  REQUIRE(session.setRenderLook(look).refused.empty());
  const auto settings = settingsOf(session);
  CHECK(settings["native"]["look"]["smoothCurves"] == false);
  CHECK(settings["native"]["look"]["roundedEdges"] == false);
  CHECK(settings["native"]["look"]["softStudRoots"] == false);

  bmapp::Session reopened;
  REQUIRE(reopened.openBytes(session.projectBytes(), "rounding.brickmotion").ok);
  CHECK_FALSE(reopened.renderLook().smoothCurves);
  CHECK_FALSE(reopened.renderLook().roundedEdges);
  CHECK_FALSE(reopened.renderLook().softStudRoots);
  REQUIRE(session.undo().refused.empty());
  CHECK(session.renderLook().smoothCurves);
}

TEST_CASE("a scene without a floor turns the floor off until one is asked for", "[bmapp][look]") {
  bmapp::Session session;
  blankWithParts(session);
  auto look = session.renderLook();
  look.scene = "black";
  look.floor = false;  // what the chooser sends: the scene's own floor
  REQUIRE(session.setRenderLook(look).refused.empty());
  CHECK(settingsOf(session)["video"]["materials"]["floor"] == "auto");
  CHECK_FALSE(session.renderLook().floor);
  look.floor = true;
  REQUIRE(session.setRenderLook(look).refused.empty());
  CHECK(settingsOf(session)["video"]["materials"]["floor"] == "shadow");
  CHECK(session.renderLook().floor);
  const auto& scenes = bmapp::Session::scenes();
  CHECK(scenes.size() == 34);
  CHECK(std::any_of(scenes.begin(), scenes.end(), [](const auto& s) { return s.id == "bricklink-white" && s.floor; }));
}

TEST_CASE("a web project keeps its own materials when the look changes", "[bmapp][look]") {
  bmapp::Session session;
  blankWithParts(session);
  auto project = nlohmann::json::parse(session.projectBytes());
  project["settings"]["video"]["materials"] = {{"finish", "glossy"}, {"floor", "wood"}, {"glass", "milky"},
                                               {"ao", {{"enabled", true}, {"strength", 0.4}, {"radius", nullptr}}}};
  project["settings"]["video"]["studioLook"] = "sage";
  REQUIRE(session.openBytes(project.dump(), "web.brickmotion").ok);
  CHECK(session.renderLook().scene == "sage");
  CHECK(session.renderLook().floor);
  auto look = session.renderLook();
  look.ambientOcclusion = false;
  REQUIRE(session.setRenderLook(look).refused.empty());
  const auto materials = settingsOf(session)["video"]["materials"];
  CHECK(materials["finish"] == "glossy");
  CHECK(materials["floor"] == "wood");
  CHECK(materials["glass"] == "milky");
  CHECK(materials["ao"]["strength"] == 0.4);
  CHECK(materials["ao"]["enabled"] == false);
}

TEST_CASE("build settings are saved only where they differ and replan the build", "[bmapp][build-settings]") {
  bmapp::Session session;
  blankWithParts(session);
  bmapp::Viewport viewport(session);
  if (!viewport.ok()) SKIP("no Metal device");
  viewport.resize(200, 150, 1);
  viewport.setPreferences({});
  viewport.requestPlan();
  finishPlan(viewport);
  const auto before = viewport.buildTimeline();
  CHECK_FALSE(settingsOf(session).contains("native"));

  auto build = session.buildSettings();
  build.order = bmapp::BuildOrder::BottomUp;
  build.flight = bmapp::FlightShape::Arc;
  build.piecesPerSecond = 0.5;  // flights at their longest (0.9 s)
  build.stepPause = 1;          // two step changes, each held 0.75 s longer
  REQUIRE(session.setBuildSettings(build).refused.empty());
  CHECK(session.undoName() == "Change Build Settings");
  const auto saved = settingsOf(session)["native"]["build"];
  CHECK(saved["order"] == "bottom-up");
  CHECK(saved["flight"] == "arc");
  CHECK(saved["piecesPerSecond"] == 0.5);
  CHECK_FALSE(saved.contains("gap"));

  viewport.draw(nullptr);
  finishPlan(viewport);
  const auto slower = viewport.buildTimeline();
  CHECK(slower.version == session.version());
  CHECK(slower.flights.size() == before.flights.size());
  CHECK(slower.duration > before.duration + 1.4);
  CHECK_FALSE(slower.reusedSnapshot);

  // A fresh viewport on the saved project plans the same build.
  bmapp::Session reopened;
  REQUIRE(reopened.openBytes(session.projectBytes(), "build.brickmotion").ok);
  CHECK(reopened.buildSettings().order == bmapp::BuildOrder::BottomUp);
  bmapp::Viewport fresh(reopened);
  fresh.resize(200, 150, 1);
  fresh.setPreferences({});
  fresh.requestPlan();
  finishPlan(fresh);
  CHECK(fresh.buildTimeline().duration == Catch::Approx(slower.duration));

  REQUIRE(session.undo().refused.empty());
  viewport.draw(nullptr);
  finishPlan(viewport);
  CHECK(viewport.buildTimeline().duration == Catch::Approx(before.duration));
  CHECK_FALSE(settingsOf(session).contains("native"));

  auto invalid = session.buildSettings();
  invalid.piecesPerSecond = 40;
  CHECK_FALSE(session.setBuildSettings(invalid).refused.empty());
}

TEST_CASE("the viewport draws the project's scene backdrop, or the editor's when asked", "[bmapp][look][viewport]") {
  bmapp::Session session;
  blankWithParts(session);
  bmapp::Viewport viewport(session);
  if (!viewport.ok()) SKIP("no Metal device");
  viewport.resize(96, 64, 1);
  viewport.setPreferences({});
  viewport.setBackground(0.96, 0.96, 0.96);
  const auto corner = [&] {
    viewport.draw(nullptr);
    const auto picture = viewport.readback();
    REQUIRE(picture.rgba.size() >= 4);
    return std::array<int, 3>{picture.rgba[0], picture.rgba[1], picture.rgba[2]};
  };
  CHECK(corner()[1] > 230);
  auto look = session.renderLook();
  look.scene = "chroma";  // flat green, no floor
  look.floor = false;
  REQUIRE(session.setRenderLook(look).refused.empty());
  const auto green = corner();
  CHECK(green[1] > 150);
  CHECK(green[0] < 40);
  bmapp::ViewportPreferences editor;
  editor.sceneBackdrop = false;
  viewport.setPreferences(editor);
  CHECK(corner()[0] > 230);
  viewport.setPreferences({});
  session.undo();
  CHECK(corner()[0] > 230);
}

#include "bmapp/assembly_inspection.h"
#include "session_impl.h"

TEST_CASE("loose pieces are found off their studs and seated as one undo step", "[bmapp][correct]") {
  bmapp::Session session;
  REQUIRE(session.newBlank().ok);
  REQUIRE(session.placePart("3001.dat", 4, {{}, {0, 0, 0}}, 0, session.generation(), session.version()).refused.empty());
  REQUIRE(session.placePart("3001.dat", 1, {{}, {3, -24, 0}}, 0, session.generation(), session.version()).refused.empty());
  REQUIRE(session.placePart("3001.dat", 14, {{}, {200, 0, 0}}, 0, session.generation(), session.version()).refused.empty());
  const std::unique_ptr<bmapp::AssemblyInspection> inspection(bmapp::AssemblyInspection::capture(&session));
  REQUIRE(inspection);
  const auto loose = inspection->loosePieces();
  INFO(loose.error);
  REQUIRE(loose.error.empty());
  REQUIRE(loose.pieces.size() == 1);
  const auto& row = loose.pieces.front();
  CHECK(row.piece == 1);
  CHECK(row.onto == 0);
  CHECK(row.safe);
  CHECK(row.pose.position.x == Catch::Approx(0).margin(1e-6));
  CHECK(row.pose.position.y == Catch::Approx(-24).margin(1e-6));

  bmapp::PieceMoves moves{{row.piece, row.pose}};
  CHECK_FALSE(session.seatPieces(moves, session.generation(), session.version() + 1).refused.empty());  // stale
  REQUIRE(session.seatPieces(moves, session.generation(), session.version()).refused.empty());
  CHECK(session.undoName() == "Seat Loose Piece");
  CHECK(session.impl().model->pieces()[1].world.t.x == Catch::Approx(0).margin(1e-6));
  session.undo();
  CHECK(session.impl().model->pieces()[1].world.t.x == Catch::Approx(3));
}

TEST_CASE("reset sets pieces back to plain poses as one named undo step", "[bmapp][transform]") {
  bmapp::Session session;
  REQUIRE(session.newBlank().ok);
  REQUIRE(session.placePart("3001.dat", 4, {{}, {0, 0, 0}}, 0, session.generation(), session.version()).refused.empty());
  REQUIRE(session.placePart("3001.dat", 1, {{}, {200, 0, 0}}, 0, session.generation(), session.version()).refused.empty());
  REQUIRE(session.rotate({0, 1}, {0, 1, 0}, 90, {0, 0, 0}, false).refused.empty());
  REQUIRE(session.scale({0}, {2, 2, 2}, {}, {0, 0, 0}, false).refused.empty());
  const auto turned = session.impl().model->pieces()[0].world;
  const auto depth = session.undoName();

  bmapp::PieceMoves plain{{0, {{}, {turned.t.x, turned.t.y, turned.t.z}}}};
  CHECK_FALSE(session.resetPoses(plain, session.generation(), session.version() + 1).refused.empty());  // stale
  REQUIRE(session.resetPoses(plain, session.generation(), session.version()).refused.empty());
  CHECK(session.undoName() == "Reset Transform");
  const auto& reset = session.impl().model->pieces()[0].world;
  CHECK(reset.r.m[0] == Catch::Approx(1).margin(1e-9));
  CHECK(reset.r.m[8] == Catch::Approx(1).margin(1e-9));
  CHECK(reset.t.x == Catch::Approx(turned.t.x).margin(1e-9));
  session.undo();
  CHECK(session.undoName() == depth);  // one step back undoes the whole reset
  CHECK(session.impl().model->pieces()[0].world.r.m[0] == Catch::Approx(turned.r.m[0]).margin(1e-9));

  const auto other = session.impl().model->pieces()[1].world;
  bmapp::PieceMoves both{{0, {{}, {turned.t.x, turned.t.y, turned.t.z}}}, {1, {{}, {other.t.x, other.t.y, other.t.z}}}};
  REQUIRE(session.resetPoses(both, session.generation(), session.version()).refused.empty());
  CHECK(session.undoName() == "Reset 2 Transforms");
}

TEST_CASE("every shading draws its own picture of the model", "[bmapp][look][viewport][shading]") {
  bmapp::Session session;
  blankWithParts(session);
  // Glass too: hybrid ray tracing changes glass and reflections, little on opaque plastic.
  REQUIRE(session.placePart("3001.dat", 47, {{}, {-60, -24, 0}}, 2, session.generation(), session.version()).refused.empty());
  bmapp::Viewport viewport(session);
  if (!viewport.ok()) SKIP("no Metal device");
  viewport.resize(160, 120, 1);
  viewport.setPreferences({});
  viewport.view(bmapp::ViewPreset::Front);
  const auto picture = [&](bmapp::Shading shading) {
    auto look = session.renderLook();
    look.shading = shading;
    look.pathSamples = 16;
    if (look.shading != session.renderLook().shading) REQUIRE(session.setRenderLook(look).refused.empty());
    // Offscreen frames are complete (the studio bake waits); the path tracer adds samples each frame.
    // Path tracing waits for the view to be still: the camera change above is a gesture for 0.11 s.
    std::this_thread::sleep_for(std::chrono::milliseconds(150));
    const int frames = shading == bmapp::Shading::HybridRT ? 24 : 40;  // hybrid: temporal accumulation
    for (int i = 0; i < frames && (i == 0 || shading == bmapp::Shading::HybridRT || viewport.needsDraw()); ++i) {
      if (shading == bmapp::Shading::HybridRT) viewport.rotateGesture(0);  // a redraw each time
      viewport.draw(nullptr);
    }
    return viewport.readback().rgba;
  };
  const auto standard = picture(bmapp::Shading::Standard);
  REQUIRE(standard.size() == 160u * 120 * 4);
  for (const auto shading : {bmapp::Shading::Studio, bmapp::Shading::Neural, bmapp::Shading::HybridRT,
                             bmapp::Shading::ScreenSpaceGI, bmapp::Shading::PathTraced}) {
    INFO("shading " << static_cast<int>(shading));
    const auto drawn = picture(shading);
    REQUIRE(drawn.size() == standard.size());
    double brightness = 0, difference = 0;
    for (size_t i = 0; i < drawn.size(); i += 4) {
      brightness += drawn[i] + drawn[i + 1] + drawn[i + 2];
      difference += std::abs(int(drawn[i]) - int(standard[i])) + std::abs(int(drawn[i + 1]) - int(standard[i + 1]));
    }
    const double pixels = drawn.size() / 4.0;
    CHECK(brightness / pixels / 3 > 40);   // not black
    CHECK(difference / pixels > 0.5);      // not the standard picture
  }
}

namespace {

/// A piece's baked flight in one channel, frame by frame.
std::vector<double> flightChannel(bmapp::Viewport& viewport, uint32_t piece, bmapp::KeyChannel channel) {
  bmapp::KeyScene scene;
  scene.buildLinked = true;
  scene.last = 400;
  std::vector<double> values;
  for (const auto& key : viewport.bakeFlightInScene(piece, scene))
    if (key.channel == channel) values.push_back(key.value);
  return values;
}

double spread(const std::vector<double>& values) {
  if (values.empty()) return 0;
  const auto [low, high] = std::minmax_element(values.begin(), values.end());
  return *high - *low;
}

}  // namespace

TEST_CASE("each build setting changes the planned build on its own", "[bmapp][build-settings]") {
  bmapp::Session session;
  blankWithParts(session);
  bmapp::Viewport viewport(session);
  if (!viewport.ok()) SKIP("no Metal device");
  viewport.resize(200, 150, 1);
  viewport.setPreferences({});
  const auto plan = [&](auto edit) {
    bmapp::BuildSettings build;
    edit(build);
    const auto changed = session.setBuildSettings(build);
    REQUIRE(changed.refused.empty());
    viewport.requestPlan();
    viewport.draw(nullptr);
    finishPlan(viewport);
    const auto timeline = viewport.buildTimeline();
    REQUIRE(timeline.version == session.version());
    REQUIRE(timeline.flights.size() == 3);
    return timeline;
  };
  const auto lengthOf = [](const bmapp::BuildFlightRow& flight) { return flight.end - flight.start; };
  const auto defaults = plan([](auto&) {});
  const uint32_t plate = 1;
  const auto height = [&] { return spread(flightChannel(viewport, plate, bmapp::KeyChannel::PositionY)); };
  const auto route = [&] {
    auto values = flightChannel(viewport, plate, bmapp::KeyChannel::PositionX);
    for (const auto channel : {bmapp::KeyChannel::PositionY, bmapp::KeyChannel::PositionZ})
      for (const double value : flightChannel(viewport, plate, channel)) values.push_back(value);
    return values;
  };
  const auto automaticRoute = route();
  REQUIRE_FALSE(automaticRoute.empty());

  SECTION("parts a second sets each flight's length") {
    CHECK(lengthOf(defaults.flights.front()) == Catch::Approx(0.425).margin(0.04));
    const auto slow = plan([](auto& b) { b.piecesPerSecond = 0.85 / 0.8; });
    for (const auto& flight : slow.flights) CHECK(lengthOf(flight) == Catch::Approx(0.8).margin(0.04));
  }
  SECTION("the gap is kept after every landing") {
    const auto spaced = plan([](auto& b) { b.gap = 1.05; });
    CHECK(spaced.duration == Catch::Approx(defaults.duration + 3).margin(0.1));
  }
  SECTION("the hold at each step can be taken out") {
    const auto held = plan([](auto& b) { b.stepPause = 0; });
    CHECK(held.duration < defaults.duration - 0.2);
  }
  SECTION("the flight shape changes the route") {
    plan([](auto& b) { b.flight = bmapp::FlightShape::Web; });
    CHECK(route() != automaticRoute);
  }
  SECTION("clearance lifts a lifted flight higher") {
    // The margin over what stands in the way. Height rises with it: 24, 60, 120 and 200 LDU of
    // clearance lift the plate 1.9, 3.7, 6.7 and 11.5 key units.
    plan([](auto& b) { b.flight = bmapp::FlightShape::Web; b.clearance = 4; });
    const double low = height();
    plan([](auto& b) { b.flight = bmapp::FlightShape::Web; b.clearance = 200; });
    CHECK(height() > low + 5);  // keys are in studs-like units (1/20 LDU): about 196 LDU higher
  }
  SECTION("corner rounding changes an Arc flight") {
    plan([](auto& b) { b.flight = bmapp::FlightShape::Arc; b.corner = 0; });
    const auto sharp = route();
    plan([](auto& b) { b.flight = bmapp::FlightShape::Arc; b.corner = 80; });
    CHECK(route() != sharp);
  }
  SECTION("the build order replans") {
    // Three parts build in the same order either way; this checks the order reaches a plan.
    const auto forward = plan([](auto& b) { b.order = bmapp::BuildOrder::BottomUp; });
    CHECK(forward.version != defaults.version);
    CHECK_FALSE(forward.standardPreview);
  }
  SECTION("the standard planner is the project's own choice") {
    const auto standard = plan([](auto& b) { b.standardPlanner = true; });
    CHECK(standard.standardPreview);
    CHECK(settingsOf(session)["native"]["build"]["planner"] == "standard");
    bmapp::Session reopened;
    REQUIRE(reopened.openBytes(session.projectBytes(), "standard.brickmotion").ok);
    CHECK(reopened.buildSettings().standardPlanner);
  }
}

TEST_CASE("bottom up and take apart bring a piece in from different sides", "[bmapp][build-settings][order]") {
  bmapp::Session session;
  REQUIRE(session.newBlank().ok);
  // tests/fixtures/plan/snot.ldr: a plate pressed sideways onto the side stud of a brick. Taken
  // apart, the brick leaves along Z; built forward it is set down from above.
  REQUIRE(session.placePart("87087.dat", 4, {{}, {0, 0, 0}}, 0, session.generation(), session.version()).refused.empty());
  bmapp::PartPose side;
  side.rotation = {{1, 0, 0, 0, 0, -1, 0, 1, 0}};
  side.position = {0, 10, -18};
  REQUIRE(session.placePart("3024.dat", 14, side, 0, session.generation(), session.version()).refused.empty());
  bmapp::Viewport viewport(session);
  if (!viewport.ok()) SKIP("no Metal device");
  viewport.resize(200, 150, 1);
  viewport.setPreferences({});
  const auto route = [&](bmapp::BuildOrder value) {
    bmapp::BuildSettings build;
    build.order = value;
    REQUIRE(session.setBuildSettings(build).refused.empty());
    viewport.requestPlan();
    viewport.draw(nullptr);
    finishPlan(viewport);
    REQUIRE(viewport.buildTimeline().flights.size() == 2);
    return std::pair{spread(flightChannel(viewport, 0, bmapp::KeyChannel::PositionY)),
                     spread(flightChannel(viewport, 0, bmapp::KeyChannel::PositionZ))};
  };
  const auto [apartY, apartZ] = route(bmapp::BuildOrder::TakeApart);
  const auto [upY, upZ] = route(bmapp::BuildOrder::BottomUp);
  INFO("take apart y " << apartY << " z " << apartZ << " | bottom up y " << upY << " z " << upZ);
  CHECK((apartY != Catch::Approx(upY).margin(1) || apartZ != Catch::Approx(upZ).margin(1)));
}

TEST_CASE("the editor's snap track sounds where the build's pieces land", "[bmapp][transport-sound]") {
  bmapp::Session session;
  REQUIRE(session.newBlank().ok);
  for (const double y : {-24.0, -48.0})
    REQUIRE(session.placePart("3001.dat", 4, {{}, {0, y, 0}}, 0, session.generation(), session.version()).refused.empty());
  // Two 2 x 4 bricks: the physical voice of a 1 x 1 part rings above what a track can hold.
  bmapp::Viewport viewport(session);
  if (!viewport.ok()) SKIP("no Metal device");
  viewport.resize(200, 150, 1);
  viewport.setPreferences({});
  const auto file = std::filesystem::temp_directory_path() / "bmapp-transport-snaps.wav";
  std::filesystem::remove(file);
  CHECK_FALSE(viewport.writeSnapTrack(file.string(), "").empty());  // nothing planned yet
  viewport.requestPlan();
  finishPlan(viewport);
  auto mix = session.snapMix();
  mix.enabled = true;
  REQUIRE(session.setSnapMix(mix).refused.empty());
  viewport.draw(nullptr);
  finishPlan(viewport);
  const auto timeline = viewport.buildTimeline();
  const auto started = std::chrono::steady_clock::now();
  REQUIRE(viewport.writeSnapTrack(file.string(), "").empty());
  const double milliseconds = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - started).count();
  INFO("written in " << milliseconds << " ms");

  // 16-bit stereo PCM after a 44-byte header (bms::writeWav).
  std::ifstream in(file, std::ios::binary);
  std::vector<char> bytes((std::istreambuf_iterator<char>(in)), {});
  REQUIRE(bytes.size() > 44);
  uint32_t rate = 0;
  std::memcpy(&rate, bytes.data() + 24, 4);
  REQUIRE(rate > 0);
  const auto* samples = reinterpret_cast<const int16_t*>(bytes.data() + 44);
  const size_t frames = (bytes.size() - 44) / 4;
  const auto loudness = [&](double from, double to) {
    double peak = 0;
    for (size_t i = static_cast<size_t>(std::max(0.0, from) * rate); i < std::min(frames, static_cast<size_t>(to * rate)); ++i)
      peak = std::max({peak, std::abs(double(samples[2 * i])), std::abs(double(samples[2 * i + 1]))});
    return peak;
  };
  // Loud at every landing, silent well before the first one starts to fly.
  for (const auto& flight : timeline.flights) CHECK(loudness(flight.end - 0.05, flight.end + 0.15) > 1000);
  CHECK(loudness(0, std::max(0.0, timeline.flights.front().start - 0.1)) < 50);
  std::filesystem::remove(file);
}

TEST_CASE("the staging area turns about the model and every piece still lands on its seat", "[bmapp][staging-turn]") {
  bmapp::Session session;
  blankWithParts(session);
  bmapp::Viewport viewport(session);
  if (!viewport.ok()) SKIP("no Metal device");
  viewport.resize(200, 150, 1);
  viewport.setPreferences({});
  viewport.requestPlan();
  finishPlan(viewport);
  const auto ends = [&](uint32_t piece) {
    const auto x = flightChannel(viewport, piece, bmapp::KeyChannel::PositionX);
    const auto z = flightChannel(viewport, piece, bmapp::KeyChannel::PositionZ);
    REQUIRE(x.size() >= 2);
    REQUIRE(z.size() == x.size());
    return std::array<double, 4>{x.front(), z.front(), x.back(), z.back()};
  };
  const auto before = ends(2);

  CHECK(session.stagingTurn() == 0);
  CHECK_FALSE(session.setStagingTurn(INFINITY).refused.empty());
  REQUIRE(session.setStagingTurn(-270).refused.empty());  // wrapped, as the web
  CHECK(session.stagingTurn() == 90);
  CHECK(session.undoName() == "Turn Staging Area");
  const auto project = nlohmann::json::parse(session.projectBytes());
  CHECK(project["plan"]["stagingTurns"][""] == 90);
  viewport.draw(nullptr);
  finishPlan(viewport);
  const auto turned = ends(2);
  // It waits somewhere else, and lands where it always did.
  CHECK(std::hypot(turned[0] - before[0], turned[1] - before[1]) > 0.5);
  CHECK(turned[2] == Catch::Approx(before[2]).margin(1e-3));
  CHECK(turned[3] == Catch::Approx(before[3]).margin(1e-3));

  bmapp::Session reopened;
  REQUIRE(reopened.openBytes(session.projectBytes(), "turned.brickmotion").ok);
  CHECK(reopened.stagingTurn() == 90);

  REQUIRE(session.setStagingTurn(0).refused.empty());
  CHECK(session.undoName() == "Reset Staging Turn");
  CHECK_FALSE(nlohmann::json::parse(session.projectBytes())["plan"].contains("stagingTurns"));
  REQUIRE(session.undo().refused.empty());
  CHECK(session.stagingTurn() == 90);
}

TEST_CASE("waiting parts turned one by one are put back as one step", "[bmapp][staging-turn]") {
  bmapp::Session session;
  blankWithParts(session);
  CHECK(session.movedWaitingParts() == 0);
  CHECK(session.putBackWaitingParts().refused.empty());
  REQUIRE(session.turnWaitingPart(0, 90).refused.empty());
  REQUIRE(session.turnWaitingPart(2, -90).refused.empty());
  CHECK(session.movedWaitingParts() == 2);
  REQUIRE(session.putBackWaitingParts().refused.empty());
  CHECK(session.undoName() == "Put Back Waiting Parts");
  CHECK(session.movedWaitingParts() == 0);
  REQUIRE(session.undo().refused.empty());
  CHECK(session.movedWaitingParts() == 2);
}

TEST_CASE("Build Staging's Apply is one undo step for the layout, the turn and straightening", "[bmapp][staging-turn]") {
  bmapp::Session session;
  blankWithParts(session);
  REQUIRE(session.turnWaitingPart(0, 90).refused.empty());
  REQUIRE(session.movedWaitingParts() == 1);
  const auto settings = session.stagingSettings();
  const std::string before = session.projectBytes();
  const auto depth = session.undoDepth();

  auto gallery = settings;
  gallery.layout = "gallery";
  REQUIRE(session.applyStaging(gallery, 45, true).refused.empty());
  CHECK(session.undoDepth() == depth + 1);
  CHECK(session.undoName() == "Change Staging");
  CHECK(session.stagingSettings().layout == "gallery");
  CHECK(session.stagingTurn() == 45);
  CHECK(session.movedWaitingParts() == 0);

  REQUIRE(session.undo().refused.empty());
  CHECK(session.stagingSettings().layout == settings.layout);
  CHECK(session.stagingTurn() == 0);
  CHECK(session.movedWaitingParts() == 1);
  auto saved = nlohmann::json::parse(session.projectBytes()), original = nlohmann::json::parse(before);
  saved.erase("savedAt"), original.erase("savedAt");
  CHECK(saved == original);
  REQUIRE(session.redo().refused.empty());
  CHECK(session.stagingTurn() == 45);

  // One change alone keeps its own name; nothing changed makes no step.
  REQUIRE(session.applyStaging(gallery, 30, false).refused.empty());
  CHECK(session.undoName() == "Turn Staging Area");
  const auto unchangedDepth = session.undoDepth();
  REQUIRE(session.applyStaging(gallery, 30, true).refused.empty());
  CHECK(session.undoDepth() == unchangedDepth);
  CHECK_FALSE(session.applyStaging(gallery, NAN, false).refused.empty());
}

TEST_CASE("turning rounding off redraws the model in place without replanning", "[bmapp][look][viewport]") {
  bmapp::Session session;
  blankWithParts(session);
  bmapp::Viewport viewport(session);
  if (!viewport.ok()) SKIP("no Metal device");
  viewport.resize(160, 120, 1);
  viewport.setPreferences({});
  viewport.view(bmapp::ViewPreset::Front);
  viewport.requestPlan();
  finishPlan(viewport);
  const uint64_t planned = viewport.plannedVersion();
  REQUIRE(planned != 0);
  session.select({0}, bmapp::SelectMode::Replace);
  viewport.draw(nullptr);
  const auto rounded = viewport.readback().rgba;

  auto look = session.renderLook();
  look.smoothCurves = look.roundedEdges = look.softStudRoots = false;
  REQUIRE(session.setRenderLook(look).refused.empty());
  viewport.draw(nullptr);
  const auto square = viewport.readback().rgba;
  REQUIRE(square.size() == rounded.size());
  CHECK(std::memcmp(square.data(), rounded.data(), rounded.size()) != 0);
  // A look change keeps the plan: no planning run, the same plan carried to the new version.
  CHECK(viewport.planState() == bmapp::PlanState::Ready);
  CHECK(viewport.plannedVersion() == session.version());
  CHECK(viewport.plannedVersion() > planned);
  CHECK(session.selection() == std::vector<uint32_t>{0});
}
