// The path tracer: what it traces is the studio's look, and the same seed gives the same picture.
#include <catch2/catch_test_macros.hpp>
#include <cmath>
#include <cstring>
#include "bmr/camera.h"
#include "bmr/device.h"
#include "bmr/path_scene.h"
#include "bmr/path_tracer.h"
#include "bmr/tolerances.h"
#include "helpers.h"

using namespace bm;
using namespace bmr;
using bmtest::piece;

#define NEED_RT()                                     \
  if (!gpuAvailable()) SKIP("no Metal device");       \
  if (!PathScene::create(nullptr)) SKIP("no compute ray tracing")

namespace {
struct Rig {
  ldraw::Library lib = bmtest::fixtureLibrary();
  ldraw::PartCache full{lib, bmtest::cacheDir()};
  ldraw::PartCache low{lib, bmtest::cacheDir() / "low", lowOptions()};
  Model model;
  Scene scene;
  MeshLibrary meshes;
  std::unique_ptr<PathScene> path = PathScene::create(nullptr);
  std::unique_ptr<PathTracer> tracer = PathTracer::create(nullptr);
  Camera camera;
  int size;
  explicit Rig(const std::string& text, int s = 64, double azimuth = 0.6, double elevation = 0.45, double zoom = 1)
      : model(bmtest::modelFrom(text, lib)), scene(buildScene(model, full)), meshes(model, full, low), size(s) {
    OrbitCamera o = OrbitCamera::framing(scene.bounds, 0.6, 1.0);
    o.azimuth = azimuth, o.elevation = elevation, o.distance *= zoom;
    camera = o.camera(1.0, scene.bounds);
    path->prepare(scene, meshes);
  }
  static ldraw::FlattenOptions lowOptions() {
    ldraw::FlattenOptions o;
    o.lowResPrimitives = true;
    return o;
  }
  PathOptions options(int samples = 16, uint64_t seed = 0) const {
    PathOptions o;
    o.width = o.height = size;
    o.samples = samples;
    o.seed = seed;
    return o;
  }
  PathImage render(const PathOptions& o) { return tracer->render(*path, camera, o); }
};
size_t at(const PathImage& im, int x, int y) { return (static_cast<size_t>(y) * im.width + x) * 3; }
bool same(const std::vector<float>& a, const std::vector<float>& b) { return a.size() == b.size() && std::memcmp(a.data(), b.data(), a.size() * sizeof(float)) == 0; }
const char* kWhite = "50331647";  // 0x2FFFFFF: direct colour, opaque white
}  // namespace

TEST_CASE("the same seed gives the same picture, bit for bit", "[gpu][pathtrace]") {
  NEED_RT();
  Rig rig(piece("3001.dat", 0, 0, 0, 4) + piece("3005.dat", 0, -24, 0, 36));
  const PathImage a = rig.render(rig.options(8, 7)), b = rig.render(rig.options(8, 7)), c = rig.render(rig.options(8, 8));
  REQUIRE(a.width == 64);
  REQUIRE(a.beauty.size() == 64 * 64 * 3);
  REQUIRE(same(a.beauty, b.beauty));
  REQUIRE(same(a.albedo, b.albedo));
  REQUIRE(same(a.normal, b.normal));
  REQUIRE_FALSE(same(a.beauty, c.beauty));
}

TEST_CASE("a sample's random numbers depend on the seed, pixel and sample only", "[gpu][pathtrace]") {
  NEED_RT();
  Rig rig(piece("3001.dat", 0, 0, 0, 4));
  const PathImage alone = rig.render(rig.options(8, 40));
  Rig other(piece("3001.dat", 0, 0, 0, 4));
  (void)other.render(other.options(8, 39));
  REQUIRE(same(alone.beauty, other.render(other.options(8, 40)).beauty));
}

TEST_CASE("albedo is the piece's colour", "[gpu][pathtrace]") {
  NEED_RT();
  Rig rig(piece("3005.dat", 0, 0, 0, 4), 64, 0.0, 0.0);
  const PathImage im = rig.render(rig.options(4));
  const Material& red = rig.scene.groups[0].material;
  const size_t i = at(im, 32, 32);
  for (int c = 0; c < 3; c++) REQUIRE(std::fabs(im.albedo[i + c] - red.base[c]) < 1e-3f);
}

