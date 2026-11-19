#include <catch2/catch_test_macros.hpp>
#include "bmf/beats.h"
#include "fixture.h"

using namespace bm;
using namespace bm::film;
using filmtest::Scene;

namespace {
bool same(const Box& a, const Box& b) { return length(a.min - b.min) < 1e-6 && length(a.max - b.max) < 1e-6; }
}  // namespace

TEST_CASE("one flight per flown move, spanning its flight", "[beats]") {
  Scene s;
  filmtest::tower(s, 3);
  const Beats b = beatsOf(s.t, s.p, *s.model, *s.world);
  std::vector<const Beat*> flights;
  for (const Beat& x : b.list)
    if (x.kind == BeatKind::Flight) flights.push_back(&x);
  REQUIRE(flights.size() == 3);
  for (const Beat* x : flights) {
    const plan::Flight& f = s.t.flights[static_cast<size_t>(x->flight)];
    REQUIRE(x->start == f.startFrame);
    REQUIRE(x->end == f.startFrame + f.frames);
    REQUIRE(same(x->seat, s.world->box(plan::piecesOf(f, s.p).front())));
  }
}

TEST_CASE("the built box grows as pieces land", "[beats]") {
  Scene s;
  filmtest::tower(s, 4);
  const Beats b = beatsOf(s.t, s.p, *s.model, *s.world);
  REQUIRE(b.frames == s.t.frames);
  REQUIRE(static_cast<int>(b.builtBox.size()) == b.frames + 1);
  REQUIRE(b.builtBox.front().empty());
  REQUIRE(same(b.builtBox.back(), b.model));
  for (size_t i = 1; i < b.builtBox.size(); i++) {
    if (b.builtBox[i - 1].empty()) continue;
    Box both = b.builtBox[i];
    both.merge(b.builtBox[i - 1]);
    REQUIRE(same(both, b.builtBox[i]));  // never shrinks
  }
}

TEST_CASE("a unit built on its spot is a UnitBuild beat before its flight", "[beats]") {
  Scene s;
  const uint32_t base = s.add(0, 0, 0);
  s.step();
  const uint32_t a = s.addIn(0, -24, 0);
  s.subStep();
  const uint32_t b = s.addIn(0, -48, 0);
  s.stud(base, a);
  s.stud(a, b);
  s.finish();
  const Beats beats = beatsOf(s.t, s.p, *s.model, *s.world);
  const Beat* unit = nullptr;
  for (const Beat& x : beats.list)
    if (x.kind == BeatKind::UnitBuild) unit = &x;
  REQUIRE(unit);
  REQUIRE(unit->flight >= 0);
  const plan::Flight& f = s.t.flights[static_cast<size_t>(unit->flight)];
  REQUIRE(unit->end <= f.startFrame);
  REQUIRE(unit->start < unit->end);
}

TEST_CASE("a tall last piece is more important than a small middle one", "[beats]") {
  Scene s;
  const uint32_t base = s.add(0, 0, 0, "3001.dat");
  s.step();
  const uint32_t left = s.add(-30, -24, 0);
  s.step();
  const uint32_t right = s.add(30, -24, 0);
  s.step();
  const uint32_t top = s.add(0, -48, 0, "3001.dat");
  s.stud(base, left), s.stud(base, right), s.stud(left, top), s.stud(right, top);
  s.finish();
  const Beats b = beatsOf(s.t, s.p, *s.model, *s.world);
  double tucked = -1, tall = -1;
  for (const Beat& x : b.list) {
    if (x.kind != BeatKind::Flight) continue;
    const uint32_t piece = plan::piecesOf(s.t.flights[static_cast<size_t>(x.flight)], s.p).front();
    if (piece == right) tucked = x.importance;
    if (piece == top) tall = x.importance;
  }
  REQUIRE(tucked >= 0);
  REQUIRE(tall >= tucked + kImportanceSilhouette * 0.5);
}

TEST_CASE("the build ends in a Reveal beat", "[beats]") {
  Scene s;
  filmtest::tower(s, 3);
  const Beats b = beatsOf(s.t, s.p, *s.model, *s.world);
  int lastLanding = 0;
  for (const plan::Flight& f : s.t.flights) lastLanding = std::max(lastLanding, f.startFrame + f.frames);
  REQUIRE(b.list.back().kind == BeatKind::Reveal);
  REQUIRE(b.list.back().start == lastLanding);
  REQUIRE(b.list.back().end == b.frames);
}
