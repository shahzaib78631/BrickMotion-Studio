// Whole frames drawn on the GPU, checked by their pixels.
#include <catch2/catch_approx.hpp>
#include <catch2/catch_test_macros.hpp>
#include <algorithm>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <utility>
#include "bmr/device.h"
#include "bmr/image.h"
#include "bmr/renderer.h"
#include "bmr/tolerances.h"
#include "gpu_rig.h"
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
  REQUIRE_FALSE(stats.submitted);  // nothing to draw into: the caller is to draw again
  r->resize(-5, 40);
  REQUIRE_FALSE(r->draw(Camera{}, plain()).submitted);
  r->resize(32, 32);
  REQUIRE(r->draw(Camera{}, plain()).submitted);
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
  // The key light is where the options put it (studioLights); the brick's top centre casts its shadow
  // 24 / -toward.y along -toward from under it. A floor point most of the way there is in the
  // shadow; one as far the other way, toward the light, is not. The camera looks almost
  // straight down so neither is hidden by the brick. The key gives about a fifth of a white
  // floor's light (the world and three fills the rest), so even a full shadow takes off at most
  // about 27 of 255; a 45-degree disk behind a brick this low is about half hidden.
  FrameOptions shadowed = plain();
  shadowed.floor = shadowed.shadows = true;
  FrameOptions unshadowed = shadowed;
  unshadowed.shadows = false;
  const std::string brick = piece("3005.dat", 0, 0, 0, 4);
  const Shot on = shotOf(brick, shadowed, 256, 256, nullptr, 3.14159265, 1.35, 3);
  const Shot off = shotOf(brick, unshadowed, 256, 256, nullptr, 3.14159265, 1.35, 3);
  const Vec3 toward = studioLights(on.camera, shadowed.lightsFollowCamera).toward[0];
  REQUIRE(toward.y < 0);  // the key is above
  const double reach = 24 / -toward.y;
  const auto [sx, sy] = on.pixel({-toward.x * reach * 0.6, 24, -toward.z * reach * 0.6});
  const auto [lx, ly] = on.pixel({toward.x * reach * 0.75, 24, toward.z * reach * 0.75});
  INFO("shadowed point at " << sx << "," << sy << " lit point at " << lx << "," << ly);
  const double darkOn = luminance(on.image.at(sx, sy)), darkOff = luminance(off.image.at(sx, sy));
  const double litOn = luminance(on.image.at(lx, ly)), litOff = luminance(off.image.at(lx, ly));
  INFO("shadowed " << darkOn << " (" << darkOff << " without shadows), lit " << litOn << " (" << litOff << ")");
  REQUIRE(darkOff - darkOn > 8);
  REQUIRE(std::abs(litOff - litOn) <= 3);
  REQUIRE(linearFromSrgb(999) == Catch::Approx(1.0f));
}

TEST_CASE("a brick behind a transparent brick shows through it, tinted", "[gpu][frame]") {
  NEED_GPU();
  // Blue (direct colour 0x20000FF) at the origin; transparent red 22 units nearer the eye along
  // the camera's level direction (azimuth 0.6: the eye is toward (-sin 0.6, -cos 0.6) in x, z).
  // The framing target is the middle of the two, so the middle pixel looks through both.
  // Glass absorbs (tolerances.h kGlassAbsorption): red glass takes most of the blue brick's
  // blue, and what comes through is redder than the bare blue brick.
  const double ax = -std::sin(0.6) * 22, az = -std::cos(0.6) * 22;
  const std::string blue = piece("3005.dat", 0, 0, 0, 0x20000FF), red = piece("3005.dat", ax, 0, az, 36);
  const Image both = shot(blue + red, plain()), glassAlone = shot(red, plain()), blueAlone = shot(blue, plain());
  const uint8_t *mid = both.at(128, 128), *glass = glassAlone.at(128, 128), *bare = blueAlone.at(128, 128);
  INFO("middle " << int(mid[0]) << " " << int(mid[1]) << " " << int(mid[2]) << ", the glass over the background " << int(glass[0]) << " " << int(glass[1]) << " " << int(glass[2])
                 << ", the blue brick bare " << int(bare[0]) << " " << int(bare[1]) << " " << int(bare[2]));
  // It shows through: the glass in front of it is not as it is in front of the background.
  REQUIRE(channelGap(mid, glass) > 30);
  // Tinted: red against blue, it is redder than the bare blue brick by much.
  REQUIRE(int(mid[0]) - int(mid[2]) > int(bare[0]) - int(bare[2]) + 60);
  // A solid 20-LDU red slab can extinguish blue below 8-bit precision; it
  // must not introduce green that was absent in the object behind it.
  REQUIRE(mid[2] >= mid[1]);
}

