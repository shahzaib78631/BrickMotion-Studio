// Whole frames drawn on the GPU, checked by their pixels.
#include <catch2/catch_test_macros.hpp>
#include <algorithm>
#include <cmath>
#include <cstdlib>
#include <utility>
#include "bmr/device.h"
#include "bmr/image.h"
#include "bmr/renderer.h"
#include "helpers.h"

using namespace bm;
using namespace bmr;
using bmtest::piece;

namespace {

FrameOptions plain() {
  FrameOptions o;
  o.edges = o.shadows = o.ambientOcclusion = o.floor = false;
  return o;
}

struct Shot {
  Image image;
  Camera camera;
  Vec3 origin;
  FrameStats stats;
  /// Where a world point lands in the picture.
  std::pair<int, int> pixel(Vec3 p) const {
    float clip[4];
    transform(multiply(projectionMatrix(camera), viewMatrix(camera, origin)), p - origin, clip);
    const double x = clip[0] / clip[3], y = clip[1] / clip[3];
    return {static_cast<int>(std::lround((x + 1) / 2 * image.width)), static_cast<int>(std::lround((1 - y) / 2 * image.height))};
  }
};

/// Draws a model given as LDraw text, framed by OrbitCamera::framing at its default angle.
Shot shotOf(const std::string& ldrText, const FrameOptions& options, int w = 256, int h = 256, const ldraw::Library* library = nullptr, double azimuth = 0.6,
            double elevation = 0.45, double zoomOut = 1) {
  static const ldraw::Library fixtures = bmtest::fixtureLibrary();
  const ldraw::Library& lib = library ? *library : fixtures;
  ldraw::PartCache full{lib, bmtest::cacheDir()};
  ldraw::FlattenOptions lowOptions;
  lowOptions.lowResPrimitives = true;
  ldraw::PartCache low{lib, bmtest::cacheDir() / "low", lowOptions};
  const Model model = bmtest::modelFrom(ldrText, lib);
  auto r = Renderer::create(model, full, low);
  REQUIRE(r);
  r->resize(w, h);
  OrbitCamera orbit = OrbitCamera::framing(r->scene().bounds, 0.6, double(w) / h);
  orbit.azimuth = azimuth, orbit.elevation = elevation;
  orbit.distance *= zoomOut;
  Shot s;
  s.camera = orbit.camera(double(w) / h, r->scene().bounds);
  s.origin = r->scene().origin;
  s.stats = r->draw(s.camera, options);
  s.image = r->readback();
  if (const char* dump = std::getenv("BMR_DUMP")) {  // look at what a test saw
    static int n = 0;
    writePng(s.image, std::filesystem::path(dump) / ("shot" + std::to_string(n++) + ".png"));
  }
  return s;
}

Image shot(const std::string& ldrText, const FrameOptions& options, int w = 256, int h = 256) { return shotOf(ldrText, options, w, h).image; }

double luminance(const uint8_t* p) { return 0.2126 * p[0] + 0.7152 * p[1] + 0.0722 * p[2]; }

#define NEED_GPU() \
  if (!gpuAvailable()) SKIP("no Metal device")

}  // namespace

TEST_CASE("one red brick fills the middle of the frame with red and leaves the corners background", "[gpu][frame]") {
  NEED_GPU();
  const Image img = shot(piece("3005.dat", 0, 0, 0, 4), plain());
  REQUIRE(img.width == 256);
  const uint8_t* mid = img.at(128, 128);
  INFO("middle " << int(mid[0]) << " " << int(mid[1]) << " " << int(mid[2]));
  REQUIRE(mid[0] > 120);
  REQUIRE(mid[0] > 3 * mid[1]);
  REQUIRE(mid[0] > 3 * mid[2]);
  for (auto [x, y] : {std::pair{2, 2}, {253, 2}, {2, 253}, {253, 253}}) {
    REQUIRE(img.at(x, y)[0] > 250);
    REQUIRE(img.at(x, y)[1] > 250);
  }
}

