#include <catch2/catch_approx.hpp>
#include <catch2/catch_test_macros.hpp>
#include "bmf/body.h"
#include "engine.h"

using Catch::Approx;

TEST_CASE("toCamera keeps the eye, target and lens of a frame", "[film]") {
  bm::film::Frame f;
  f.eye = {10, -200, -300}, f.target = {5, -20, 7}, f.up = {0, -1, 0};
  f.fovY = 0.42;
  const bmr::Camera c = bmtools::toCamera(f, 9.0 / 16);
  CHECK(c.eye.x == f.eye.x);
  CHECK(c.eye.y == f.eye.y);
  CHECK(c.eye.z == f.eye.z);
  CHECK(c.target.x == f.target.x);
  CHECK(c.target.y == f.target.y);
  CHECK(c.target.z == f.target.z);
  CHECK(c.up.y == f.up.y);
  CHECK(c.fovY == Approx(0.42));
  CHECK(c.aspect == Approx(9.0 / 16));
  CHECK(c.near > 0);
  CHECK(c.far > bm::length(f.eye - f.target));
}

TEST_CASE("keysFromTrack gives one key a frame that sees what the frame sees", "[film]") {
  bm::film::Track track;
  for (int i = 0; i < 3; i++) {
    bm::film::Frame f;
    f.target = {0, -10.0 * i, 0};
    f.eye = f.target + bm::Vec3{-100, -100, -100};
    track.frames.push_back(f);
  }
  bm::plan::Timeline t;
  t.frames = 2;
  t.camera.push_back({});
  bmtools::keysFromTrack(track, t);
  REQUIRE(t.camera.size() == 3);
  const bmr::Camera c = bmr::OrbitCamera::along(t, 1).camera(1, bm::Box{});
  CHECK(c.eye.x == Approx(-100).margin(1e-6));
  CHECK(c.eye.y == Approx(-110).margin(1e-6));
  CHECK(c.eye.z == Approx(-100).margin(1e-6));
  CHECK(c.target.y == Approx(-10).margin(1e-6));
}