TEST_CASE("two overlapping transparent bricks look the same whichever is listed first", "[gpu][frame]") {
  NEED_GPU();
  // Same colour, so one group whose instance order is the listing order.
  const std::string a = piece("3005.dat", 0, 0, 0, 36), b = piece("3005.dat", 10, -6, -10, 36), c = piece("3005.dat", 0, 0, 0, 4);
  const Difference d = compare(shot(a + b + c, FrameOptions{}), shot(b + a + c, FrameOptions{}));
  INFO("meanAbs " << d.meanAbs);
  REQUIRE(d.sameSize);
  // Ray queries can round a coincident edge by one output level.
  REQUIRE(d.meanAbs < 0.001);
  REQUIRE(d.worstBlock < 0.02);
}

TEST_CASE("glass shadows the floor as an opaque brick does, and the floor seen through it shows no shadow", "[gpu][frame]") {
  NEED_GPU();
  // EyeSight's ground is a shadow catcher (native/corpus/calib/glass.ldr): glass on it casts
  // the shadow an opaque piece would, and the floor seen through glass is not shadowed. Seen
  // from well above, so that much of the floor is behind the glass and much of the shadow is not.
  FrameOptions lit;
  lit.edges = false;
  FrameOptions unlit = lit;  // the floor drawn, its light not worked out
  unlit.shadows = unlit.ambientOcclusion = false;
  const std::string glass = piece("3005.dat", 0, 0, 0, 36), solid = piece("3005.dat", 0, 0, 0, 4);
  auto at = [&](const std::string& text, const FrameOptions& o) { return shotOf(text, o, 256, 256, nullptr, 0.6, 0.9, 2).image; };
  const Image glassLit = at(glass, lit), glassUnlit = at(glass, unlit), solidLit = at(solid, lit);
  // Where each brick is: the plain pictures (no floor), not the background.
  const Image glassPlain = at(glass, plain()), solidPlain = at(solid, plain());
  const uint8_t* background = glassPlain.at(0, 0);
  auto brick = [&](int x, int y) {
    if (x < 0 || y < 0 || x >= 256 || y >= 256) return false;
    return channelGap(glassPlain.at(x, y), background) > 0 || channelGap(solidPlain.at(x, y), background) > 0;
  };
  auto glassAt = [&](int x, int y) { return x >= 0 && y >= 0 && x < 256 && y < 256 && channelGap(glassPlain.at(x, y), background) > 0; };
  // Within `r` pixels of a pixel: all glass, or no brick at all.
  auto allGlass = [&](int x, int y, int r) {
    for (int dy = -r; dy <= r; dy++)
      for (int dx = -r; dx <= r; dx++)
        if (!glassAt(x + dx, y + dy)) return false;
    return true;
  };
  auto clear = [&](int x, int y, int r) {
    for (int dy = -r; dy <= r; dy++)
      for (int dx = -r; dx <= r; dx++)
        if (brick(x + dx, y + dy)) return false;
    return true;
  };
  // The floor's light is smoothed over a few pixels (the half-size pass, its blur, and the
  // upsample), so the floor next to a brick's outline is left out.
  const int band = 6;
  int behind = 0, behindOff = 0, around = 0, aroundOff = 0, shaded = 0;
  for (int y = 0; y < 256; y++)
    for (int x = 0; x < 256; x++) {
      if (allGlass(x, y, 2)) {
        behind++;
        // Up to 2 apart: the glass's own key light is dithered (keyShadow) with shadows on. The
        // floor under it is in the brick's full shadow, which would take off tens of levels.
        if (channelGap(glassLit.at(x, y), glassUnlit.at(x, y)) > 2) behindOff++;
      } else if (clear(x, y, band)) {
        around++;
        if (channelGap(glassLit.at(x, y), solidLit.at(x, y)) > 1) aroundOff++;
        if (luminance(glassUnlit.at(x, y)) - luminance(glassLit.at(x, y)) > 3) shaded++;
      }
    }
  INFO("through glass " << behind << " (" << behindOff << " differ with the floor's light on), around " << around << " (" << aroundOff << " differ from an opaque brick's, "
                        << shaded << " in its shadow)");
  REQUIRE(behind > 400);
  REQUIRE(behindOff == 0);
  REQUIRE(shaded > 100);
  REQUIRE(aroundOff == 0);
}

