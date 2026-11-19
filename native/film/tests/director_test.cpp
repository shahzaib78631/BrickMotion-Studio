#include <catch2/catch_approx.hpp>
#include <catch2/catch_test_macros.hpp>
#include <chrono>
#include <cmath>
#include "bmf/director.h"
#include "fixture.h"

using namespace bm;
using namespace bm::film;
using filmtest::Scene;
using Catch::Approx;

namespace {
constexpr double kFps = 30;

/// A 2x4 base, then a tower of `n` bricks on its +x end (one step), then one on its -x end.
void twoSides(Scene& s, int n) {
  const uint32_t base = s.add(0, 0, 0, "3001.dat");
  for (double side : {30.0, -30.0}) {
    s.step();
    uint32_t below = base;
    for (int i = 1; i <= n; i++) {
      const uint32_t b = s.add(side, -24.0 * i, 0);
      s.stud(below, b);
      below = b;
    }
  }
  s.finish();
}
/// The shot playing at `seconds`.
const Shot& at(const std::vector<Shot>& shots, double seconds) {
  for (const Shot& s : shots)
    if (s.start <= seconds && seconds < s.end) return s;
  return shots.back();
}
/// The first and middle flights of the pieces placed in root step `step`.
std::pair<const plan::Flight*, const plan::Flight*> ofStep(const Scene& s, int step) {
  std::vector<const plan::Flight*> fs;
  for (const plan::Flight& f : s.t.flights)
    if (f.parent < 0 && s.model->pieces()[plan::piecesOf(f, s.p).front()].step == step) fs.push_back(&f);
  std::sort(fs.begin(), fs.end(), [](auto* a, auto* b) { return a->startFrame < b->startFrame; });
  return {fs.front(), fs[fs.size() / 2]};
}
bool isMain(const Shot& s) { return s.subject.kind == SubjectKind::BuiltSoFar && s.size == Size::Wide; }
}  // namespace

TEST_CASE("a one-piece build has an opening and a finish", "[director]") {
  Scene s;
  s.add(0, 0, 0);
  s.finish();
  const Beats b = beatsOf(s.t, s.p, *s.model, *s.world);
  const DirectorStyle style = referenceStyle();
  const std::vector<Shot> shots = direct(b, s.t, s.p, *s.world, style, kFps);
  REQUIRE(shots.size() >= 2);
  REQUIRE(isMain(shots.front()));
  REQUIRE(shots.front().elevation == Approx(style.elStart));
  REQUIRE(shots.back().end == Approx(s.t.frames / kFps));
  REQUIRE(endAngles(shots.back()).first == Approx(0).margin(1e-9));
  REQUIRE(checkEditing(shots, b, kFps).empty());
}

TEST_CASE("the camera swings to the side being built", "[director]") {
  Scene s;
  twoSides(s, 10);
  const Beats b = beatsOf(s.t, s.p, *s.model, *s.world);
  const std::vector<Shot> shots = direct(b, s.t, s.p, *s.world, referenceStyle(), kFps);
  // The eye is on the side being built: azimuth a puts it at x = -sin(a) * distance.
  const Shot& right = at(shots, ofStep(s, 1).second->startFrame / kFps);
  const Shot& left = at(shots, ofStep(s, 2).second->startFrame / kFps);
  REQUIRE(isMain(right));
  REQUIRE(isMain(left));
  REQUIRE(-std::sin(right.azimuth) > 0.5);
  REQUIRE(-std::sin(left.azimuth) < -0.5);
}

TEST_CASE("the move toward a scene starts before its first piece leaves", "[director]") {
  Scene s;
  twoSides(s, 10);
  const Beats b = beatsOf(s.t, s.p, *s.model, *s.world);
  const std::vector<Shot> shots = direct(b, s.t, s.p, *s.world, referenceStyle(), kFps);
  const auto [first, middle] = ofStep(s, 2);
  const Shot& left = at(shots, middle->startFrame / kFps);
  REQUIRE(left.enter == EnterKind::Blend);
  REQUIRE(left.start <= first->startFrame / kFps - kAnticipateSeconds + 1e-9);
}

