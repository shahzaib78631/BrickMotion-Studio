// The Build Camera track: the web's sampler and edits (camera_track.cpp), the session's undo
// steps, and the viewport filming the Build with it.
#include <catch2/catch_approx.hpp>
#include <catch2/catch_test_macros.hpp>
#include <algorithm>
#include <chrono>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <cmath>
#include <thread>
#include <nlohmann/json.hpp>
#include "bm/plan/timeline.h"
#include "bmapp/session.h"
#include "bmapp/viewport.h"
#include "bmr/image.h"
#include "camera_track.h"

namespace ct = bmapp::camtrack;
using Catch::Approx;

namespace {

ct::Context boxContext() {
  ct::Context c;
  c.aspect = 16.0 / 9;
  c.model.grow({-2, 0, -2});
  c.model.grow({2, 3, 2});
  c.build = [c](double) { return c.model; };
  c.piece = [](double) { return std::optional<bm::Box>{}; };
  return c;
}

ct::Json fittedKey(double t, double azimuth) {
  return {{"t", t}, {"target", {{"kind", "model"}}}, {"offset", {0, 0, 0}}, {"azimuth", azimuth}, {"elevation", 20},
          {"distance", {{"fit", true}, {"margin", 1.2}}}, {"roll", 0}, {"lensMm", 50}, {"focus", "target"}, {"blur", 0}};
}

double azimuthOf(const ct::Shot& shot) {
  const bm::Vec3 d = shot.eye - shot.target;
  return std::atan2(d.x, d.z) * 180 / M_PI;
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

double gap(bmapp::Vec3 a, bmapp::Vec3 b) { return std::hypot(a.x - b.x, a.y - b.y, a.z - b.z); }

}  // namespace

TEST_CASE("a key from the view gives that view back exactly", "[bmapp][camera-track]") {
  const bm::Vec3 eye{3, 4, 12}, target{0.5, 1, -1};
  const auto track = ct::addKey({}, ct::keyFromView(eye, target, 33, 1.5), 30, 10);
  const auto shot = ct::sample(track, 1.5, boxContext());
  REQUIRE(shot);
  CHECK(shot->eye.x == Approx(eye.x).margin(1e-9));
  CHECK(shot->eye.y == Approx(eye.y).margin(1e-9));
  CHECK(shot->eye.z == Approx(eye.z).margin(1e-9));
  CHECK(shot->target.z == Approx(target.z).margin(1e-9));
  CHECK(shot->fovDegrees == Approx(33).margin(1e-9));
  // the web's world: LDraw (x, y, z) is (x/20, -y/20, -z/20) studs
  CHECK(ct::toLdu(ct::toWeb(bm::Vec3{20, -40, 60})).y == Approx(-40));
  CHECK(ct::toWeb(bm::Vec3{20, -40, 60}).y == Approx(2));
  CHECK(ct::toWeb(bm::Vec3{20, -40, 60}).z == Approx(-3));
}

TEST_CASE("moves between keys ease, turn the chosen way and follow their preset", "[bmapp][camera-track]") {
  const auto c = boxContext();
  auto track = ct::addKey({}, fittedKey(0, 0), 30, 10);
  track = ct::addKey(track, fittedKey(4, 90), 30, 10);
  REQUIRE(track["transitions"].size() == 1);
  CHECK(track["transitions"][0]["preset"] == "glide");
  // The glide eases in and out: half way round at half time, a little at a quarter.
  CHECK(azimuthOf(*ct::sample(track, 2, c)) == Approx(45).margin(1e-6));
  CHECK(azimuthOf(*ct::sample(track, 1, c)) < 22.5);
  CHECK(azimuthOf(*ct::sample(track, 9, c)) == Approx(90).margin(1e-6));  // held after the last key

  // The long way round (cw from 0 to 90 the short way is cw too; ccw goes -270).
  auto ccw = track;
  ccw["transitions"][0]["settings"]["orbit"] = "ccw";
  CHECK(std::remainder(azimuthOf(*ct::sample(ccw, 2, c)) - (-135), 360) == Approx(0).margin(1e-6));
  // A hard cut holds the first view until the second key.
  const auto first = track["keys"][0]["id"].get<std::string>();
  auto cut = ct::choosePreset(track, first, "cut", 10);
  CHECK(cut["transitions"][0]["preset"] == "cut");
  CHECK(azimuthOf(*ct::sample(cut, 3.9, c)) == Approx(0).margin(1e-6));

  // Orbit around: the end key is set a quarter turn on from the start key.
  auto orbit = ct::choosePreset(track, first, "orbit", 10);
  CHECK(orbit["keys"][1]["azimuth"] == Approx(90));
  auto push = ct::choosePreset(track, first, "push-in", 10);
  CHECK(push["keys"][1]["distance"]["margin"] == Approx(0.84));
  // Fitted keys frame the model: the eye is farther from a bigger box.
  ct::Context big = c;
  big.model.grow({8, 8, 8});
  CHECK(bm::length(ct::sample(track, 0, big)->eye - ct::sample(track, 0, big)->target) >
        bm::length(ct::sample(track, 0, c)->eye - ct::sample(track, 0, c)->target));
}

TEST_CASE("flowing moves pass through every key exactly and keep their speed", "[bmapp][camera-track]") {
  const auto c = boxContext();
  ct::Json track;
  for (const auto& [t, az] : std::vector<std::pair<double, double>>{{0, 0}, {2, 60}, {4, 150}, {6, 180}})
    track = ct::addKey(track, fittedKey(t, az), 30, 10);
  for (auto& tr : track["transitions"]) tr["settings"]["flowThrough"] = true;
  for (const auto& [t, az] : std::vector<std::pair<double, double>>{{0, 0}, {2, 60}, {4, 150}, {6, 180}})
    CHECK(azimuthOf(*ct::sample(track, t, c)) == Approx(az).margin(1e-6));
  // Through a key the turn does not stop: just either side of 2 s it is still moving.
  const double before = azimuthOf(*ct::sample(track, 1.95, c)), after = azimuthOf(*ct::sample(track, 2.05, c));
  CHECK(after - before > 1);
  // Never past the neighbours (auto-clamped slopes).
  for (double t = 0; t <= 6; t += 0.1) {
    const double az = azimuthOf(*ct::sample(track, t, c));
    CHECK(az > -1e-6);
    CHECK(az < 180 + 1e-6);
  }
}

TEST_CASE("keys stay sorted with one move between each pair as they are added, moved and deleted", "[bmapp][camera-track]") {
  auto track = ct::addKey({}, fittedKey(0, 0), 30, 10);
  track = ct::addKey(track, fittedKey(6, 90), 30, 10);
  track = ct::addKey(track, fittedKey(0, 45), 30, 10);  // lands on a key: nudged a frame
  REQUIRE(track["keys"].size() == 3);
  CHECK(track["keys"][1]["t"].get<double>() == Approx(1.0 / 30));
  CHECK(track["transitions"].size() == 2);
  const auto keys = ct::keysOf(track);
  REQUIRE(keys.size() == 3);
  CHECK(keys.back().preset.empty());
  CHECK(keys.front().preset == "glide");

  const std::string a = keys[0].id, b = keys[1].id, last = keys[2].id;
  track = ct::choosePreset(track, a, "orbit", 10);
  track = ct::moveKey(track, b, 8, 30, 10);  // now last: the moves follow the new neighbours
  CHECK(track["transitions"][0]["preset"] == "glide");  // a new pair, as the web's relink
  track = ct::choosePreset(track, a, "orbit", 10);
  REQUIRE(track["transitions"].size() == 2);
  CHECK(track["keys"][2]["id"] == b);
  CHECK(track["transitions"][0]["from"] == a);
  CHECK(track["transitions"][0]["to"] == last);
  CHECK(track["transitions"][1]["from"] == last);
  track = ct::removeKey(track, last);  // the move arriving carries on to the next key
  REQUIRE(track["transitions"].size() == 1);
  CHECK(track["transitions"][0]["from"] == a);
  CHECK(track["transitions"][0]["to"] == b);
  CHECK(track["transitions"][0]["preset"] == "orbit");

  // Values the native camera does not play are kept as written.
  track["keys"][0]["roll"] = 12;
  track["keys"][0]["note"] = "the web's own";
  track = ct::setKeyView(track, a, ct::keyFromView({1, 2, 9}, {}, 40, 0));
  CHECK(track["keys"][0]["roll"] == 12);
  CHECK(track["keys"][0]["note"] == "the web's own");
  CHECK(track["keys"][0]["target"]["kind"] == "point");
  track = ct::setKeyTarget(track, a, "build");
  CHECK(track["keys"][0]["target"] == ct::Json{{"kind", "build"}});
  CHECK(track["keys"][0]["distance"]["fit"] == true);
}

TEST_CASE("the viewport films the Build with the camera track, and the track is saved as the web's", "[bmapp][camera-track][viewport]") {
  bmapp::Session session;
  REQUIRE(session.newBlank().ok);
  for (const double y : {-24.0, -48.0, -72.0})
    REQUIRE(session.placePart("3001.dat", 4, {{}, {0, y, 0}}, 0, session.generation(), session.version()).refused.empty());
  // A web project's track for the Timeline clock, kept through every edit of the Build's.
  auto project = nlohmann::ordered_json::parse(session.projectBytes());
  project["plan"]["cameraTracks"] = {{"", {{"timeline", {{"keys", nlohmann::ordered_json::array()},
                                                          {"transitions", nlohmann::ordered_json::array()}, {"shutter", 0.3}}}}}};
  REQUIRE(session.openBytes(project.dump(), "camera.brickmotion").ok);

  bmapp::Viewport viewport(session);
  if (!viewport.ok()) SKIP("no Metal device");
  viewport.resize(320, 180, 1);
  viewport.setPreferences({});
  viewport.requestPlan();
  finishPlan(viewport);
  const double duration = viewport.buildTimeline().duration;
  REQUIRE(duration > 1);
  CHECK_FALSE(viewport.followsCameraTrack());

  bmapp::SceneCamera front;
  front.position = {0, -60, -400}, front.target = {0, -40, 0}, front.fieldOfView = 30;
  bmapp::SceneCamera side;
  side.position = {400, -200, 0}, side.target = {0, -40, 0}, side.fieldOfView = 45;
  CHECK_FALSE(session.addCameraKey(bmapp::CameraClock::Build, 0, {}, 30, duration).refused.empty());  // not a view
  REQUIRE(session.addCameraKey(bmapp::CameraClock::Build, 0, front, 30, duration).refused.empty());
  CHECK(session.undoName() == "Add Camera Key");
  REQUIRE(session.addCameraKey(bmapp::CameraClock::Build, duration, side, 30, duration).refused.empty());
  const auto keys = session.cameraKeys(bmapp::CameraClock::Build);
  REQUIRE(keys.size() == 2);
  CHECK(keys[0].preset == "glide");
  CHECK(keys[1].seconds == Approx(duration));

  viewport.draw(nullptr);
  REQUIRE(viewport.followsCameraTrack());
  viewport.setDirectorPreview(true);
  // At each key the viewport looks exactly from where the key was made.
  viewport.seek(0);
  auto seen = viewport.captureSceneCamera();
  CHECK(gap(seen.position, front.position) < 1e-3);
  CHECK(gap(seen.target, front.target) < 1e-3);
  CHECK(seen.fieldOfView == Approx(30).margin(1e-6));
  viewport.seek(duration);
  seen = viewport.captureSceneCamera();
  CHECK(gap(seen.position, side.position) < 1e-3);
  CHECK(seen.fieldOfView == Approx(45).margin(1e-6));
  // In between it swings round the aim rather than cutting across.
  viewport.seek(duration / 2);
  seen = viewport.captureSceneCamera();
  CHECK(gap(seen.target, front.target) < 1e-3);
  CHECK(gap(seen.position, front.position) > 50);
  CHECK(gap(seen.position, side.position) > 50);
  const auto middle = viewport.cameraTrackView(duration / 2);
  CHECK(gap(middle.position, seen.position) < 1e-3);

  REQUIRE(session.chooseCameraPreset(bmapp::CameraClock::Build, keys[0].id, "cut", 400).refused.empty());
  CHECK(session.undoName() == "Camera Move: Hard cut");
  viewport.draw(nullptr);
  viewport.seek(duration * 0.9);
  CHECK(gap(viewport.captureSceneCamera().position, front.position) < 1e-3);
  // A cut is a cut between frames too: half a frame before the second key is still the first view.
  viewport.seek(duration - 0.5 / 30);
  CHECK(gap(viewport.captureSceneCamera().position, front.position) < 1e-3);
  REQUIRE(session.setCameraKeyTarget(bmapp::CameraClock::Build, keys[1].id, "build").refused.empty());
  CHECK(session.undoName() == "Follow the Build");
  REQUIRE(session.moveCameraKey(bmapp::CameraClock::Build, keys[1].id, duration / 2, 30, duration).refused.empty());
  CHECK(session.undoName() == "Move Camera Key");

  // A longer hold replans the timing: a key following the build frames it as newly planned.
  auto fields = session.stepFields(0);
  fields.pauseAfter = 3;
  REQUIRE(session.setStepFields(0, fields, false).refused.empty());
  viewport.draw(nullptr);
  finishPlan(viewport);
  bmapp::Viewport fresh(session);
  fresh.resize(320, 180, 1);
  fresh.setPreferences({});
  fresh.requestPlan();
  finishPlan(fresh);
  for (const double t : {0.0, duration / 4, duration / 2, duration * 0.75}) {
    INFO("at " << t);
    CHECK(gap(viewport.cameraTrackView(t).position, fresh.cameraTrackView(t).position) < 1e-3);
  }

  const auto saved = nlohmann::ordered_json::parse(session.projectBytes());
  const auto& tracks = saved["plan"]["cameraTracks"][""];
  CHECK(tracks["timeline"]["shutter"] == 0.3);
  CHECK(tracks["build"]["keys"].size() == 2);
  CHECK(tracks["build"]["transitions"][0]["preset"] == "cut");
  CHECK(tracks["build"]["keys"][1]["target"]["kind"] == "build");

  bmapp::Session reopened;
  REQUIRE(reopened.openBytes(session.projectBytes(), "camera.brickmotion").ok);
  CHECK(reopened.cameraKeys(bmapp::CameraClock::Build).size() == 2);

  REQUIRE(session.removeCameraKey(bmapp::CameraClock::Build, keys[0].id).refused.empty());
  CHECK(session.undoName() == "Delete Camera Key");
  REQUIRE(session.clearCameraTrack(bmapp::CameraClock::Build).refused.empty());
  CHECK(session.undoName() == "Clear Camera Track");
  CHECK(session.cameraKeys(bmapp::CameraClock::Build).empty());
  viewport.draw(nullptr);
  CHECK_FALSE(viewport.followsCameraTrack());
  REQUIRE(session.undo().refused.empty());
  CHECK(session.cameraKeys(bmapp::CameraClock::Build).size() == 1);
}

TEST_CASE("the video camera is the web's exportCamera, the Camera track by default", "[bmapp][camera-track]") {
  bmapp::Session session;
  REQUIRE(session.newBlank().ok);
  REQUIRE(session.placePart("3001.dat", 4, {{}, {0, -24, 0}}, 0, session.generation(), session.version()).refused.empty());
  CHECK(session.exportCamera() == "track");
  CHECK_FALSE(session.setExportCamera("drone").refused.empty());
  REQUIRE(session.setExportCamera("automatic").refused.empty());
  CHECK(session.undoName() == "Film Videos with the Automatic Camera");
  CHECK(nlohmann::json::parse(session.projectBytes())["settings"]["exportCamera"] == "automatic");
  REQUIRE(session.setExportCamera("buildView").refused.empty());
  CHECK(session.exportCamera() == "buildView");
  REQUIRE(session.undo().refused.empty());
  CHECK(session.exportCamera() == "automatic");
  // anything the web would not know reads as its default
  auto project = nlohmann::ordered_json::parse(session.projectBytes());
  project["settings"]["exportCamera"] = "dolly";
  REQUIRE(session.openBytes(project.dump(), "odd.brickmotion").ok);
  CHECK(session.exportCamera() == "track");
}

TEST_CASE("the Build clock is the web's: camera key seconds mean the same moment in both apps", "[bmapp][camera-track][viewport]") {
  bmapp::Session session;
  REQUIRE(session.newBlank().ok);
  for (const double y : {-24.0, -48.0})
    REQUIRE(session.placePart("3001.dat", 4, {{}, {0, y, 0}}, 0, session.generation(), session.version()).refused.empty());
  bmapp::Viewport viewport(session);
  if (!viewport.ok()) SKIP("no Metal device");
  viewport.resize(160, 90, 1);
  viewport.setPreferences({});
  viewport.requestPlan();
  finishPlan(viewport);
  // pacing.ts: the first piece flies at the end of a 1 s intro; the outro is 0.5 s without the
  // hero orbit (3 s with it). Times are seconds from the start of the video at 30 fps.
  auto timeline = viewport.buildTimeline();
  REQUIRE_FALSE(timeline.flights.empty());
  CHECK(timeline.buildStart == Approx(1.0).margin(1e-9));
  CHECK(timeline.flights.front().start == Approx(1.0).margin(1.0 / 30));
  CHECK(timeline.duration - timeline.buildEnd == Approx(0.5).margin(1e-9));
  REQUIRE(session.setSequenceDuration(bmapp::SequenceSegment::Intro, 0).refused.empty());  // held at 0.2, as the web
  viewport.draw(nullptr);
  finishPlan(viewport);
  timeline = viewport.buildTimeline();
  CHECK(timeline.buildStart == Approx(0.2).margin(1e-9));
}

TEST_CASE("what is being built holds on a unit while it is built on its spot, as the web's focus plan", "[bmapp][camera-track]") {
  const auto box = [](double x0, double x1) {
    bm::Box b;
    b.grow({x0, 0, 0});
    b.grow({x1, 1, 1});
    return b;
  };
  // The main model is built on 0..10 from 1 s; a unit is built on its spot at 20..22 from 3 s
  // to 5 s, and flies onto the model, landing at 6 s.
  ct::Assembly main, unit;
  main.lands = {{1, 1.5, box(0, 2)}, {1.5, 2, box(2, 4)}, {5.4, 6, box(8, 10)}, {7, 7.5, box(4, 6)}};
  unit.lands = {{3, 3.5, box(20, 21)}, {4.5, 5, box(21, 22)}};
  const bm::Box model = box(0, 10);
  const std::vector<ct::Assembly> groups{main, unit};
  const auto at = [&](double t) { return ct::focusBox(groups, model, t); };
  // While the unit is built the camera holds the whole unit, entered half a second before its
  // first flight (the previous landing settled at 2 + 0.4) and left 0.4 s after its last landing.
  CHECK(at(4).min.x == Approx(20));
  CHECK(at(4).max.x == Approx(22));
  CHECK(at(2.55).min.x == Approx(20));
  CHECK(at(2.45).max.x < 20);
  CHECK(at(5.39).min.x == Approx(20));
  CHECK(at(5.45).max.x <= 10);
  // On the main model: the landings so far and those due within 1.2 s, grown towards 0.6 of the
  // model's size but never past it.
  CHECK(at(0).min.x == Approx(0));
  CHECK(at(0).max.x == Approx(4));
  CHECK(at(6.5).max.x == Approx(10));
  // The smoothed box glides into the close-up rather than jumping.
  const auto context = ct::buildContext(groups, model, 1);
  const double before = context.build(2.2).max.x, middle = context.build(2.6).max.x, inside = context.build(4).max.x;
  CHECK(before < middle);
  CHECK(middle < inside);
  CHECK(context.piece(3.2).has_value());
  CHECK_FALSE(context.piece(6.5).has_value());
}

TEST_CASE("following what is being built, the viewport holds on a submodel while it is built on the floor", "[bmapp][camera-track][viewport]") {
  bmapp::Session session;
  REQUIRE(session.newBlank().ok);
  // a wide base, then a tall tower on it made as a submodel: the tower is built on its own spot
  for (const double x : {-60.0, -20.0, 20.0, 60.0})
    REQUIRE(session.placePart("3001.dat", 4, {{}, {x, -24, 0}}, 0, session.generation(), session.version()).refused.empty());
  for (const double y : {-48.0, -72.0, -96.0, -120.0})
    REQUIRE(session.placePart("3001.dat", 1, {{}, {60, y, 0}}, 0, session.generation(), session.version()).refused.empty());
  REQUIRE(session.makeSubmodel({4, 5, 6, 7}, "Tower").refused.empty());

  bmapp::Viewport viewport(session);
  if (!viewport.ok()) SKIP("no Metal device");
  viewport.resize(320, 180, 1);
  viewport.setPreferences({});
  viewport.requestPlan();
  finishPlan(viewport);
  const auto timeline = viewport.buildTimeline();
  const auto unit = std::find_if(timeline.submodels.begin(), timeline.submodels.end(), [](const auto& s) { return s.attach > s.start + 0.5; });
  if (unit == timeline.submodels.end()) SKIP("the planner seats this submodel whole");
  bmapp::SceneCamera view;
  view.position = {0, -200, -500}, view.target = {0, -60, 0}, view.fieldOfView = 40;
  REQUIRE(session.addCameraKey(bmapp::CameraClock::Build, 0, view, 30, timeline.duration).refused.empty());
  const std::string id = session.cameraKeys(bmapp::CameraClock::Build)[0].id;
  REQUIRE(session.setCameraKeyTarget(bmapp::CameraClock::Build, id, "build").refused.empty());
  viewport.draw(nullptr);
  REQUIRE(viewport.followsCameraTrack());
  const auto during = viewport.cameraTrackView((unit->start + unit->attach) / 2);
  const auto after = viewport.cameraTrackView(timeline.duration);
  INFO("unit " << unit->start << ".." << unit->attach << " target " << during.target.x << "," << during.target.y << "," << during.target.z
               << " finished " << after.target.x << "," << after.target.y << "," << after.target.z);
  // the close-up looks at the tower's spot on the floor, away from where the finished model stands,
  // and from nearer, since a unit is smaller than the model
  CHECK(gap(during.target, after.target) > 40);
  CHECK(gap(during.position, during.target) < gap(after.position, after.target));
}

namespace {

/// Two JSON values alike, numbers to 1e-6; `where` names the first difference.
bool alike(const ct::Json& a, const ct::Json& b, std::string& where, const std::string& at = "") {
  if (a.is_number() && b.is_number()) {
    if (std::abs(a.get<double>() - b.get<double>()) <= 1e-6 * std::max(1.0, std::abs(b.get<double>()))) return true;
    where = at + ": " + a.dump() + " vs " + b.dump();
    return false;
  }
  if (a.type() != b.type()) {
    where = at + ": " + a.dump() + " vs " + b.dump();
    return false;
  }
  if (a.is_array()) {
    if (a.size() != b.size()) {
      where = at + ": " + std::to_string(a.size()) + " items vs " + std::to_string(b.size());
      return false;
    }
    for (size_t i = 0; i < a.size(); ++i)
      if (!alike(a[i], b[i], where, at + "[" + std::to_string(i) + "]")) return false;
    return true;
  }
  if (a.is_object()) {
    for (const auto& [k, v] : b.items()) {
      if (!a.contains(k)) {
        where = at + "." + k + " missing";
        return false;
      }
      if (!alike(a[k], v, where, at + "." + k)) return false;
    }
    for (const auto& [k, v] : a.items())
      if (!b.contains(k)) {
        where = at + "." + k + " extra";
        return false;
      }
    return true;
  }
  if (a == b) return true;
  where = at + ": " + a.dump() + " vs " + b.dump();
  return false;
}

bm::Box lduBox(const ct::Json& b) {
  bm::Box box;
  box.grow({b["min"][0].get<double>(), b["min"][1].get<double>(), b["min"][2].get<double>()});
  box.grow({b["max"][0].get<double>(), b["max"][1].get<double>(), b["max"][2].get<double>()});
  return box;
}

}  // namespace

TEST_CASE("Auto-direct writes the web's track for every style, and keeps hand-made keys", "[bmapp][camera-track]") {
  std::ifstream file(std::string(BM_REPO) + "/native/app/bmapp/tests/data/autodirect_goldens.json");
  REQUIRE(file);
  const auto goldens = ct::Json::parse(file);
  for (const auto& c : goldens["cases"]) {
    ct::DirectorBuild build;
    for (const auto& u : c["units"]) {
      const double start = u["start"].get<double>();
      build.lands.push_back({start, start + u["dur"].get<double>(), ct::toWeb(lduBox(u["land"]))});
    }
    build.model = ct::toWeb(lduBox(c["modelBox"]));
    build.intro = c["intro"].get<double>(), build.buildEnd = c["buildEnd"].get<double>(), build.duration = c["duration"].get<double>();
    for (const auto& [style, want] : c["tracks"].items()) {
      ct::DirectorOptions options;
      options.style = style;
      std::string where;
      INFO(c["name"].get<std::string>() << " " << style);
      CHECK(alike(ct::autoDirect(build, options), want, where));
      INFO(where);
      CHECK(where.empty());
    }
  }
  const auto& merge = goldens["merge"];
  std::string where;
  const auto merged = ct::mergeAuto(merge["existing"], goldens["cases"][0]["tracks"]["reference"], goldens["cases"][0]["duration"].get<double>());
  CHECK(alike(merged, merge["merged"], where));
  INFO(where);
  CHECK(where.empty());
  // the comparison notices a difference: one style is not another
  CHECK_FALSE(alike(goldens["cases"][0]["tracks"]["calm"], goldens["cases"][0]["tracks"]["overhead"], where));
  // an unknown style directs as the Speed build
  ct::DirectorOptions odd;
  odd.style = "nonsense";
  CHECK(ct::autoDirect({}, odd)["style"] == "reference");
}

TEST_CASE("the Keyframes timeline has a Camera track of its own, on its own clock", "[bmapp][camera-track][viewport]") {
  bmapp::Session session;
  REQUIRE(session.newBlank().ok);
  for (const double y : {-24.0, -48.0, -72.0})
    REQUIRE(session.placePart("3001.dat", 4, {{}, {0, y, 0}}, 0, session.generation(), session.version()).refused.empty());
  bmapp::Viewport viewport(session);
  if (!viewport.ok()) SKIP("no Metal device");
  viewport.resize(320, 180, 1);
  viewport.setPreferences({});
  viewport.requestPlan();
  finishPlan(viewport);
  const auto scene = session.keyScene();
  const double length = static_cast<double>(scene.last - scene.first + 1) / scene.fps;
  bmapp::SceneCamera front, side, build;
  front.position = {0, -60, -400}, front.target = {0, -40, 0}, front.fieldOfView = 30;
  side.position = {400, -200, 0}, side.target = {0, -40, 0}, side.fieldOfView = 45;
  build.position = {0, -400, -300}, build.target = {0, 0, 0}, build.fieldOfView = 35;
  REQUIRE(session.addCameraKey(bmapp::CameraClock::Timeline, 0, front, scene.fps, length).refused.empty());
  REQUIRE(session.addCameraKey(bmapp::CameraClock::Timeline, 4, side, scene.fps, length).refused.empty());
  REQUIRE(session.addCameraKey(bmapp::CameraClock::Build, 0, build, 30, viewport.buildTimeline().duration).refused.empty());
  CHECK(session.cameraKeys(bmapp::CameraClock::Timeline).size() == 2);
  CHECK(session.cameraKeys(bmapp::CameraClock::Build).size() == 1);
  // saved as the web keeps them: each clock under its own key
  const auto saved = nlohmann::ordered_json::parse(session.projectBytes())["plan"]["cameraTracks"][""];
  CHECK(saved["timeline"]["keys"].size() == 2);
  CHECK(saved["build"]["keys"].size() == 1);

  viewport.setDirectorPreview(true);
  viewport.draw(nullptr);
  REQUIRE(viewport.followsCameraTrack());
  CHECK(gap(viewport.cameraTrackView(0).position, build.position) < 1e-3);  // the Build tab: the Build's track
  viewport.useKeyframes(true);
  viewport.draw(nullptr);
  REQUIRE(viewport.followsCameraTrack());
  // the Keyframes tab: the timeline's own keys, at seconds from its first frame
  CHECK(gap(viewport.cameraTrackView(0).position, front.position) < 1e-3);
  CHECK(gap(viewport.cameraTrackView(4).position, side.position) < 1e-3);
  viewport.seek(4);
  viewport.draw(nullptr);
  CHECK(gap(viewport.captureSceneCamera().position, side.position) < 1e-3);
  // clearing one clock leaves the other
  REQUIRE(session.clearCameraTrack(bmapp::CameraClock::Timeline).refused.empty());
  CHECK(session.cameraKeys(bmapp::CameraClock::Build).size() == 1);
  viewport.draw(nullptr);
  CHECK_FALSE(viewport.followsCameraTrack());
}

TEST_CASE("the inspector's key and move fields: held to range, a drag one undo step, a typed camera position", "[bmapp][camera-track]") {
  bmapp::Session session;
  REQUIRE(session.newBlank().ok);
  REQUIRE(session.placePart("3001.dat", 4, {{}, {0, -24, 0}}, 0, session.generation(), session.version()).refused.empty());
  const auto B = bmapp::CameraClock::Build;
  bmapp::SceneCamera view;
  view.position = {0, -60, -400}, view.target = {0, -40, 0}, view.fieldOfView = 30;
  REQUIRE(session.addCameraKey(B, 0, view, 30, 10).refused.empty());
  view.position = {400, -60, 0};
  REQUIRE(session.addCameraKey(B, 5, view, 30, 10).refused.empty());
  auto key = session.cameraKeys(B)[0];
  CHECK(key.target == "point");
  CHECK_FALSE(key.fitted);
  CHECK(gap(key.eye, {0, -60, -400}) < 1e-6);  // where the camera stands, as it was keyed
  CHECK(gap(key.point, {0, -40, 0}) < 1e-6);
  CHECK(key.distance == Approx(std::hypot(400.0, 20.0) / 20));

  // a drag: its first change is a step, the rest of it grows that step
  const double keyed = key.elevation;
  key.elevation = 30;
  REQUIRE(session.setCameraKey(B, key, false).refused.empty());
  key.elevation = 40;
  REQUIRE(session.setCameraKey(B, key, true).refused.empty());
  key.elevation = 200;  // past the top: held at 89
  REQUIRE(session.setCameraKey(B, key, true).refused.empty());
  CHECK(session.cameraKeys(B)[0].elevation == Approx(89));
  CHECK(session.undoName() == "Change Camera Key");
  session.undo();
  CHECK(session.cameraKeys(B)[0].elevation == Approx(keyed));
  CHECK(session.undoName() == "Add Camera Key");  // the whole drag was one step
  session.redo();
  CHECK(session.cameraKeys(B)[0].elevation == Approx(89));
  // a new drag right after is a new step
  key = session.cameraKeys(B)[0];
  key.elevation = 10;
  REQUIRE(session.setCameraKey(B, key, false).refused.empty());
  session.undo();
  CHECK(session.cameraKeys(B)[0].elevation == Approx(89));
  CHECK(session.undoName() == "Change Camera Key");

  // typing where the camera stands works out its angle and distance; it still looks at the point
  key = session.cameraKeys(B)[0];
  key.eye = {300, -40, 0};
  REQUIRE(session.setCameraKey(B, key, false).refused.empty());
  key = session.cameraKeys(B)[0];
  CHECK(gap(key.eye, {300, -40, 0}) < 1e-6);
  CHECK(key.elevation == Approx(0).margin(1e-9));
  CHECK(key.distance == Approx(15));
  CHECK(std::abs(key.azimuth) == Approx(90));
  // the lens, focus and blur are kept as the web keeps them, and a fitted distance has a margin
  key.lensMm = 1000, key.focusTarget = false, key.focus = 0.25, key.blur = 2, key.fitted = true, key.margin = 1.4, key.roll = 12;
  REQUIRE(session.setCameraKey(B, key, false).refused.empty());
  key = session.cameraKeys(B)[0];
  CHECK(key.lensMm == Approx(400));
  CHECK_FALSE(key.focusTarget);
  CHECK(key.focus == Approx(0.25));
  CHECK(key.blur == Approx(1));
  CHECK(key.fitted);
  CHECK(key.margin == Approx(1.4));
  CHECK(key.roll == Approx(12));
  CHECK(key.user);

  // the move between the keys
  auto moves = session.cameraMoves(B);
  REQUIRE(moves.size() == 1);
  auto move = moves[0];
  CHECK(move.preset == "glide");
  CHECK(move.curve == "easeInOut");
  move.orbit = "ccw", move.extraTurns = 9, move.curve = "nonsense", move.shake = 0.5, move.turnLast = 1.5, move.straight = true;
  REQUIRE(session.setCameraMove(B, move, false).refused.empty());
  CHECK(session.undoName() == "Change Camera Move");
  move = session.cameraMoves(B)[0];
  CHECK(move.orbit == "ccw");
  CHECK(move.extraTurns == 5);
  CHECK(move.curve == "easeInOut");
  CHECK(move.shake == Approx(0.5));
  CHECK(move.turnLast == Approx(1.5));
  CHECK(move.straight);
  CHECK(move.preset == "glide");  // the preset's name stays, as the web's inspector keeps it
  move.turnLast = 0;
  REQUIRE(session.setCameraMove(B, move, false).refused.empty());
  const auto track = nlohmann::ordered_json::parse(session.projectBytes())["plan"]["cameraTracks"][""]["build"];
  CHECK_FALSE(track["transitions"][0]["settings"].contains("turnLast"));
  CHECK(track["transitions"][0]["settings"]["path"] == "straight");
  CHECK(track["transitions"][0]["origin"] == "user");
}

TEST_CASE("Auto-direct on the Build and the linked timeline: one undo step that films videos with the track", "[bmapp][camera-track][viewport]") {
  bmapp::Session session;
  REQUIRE(session.newBlank().ok);
  for (const double x : {-40.0, 0.0, 40.0})
    for (const double y : {-24.0, -48.0})
      REQUIRE(session.placePart("3001.dat", 4, {{}, {x, y, 0}}, 0, session.generation(), session.version()).refused.empty());
  REQUIRE(session.setExportCamera("automatic").refused.empty());
  const auto B = bmapp::CameraClock::Build, T = bmapp::CameraClock::Timeline;
  CHECK_FALSE(session.autoDirectCamera(B, {}, "reference", 50).refused.empty());  // nothing planned
  bmapp::Viewport viewport(session);
  if (!viewport.ok()) SKIP("no Metal device");
  viewport.resize(320, 180, 1);
  viewport.setPreferences({});
  viewport.requestPlan();
  finishPlan(viewport);
  const auto input = viewport.cameraDirectorInput();
  REQUIRE(input.ok);
  CHECK(input.lands.size() == 6);
  CHECK(input.buildEnd > input.intro);
  // a key of mine stays
  bmapp::SceneCamera view;
  view.position = {0, -60, -400}, view.target = {0, -40, 0}, view.fieldOfView = 30;
  REQUIRE(session.addCameraKey(B, input.duration, view, 30, input.duration).refused.empty());
  REQUIRE(session.autoDirectCamera(B, input, "reference", 50).refused.empty());
  CHECK(session.undoName() == "Auto-Direct Camera");
  CHECK(session.exportCamera() == "track");
  CHECK(session.cameraDirectorStyle(B) == "reference");
  const auto keys = session.cameraKeys(B);
  REQUIRE(keys.size() >= 3);
  CHECK(std::count_if(keys.begin(), keys.end(), [](const auto& k) { return k.user; }) == 1);
  CHECK(keys.back().user);  // mine, at the end; the automatic key there made way
  // one step undoes both the track and the video camera
  session.undo();
  CHECK(session.cameraKeys(B).size() == 1);
  CHECK(session.exportCamera() == "automatic");
  session.redo();

  // the timeline's: refused until the Build is linked, then on the timeline's clock
  CHECK_FALSE(session.autoDirectCamera(T, input, "calm", 50).refused.empty());
  auto scene = session.keyScene();
  scene.buildLinked = true, scene.buildStart = scene.first + scene.fps * 2, scene.buildSpeed = 2;
  REQUIRE(session.setKeyScene(scene).refused.empty());
  REQUIRE(session.autoDirectCamera(T, input, "calm", 50).refused.empty());
  const auto timeline = session.cameraKeys(T);
  const auto build = ct::autoDirect([&] {
    ct::DirectorBuild b;
    for (const auto& l : input.lands) {
      bm::Box box;
      box.grow({l.min.x, l.min.y, l.min.z});
      box.grow({l.max.x, l.max.y, l.max.z});
      b.lands.push_back({l.start, l.end, ct::toWeb(box)});
    }
    bm::Box model;
    model.grow({input.modelMin.x, input.modelMin.y, input.modelMin.z});
    model.grow({input.modelMax.x, input.modelMax.y, input.modelMax.z});
    b.model = ct::toWeb(model), b.intro = input.intro, b.buildEnd = input.buildEnd, b.duration = input.duration;
    return b;
  }(), [] { ct::DirectorOptions o; o.style = "calm"; return o; }());
  REQUIRE(timeline.size() >= 2);
  // the Build starts 2 s into the timeline and plays at twice the speed
  CHECK(timeline[1].seconds == Approx(2 + build["keys"][1]["t"].get<double>() / 2));
  CHECK(session.cameraKeys(B).size() == keys.size());  // the Build's track is not touched
}

TEST_CASE("a shot's roll turns the camera about its view, and its focus lies across the model", "[bmapp][camera-track]") {
  auto c = boxContext();
  auto key = fittedKey(0, 30);
  key["roll"] = 20, key["blur"] = 0.6, key["focus"] = 0.25;
  const ct::Json track = ct::addKey({}, key, 30, 10);
  const auto shot = ct::sample(track, 0, c);
  REQUIRE(shot);
  CHECK(shot->roll == Approx(20));
  CHECK(shot->blur == Approx(0.6));
  CHECK(shot->focus == Approx(0.25));
  CHECK(ct::lensBlurShare(*shot) == Approx(0.6 * 18 / 1080));
  // 'target' focus samples as the middle of the model, as the web's
  key["focus"] = "target";
  CHECK(ct::sample(ct::addKey({}, key, 30, 10), 0, c)->focus == Approx(0.5));

  // Unrolled, up is web +Y (LDU -Y); rolled, it leans `roll` degrees about the view, staying square to it.
  ct::Shot level = *shot;
  level.roll = 0;
  const bm::Vec3 up0 = ct::upLdu(level), up = ct::upLdu(*shot);
  const bm::Vec3 view = bm::normalized(ct::toLdu(shot->target) - ct::toLdu(shot->eye));
  CHECK(bm::dot(up, view) == Approx(0).margin(1e-9));
  CHECK(bm::length(up) == Approx(1));
  CHECK(std::acos(std::clamp(bm::dot(up, up0), -1.0, 1.0)) * 180 / M_PI == Approx(20));
  CHECK(up0.y < -0.9);
  // three.js rotateZ(+roll) turns the camera anticlockwise as it looks: its up leans to its left
  const bm::Vec3 rightWeb = bm::normalized(bm::cross(bm::normalized(shot->target - shot->eye), bm::Vec3{0, 1, 0}));
  CHECK(bm::dot(up, bm::Vec3{rightWeb.x, -rightWeb.y, -rightWeb.z}) == Approx(-std::sin(20 * M_PI / 180)));
  ct::Shot down = level;
  down.eye = down.target + bm::Vec3{0, 10, 0};
  CHECK(ct::upLdu(down).y == Approx(-1));  // straight down: no roll to take

  // Focus 0 is the box's nearest corner along the view, 1 its farthest.
  bm::Box box;
  box.grow({-10, -10, 90}), box.grow({10, 10, 110});
  CHECK(ct::focusDistance({0, 0, 0}, {0, 0, 1}, box, 0, 1) == Approx(90));
  CHECK(ct::focusDistance({0, 0, 0}, {0, 0, 1}, box, 1, 1) == Approx(110));
  CHECK(ct::focusDistance({0, 0, 0}, {0, 0, 1}, box, 0.5, 1) == Approx(100));
  CHECK(ct::focusDistance({0, 0, 100}, {0, 0, 101}, box, 0, 1) == Approx(1));  // never nearer than near
}

TEST_CASE("the viewport films a shot's roll and depth of field", "[bmapp][camera-track][viewport]") {
  bmapp::Session session;
  REQUIRE(session.newBlank().ok);
  // A brick near the front and one far behind it, so a lens focused on one blurs the other.
  REQUIRE(session.placePart("3001.dat", 4, {{}, {-40, -24, -200}}, 0, session.generation(), session.version()).refused.empty());
  REQUIRE(session.placePart("3001.dat", 1, {{}, {60, -24, 400}}, 0, session.generation(), session.version()).refused.empty());
  bmapp::Viewport viewport(session);
  if (!viewport.ok()) SKIP("no Metal device");
  viewport.resize(240, 135, 1);
  viewport.setPreferences({});
  viewport.requestPlan();
  finishPlan(viewport);
  const double duration = viewport.buildTimeline().duration;
  bmapp::SceneCamera front;
  front.position = {0, -120, -900}, front.target = {0, -24, 100}, front.fieldOfView = 40;
  REQUIRE(session.addCameraKey(bmapp::CameraClock::Build, duration, front, 30, duration).refused.empty());
  viewport.draw(nullptr);
  REQUIRE(viewport.followsCameraTrack());
  viewport.setDirectorPreview(true);
  const auto at = [&] {
    viewport.seek(duration);
    return viewport.capture();
  };
  const auto differing = [](const bmapp::Picture& a, const bmapp::Picture& b) {
    REQUIRE(a.rgba.size() == b.rgba.size());
    size_t n = 0;
    for (size_t i = 0; i < a.rgba.size(); i += 4)
      if (std::abs(int(a.rgba[i]) - int(b.rgba[i])) + std::abs(int(a.rgba[i + 1]) - int(b.rgba[i + 1])) + std::abs(int(a.rgba[i + 2]) - int(b.rgba[i + 2])) > 24) n++;
    return n;
  };
  const auto plain = at();
  CHECK(differing(plain, at()) == 0);

  auto key = session.cameraKeys(bmapp::CameraClock::Build).at(0);
  key.blur = 1, key.focusTarget = false, key.focus = 0;  // focused on the near brick
  REQUIRE(session.setCameraKey(bmapp::CameraClock::Build, key, false).refused.empty());
  viewport.draw(nullptr);
  const auto blurred = at();
  const size_t blurredPixels = differing(plain, blurred);
  CHECK(blurredPixels > 40);

  if (const char* dump = std::getenv("BMR_DUMP")) {  // look at what the test saw
    for (const auto& [name, picture] : {std::pair{"track_plain", &plain}, std::pair{"track_blurred", &blurred}})
      bmr::writePng({picture->width, picture->height, picture->rgba}, std::filesystem::path(dump) / (std::string(name) + ".png"));
  }
  key.blur = 0, key.roll = 15;
  REQUIRE(session.setCameraKey(bmapp::CameraClock::Build, key, false).refused.empty());
  viewport.draw(nullptr);
  const auto rolled = at();
  CHECK(differing(plain, rolled) > 40);
  if (const char* dump = std::getenv("BMR_DUMP"))
    bmr::writePng({rolled.width, rolled.height, rolled.rgba}, std::filesystem::path(dump) / "track_rolled.png");
  // The camera stands where it did: only its up turned.
  const auto seen = viewport.captureSceneCamera();
  CHECK(gap(seen.position, front.position) < 1e-3);
}
