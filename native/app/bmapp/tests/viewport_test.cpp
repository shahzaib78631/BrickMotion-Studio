#include <catch2/catch_approx.hpp>
#include <catch2/catch_test_macros.hpp>
#include <array>
#include <filesystem>
#include <future>
#include "bmapp/gizmo.h"
#include "bmapp/part_preview.h"
#include "bmapp/session.h"
#include "bmapp/viewport.h"

namespace fs = std::filesystem;

namespace {
fs::path helicopter() { return fs::path(BM_REPO) / "samples" / "helicopter" / "helicopter.mpd"; }

/// The box of pixels that differ from the background (the top-left pixel), as x0, y0, x1, y1.
struct Extent {
  int x0 = 1 << 30, y0 = 1 << 30, x1 = -1, y1 = -1;
};
Extent drawnExtent(const bmapp::Picture& p) {
  Extent e;
  const uint8_t* bg = p.rgba.data();
  for (int y = 0; y < p.height; y++)
    for (int x = 0; x < p.width; x++) {
      const uint8_t* px = p.rgba.data() + (static_cast<size_t>(y) * p.width + x) * 4;
      if (std::abs(px[0] - bg[0]) + std::abs(px[1] - bg[1]) + std::abs(px[2] - bg[2]) > 24) {
        e.x0 = std::min(e.x0, x), e.y0 = std::min(e.y0, y), e.x1 = std::max(e.x1, x), e.y1 = std::max(e.y1, y);
      }
    }
  return e;
}
}  // namespace

TEST_CASE("fitAll frames the model", "[bmapp][viewport]") {
  bmapp::Session session;
  REQUIRE(session.open(helicopter().string()).ok);
  bmapp::Viewport view(session);
  if (!view.ok()) SKIP("no Metal device");
  view.resize(800, 600, 1);
  view.fitAll();
  view.draw(nullptr);
  const bmapp::Picture p = view.readback();
  REQUIRE(p.width == 800);
  REQUIRE(p.height == 600);
  const Extent e = drawnExtent(p);
  REQUIRE(e.x1 >= 0);
  CHECK(e.x0 > 0);
  CHECK(e.y0 > 0);
  CHECK(e.x1 < 799);
  CHECK(e.y1 < 599);
  CHECK((e.x1 - e.x0 > 400 || e.y1 - e.y0 > 300));
}

TEST_CASE("orbit then view preset Front is exact", "[bmapp][viewport]") {
  bmapp::Session session;
  REQUIRE(session.open(helicopter().string()).ok);
  bmapp::Viewport view(session);
  if (!view.ok()) SKIP("no Metal device");
  view.resize(800, 600, 1);
  view.orbit(130, -45);
  view.view(bmapp::ViewPreset::Front);
  CHECK(view.camera().yaw == 0);
  CHECK(view.camera().pitch == 0);
  view.view(bmapp::ViewPreset::Right);
  CHECK(view.camera().yaw == Catch::Approx(-1.5707963267948966));
  view.view(bmapp::ViewPreset::Top);
  CHECK(view.camera().pitch > 1.5);  // straight down, held a hair short of the pole
}

TEST_CASE("zoom clamps", "[bmapp][viewport]") {
  bmapp::Session session;
  REQUIRE(session.open(helicopter().string()).ok);
  bmapp::Viewport view(session);
  if (!view.ok()) SKIP("no Metal device");
  view.resize(800, 600, 1);
  view.zoom(1e9);
  CHECK(view.camera().distance >= 1);
  view.zoom(1e-9);
  CHECK(std::isfinite(view.camera().distance));
}

TEST_CASE("parallel projection uses offset rays that agree with the viewport gizmo", "[bmapp][viewport]") {
  bmapp::CameraState camera;
  camera.distance = 400;
  camera.orthographic = true;
  const auto near = bmapp::projectPoint(camera, {800, 600}, {35, 0, -100});
  const auto far = bmapp::projectPoint(camera, {800, 600}, {35, 0, 100});
  REQUIRE(near.x == Catch::Approx(far.x));
  REQUIRE(near.y == Catch::Approx(far.y));
  camera.orthographic = false;
  const auto perspective = bmapp::projectPoint(camera, {800, 600}, {35, 0, -100});
  CHECK(perspective.x > near.x);
}

TEST_CASE("a viewport of an empty session draws nothing and does not crash", "[bmapp][viewport]") {
  bmapp::Session session;
  bmapp::Viewport view(session);
  CHECK_FALSE(view.ok());
  view.resize(100, 100, 1);
  CHECK_FALSE(view.draw(nullptr));
  CHECK(view.readback().rgba.empty());
}

TEST_CASE("worker part previews render beside an open viewport", "[bmapp][parts]") {
  bmapp::Session session;
  REQUIRE(session.open(helicopter().string()).ok);
  bmapp::Viewport view(session);
  if (!view.ok()) SKIP("no Metal device");
  view.resize(320, 240, 1);
  auto previews = std::async(std::launch::async, [] {
    bmapp::PartPreview renderer(bmapp::Session::ldrawDirectory());
    return std::array{
      renderer.render("3001.dat", 71, false),
      renderer.render("3700.dat", 71, true),
      renderer.render("does-not-exist.dat", 71, false)
    };
  });
  view.draw(nullptr);
  const auto pictures = previews.get();
  CHECK_FALSE(view.readback().rgba.empty());
  CHECK(pictures[2].rgba.empty());
  for (size_t i : {0, 1}) {
    const auto& p = pictures[i];
    REQUIRE(p.width >= 192);
    REQUIRE(p.height == p.width);
    REQUIRE(p.rgba.size() == static_cast<size_t>(p.width * p.height * 4));
    const auto part = drawnExtent(p);
    CHECK(part.x0 > 0);
    CHECK(part.x1 < p.width - 1);
    CHECK(part.x1 - part.x0 > p.width / 3);
    CHECK(part.y0 > 0);
    CHECK(part.y1 < p.height - 1);
  }
  CHECK(pictures[0].rgba[0] > pictures[1].rgba[0] + 100);
}
