#include <catch2/catch_test_macros.hpp>
#include <cmath>
#include "bmf/shots.h"

using namespace bm;
using namespace bm::film;

namespace {
std::vector<Shot> three() {
  Shot a;
  a.start = 0, a.end = 2.5, a.subject = {SubjectKind::BuiltSoFar, -1, {}}, a.size = Size::Wide, a.azimuth = 0.3, a.elevation = 1.0;
  a.move = {MoveKind::Crane, -0.2}, a.lensMm = 50, a.enter = EnterKind::Cut;
  Shot b;
  b.start = 2.5, b.end = 4, b.subject = {SubjectKind::Piece, 7, {}}, b.size = Size::Close, b.azimuth = -1.2, b.elevation = 0.4;
  b.move = {MoveKind::Follow, 0}, b.lensMm = 85, b.enter = EnterKind::Blend, b.blendSeconds = 0.6, b.origin = "user", b.pinned = true;
  Shot c;
  c.start = 4, c.end = 9.25, c.subject = {SubjectKind::Point, -1, {1.5, -20, 3}}, c.size = Size::Medium, c.move = {MoveKind::ArcReveal, 0.8};
  for (Shot* s : {&a, &b, &c}) s->id = shotId(*s);
  return {a, b, c};
}
bool near(double x, double y) { return std::abs(x - y) < 1e-9; }
}  // namespace

TEST_CASE("a shot list survives JSON exactly", "[shots]") {
  const std::vector<Shot> in = three();
  const std::vector<Shot> out = shotsFromJson(nlohmann::json::parse(toJson(in).dump()));
  REQUIRE(out.size() == in.size());
  for (size_t i = 0; i < in.size(); i++) {
    const Shot &a = in[i], &b = out[i];
    REQUIRE(a.id == b.id);
    REQUIRE((near(a.start, b.start) && near(a.end, b.end)));
    REQUIRE(a.subject.kind == b.subject.kind);
    REQUIRE(a.subject.flight == b.subject.flight);
    REQUIRE(length(a.subject.point - b.subject.point) < 1e-9);
    REQUIRE(a.size == b.size);
    REQUIRE((near(a.azimuth, b.azimuth) && near(a.elevation, b.elevation)));
    REQUIRE(a.move.kind == b.move.kind);
    REQUIRE(near(a.move.amount, b.move.amount));
    REQUIRE(near(a.lensMm, b.lensMm));
    REQUIRE(a.enter == b.enter);
    REQUIRE(near(a.blendSeconds, b.blendSeconds));
    REQUIRE(a.origin == b.origin);
    REQUIRE(a.pinned == b.pinned);
  }
}

TEST_CASE("ids are stable and differ for different shots", "[shots]") {
  const Shot a = three()[0];
  REQUIRE(shotId(a) == shotId(three()[0]));
  REQUIRE(shotId(a).size() == 8);
  Shot turned = a;
  turned.azimuth += 31 * M_PI / 180;
  REQUIRE(shotId(turned) != shotId(a));
}

TEST_CASE("unknown names are refused", "[shots]") {
  nlohmann::json j = toJson(three());
  j[0]["size"] = "huge";
  try {
    (void)shotsFromJson(j);
    FAIL("accepted an unknown size");
  } catch (const std::runtime_error& e) {
    REQUIRE(std::string(e.what()).find("size") != std::string::npos);
  }
}