TEST_CASE("a face turned to the key light is brighter than one turned away", "[gpu][frame]") {
  NEED_GPU();
  // 3005 here is a box 20 wide and 24 tall, y from 0 (top) to 24. Seen from above at the front
  // left (azimuth 0.6 puts the eye at -x, -z), the top face, the front face (-z) and the left
  // face (-x) are in view. The key light is toward +x, up and -z: the top faces it most and the
  // left face is turned away from it. Points are a quarter of the way in from each face's edges
  // so that antialiasing at the silhouette does not touch them.
  const Shot s = shotOf(piece("3005.dat", 0, 0, 0, 4), plain());
  const auto [tx, ty] = s.pixel({0, 0, 0});
  const auto [lx, ly] = s.pixel({-10, 12, 0});
  INFO("top at " << tx << "," << ty << " left at " << lx << "," << ly);
  const uint8_t* top = s.image.at(tx, ty);
  const uint8_t* left = s.image.at(lx, ly);
  REQUIRE(top);
  REQUIRE(left);
  INFO("top red " << int(top[0]) << " left red " << int(left[0]));
  REQUIRE(top[0] > left[0] + 20);
}

TEST_CASE("a mirrored brick is lit like its unmirrored twin", "[gpu][frame]") {
  NEED_GPU();
  const Image a = shot(piece("3005.dat", 0, 0, 0, 4), plain());
  const Image b = shot(piece("3005.dat", 0, 0, 0, 4, "-1 0 0 0 1 0 0 0 1"), plain());
  const Difference d = compare(a, b);
  INFO("meanAbs " << d.meanAbs << " worstBlock " << d.worstBlock);
  REQUIRE(d.sameSize);
  REQUIRE(d.meanAbs < 1.0);
}

TEST_CASE("a brick 100000 LDU from the origin draws the same as one at the origin", "[gpu][frame]") {
  NEED_GPU();
  const Image a = shot(piece("3005.dat", 0, 0, 0, 4), plain());
  const Image b = shot(piece("3005.dat", 100000, 0, 100000, 4), plain());
  const Difference d = compare(a, b);
  INFO("meanAbs " << d.meanAbs << " worstBlock " << d.worstBlock);
  REQUIRE(d.worstBlock < 1.0);
}

TEST_CASE("an empty model, a model of only missing parts, and a zero-size target draw without failing", "[gpu][frame]") {
  NEED_GPU();
  const Image empty = shot("0 nothing\n", plain());
  REQUIRE(empty.width == 256);
  REQUIRE(empty.at(128, 128)[0] > 250);
  const Image missing = shot(piece("nosuchpart.dat", 0, 0, 0, 4), plain());
  REQUIRE(missing.width == 256);

  const ldraw::Library lib = bmtest::fixtureLibrary();
  ldraw::PartCache full{lib, bmtest::cacheDir()};
  ldraw::PartCache low{lib, bmtest::cacheDir() / "low"};
  const Model m = bmtest::modelFrom(piece("3005.dat", 0, 0, 0, 4), lib);
  auto r = Renderer::create(m, full, low);
  REQUIRE(r);
  r->resize(0, 0);
  const FrameStats stats = r->draw(Camera{}, plain());
  REQUIRE(stats.drawCalls == 0);
  r->resize(-5, 40);
  r->draw(Camera{}, plain());
  r->resize(32, 32);
  r->draw(Camera{}, plain());
  REQUIRE(r->readback().width == 32);
}

TEST_CASE("the same frame drawn twice is the same image", "[gpu][frame]") {
  NEED_GPU();
  const std::string text = piece("3005.dat", 0, 0, 0, 4) + piece("3001.dat", 30, 0, 0, 0) + piece("3005.dat", 0, -24, 0, 36);
  const Image a = shot(text, FrameOptions{});
  const Image b = shot(text, FrameOptions{});
  const Difference d = compare(a, b);
  REQUIRE(d.sameSize);
  REQUIRE(d.meanAbs == 0);
}