TEST_CASE("refractive glass keeps its moulded contour lines in front of the pane", "[gpu][glass]") {
  NEED_GPU();
  const std::string glass = piece("3005.dat", 0, 0, 0, 36);
  FrameOptions noEdges = plain();
  noEdges.refractiveGlass = true;
  FrameOptions outlined = noEdges;
  outlined.edges = true;
  const Image clear = shot(glass, noEdges), contoured = shot(glass, outlined);
  // Check interior edge lines (stud rims and mould seams), not just the external
  // silhouette, where a line can fall outside the glass and survive by accident.
  const uint8_t* background = clear.at(0, 0);
  int changed = 0;
  for (int y = 4; y < clear.height - 4; ++y)
    for (int x = 4; x < clear.width - 4; ++x) {
      bool interior = true;
      for (int dy = -3; dy <= 3 && interior; ++dy)
        for (int dx = -3; dx <= 3 && interior; ++dx)
          interior = channelGap(clear.at(x + dx, y + dy), background) > 10;
      if (interior && channelGap(clear.at(x, y), contoured.at(x, y)) > 4) ++changed;
    }
  INFO("interior refractive-glass contour pixels: " << changed);
  REQUIRE(changed > 10);
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

namespace {
/// A model file from the real library, drawn framed at `azimuth`, from `zoomOut` times the framing distance.
Shot shotOfFile(const std::filesystem::path& file, const ldraw::Library& lib, const FrameOptions& options, int w, int h, double azimuth, double zoomOut = 1) {
  ldraw::PartCache full{lib, ldraw::PartCache::defaultDirectory()};
  ldraw::FlattenOptions lowOptions;
  lowOptions.lowResPrimitives = true;
  ldraw::PartCache low{lib, ldraw::PartCache::defaultDirectory().parent_path() / "parts-low", lowOptions};
  const Model model = io::load(file, lib, &full);
  auto r = Renderer::create(model, full, low);
  REQUIRE(r);
  r->resize(w, h);
  OrbitCamera orbit = OrbitCamera::framing(r->scene().bounds, 0.6, double(w) / h);
  orbit.azimuth = azimuth;
  orbit.distance *= zoomOut;
  Shot s;
  s.camera = orbit.camera(double(w) / h, r->scene().bounds);
  s.origin = r->scene().origin;
  s.stats = r->draw(s.camera, options);
  s.image = r->readback();
  if (const char* dump = std::getenv("BMR_DUMP")) {
    static int n = 0;
    writePng(s.image, std::filesystem::path(dump) / ("file" + std::to_string(n++) + ".png"));
  }
  return s;
}

FrameOptions everything() {
  FrameOptions o;
  o.cull = false;
  o.forceDetail = 0;
  return o;
}

std::filesystem::path samples() { return std::filesystem::path(BM_FIXTURES).parent_path().parent_path().parent_path() / "samples"; }
}  // namespace

TEST_CASE("a culled, level-of-detail frame matches the full frame", "[gpu][frame][data]") {
  NEED_GPU();
  const char* dir = std::getenv("BM_LDRAW_DIR");
  if (!dir) SKIP("BM_LDRAW_DIR is not set");
  const ldraw::Library lib{std::filesystem::path(dir)};
  for (double azimuth : {0.6, 2.2, 3.8, 5.4}) {
    const Shot full = shotOfFile(samples() / "helicopter" / "helicopter.mpd", lib, everything(), 1600, 1000, azimuth);
    const Shot fast = shotOfFile(samples() / "helicopter" / "helicopter.mpd", lib, FrameOptions{}, 1600, 1000, azimuth);
    const Difference d = compare(full.image, fast.image);
    INFO("azimuth " << azimuth << " meanAbs " << d.meanAbs << " worstBlock " << d.worstBlock << " by detail " << fast.stats.byDetail[0] << "/" << fast.stats.byDetail[1] << "/"
                    << fast.stats.byDetail[2]);
    REQUIRE(d.meanAbs < kDetailMeanTolerance);
    REQUIRE(d.worstBlock < kDetailBlockTolerance);
    if (std::getenv("BMR_REPORT")) std::printf("helicopter azimuth %.1f: meanAbs %.3f worstBlock %.2f\n", azimuth, d.meanAbs, d.worstBlock);
  }
}

TEST_CASE("a far model is mostly low detail and boxes, and still looks like itself", "[gpu][frame][data]") {
  NEED_GPU();
  const char* dir = std::getenv("BM_LDRAW_DIR");
  if (!dir) SKIP("BM_LDRAW_DIR is not set");
  const ldraw::Library lib{std::filesystem::path(dir)};
  const Shot full = shotOfFile(samples() / "42000-1.mpd", lib, everything(), 1600, 1000, 0.6, 6);
  const Shot fast = shotOfFile(samples() / "42000-1.mpd", lib, FrameOptions{}, 1600, 1000, 0.6, 6);
  const uint32_t all = fast.stats.byDetail[0] + fast.stats.byDetail[1] + fast.stats.byDetail[2];
  INFO("by detail " << fast.stats.byDetail[0] << "/" << fast.stats.byDetail[1] << "/" << fast.stats.byDetail[2]);
  REQUIRE(all == full.stats.instances);
  REQUIRE(fast.stats.byDetail[0] < all / 10);
  const Difference d = compare(full.image, fast.image);
  INFO("meanAbs " << d.meanAbs << " worstBlock " << d.worstBlock);
  if (std::getenv("BMR_REPORT"))
    std::printf("42000-1 x6: by detail %u/%u/%u meanAbs %.3f worstBlock %.2f\n", fast.stats.byDetail[0], fast.stats.byDetail[1], fast.stats.byDetail[2], d.meanAbs, d.worstBlock);
  REQUIRE(d.meanAbs < kDetailMeanTolerance);
  REQUIRE(d.worstBlock < kDetailBlockTolerance);
}

TEST_CASE("a brick standing on a plate darkens the plate beside it", "[gpu][frame]") {
  NEED_GPU();
  // A plate of nine 2x4 bricks (each 80 x 24 x 40, top at y = 24) with a 1x1 brick standing on
  // its middle (x and z within +-10). Seen from the front left, the brick's left face meets the
  // plate along x = -10. A plate point 1.5 units from it is in the brick's ambient shadow; one
  // 35 units away (more than twice kAoRadius) is not.
  std::string text = piece("3005.dat", 0, 0, 0, 4);
  for (int i = -1; i <= 1; i++)
    for (int k = -1; k <= 1; k++) text += piece("3001.dat", 80.0 * i, 24, 40.0 * k, 0x2A0A0A0);
  FrameOptions withAo = plain();
  withAo.ambientOcclusion = true;
  const Shot on = shotOf(text, withAo, 256, 256, nullptr, 0.6, 0.6);
  const auto [nx, ny] = on.pixel({-11.5, 24, 0});
  const auto [fx, fy] = on.pixel({-45, 24, 0});
  INFO("near " << nx << "," << ny << " far " << fx << "," << fy);
  const double near = luminance(on.image.at(nx, ny)), far = luminance(on.image.at(fx, fy));
  INFO("near " << near << " far " << far);
  REQUIRE(far - near > 8);
  // Without occlusion the two differ only by the glossy reflection of the wide lights, which
  // moves across the plate with the angle it is seen at.
  const Shot off = shotOf(text, plain(), 256, 256, nullptr, 0.6, 0.6);
  REQUIRE(std::abs(luminance(off.image.at(nx, ny)) - luminance(off.image.at(fx, fy))) <= 4);
}

TEST_CASE("a brick's lowest band, just above the floor's plane, is shaded as the brick, not as floor", "[gpu][frame]") {
  NEED_GPU();
  // A 1x1 brick (24 tall, bottom at y = 24; the floor's plane is kFloorLift below that), seen
  // square on from close to the bottom of its front face (z = -10): an LDU is about 14 pixels.
  // Shadows and occlusion on, the floor off: nothing is near the face to darken it, so a point
  // the rounded band 0.2 LDU above its bottom and the flat face 2 LDU above it
  // must not acquire extra darkening from mistaking either surface for the floor.
  bmtest::GpuRig rig(piece("3005.dat", 0, 0, 0, 4));
  REQUIRE(rig.renderer);
  rig.camera.eye = {0, 23, -40}, rig.camera.target = {0, 23, 0};
  rig.camera.up = {0, -1, 0}, rig.camera.aspect = 1;
  FrameOptions o = plain();
  o.shadows = o.ambientOcclusion = true;
  const Image img = rig.shot(o);
  const auto [lx, ly] = rig.pixel({0, 23.8, -10});
  const auto [hx, hy] = rig.pixel({0, 22, -10});
  INFO("low " << lx << "," << ly << " high " << hx << "," << hy);
  const double low = luminance(img.at(lx, ly)), high = luminance(img.at(hx, hy));
  INFO("low " << low << " high " << high);
  const Image unoccluded = rig.shot(plain());
  REQUIRE(std::abs(low - luminance(unoccluded.at(lx, ly))) <= 3);
  REQUIRE(std::abs(high - luminance(unoccluded.at(hx, hy))) <= 3);
}

TEST_CASE("the shadow catcher does not hide glass or replace brick AO from below", "[gpu][frame]") {
  NEED_GPU();
  const std::string model = piece("3005.dat", 0, 0, 0, 36) + piece("3005.dat", 20, 0, 0, 4);
  FrameOptions withFloor = plain();
  withFloor.floor = withFloor.ambientOcclusion = withFloor.shadows = true;
  FrameOptions withoutFloor = withFloor;
  withoutFloor.floor = false;
  for (double azimuth : {0.6, 2.1, 3.8}) {
    const Shot a = shotOf(model, withFloor, 256, 256, nullptr, azimuth, -0.45);
    const Shot b = shotOf(model, withoutFloor, 256, 256, nullptr, azimuth, -0.45);
    INFO("azimuth " << azimuth);
    REQUIRE(compare(a.image, b.image).meanAbs < 0.05);
    REQUIRE(compare(a.image, b.image).worstBlock < 0.5);
  }
}

TEST_CASE("neural shader executes deterministically across odd viewport sizes and refines brick, floor, and glass transport", "[gpu][frame][neural]") {
  NEED_GPU();
  const std::string model = piece("3005.dat", 0, 0, 0, 4) + piece("3001.dat", 30, 0, 0, 14) + piece("3005.dat", 0, -24, 0, 36);
  FrameOptions base;
  FrameOptions neural = base;
  neural.neuralShader = true;

  // Non-multiple-of-16 dimensions exercise partial threadgroup boundaries in neuralInferKernel.
  const Image n1 = shot(model, neural, 251, 189);
  const Image n2 = shot(model, neural, 251, 189);
  const Image b1 = shot(model, base, 251, 189);
  REQUIRE(n1.width == 251);
  REQUIRE(n1.height == 189);

  // Deterministic across repeated draws.
  const Difference repeat = compare(n1, n2);
  REQUIRE(repeat.sameSize);
  REQUIRE(repeat.meanAbs == 0.0);

  // Actively refines shading compared to baseline while keeping top sky corners pure white
  // and outer floor corners consistent with baseline.
  const Difference delta = compare(n1, b1);
  REQUIRE(delta.sameSize);
  REQUIRE(delta.meanAbs > 0.02);
  REQUIRE(delta.meanAbs < 12.0);
  for (auto [x, y] : {std::pair{2, 2}, {248, 2}}) {
    REQUIRE(n1.at(x, y)[0] > 250);
    REQUIRE(n1.at(x, y)[1] > 250);
    REQUIRE(n1.at(x, y)[2] > 250);
  }
  for (auto [x, y] : {std::pair{2, 186}, {248, 186}}) {
    REQUIRE(std::abs(int(n1.at(x, y)[0]) - int(b1.at(x, y)[0])) <= 5);
  }
}
