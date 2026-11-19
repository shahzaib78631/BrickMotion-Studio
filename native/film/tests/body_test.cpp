#include <catch2/catch_test_macros.hpp>
#include <cmath>
#include "bmf/body.h"
#include "bmf/director.h"
#include "fixture.h"

using namespace bm;
using namespace bm::film;
using filmtest::Scene;

namespace {
constexpr double kFps = 30;
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
struct Filmed {
  Beats beats;
  std::vector<Shot> shots;
  Track track;
};
Filmed filmed(Scene& s, double aspect) {
  Filmed f{beatsOf(s.t, s.p, *s.model, *s.world), {}, {}};
  f.shots = direct(f.beats, s.t, s.p, *s.world, referenceStyle(), kFps);
  FrameShape shape;
  shape.aspect = aspect;
  f.track = shoot(f.shots, f.beats, s.t, s.p, *s.world, shape, kFps);
  return f;
}
double boxDistance(Vec3 p, const Box& b) {
  const double dx = std::max({b.min.x - p.x, 0.0, p.x - b.max.x}), dy = std::max({b.min.y - p.y, 0.0, p.y - b.max.y}), dz = std::max({b.min.z - p.z, 0.0, p.z - b.max.z});
  return std::sqrt(dx * dx + dy * dy + dz * dz);
}
}  // namespace

TEST_CASE("every landing seat is in frame, in 16:9 and in 9:16", "[body]") {
  for (double aspect : {16.0 / 9, 9.0 / 16}) {
    Scene s;
    twoSides(s, 6);
    const Filmed f = filmed(s, aspect);
    REQUIRE(f.track.frames.size() == static_cast<size_t>(s.t.frames) + 1);
    for (const Beat& b : f.beats.list) {
      if (b.kind != BeatKind::Flight) continue;
      const plan::Flight& fl = s.t.flights[static_cast<size_t>(b.flight)];
      for (int frame = fl.startFrame + static_cast<int>(fl.seatAt); frame <= b.end; frame++) {
        const Rig rig = rigOf(f.track.frames[static_cast<size_t>(frame)]);
        for (Vec3 c : corners(b.seat)) {
          const Vec3 p = project(rig, f.track.shape, c);
          INFO("aspect " << aspect << " flight " << b.flight << " frame " << frame << " ndc " << p.x << ", " << p.y);
          REQUIRE(p.z > 0);
          REQUIRE(std::abs(p.x) <= f.track.shape.safe + 1e-6);
          REQUIRE(std::abs(p.y) <= f.track.shape.safe + 1e-6);
        }
      }
    }
  }
}

TEST_CASE("the eye never enters the model or the floor", "[body]") {
  // An arch: two pillars of three and a 2x4 across them.
  Scene s;
  const uint32_t a0 = s.add(-30, 0, 0), b0 = s.add(30, 0, 0);
  uint32_t a = a0, b = b0;
  for (int i = 1; i < 3; i++) {
    s.step();
    const uint32_t na = s.add(-30, -24.0 * i, 0), nb = s.add(30, -24.0 * i, 0);
    s.stud(a, na), s.stud(b, nb);
    a = na, b = nb;
  }
  s.step();
  const uint32_t top = s.add(0, -72, 0, "3001.dat");
  s.stud(a, top), s.stud(b, top);
  s.finish();
  const Filmed f = filmed(s, 16.0 / 9);
  std::vector<int> landed(s.model->pieces().size(), INT32_MAX);
  for (const plan::Flight& fl : s.t.flights)
    for (uint32_t p : plan::piecesOf(fl, s.p)) landed[p] = std::min(landed[p], fl.startFrame + fl.frames);
  for (size_t i = 0; i < f.track.frames.size(); i++) {
    const Vec3 eye = f.track.frames[i].eye;
    INFO("frame " << i);
    REQUIRE(eye.y <= f.beats.model.max.y - kEyeClearance + 1e-6);
    for (uint32_t p = 0; p < landed.size(); p++)
      if (landed[p] <= static_cast<int>(i)) REQUIRE(boxDistance(eye, s.world->box(p)) >= kEyeClearance - 1e-6);
  }
}

TEST_CASE("the eye backs away from a part that grows into it", "[body]") {
  Scene s;
  filmtest::tower(s, 12);
  const Filmed f = filmed(s, 16.0 / 9);
  for (size_t i = 1; i < f.track.frames.size(); i++) {
    if (f.track.frames[i].cut) continue;
    const double d = length(f.track.frames[i - 1].eye - f.track.frames[i - 1].target);
    INFO("frame " << i);
    REQUIRE(length(f.track.frames[i].eye - f.track.frames[i - 1].eye) <= 2 * kAvoidStep * d);
  }
}

TEST_CASE("motion inside a shot is smooth", "[body]") {
  Scene s;
  filmtest::tower(s, 10);
  const Filmed f = filmed(s, 16.0 / 9);
  const auto& fr = f.track.frames;
  for (size_t i = 2; i < fr.size(); i++) {
    if (fr[i].cut || fr[i - 1].cut) continue;
    INFO("frame " << i);
    // Angular, as the spec measures it: 0.5 LDU per frame squared for every 250 LDU away.
    const double d = length(fr[i - 1].eye - fr[i - 1].target);
    REQUIRE(length(fr[i].eye - fr[i - 1].eye * 2 + fr[i - 2].eye) <= 0.5 * std::max(1.0, d / 250));
    REQUIRE(length(fr[i].target - fr[i - 1].target) <= 2.0);
  }
}

TEST_CASE("a cut resets: the frame after a cut is the next shot's own", "[body]") {
  Scene s;
  twoSides(s, 6);
  const Filmed f = filmed(s, 16.0 / 9);
  bool any = false;
  for (size_t i = 1; i < f.track.frames.size(); i++) {
    if (!f.track.frames[i].cut) continue;
    any = true;
    const Frame &a = f.track.frames[i - 1], &b = f.track.frames[i];
    REQUIRE(f.shots[static_cast<size_t>(b.shot)].enter == EnterKind::Cut);
    REQUIRE(b.shot != a.shot);
    const Vec3 va = normalized(a.target - a.eye), vb = normalized(b.target - b.eye);
    const double turn = std::acos(std::clamp(dot(va, vb), -1.0, 1.0));
    const double move = length(b.eye - a.eye);
    REQUIRE((turn > 0.2 || move > 20));  // a different picture, not a blend from the one before
  }
  REQUIRE(any);
}

TEST_CASE("cameraAt between frames is between them, and not across a cut", "[body]") {
  Scene s;
  twoSides(s, 6);
  const Filmed f = filmed(s, 16.0 / 9);
  const auto& fr = f.track.frames;
  const Frame mid = cameraAt(f.track, 10.5);
  REQUIRE(length(mid.eye - (fr[10].eye + fr[11].eye) * 0.5) < 1e-9);
  for (size_t i = 1; i < fr.size(); i++)
    if (fr[i].cut) {
      const Frame x = cameraAt(f.track, static_cast<double>(i) - 0.5);
      REQUIRE(length(x.eye - fr[i - 1].eye) < 1e-9);
    }
  REQUIRE(length(cameraAt(f.track, 1e9).eye - fr.back().eye) < 1e-9);
}
