#include <catch2/catch_test_macros.hpp>
#include <catch2/matchers/catch_matchers_floating_point.hpp>
#include <filesystem>
#include <fstream>
#include <unistd.h>
#include "bm/io.h"
#include "bm/stable/stability.h"
#include "bm/stable/tolerances.h"

using namespace bm;
using namespace bm::stable;
using Catch::Matchers::WithinAbs;
using Catch::Matchers::WithinRel;
namespace fs = std::filesystem;

namespace {
struct Scene {
  ldraw::Library lib{fs::path(BM_FIXTURES) / "lib"};
  ldraw::PartCache parts{lib, fs::temp_directory_path() / "bm_stable_cache"};
  std::string text;
  connect::Graph graph;
  uint32_t count = 0;
  std::unique_ptr<Model> model;
  uint32_t add(const char* part, double x, double y, double z) {
    text += "1 4 " + std::to_string(x) + " " + std::to_string(y) + " " + std::to_string(z) + " 1 0 0 0 1 0 0 0 1 " + part + "\n";
    return count++;
  }
  void join(uint32_t a, uint32_t b) {
    connect::Connection c;
    c.a = std::min(a, b), c.b = std::max(a, b);
    graph.connections.push_back(c);
  }
  Result check(Options options = {}) {
    static int counter = 0;
    const fs::path file = fs::temp_directory_path() / ("bm_stable_" + std::to_string(::getpid()) + "_" + std::to_string(counter++) + ".ldr");
    { std::ofstream out(file); out << text; }
    model = std::make_unique<Model>(io::load(file, lib));
    fs::remove(file);
    return stable::check(*model, graph, parts, options);
  }
};
}  // namespace

TEST_CASE("an empty model stands and weighs nothing", "[stable]") {
  Scene s;
  const Result r = s.check();
  REQUIRE((r.stands && r.groups.empty() && r.unsupported.empty() && r.tipping.empty()));
  REQUIRE(r.mass == 0);
}

TEST_CASE("a brick on the floor stands, with its weight inside its footprint", "[stable]") {
  Scene s;
  s.add("3001.dat", 0, 0, 0);
  const Result r = s.check();
  REQUIRE(r.stands);
  REQUIRE(r.groups.size() == 1);
  REQUIRE(r.groups[0].onFloor);
  REQUIRE(r.groups[0].mass > 0);
  REQUIRE_THAT(r.mass, WithinRel(r.groups[0].mass, 1e-12));
  // A 2x4 brick is 40 x 80: the centre is 20 from the nearest edge, give or take its studs' pull.
  REQUIRE(r.margin > 15);
  REQUIRE(r.margin <= 20.5);
}

TEST_CASE("a piece joined to nothing that reaches the floor is unsupported", "[stable]") {
  Scene s;
  const uint32_t base = s.add("3001.dat", 0, 0, 0), top = s.add("3005.dat", 0, -24, 0), loose = s.add("3005.dat", 200, -100, 0);
  s.join(base, top);
  const Result r = s.check();
  REQUIRE_FALSE(r.stands);
  REQUIRE(r.unsupported == std::vector<uint32_t>{loose});
  REQUIRE(r.tipping.empty());
  // In a build step without the base, what stood on it hangs in the air: the floor has not moved.
  std::vector<uint8_t> present{0, 1, 0};
  Options step;
  step.present = &present;
  const Result early = s.check(step);
  REQUIRE(early.unsupported == std::vector<uint32_t>{top});
  REQUIRE(early.groups.size() == 1);
}

TEST_CASE("a group whose weight is outside what it stands on tips", "[stable]") {
  Scene s;
  // A 1x1 foot with 2x4 bricks joined to it far out to one side.
  const uint32_t foot = s.add("3005.dat", 0, 0, 0);
  for (int i = 0; i < 3; i++) s.join(foot, s.add("3001.dat", 100 + 80 * i, -24, 0));
  const Result r = s.check();
  REQUIRE_FALSE(r.stands);
  REQUIRE(r.unsupported.empty());
  REQUIRE(r.tipping == std::vector<uint32_t>{0});
  REQUIRE(r.margin < -50);
  // The same bricks set evenly either side of the foot balance.
  Scene even;
  const uint32_t middle = even.add("3005.dat", 0, 0, 0);
  even.join(middle, even.add("3001.dat", -60, -24, 0));
  even.join(middle, even.add("3001.dat", 60, -24, 0));
  REQUIRE(even.check().stands);
}

TEST_CASE("gravity may point any way", "[stable]") {
  Scene s;
  s.add("3001.dat", 0, 0, 0);
  Options sideways;
  sideways.down = {1, 0, 0};
  const Result r = s.check(sideways);
  REQUIRE(r.stands);
  Options none;
  none.down = {0, 0, 0};  // taken as LDraw's down
  REQUIRE(s.check(none).stands);
}

TEST_CASE("a part's weight comes from the volume its mesh encloses", "[stable][mass]") {
  // A closed box 20 x 10 x 30, wound counter-clockwise from outside.
  ldraw::Mesh box;
  const float x = 20, y = 10, z = 30;
  box.positions = {0, 0, 0, x, 0, 0, x, y, 0, 0, y, 0, 0, 0, z, x, 0, z, x, y, z, 0, y, z};
  box.triangles = {0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 2, 3, 7, 2, 7, 6, 1, 2, 6, 1, 6, 5, 3, 0, 4, 3, 4, 7};
  box.bounds.grow({0, 0, 0});
  box.bounds.grow({x, y, z});
  Vec3 centre;
  REQUIRE_THAT(massOf(box, &centre), WithinRel(6000 * kDensity, 1e-9));
  REQUIRE_THAT(centre.x, WithinAbs(10, 1e-9));
  REQUIRE_THAT(centre.y, WithinAbs(5, 1e-9));
  REQUIRE_THAT(centre.z, WithinAbs(15, 1e-9));
  // A mesh that encloses next to nothing (here one flat sheet through the middle of the same
  // box) is weighed by its box instead.
  ldraw::Mesh open = box;
  open.positions = {0, 5, 0, x, 5, 0, x, 5, z, 0, 0, 0, x, y, z};
  open.triangles = {0, 1, 2};
  REQUIRE_THAT(massOf(open, &centre), WithinRel(6000 * kHollowShare * kDensity, 1e-9));
  REQUIRE_THAT(centre.x, WithinAbs(10, 1e-9));
  REQUIRE(massOf(ldraw::Mesh{}) == 0);
}