TEST_CASE("elevation comes down as the model grows", "[director]") {
  Scene s;
  filmtest::tower(s, 10);
  const Beats b = beatsOf(s.t, s.p, *s.model, *s.world);
  const DirectorStyle style = referenceStyle();
  const std::vector<Shot> shots = direct(b, s.t, s.p, *s.world, style, kFps);
  std::vector<const Shot*> mains;
  for (const Shot& x : shots)
    if (isMain(x)) mains.push_back(&x);
  REQUIRE(!mains.empty());
  REQUIRE(startAngles(*mains.front()).second == Approx(style.elStart));
  double last = 10;
  for (const Shot* m : mains) {
    REQUIRE(startAngles(*m).second <= last + 1e-9);
    REQUIRE(endAngles(*m).second <= startAngles(*m).second + 1e-9);
    last = endAngles(*m).second;
  }
  REQUIRE(std::abs(last - style.elEnd) <= 5 * M_PI / 180);
}

TEST_CASE("a long build keeps to the cut rate", "[director]") {
  Scene s;
  const uint32_t base = s.add(0, 0, 0, "3001.dat");
  uint32_t top[2] = {base, base};
  for (int i = 0; i < 400; i++) {
    s.step();
    const int side = i % 2;
    const uint32_t b = s.add(side ? -30 : 30, -24.0 * (i / 2 + 1), 0);
    s.stud(top[side], b);
    top[side] = b;
  }
  s.finish();
  const Beats b = beatsOf(s.t, s.p, *s.model, *s.world);
  const auto t0 = std::chrono::steady_clock::now();
  const std::vector<Shot> shots = direct(b, s.t, s.p, *s.world, referenceStyle(), kFps);
  const double seconds = std::chrono::duration<double>(std::chrono::steady_clock::now() - t0).count();
  for (const RuleMiss& m : checkEditing(shots, b, kFps)) {
    INFO(m.rule << " at " << m.at << ": " << m.detail);
    REQUIRE((m.rule != "cut-rate" && m.rule != "min-length"));
  }
#ifndef BM_SANITIZED
  REQUIRE(seconds < 0.2);
#endif
}

TEST_CASE("the same build directs the same shots", "[director]") {
  Scene s;
  twoSides(s, 6);
  const Beats b = beatsOf(s.t, s.p, *s.model, *s.world);
  REQUIRE(toJson(direct(b, s.t, s.p, *s.world, referenceStyle(), kFps)).dump() == toJson(direct(b, s.t, s.p, *s.world, referenceStyle(), kFps)).dump());
}

TEST_CASE("debug print", "[.dbg]") {
  for (int which = 0; which < 2; which++) {
    Scene s;
    if (which == 0) twoSides(s, 10); else filmtest::tower(s, 10);
    const Beats b = beatsOf(s.t, s.p, *s.model, *s.world);
    std::printf("frames %d (%.2f s)\n", s.t.frames, s.t.frames / kFps);
    for (const plan::Flight& f : s.t.flights) std::printf("  flight piece %u step %d %.2f..%.2f\n", plan::piecesOf(f, s.p).front(), s.model->pieces()[plan::piecesOf(f, s.p).front()].step, f.startFrame / kFps, (f.startFrame + f.frames) / kFps);
    for (const Shot& x : direct(b, s.t, s.p, *s.world, referenceStyle(), kFps))
      std::printf("  %.2f-%.2f subj %d size %d az %.0f el %.0f->%.0f enter %d\n", x.start, x.end, int(x.subject.kind), int(x.size), x.azimuth * 180 / M_PI, startAngles(x).second * 180 / M_PI, endAngles(x).second * 180 / M_PI, int(x.enter));
  }
}
