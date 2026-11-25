#include <catch2/catch_test_macros.hpp>
#include <catch2/matchers/catch_matchers_floating_point.hpp>

#include <filesystem>

#include "bmapp/build_lanes.h"
#include "bmapp/session.h"

namespace fs = std::filesystem;
using Catch::Matchers::WithinAbs;

namespace {

fs::path helicopter() { return fs::path(BM_REPO) / "samples" / "helicopter" / "helicopter.mpd"; }

bmapp::BuildFlightRow flight(uint32_t piece, int step, double start, double end, const char* flag = "") {
  bmapp::BuildFlightRow f;
  f.piece = piece;
  f.step = step;
  f.start = start;
  f.end = end;
  f.flag = flag;
  return f;
}

// Three steps, seven flights; step 1's last flight runs past step 2's first start.
bmapp::BuildTimeline handTimeline() {
  bmapp::BuildTimeline t;
  t.version = 7;
  t.duration = 8;
  t.buildStart = 1;
  t.buildEnd = 6;
  t.flights = {flight(0, 0, 1.0, 1.5), flight(1, 0, 1.3, 1.8), flight(2, 0, 1.6, 2.0), flight(3, 1, 3.0, 3.5),
               flight(4, 1, 3.4, 4.2), flight(5, 2, 4.0, 4.6), flight(6, 2, 4.5, 5.0, "blocked")};
  return t;
}


}  // namespace

TEST_CASE("runs merge overlapping steps", "[lanes]") {
  const bmapp::BuildLanes lanes = bmapp::buildLanes(handTimeline(), nullptr);
  CHECK(lanes.version == 7);
  REQUIRE(lanes.runs.size() == 2);
  CHECK(lanes.runs[0].step == 0);
  CHECK(lanes.runs[0].start == 1.0);
  CHECK(lanes.runs[0].end == 2.0);
  CHECK(lanes.runs[0].next == 3.0);
  CHECK(lanes.runs[1].id == 1);
  CHECK(lanes.runs[1].step == 1);
  CHECK(lanes.runs[1].start == 3.0);
  CHECK(lanes.runs[1].end == 5.0);
  CHECK(lanes.runs[1].next == 6.0);
}

TEST_CASE("step clips pause to the next start", "[lanes]") {
  const bmapp::BuildLanes lanes = bmapp::buildLanes(handTimeline(), nullptr);
  REQUIRE(lanes.steps.size() == 3);
  CHECK(lanes.steps[0].step == 0);
  CHECK(lanes.steps[0].pauseEnd == 3.0);
  CHECK(lanes.steps[0].flights == std::vector<size_t>{0, 1, 2});
  CHECK(lanes.steps[1].end == 4.2);
  CHECK(lanes.steps[1].pauseEnd == 4.2);  // the next step starts before this one ends
  CHECK(lanes.steps[2].start == 4.0);
  CHECK(lanes.steps[2].pauseEnd == 8.0);  // the last pauses to the timeline's end
}

TEST_CASE("diagnostics are flagged flights", "[lanes]") {
  const bmapp::BuildLanes lanes = bmapp::buildLanes(handTimeline(), nullptr);
  CHECK(lanes.diagnostics == std::vector<size_t>{6});
}

TEST_CASE("runAt and travel", "[lanes]") {
  const bmapp::BuildLanes lanes = bmapp::buildLanes(handTimeline(), nullptr);
  size_t run = 99;
  REQUIRE(bmapp::runAt(lanes, 0.5, &run));
  CHECK(run == 0);
  REQUIRE(bmapp::runAt(lanes, 3.5, &run));
  CHECK(run == 1);
  CHECK_FALSE(bmapp::runAt(bmapp::BuildLanes{}, 1, &run));

  CHECK(bmapp::travel(lanes, 0, 8, true) == 1.0);
  CHECK(bmapp::travel(lanes, 1.0, 8, true) == 3.0);
  CHECK(bmapp::travel(lanes, 4.0, 8, true) == 8.0);
  CHECK(bmapp::travel(lanes, 3.01, 8, false) == 1.0);
  CHECK(bmapp::travel(lanes, 0.5, 8, false) == 0.0);
}

TEST_CASE("nearest flight keeps to its depth", "[lanes]") {
  bmapp::BuildTimeline t = handTimeline();
  t.flights[3].depth = 1;
  CHECK(bmapp::nearestFlight(t, 3.2, false) == 4);
  CHECK(bmapp::nearestFlight(t, 3.2, true) == 3);
  CHECK(bmapp::nearestFlight(bmapp::BuildTimeline{}, 1, false) == -1);
}