TEST_CASE("a mirrored piece's normals face the camera", "[gpu][pathtrace]") {
  NEED_RT();
  Rig rig("1 4 0 0 0 -1 0 0 0 1 0 0 0 1 3001.dat\n");
  PathOptions o = rig.options(1);
  o.floor = false;
  const PathImage im = rig.render(o);
  int hits = 0;
  const Vec3 toEye = normalized(rig.camera.eye - rig.camera.target);
  for (int y = 0; y < im.height; y++)
    for (int x = 0; x < im.width; x++) {
      const size_t i = at(im, x, y);
      const Vec3 n{im.normal[i], im.normal[i + 1], im.normal[i + 2]};
      if (length(n) < 0.5) continue;  // background
      if (std::fabs(im.albedo[i] - 1.0f) < 1e-3f) continue;  // the background's albedo is white
      hits++;
      INFO("pixel " << x << "," << y);
      REQUIRE(dot(n, toEye) > -0.05);
    }
  REQUIRE(hits > 100);
}

TEST_CASE("a part with no geometry is traced as its placeholder box", "[gpu][pathtrace]") {
  NEED_RT();
  Rig rig(piece("nosuchpart.dat", 0, 0, 0, 4));
  PathOptions o = rig.options(16);
  o.floor = false;
  const PathImage im = rig.render(o);
  const size_t i = at(im, 32, 32);
  REQUIRE(std::fabs(im.beauty[i] - 1.0f) + std::fabs(im.beauty[i + 1] - 1.0f) + std::fabs(im.beauty[i + 2] - 1.0f) > 0.05f);
}

TEST_CASE("clear glass lets more through than black plastic", "[gpu][pathtrace]") {
  NEED_RT();
  Rig glass(piece("3005.dat", 0, 0, 0, 36), 64, 0.0, 0.3), black(piece("3005.dat", 0, 0, 0, 0), 64, 0.0, 0.3);
  const PathImage g = glass.render(glass.options(64)), b = black.render(black.options(64));
  const size_t i = at(g, 32, 34);
  REQUIRE(g.beauty[i] > b.beauty[i] + 0.1f);
}

TEST_CASE("energy is kept: a white face under the world alone is as bright as the world", "[gpu][pathtrace]") {
  NEED_RT();
  // Straight down on a flat-topped white 1x1 brick: its top sees the whole sky.
  Rig rig(piece("3005.dat", 0, 0, 0, std::atoi(kWhite)), 64, 0.0, 1.45);
  PathOptions o = rig.options(1024);
  o.floor = false;
  o.lights = false;
  const PathImage im = rig.render(o);
  const size_t i = at(im, 32, 32);
  for (int c = 0; c < 3; c++) {
    INFO("channel " << c << ": " << im.beauty[i + c]);
    REQUIRE(std::fabs(im.beauty[i + c] - kWorldStrength) < 0.05f * kWorldStrength);
  }
}

TEST_CASE("the shadow-catching floor is the background where nothing shades it", "[gpu][pathtrace]") {
  NEED_RT();
  Rig rig(piece("3005.dat", 0, 0, 0, 4), 64, 0.6, 0.5, 8);
  const PathImage im = rig.render(rig.options(64));
  // A corner pixel: floor far from the brick.
  const size_t i = at(im, 1, 62);
  for (int c = 0; c < 3; c++) REQUIRE(std::fabs(im.beauty[i + c] - 1.0f) < 0.02f);
}

TEST_CASE("toImage writes the picture as the viewport does: clamped, sRGB", "[pathtrace]") {
  PathImage p;
  p.width = 2, p.height = 1;
  p.beauty = {0.0f, 0.5f, 1.0f, 2.0f, 0.2159f, -1.0f};
  const Image im = toImage(p);
  REQUIRE(im.width == 2);
  REQUIRE(im.at(0, 0)[0] == 0);
  REQUIRE(im.at(0, 0)[1] == 188);
  REQUIRE(im.at(0, 0)[2] == 255);
  REQUIRE(im.at(1, 0)[0] == 255);
  REQUIRE(im.at(1, 0)[1] == 128);
  REQUIRE(im.at(1, 0)[2] == 0);
  REQUIRE(im.at(1, 0)[3] == 255);
}