TEST_CASE("chrome reflects the room; rubber does not", "[gpu][frame][data]") {
  NEED_GPU();
  const char* dir = std::getenv("BM_LDRAW_DIR");
  if (!dir) SKIP("BM_LDRAW_DIR is not set");
  const ldraw::Library lib{std::filesystem::path(dir)};
  // 3062b is a round 1x1 brick: a cylinder shows the room across its curve.
  auto spread = [&](int color) {
    const Shot s = shotOf(piece("3062b.dat", 0, 0, 0, color), plain(), 256, 256, &lib, 0.6, 0.2);
    double sum = 0, sum2 = 0;
    int n = 0;
    // Every pixel on the piece and at least 3 px inside its outline (anything not the white
    // background, nor next to it): what the whole curve shows, without the antialiased rim.
    auto background = [&](int x, int y) {
      const uint8_t* p = s.image.at(x, y);
      return !p || (p[0] > 250 && p[1] > 250 && p[2] > 250);
    };
    for (int y = 0; y < s.image.height; y++)
      for (int x = 0; x < s.image.width; x++) {
        bool inside = true;
        for (int dy = -3; dy <= 3 && inside; dy++)
          for (int dx = -3; dx <= 3 && inside; dx++) inside = !background(x + dx, y + dy);
        if (!inside) continue;
        const uint8_t* p = s.image.at(x, y);
        const double l = luminance(p);
        sum += l, sum2 += l * l, n++;
      }
    REQUIRE(n > 1000);
    const double mean = sum / n;
    return sum2 / n - mean * mean;
  };
  const double chrome = spread(383), rubber = spread(256);
  INFO("chrome variance " << chrome << " rubber variance " << rubber);
  REQUIRE(chrome > 4 * rubber);
}

namespace {
/// The largest difference of any channel between two pixels.
int channelGap(const uint8_t* a, const uint8_t* b) {
  int most = 0;
  for (int c = 0; c < 3; c++) most = std::max(most, std::abs(int(a[c]) - int(b[c])));
  return most;
}
}  // namespace

TEST_CASE("a brick casts a shadow on the floor on the side away from the key light", "[gpu][frame]") {
  NEED_GPU();
  // The fixture 3005 is a box 20 x 24 x 20 standing on y = 24, which is where the floor goes.
  // Toward the key light is (0.35, -0.8, -0.5): right, up and to the front, so the shadow
  // falls to the left and back. The top edge's shadow lands 24 / 0.8 = 30 units along
  // (-0.35, 0.5) from under it, about (-10.5, +15): (-8, 24, 18) is inside it. (18, 24, 0) is to
  // the right, toward the light: lit. The camera looks down from behind (azimuth pi, elevation
  // 1.1) so the floor behind the brick is not hidden by it, from three times the framing distance.
  FrameOptions shadowed = plain();
  shadowed.floor = shadowed.shadows = true;
  const std::string brick = piece("3005.dat", 0, 0, 0, 4);
  const Shot on = shotOf(brick, shadowed, 256, 256, nullptr, 3.14159265, 1.1, 3);
  const auto [sx, sy] = on.pixel({-8, 24, 18});
  const auto [lx, ly] = on.pixel({18, 24, 0});
  INFO("shadowed point at " << sx << "," << sy << " lit point at " << lx << "," << ly);
  const double dark = luminance(on.image.at(sx, sy)), lit = luminance(on.image.at(lx, ly));
  INFO("lit " << lit << " shadowed " << dark);
  REQUIRE(lit - dark > 15);

  FrameOptions unshadowed = shadowed;
  unshadowed.shadows = false;
  const Shot off = shotOf(brick, unshadowed, 256, 256, nullptr, 3.14159265, 1.1, 3);
  REQUIRE(std::abs(luminance(off.image.at(sx, sy)) - luminance(off.image.at(lx, ly))) <= 2);
}

