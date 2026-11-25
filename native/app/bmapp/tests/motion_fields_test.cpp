// The Build Motion editor's shared maths (motion_fields.h), moved down from the Swift app.
#include <catch2/catch_approx.hpp>
#include <catch2/catch_test_macros.hpp>

#include <filesystem>

#include "bmapp/motion_fields.h"
#include "bmapp/session.h"

namespace fs = std::filesystem;
using Catch::Approx;

TEST_CASE("effective motion inherits", "[motion fields]") {
  bmapp::Session s;
  REQUIRE(s.open((fs::path(BM_REPO) / "samples" / "helicopter" / "helicopter.mpd").string()).ok);
  REQUIRE(s.stepCount() > 1);
  bmapp::MotionFields project;
  project.time = 2;
  REQUIRE(s.setMotionFields(bmapp::MotionScope::Project, 0, {}, project).refused.empty());
  bmapp::MotionFields step;
  step.landing = 0.4;
  REQUIRE(s.setMotionFields(bmapp::MotionScope::Step, 1, {}, step).refused.empty());

  const bmapp::MotionFields parts = bmapp::effectiveMotion(&s, bmapp::MotionScope::Parts, 1, {});
  CHECK(parts.time == Approx(2));
  CHECK(parts.landing == Approx(0.4));
  CHECK(parts.hover == Approx(0));
  CHECK(parts.ease == 0);
  // another step's parts do not see step 1's landing
  CHECK(bmapp::effectiveMotion(&s, bmapp::MotionScope::Parts, 0, {}).landing == Approx(0.25));
  // a step's own fields are the ones passed; it inherits the project only
  const bmapp::MotionFields asStep = bmapp::effectiveMotion(&s, bmapp::MotionScope::Step, 1, {});
  CHECK(asStep.time == Approx(2));
  CHECK(asStep.landing == Approx(0.25));
  // the project inherits the defaults only; set fields win
  bmapp::MotionFields own;
  own.hover = 0.1;
  const bmapp::MotionFields asProject = bmapp::effectiveMotion(&s, bmapp::MotionScope::Project, 0, own);
  CHECK(asProject.time == Approx(1));
  CHECK(asProject.hover == Approx(0.1));
}

TEST_CASE("flight phases", "[motion fields]") {
  bmapp::MotionFields f;
  f.time = 1, f.landing = 0.25, f.hover = 0.9, f.ease = 0;
  bmapp::FlightPhases a = bmapp::flightPhases(f);
  CHECK(a.hover == Approx(0.7));
  CHECK(a.travel == Approx(0.05));
  CHECK(a.landing == Approx(0.25));
  f.hover = 0;
  bmapp::FlightPhases b = bmapp::flightPhases(f);
  CHECK(b.travel == Approx(0.75));
  CHECK(b.hover == Approx(0));
}