TEST_CASE("arrival target before the first later flight, else after the last in run", "[lanes]") {
  bmapp::Session s;
  REQUIRE(s.open(helicopter().string()).ok);
  size_t step = 0;
  while (step < s.stepCount() && s.stepItems(step).size() < 4) ++step;
  REQUIRE(step < s.stepCount());
  const std::vector<bmapp::ItemRow> items = s.stepItems(step);
  bmapp::BuildTimeline t;
  t.version = 1;
  t.duration = 10;
  t.buildEnd = 9;
  for (size_t i = 0; i < 4; ++i) {
    REQUIRE(!items[i].pieces.empty());
    t.flights.push_back(flight(items[i].pieces[0], int(step), 1 + 0.4 * double(i), 1.5 + 0.4 * double(i)));
  }
  const bmapp::BuildLanes lanes = bmapp::buildLanes(t, &s);

  bmapp::ArrivalTarget a = bmapp::arrivalTarget(lanes, t, &s, 1.5, {});
  REQUIRE(a.ok);
  CHECK(a.step == int(step));
  CHECK(a.before == 2);
  CHECK_THAT(a.time, WithinAbs(1.8, 1e-9));

  // Excluding the flight under the pointer skips it.
  a = bmapp::arrivalTarget(lanes, t, &s, 1.5, {items[2].pieces[0]});
  CHECK(a.before == 3);

  // After the run's last start: after its last item, drawn at the run's end.
  a = bmapp::arrivalTarget(lanes, t, &s, 2.3, {});
  CHECK(a.before == 4);  // after the fourth item (index 3)
  CHECK_THAT(a.time, WithinAbs(lanes.runs[0].end, 1e-9));

  CHECK_FALSE(bmapp::arrivalTarget(bmapp::BuildLanes{}, t, &s, 1, {}).ok);
  CHECK_FALSE(bmapp::arrivalTarget(lanes, t, nullptr, 1.5, {}).ok);
}

TEST_CASE("packLane reuses the first free row", "[lanes]") {
  const bmapp::LanePacking p = bmapp::packLane({{0, 10}, {5, 10}, {12, 3}});
  CHECK(p.rows == std::vector<uint32_t>{0, 1, 0});
  CHECK(p.count == 2);
}

TEST_CASE("packLane grows past a power of two", "[lanes]") {
  std::vector<bmapp::LaneSpan> spans;
  for (int i = 0; i < 100; ++i) spans.push_back({double(i) * 0.01, 50});
  const bmapp::LanePacking p = bmapp::packLane(spans);
  REQUIRE(p.rows.size() == 100);
  for (uint32_t i = 0; i < 100; ++i) CHECK(p.rows[i] == i);
  CHECK(p.count == 100);
  // A later span reuses row 0 once it is free.
  spans.push_back({100, 1});
  CHECK(bmapp::packLane(spans).rows.back() == 0);
}

TEST_CASE("submodel uses not scheduled become use clips", "[lanes]") {
  bmapp::Session s;
  REQUIRE(s.open(helicopter().string()).ok);
  bmapp::ItemRow use;
  bool found = false;
  for (size_t step = 0; step < s.stepCount() && !found; ++step) {
    for (const bmapp::ItemRow& item : s.stepItems(step)) {
      if (item.submodel && !item.pieces.empty()) {
        use = item;
        found = true;
        break;
      }
    }
  }
  REQUIRE(found);
  bmapp::BuildTimeline t;
  t.version = 3;
  t.duration = 20;
  t.buildEnd = 19;
  double at = 2;
  for (uint32_t piece : use.pieces) {
    bmapp::BuildFlightRow f = flight(piece, int(use.step), at, at + 0.5);
    f.depth = 1;
    t.flights.push_back(f);
    at += 0.3;
  }
  const bmapp::BuildLanes lanes = bmapp::buildLanes(t, &s);
  REQUIRE(lanes.submodels.size() == 1);
  const bmapp::LaneSubmodel& clip = lanes.submodels[0];
  CHECK_FALSE(clip.scheduled);
  CHECK(clip.item == use.item);
  CHECK(clip.depth == 0);
  CHECK(clip.attach < 0);
  CHECK(clip.start == 2.0);
  CHECK_THAT(clip.end, WithinAbs(t.flights.back().end, 1e-9));
  CHECK(clip.path == bmapp::StringList{use.name});
  CHECK(clip.pieces == use.pieces);

  // Once the planner schedules it, the use is not repeated.
  bmapp::BuildSubmodelRow row;
  row.flight = 0;
  row.start = 2;
  row.end = 9;
  row.attach = 8;
  row.path = {use.name};
  row.pieces = use.pieces;
  t.submodels.push_back(row);
  const bmapp::BuildLanes scheduled = bmapp::buildLanes(t, &s);
  REQUIRE(scheduled.submodels.size() == 1);
  CHECK(scheduled.submodels[0].scheduled);
  CHECK(scheduled.submodels[0].flight == 0);
  CHECK(scheduled.submodels[0].attach == 8);
}