TEST_CASE("a brick behind a transparent brick shows through it, tinted", "[gpu][frame]") {
  NEED_GPU();
  // Blue (direct colour 0x20000FF) at the origin; transparent red 22 units nearer the eye along
  // the camera's level direction (azimuth 0.6: the eye is toward (-sin 0.6, -cos 0.6) in x, z).
  // The framing target is the middle of the two, so the middle pixel looks through both.
  const double ax = -std::sin(0.6) * 22, az = -std::cos(0.6) * 22;
  const Image img = shot(piece("3005.dat", 0, 0, 0, 0x20000FF) + piece("3005.dat", ax, 0, az, 36), plain());
  const uint8_t* mid = img.at(128, 128);
  INFO("middle " << int(mid[0]) << " " << int(mid[1]) << " " << int(mid[2]));
  REQUIRE(mid[0] > 60);
  REQUIRE(mid[2] > 60);
}

TEST_CASE("two overlapping transparent bricks look the same whichever is listed first", "[gpu][frame]") {
  NEED_GPU();
  // Same colour, so one group whose instance order is the listing order.
  const std::string a = piece("3005.dat", 0, 0, 0, 36), b = piece("3005.dat", 10, -6, -10, 36), c = piece("3005.dat", 0, 0, 0, 4);
  const Difference d = compare(shot(a + b + c, FrameOptions{}), shot(b + a + c, FrameOptions{}));
  INFO("meanAbs " << d.meanAbs);
  REQUIRE(d.sameSize);
  REQUIRE(d.meanAbs == 0);
}

TEST_CASE("edges darken a brick's outline and nothing else", "[gpu][frame]") {
  NEED_GPU();
  FrameOptions withEdges = plain();
  withEdges.edges = true;
  const Shot off = shotOf(piece("3005.dat", 0, 0, 0, 4), plain());
  const Image on = shot(piece("3005.dat", 0, 0, 0, 4), withEdges);
  // An outline or crease is where the picture without edges changes sharply: background to
  // brick, or one face to another (each face of the box is lit differently). Every pixel the
  // edges change must be within 3 pixels of one.
  auto sharp = [&](int x, int y) {
    const uint8_t* p = off.image.at(x, y);
    const uint8_t* right = off.image.at(x + 1, y);
    const uint8_t* down = off.image.at(x, y + 1);
    return p && ((right && channelGap(p, right) > 6) || (down && channelGap(p, down) > 6));
  };
  int changed = 0, stray = 0;
  for (int y = 0; y < 256; y++)
    for (int x = 0; x < 256; x++) {
      if (channelGap(on.at(x, y), off.image.at(x, y)) <= 2) continue;
      changed++;
      bool near = false;
      for (int dy = -3; dy <= 3 && !near; dy++)
        for (int dx = -3; dx <= 3 && !near; dx++) near = sharp(x + dx, y + dy);
      if (!near) stray++;
    }
  INFO("changed " << changed << " away from an outline " << stray);
  REQUIRE(changed > 50);
  REQUIRE(stray == 0);
  // The middle of the top face is untouched.
  const auto [tx, ty] = off.pixel({0, 0, 0});
  REQUIRE(channelGap(on.at(tx, ty), off.image.at(tx, ty)) == 0);
}

TEST_CASE("the floor has no visible edge", "[gpu][frame]") {
  NEED_GPU();
  // From eight times the framing distance the floor's far edge (four diagonals out) is in view.
  // Beyond three brick widths from the brick on screen nothing may differ from the background:
  // no floor edge, and no shadow drawn where the shadow map does not reach.
  const Shot s = shotOf(piece("3005.dat", 0, 0, 0, 4), FrameOptions{}, 256, 256, nullptr, 0.6, 0.6, 8);
  const auto [cx, cy] = s.pixel({0, 12, 0});
  const auto [ex, ey] = s.pixel({10, 12, 0});
  const double reach = 3 * 2 * std::hypot(ex - cx, ey - cy) + 6;
  int off = 0;
  for (int y = 0; y < 256; y++)
    for (int x = 0; x < 256; x++) {
      if (std::hypot(x - cx, y - cy) < reach) continue;
      const uint8_t* p = s.image.at(x, y);
      if (p[0] < 253 || p[1] < 253 || p[2] < 253) off++;
    }
  INFO("pixels off the background " << off << " beyond " << reach << " px");
  REQUIRE(off == 0);
}
