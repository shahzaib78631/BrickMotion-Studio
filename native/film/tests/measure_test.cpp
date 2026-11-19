#include <catch2/catch_test_macros.hpp>
#include <algorithm>
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
  CHECK(std::find(r.missed.begin(), r.missed.end(), flight) != r.missed.end());
  CHECK(r.landingsInFrame == r.landings - static_cast<int>(r.missed.size()));
  CHECK(r.missed.size() <= 2);  // the deep one, and at most one more: the rest are in plain view
}

TEST_CASE("a clean build measures clean", "[measure]") {
  Scene s;
  filmtest::tower(s, 8);
  const Report r = filmAndMeasure(s, 16.0 / 9);
  CHECK(r.landings == 8);
  CHECK(r.landingsInFrame == r.landings);
  CHECK(r.missed.empty());
  CHECK(r.insideFrames == 0);
  CHECK(r.rules.empty());
  CHECK(r.maxTargetJump >= 0);
  CHECK(r.shortestShot >= kMinShotSeconds - 1e-9);
  CHECK(r.cutsPerMinute >= 0);
}
