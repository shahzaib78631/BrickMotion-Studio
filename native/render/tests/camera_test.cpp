#include <algorithm>
#include <catch2/catch_approx.hpp>
#include <catch2/catch_test_macros.hpp>
#include <cmath>
#include "bmr/camera.h"
#include "bmr/tolerances.h"

using namespace bm;
using namespace bmr;

namespace {
void project(const Camera& c, Vec3 origin, Vec3 p, float out[4]) { transform(multiply(projectionMatrix(c), viewMatrix(c, origin)), p - origin, out); }
}  // namespace

TEST_CASE("the framing camera has the whole box in view", "[camera]") {
  const Box box{{-100, -300, -50}, {100, 0, 50}};
  for (double aspect : {0.5, 1.0, 2.4})
    for (double azimuth : {0.0, 0.6, 2.0, -1.3}) {
      OrbitCamera o = OrbitCamera::framing(box, 0.6, aspect);
      o.azimuth = azimuth;
      const Camera c = o.camera(aspect, box);
      for (int i = 0; i < 8; i++) {
        const Vec3 corner{i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z};
        float v[4];
        project(c, {}, corner, v);
        REQUIRE(v[3] > 0);
        REQUIRE(std::abs(v[0]) <= v[3]);
        REQUIRE(std::abs(v[1]) <= v[3]);
        REQUIRE(v[2] >= 0);
        REQUIRE(v[2] <= v[3]);
      }
      REQUIRE_FALSE(outside(frustumOf(c, {}), box, {}));
    }
}

TEST_CASE("a fitted camera has the box in view, touching the margin, and is no further than framing", "[camera]") {
  const Box box{{-300, -80, -40}, {300, 0, 40}};  // long and low, as a helicopter is
  for (double aspect : {0.5, 1.6})
    for (double azimuth : {0.0, 0.9, 2.0})
      for (double elevation : {0.1, 0.5}) {
        const OrbitCamera o = OrbitCamera::fitted(box, 0.6, aspect, azimuth, elevation);
        REQUIRE(o.distance <= OrbitCamera::framing(box, 0.6, aspect).distance + 1e-6);
        const Camera c = o.camera(aspect, box);
        double widest = 0;  // the largest |x| or |y| over w among the corners
        for (int i = 0; i < 8; i++) {
          const Vec3 corner{i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z};
          float v[4];
          project(c, {}, corner, v);
          REQUIRE(v[3] > 0);
          widest = std::max({widest, std::abs(double(v[0]) / v[3]), std::abs(double(v[1]) / v[3])});
        }
        REQUIRE(widest <= 1.0);
        REQUIRE(widest == Catch::Approx(1.0 / kFrameMargin).epsilon(0.02));
      }
}

TEST_CASE("the key light's map holds the whole box and does not crawl when it moves a little", "[camera]") {
  const Vec3 toward{0.35, -0.8, -0.5};
  const Box box{{-100, -300, -50}, {100, 0, 50}};
  const KeyLight k = keyLight(box, {}, toward, 4096, 500);
  REQUIRE(k.texel > 0);
  for (int i = 0; i < 8; i++) {
    const Vec3 corner{i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z};
    float v[4];
    transform(k.matrix, corner, v);
    REQUIRE(std::abs(v[0]) < 1);
    REQUIRE(std::abs(v[1]) < 1);
    REQUIRE(v[2] > 0);
    REQUIRE(v[2] < 1);
  }
  // Nearer the light is less.
  float high[4], low[4];
  transform(k.matrix, Vec3{0, -300, 0}, high);
  transform(k.matrix, Vec3{0, 0, 0}, low);
  REQUIRE(high[2] < low[2]);
  // Moved by a tenth of a texel: the same side, and a fixed point lands within a hair of a
  // whole number of texels from where it was.
  const Vec3 nudge{k.texel * 0.1, 0, 0};
  const KeyLight moved = keyLight(Box{box.min + nudge, box.max + nudge}, {}, toward, 4096, 500);
  REQUIRE(moved.texel == Catch::Approx(k.texel));
  float a[4], b[4];
  transform(k.matrix, Vec3{17, -40, 3}, a);
  transform(moved.matrix, Vec3{17, -40, 3}, b);
  for (int c = 0; c < 2; c++) {
    const double texels = (double(a[c]) - b[c]) / 2 * 4096;
    REQUIRE(std::abs(texels - std::round(texels)) < 0.01);
  }
}

TEST_CASE("depth is reversed: near maps to one, far to zero", "[camera]") {
  Camera c;
  c.eye = {0, 0, 100}, c.target = {0, 0, 0}, c.near = 10, c.far = 1000;
  float v[4];
  project(c, {}, {0, 0, 90}, v);  // 10 in front of the eye
  REQUIRE(v[2] / v[3] == Catch::Approx(1.0f).margin(1e-5));
  project(c, {}, {0, 0, -900}, v);  // 1000 in front
  REQUIRE(v[2] / v[3] == Catch::Approx(0.0f).margin(1e-5));
  project(c, {}, {0, 0, 0}, v);
  REQUIRE(v[2] / v[3] > 0);
  REQUIRE(v[2] / v[3] < 1);
}

