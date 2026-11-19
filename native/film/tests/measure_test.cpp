#include <catch2/catch_test_macros.hpp>
#include <algorithm>
#include <cstdio>
#include "bmf/body.h"
#include "bmf/director.h"
#include "bmf/measure.h"
#include "fixture.h"

using namespace bm;
using namespace bm::film;
using filmtest::Scene;

namespace {
constexpr double kFps = 30;
Report filmAndMeasure(Scene& s, double aspect) {
  const Beats beats = beatsOf(s.t, s.p, *s.model, *s.world);
  const std::vector<Shot> shots = direct(beats, s.t, s.p, *s.world, referenceStyle(), kFps);
  FrameShape shape;
  shape.aspect = aspect;
  const Track track = shoot(shots, beats, s.t, s.p, *s.world, shape, kFps);
  return measure(track, shots, beats, s.t, s.p, *s.world);
}
}  // namespace

TEST_CASE("a seat no angle sees is reported, not hidden", "[measure]") {
  // A well two bricks deep, ringed all round (diagonals too, so no ray slips out between them);
  // the brick at its bottom lands last but one, then a brick on it fills the well's top.
  Scene s;
  std::vector<uint32_t> low;
  for (int x = -1; x <= 1; x++)
    for (int z = -1; z <= 1; z++)
      if (x || z) low.push_back(s.add(20.0 * x, 0, 20.0 * z));
  s.step();
  for (size_t i = 0; i < low.size(); i++) s.stud(low[i], s.add(s.at[low[i]].x, -24, s.at[low[i]].z));
  s.step();
  const uint32_t deep = s.add(0, 0, 0);
  s.step();
  s.stud(deep, s.add(0, -24, 0));
  s.finish();
  int flight = -1;
  for (size_t f = 0; f < s.t.flights.size(); f++) {
    const auto& own = plan::piecesOf(s.t.flights[f], s.p);
    if (std::find(own.begin(), own.end(), deep) != own.end()) flight = static_cast<int>(f);
  }
  REQUIRE(flight >= 0);
  const Report r = filmAndMeasure(s, 16.0 / 9);
  CHECK(r.landings == static_cast<int>(std::count_if(s.t.flights.begin(), s.t.flights.end(), [](const plan::Flight& f) { return f.parent < 0; })));
  // In the frame (the spec's gate), behind what was built: hidden, which no angle can mend.
  CHECK(std::find(r.missed.begin(), r.missed.end(), flight) == r.missed.end());
  CHECK(std::find(r.hidden.begin(), r.hidden.end(), flight) != r.hidden.end());
  CHECK(r.landingsInFrame == r.landings - static_cast<int>(r.missed.size()));
  CHECK(r.landingsSeen == r.landingsInFrame - static_cast<int>(r.hidden.size()));
  CHECK(r.hidden.size() <= 2);  // the deep one, and at most one more: the rest are in plain view
}

TEST_CASE("a landing the camera looks away from is off frame, not hidden", "[measure]") {
  Scene s;
  filmtest::tower(s, 4);
  const Beats beats = beatsOf(s.t, s.p, *s.model, *s.world);
  const std::vector<Shot> shots = direct(beats, s.t, s.p, *s.world, referenceStyle(), kFps);
  Track track = shoot(shots, beats, s.t, s.p, *s.world, FrameShape{}, kFps);
  for (Frame& f : track.frames) f.target = f.target + Vec3{5000, 0, 0}, f.eye = f.eye + Vec3{5000, 0, 0};
  const Report r = measure(track, shots, beats, s.t, s.p, *s.world);
  CHECK(r.landingsInFrame == 0);
  CHECK(r.landingsSeen == 0);
  CHECK(r.missed.size() == 4);
  CHECK(r.hidden.empty());
}

TEST_CASE("a clean build measures clean", "[measure]") {
  Scene s;
  filmtest::tower(s, 8);
  const Report r = filmAndMeasure(s, 16.0 / 9);
  CHECK(r.landings == 8);
  CHECK(r.landingsInFrame == r.landings);
  CHECK(r.landingsSeen == r.landings);
  CHECK(r.missed.empty());
  CHECK(r.insideFrames == 0);
  CHECK(r.rules.empty());
  CHECK(r.maxTargetJump >= 0);
  CHECK(r.shortestShot >= kMinShotSeconds - 1e-9);
  CHECK(r.cutsPerMinute >= 0);
  // Where the worst moves are, so a reader can find them.
  CHECK(r.jerkFrame >= 3);
  CHECK(r.jumpFrame >= 1);
}

TEST_CASE("what lands as the camera moves to a unit stays in frame", "[measure]") {
  // Bricks land on one 2x4; then a unit is built on its spot on another, well away. The move to
  // the unit starts before its first piece leaves, while the last bricks are still landing.
  Scene s;
  const uint32_t near = s.add(0, 0, 0, "3001.dat"), far = s.add(300, 0, 0, "3001.dat");
  s.step();
  uint32_t below = near;
  for (int i = 1; i <= 4; i++) {
    const uint32_t b = s.add(30, -24.0 * i, 0);
    s.stud(below, b);
    below = b;
  }
  s.step();
  uint32_t lower = s.addIn(270, -24, 0);
  s.stud(far, lower);
  for (int i = 2; i <= 4; i++) {
    s.subStep();
    const uint32_t b = s.addIn(270, -24.0 * i, 0);
    s.stud(lower, b);
    lower = b;
  }
  s.finish();
  const Beats beats = beatsOf(s.t, s.p, *s.model, *s.world);
  const std::vector<Shot> shots = direct(beats, s.t, s.p, *s.world, referenceStyle(), kFps);
  for (double aspect : {16.0 / 9, 9.0 / 16}) {
  FrameShape shape;
  shape.aspect = aspect;
  const Track track = shoot(shots, beats, s.t, s.p, *s.world, shape, kFps);
  INFO("aspect " << aspect);
  // The case is only a case if a brick of the first step lands in the unit's shot.
  bool overlap = false;
  for (const plan::Flight& f : s.t.flights) {
    const uint32_t piece = plan::piecesOf(f, s.p).front();
    if (f.parent >= 0 || s.model->pieces()[piece].step != 1 || s.at[piece].x != 30) continue;
    const Shot& at = shots[static_cast<size_t>(track.frames[static_cast<size_t>(f.startFrame + f.frames)].shot)];
    overlap = overlap || at.subject.kind == SubjectKind::Unit;
  }
  REQUIRE(overlap);
  const Report r = measure(track, shots, beats, s.t, s.p, *s.world);
  CHECK(r.landingsInFrame == r.landings);
  }
}
