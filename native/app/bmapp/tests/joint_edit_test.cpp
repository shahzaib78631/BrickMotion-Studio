// Joint info and joint edits (turn, slide, limits) on AssemblyInspection.
#include <catch2/catch_approx.hpp>
#include <catch2/catch_test_macros.hpp>
#include <cmath>
#include <limits>
#include <memory>
#include "bmapp/assembly_inspection.h"
#include "session_impl.h"

namespace {

/// A hinge base 1×2 (3937) with its hinge top (3938) seated on it, plus a loose brick far away.
void hinge(bmapp::Session& s) {
  REQUIRE(s.newBlank().ok);
  REQUIRE(s.placePart("3937.dat", 4, {{}, {0, 0, 0}}, 0, s.generation(), s.version()).refused.empty());
  REQUIRE(s.placePart("3938.dat", 14, {{}, {0, 0, 0}}, 0, s.generation(), s.version()).refused.empty());
  REQUIRE(s.placePart("3001.dat", 1, {{}, {400, 0, 0}}, 0, s.generation(), s.version()).refused.empty());
  REQUIRE(s.pieceCount() == 3);
}

}  // namespace

std::unique_ptr<bmapp::AssemblyInspection> reader(const bmapp::Session& s) {
  std::unique_ptr<bmapp::AssemblyInspection> r(bmapp::AssemblyInspection::capture(&s));
  REQUIRE(r);
  return r;
}

TEST_CASE("joint info resolves a hinge's branch, axis and collision-free travel", "[bmapp][joints]") {
  bmapp::Session s;
  hinge(s);
  const auto r = reader(s);
  const auto info = r->jointInfo(0, 1, true);
  INFO(info.error);
  REQUIRE(info.error.empty());
  CHECK(info.type == bmapp::JointType::Hinge);
  CHECK(info.pieces == bmapp::PieceList{1});
  CHECK(info.canTurn);
  CHECK_FALSE(info.canSlide);
  CHECK_FALSE(info.fullTurn);
  // The hinge top folds one way until it meets the base, and barely the other way.
  CHECK(info.maxDeg > 80);
  CHECK(info.maxDeg < 120);
  CHECK(info.minDeg < 0);
  CHECK(info.minDeg > -30);
  CHECK(info.maxBlocker.find("Hinge") != std::string::npos);

  const auto free = r->jointInfo(0, 1, false);
  REQUIRE(free.error.empty());
  CHECK(free.fullTurn);
  CHECK(free.minDeg == -180);
  CHECK(free.maxDeg == 180);
}

TEST_CASE("joint info explains pieces that are not one connection", "[bmapp][joints]") {
  bmapp::Session s;
  hinge(s);
  const auto r = reader(s);
  CHECK(r->jointInfo(0, 2, true).error == "The two parts are no longer connected.");
  CHECK(r->jointInfo(0, 99, true).error == "Choose a connection first.");
  CHECK(r->changeJointEx(0, 99, 10, 0, {}, true).error.empty() == false);
}

TEST_CASE("a hinge turns past 90 degrees when nothing is in the way", "[bmapp][joints]") {
  bmapp::Session s;
  hinge(s);
  const auto r = reader(s);
  const auto turned = r->changeJoint(0, 1, 120, false);
  INFO(turned.error);
  REQUIRE(turned.error.empty());
  CHECK(turned.pieces == bmapp::PieceList{1});
  const auto applied = s.placeMoved(turned.pieces, turned.pivot, turned.pose, s.generation(), s.version());
  REQUIRE(applied.refused.empty());
  s.undo();
  CHECK(s.impl().model->pieces()[1].world.t == bm::Vec3{0, 0, 0});

  // With collisions on, the base stops the fold and names itself.
  CHECK(r->changeJoint(0, 1, 120, true).error.find("blocked") != std::string::npos);
}

TEST_CASE("joint edits refuse out-of-range turns, bad slides and slides on a hinge", "[bmapp][joints]") {
  bmapp::Session s;
  hinge(s);
  const auto r = reader(s);
  CHECK_FALSE(r->changeJoint(0, 1, 361, false).error.empty());
  CHECK_FALSE(r->changeJoint(0, 1, std::numeric_limits<double>::quiet_NaN(), false).error.empty());
  CHECK_FALSE(r->changeJointEx(0, 1, 0, 1001, {}, false).error.empty());
  CHECK_FALSE(r->changeJointEx(0, 1, 0, std::numeric_limits<double>::infinity(), {}, false).error.empty());
  CHECK(r->changeJointEx(0, 1, 0, 8, {}, false).error == "This connection cannot slide.");
  CHECK(r->changeJointEx(0, 1, 30, 0, {}, false).error.empty());
}