TEST_CASE("a box behind the camera or beside the view is outside; one that straddles an edge is not", "[camera]") {
  Camera c;
  c.eye = {0, 0, 500}, c.target = {0, 0, 0}, c.near = 1, c.far = 5000;
  const Frustum f = frustumOf(c, {});
  auto cube = [](Vec3 centre, double half) { return Box{centre - Vec3{half, half, half}, centre + Vec3{half, half, half}}; };
  REQUIRE_FALSE(outside(f, cube({0, 0, 0}, 10), {}));
  REQUIRE(outside(f, cube({0, 0, 1000}, 10), {}));     // behind the eye
  REQUIRE(outside(f, cube({2000, 0, 0}, 10), {}));     // far off to the side
  REQUIRE(outside(f, cube({0, 0, -9000}, 10), {}));    // beyond the far plane
  const double edge = 500 * std::tan(0.3);             // where the view's top and bottom are at the target
  REQUIRE_FALSE(outside(f, cube({0, edge, 0}, 10), {}));
  REQUIRE(outside(f, cube({0, edge + 40, 0}, 10), {}));
  REQUIRE(outside(f, Box{}, {}));                      // nothing is never in view
  // The same with everything moved far away and the origin moved with it.
  const Vec3 far{250000, -4000, 90000};
  Camera moved = c;
  moved.eye = c.eye + far, moved.target = c.target + far;
  const Frustum g = frustumOf(moved, far);
  REQUIRE_FALSE(outside(g, cube(far, 10), far));
  REQUIRE(outside(g, cube(far + Vec3{2000, 0, 0}, 10), far));
}

TEST_CASE("up on the screen is -y of the model, and right is +x seen from the front", "[camera]") {
  Camera c;
  c.eye = {0, 0, -300};  // the front of an LDraw model faces -z
  float mid[4], above[4], right[4];
  project(c, {}, {0, 0, 0}, mid);
  project(c, {}, {0, -10, 0}, above);
  project(c, {}, {10, 0, 0}, right);
  REQUIRE(above[1] / above[3] > mid[1] / mid[3]);
  REQUIRE(right[0] / right[3] > mid[0] / mid[3]);
}

TEST_CASE("orbiting and zooming stay within their limits; a camera key converts", "[camera]") {
  OrbitCamera o;
  o.orbit(0, 99);
  REQUIRE(o.elevation == kMaxElevation);
  o.orbit(0, -999);
  REQUIRE(o.elevation == -kMaxElevation);
  o.orbit(std::nan(""), std::nan(""));
  REQUIRE(std::isfinite(o.azimuth));
  o.zoom(1e-12);
  REQUIRE(o.distance == kMinDistance);
  o.zoom(1e30);
  REQUIRE(o.distance == kMaxDistance);
  o.zoom(-1);
  o.zoom(0);
  REQUIRE(o.distance == kMaxDistance);
  // Above the target when elevation is positive: -y is up.
  OrbitCamera high;
  high.elevation = 0.5;
  REQUIRE(high.eye().y < high.target.y);
  // Azimuth 0 is the front view, from -z.
  OrbitCamera front;
  front.azimuth = 0, front.elevation = 0, front.distance = 100;
  REQUIRE(length(front.eye() - Vec3{0, 0, -100}) < 1e-9);
  // Dragging right moves the target left across the view, by the pixel's size at the target.
  OrbitCamera p = front;
  p.pan(10, 0, 100);
  REQUIRE(p.target.x == Catch::Approx(-10 * 2 * 100 * std::tan(0.3) / 100));
  p.pan(1, 1, 0);  // a view with no height: nothing happens
  REQUIRE(std::isfinite(p.target.x));
  const OrbitCamera k = OrbitCamera::from(plan::CameraKey{12, {1, 2, 3}, 500, 0.7, 9.0});
  REQUIRE(k.target == Vec3{1, 2, 3});
  REQUIRE(k.distance == 500);
  REQUIRE(k.elevation == kMaxElevation);
  // Odd cameras still give finite matrices.
  Camera odd;
  odd.eye = odd.target;
  for (float v : viewMatrix(odd, {}).m) REQUIRE(std::isfinite(v));
  odd.eye = {0, -100, 0};  // looking straight down, along up
  for (float v : viewMatrix(odd, {}).m) REQUIRE(std::isfinite(v));
  odd.aspect = 0, odd.fovY = std::nan(""), odd.near = -5, odd.far = -9;
  for (float v : projectionMatrix(odd).m) REQUIRE(std::isfinite(v));
  REQUIRE(OrbitCamera::framing(Box{}, 0.6, 1).distance > 0);
}

TEST_CASE("the timeline's camera is its keys, and between them the turn goes the short way round", "[camera]") {
  plan::Timeline t;
  REQUIRE(OrbitCamera::along(t, 5).distance == OrbitCamera{}.distance);  // no keys: the default
  plan::CameraKey a, b;
  a.frame = 0, a.target = {0, 0, 0}, a.distance = 400, a.azimuth = 3.0, a.elevation = 0.2;
  b.frame = 30, b.target = {30, 0, 0}, b.distance = 600, b.azimuth = -3.0, b.elevation = 0.4;
  t.camera = {a, b};
  const OrbitCamera start = OrbitCamera::along(t, 0), end = OrbitCamera::along(t, 99);
  REQUIRE(start.azimuth == Catch::Approx(3.0));
  REQUIRE(end.distance == Catch::Approx(600));
  const OrbitCamera mid = OrbitCamera::along(t, 15);
  REQUIRE(mid.target.x == Catch::Approx(15));
  REQUIRE(mid.distance == Catch::Approx(500));
  REQUIRE(mid.elevation == Catch::Approx(0.3));
  // From 3.0 to -3.0 the short way is through pi, not through 0.
  REQUIRE(std::abs(std::remainder(mid.azimuth - M_PI, 2 * M_PI)) < 1e-9);
}
