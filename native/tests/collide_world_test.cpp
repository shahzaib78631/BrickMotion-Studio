#include <catch2/catch_test_macros.hpp>
#include <chrono>
#include <filesystem>
#include <fstream>
#include <unistd.h>
#include "bm/collide/world.h"
#include "bm/io.h"

using namespace bm;
using namespace bm::collide;
namespace fs = std::filesystem;

namespace {
struct Rig {
  ldraw::Library lib{fs::path(BM_FIXTURES) / "lib"};
  connect::ShadowLibrary shadow{fs::path(BM_FIXTURES) / "shadow"};
  connect::ConnectorDb db{lib, shadow};
  ldraw::PartCache parts{lib, fs::temp_directory_path() / "bm_collide_world_cache"};
  ShapeCache shapes;

  Model model(const std::string& text) {
    static int counter = 0;
    const fs::path file = fs::temp_directory_path() / ("bm_world_test_" + std::to_string(::getpid()) + "_" + std::to_string(counter++) + ".ldr");
    { std::ofstream out(file); out << text; }
    Model m = io::load(file, lib);
    fs::remove(file);
    return m;
  }
  Report check(const std::string& text, const kin::GearDb* gears = nullptr) {
    const Model m = model(text);
    return findOverlaps(m, connect::buildGraph(m, db, gears), parts, shapes);
  }
};
std::string piece(const char* part, double x, double y, double z) {
  return "1 4 " + std::to_string(x) + " " + std::to_string(y) + " " + std::to_string(z) + " 1 0 0 0 1 0 0 0 1 " + part + "\n";
}
}  // namespace

TEST_CASE("a clean stack has no overlaps; studs in their sockets are exempt", "[collide][world]") {
  Rig r;
  // The fixture bricks are solid, so each stud really is inside the brick above it.
  const Report rep = r.check(piece("c2x4.dat", 0, 0, 0) + piece("c2x4.dat", 0, -24, 0) + piece("c2x4.dat", 0, -48, 0) + piece("c1x1.dat", 200, 0, 0));
  REQUIRE(rep.overlaps.empty());
  REQUIRE(rep.tested >= 2);
}

TEST_CASE("a brick pushed into its neighbour is reported once", "[collide][world]") {
  Rig r;
  const Report rep = r.check(piece("c2x4.dat", 0, 0, 0) + piece("c2x4.dat", 500, 0, 0) + piece("c2x4.dat", 70, 0, 0));
  REQUIRE(rep.overlaps.size() == 1);
  REQUIRE((rep.overlaps[0].a == 0 && rep.overlaps[0].b == 2 && !rep.overlaps[0].duplicate));
  REQUIRE((rep.overlaps[0].point.x > 28 && rep.overlaps[0].point.x < 42));
}

TEST_CASE("a brick sunk into the one below is an overlap, zones or not", "[collide][world]") {
  Rig r;
  REQUIRE(r.check(piece("c2x4.dat", 0, 0, 0) + piece("c2x4.dat", 0, -18, 0)).overlaps.size() == 1);
  // Plain boxes (no studs): 0.2 deep is within the skin, 1.5 deep is not.
  REQUIRE(r.check(piece("3005.dat", 0, 0, 0) + piece("3005.dat", 0, -23.8, 0)).overlaps.empty());
  REQUIRE(r.check(piece("3005.dat", 0, 0, 0) + piece("3005.dat", 0, -22.5, 0)).overlaps.size() == 1);
}

TEST_CASE("an exact duplicate is reported as one", "[collide][world][focus]") {
  Rig r;
  const Report rep = r.check(piece("c2x4.dat", 0, 0, 0) + piece("c2x4.dat", 0, 0, 0));
  REQUIRE(rep.overlaps.size() == 1);
  REQUIRE(rep.overlaps[0].duplicate);
}

TEST_CASE("flexible segments and parts with no geometry are not tested", "[collide][world]") {
  Rig r;
  REQUIRE(r.check(piece("c2x4.dat", 0, 0, 0) + piece("seg.dat", 0, 10, 0) + piece("nosuch.dat", 0, 10, 0)).overlaps.empty());
  REQUIRE(r.check("").overlaps.empty());
}

TEST_CASE("ten thousand bricks are checked quickly", "[collide][world][focus]") {
  Rig r;
  std::string text;
  for (int i = 0; i < 100; i++)
    for (int j = 0; j < 50; j++) text += piece("c2x4.dat", i * 80, 0, j * 40) + piece("c2x4.dat", i * 80, -24, j * 40);
  const Model m = r.model(text);
  const connect::Graph g = connect::buildGraph(m, r.db);
  const auto t0 = std::chrono::steady_clock::now();
  const Report rep = findOverlaps(m, g, r.parts, r.shapes);
  const double seconds = std::chrono::duration<double>(std::chrono::steady_clock::now() - t0).count();
  REQUIRE(rep.overlaps.empty());
#ifndef BM_SANITIZED
  REQUIRE(seconds < 3.0);
#else
  (void)seconds;
#endif
}

TEST_CASE("the world answers for one more shape, still or moving", "[collide][world][sweep]") {
  Rig r;
  const Model m = r.model(piece("c2x4.dat", 0, 0, 0) + piece("c2x4.dat", 200, 0, 0));
  const World world(m, r.parts, r.shapes);
  const auto brick = r.shapes.get(r.parts.get("3005.dat"));  // a plain 20 x 24 x 20 box
  auto at = [](double x, double y, double z) { return Xform{Mat3::identity(), {x, y, z}}; };

  REQUIRE_FALSE(world.hits(*brick, at(0, -100, 0)).has_value());
  REQUIRE(world.hits(*brick, at(0, -10, 0)) == std::optional<uint32_t>(0));
  REQUIRE(world.hits(*brick, at(200, -10, 0)) == std::optional<uint32_t>(1));
  REQUIRE_FALSE(world.hits(*brick, at(0, -10, 0), {0}).has_value());  // told to ignore that piece
  REQUIRE_FALSE(world.hits(*brick, at(0, -28, 0)).has_value());       // resting on the studs' tops (stud top is y = -4)

  // Coming straight down: clear until it reaches the studs.
  const auto down = world.sweep(*brick, at(0, -200, 0), at(0, -24, 0));
  REQUIRE(down.has_value());
  REQUIRE((*down > 0.95 && *down < 1.0));  // stopped by the studs, 4 LDU short of the surface
  REQUIRE_FALSE(world.sweep(*brick, at(0, -200, 0), at(0, -28, 0)).has_value());
  // Sideways through the first brick.
  const auto through = world.sweep(*brick, at(-300, 0, 0), at(100, 0, 0));
  REQUIRE(through.has_value());
  REQUIRE((*through > 0.5 && *through < 0.7));  // first touches at x = -50, 250 of 400 along
  // Past both, well above.
  REQUIRE_FALSE(world.sweep(*brick, at(-300, -100, 0), at(400, -100, 0)).has_value());
  // A move that also turns.
  const double c = std::sqrt(0.5);
  REQUIRE(world.sweep(*brick, at(-300, 0, 0), Xform{Mat3{{c, 0, c, 0, 1, 0, -c, 0, c}}, {0, 0, 0}}).has_value());
  REQUIRE_FALSE(world.sweep(*brick, at(0, -100, 0), at(0, -100, 0)).has_value());  // not moving, in free space
}

TEST_CASE("the teeth of meshed gears may interleave; gears jammed together may not", "[collide][world][meshes]") {
  Rig r;
  kin::GearDb gears;
  REQUIRE(gears.load(R"({"parts":{"3005":[{"kind":"spur","teeth":8,"axis":[0,1,0],"centre":[0,12,0],"pitchRadius":9.5,"width":24}]}})") == 1);
  const std::string meshed = piece("3005.dat", 0, 0, 0) + piece("3005.dat", 19, 0, 0);  // the boxes cross by 1 LDU
  REQUIRE(r.check(meshed).overlaps.size() == 1);        // without the gear table they are just two crossing boxes
  REQUIRE(r.check(meshed, &gears).overlaps.empty());
  REQUIRE(r.check(piece("3005.dat", 0, 0, 0) + piece("3005.dat", 16, 0, 0), &gears).overlaps.size() == 1);  // 3 too close: not a mesh
}

TEST_CASE("how far a unit can travel before it meets a present piece", "[collide][world][travel]") {
  Rig r;
  // Piece 0 is the mover (a 1x1: 20 wide); piece 1 a wall 30 LDU away, so a 10 LDU gap; piece 2 far off.
  const Model m = r.model(piece("c1x1.dat", 0, 0, 0) + piece("c1x1.dat", 30, 0, 0) + piece("c1x1.dat", 0, 0, 300) + piece("c1x1.dat", -20, 0, 0));
  const World w(m, r.parts, r.shapes);
  uint32_t blocker = 7;
  // Touching, and passing by less than the skin, is not a hit: it stops within the skin of the gap.
  const double reached = w.clearTravel({0}, {1, 0, 0}, 100, nullptr, {}, &blocker);
  REQUIRE(reached >= 10.0);
  REQUIRE(reached <= 10.0 + 2 * kSkin + 0.1);
  REQUIRE(blocker == 1);
  // Away from everything it goes the whole way.
  REQUIRE(w.clearTravel({0}, {0, -1, 0}, 100, nullptr, {}, &blocker) == 100);
  REQUIRE(blocker == UINT32_MAX);
  // With the wall not there, nothing stops it.
  World::Present present{1, 0, 1, 1};
  REQUIRE(w.clearTravel({0}, {1, 0, 0}, 100, &present) == 100);
  // Two pieces moving as one never stop on each other, and stop when either meets something.
  const double pair = w.clearTravel({0, 3}, {1, 0, 0}, 100, nullptr, {}, &blocker);
  REQUIRE(pair >= 10.0);
  REQUIRE(pair <= 11.2);
  REQUIRE(blocker == 1);
  // A later leg starts from where the unit has got to.
  Xform up;
  up.t = {0, -50, 0};
  REQUIRE(w.clearTravel({0}, {1, 0, 0}, 100, nullptr, {}, nullptr, up) == 100);
  // near() respects the mask.
  std::vector<uint32_t> found;
  w.near(w.box(0), nullptr, found);
  REQUIRE(found == std::vector<uint32_t>{0, 3});
  w.near(w.box(0), &present, found);
  REQUIRE(found == std::vector<uint32_t>{0, 3});
  present[3] = 0;
  w.near(w.box(0), &present, found);
  REQUIRE(found == std::vector<uint32_t>{0});
  REQUIRE(w.clearTravel({0}, {0, 0, 0}, 100, nullptr) == 0);
}

TEST_CASE("a mate's zone lets the two pieces it joins cross there, and no other two", "[collide][world][travel]") {
  Rig r;
  // Piece 0 moves toward a wall (piece 1) 30 LDU away; piece 2, far off, is what it is joined to.
  const Model m = r.model(piece("c1x1.dat", 0, 0, 0) + piece("c1x1.dat", 30, 0, 0) + piece("c1x1.dat", 0, 0, 300));
  const World w(m, r.parts, r.shapes);
  // The zone of a mate that holds anywhere, as a tyre's on its rim does, between piece 0 and piece 2.
  Zone everywhere{{0, 0, 0}, {0, 0, 0}, 1e9};
  everywhere.first = 0, everywhere.second = 2;
  uint32_t blocker = 7;
  REQUIRE(w.clearTravel({0}, {1, 0, 0}, 100, nullptr, {everywhere}, &blocker) <= 10.0 + 2 * kSkin + 0.1);
  REQUIRE(blocker == 1);
  REQUIRE(w.clearTravel({0}, {1, 0, 0}, 100, nullptr, {everywhere}, &blocker, {}, 0.05, 99.9) < 99.9);
  REQUIRE(blocker == 1);
  // Between piece 0 and the wall, either way round, it lets the two cross.
  everywhere.second = 1;
  REQUIRE(w.clearTravel({0}, {1, 0, 0}, 100, nullptr, {everywhere}) == 100);
  REQUIRE(w.clearTravel({0}, {1, 0, 0}, 100, nullptr, {everywhere}, nullptr, {}, 0.05, 99.9) == 100);
  everywhere.first = 1, everywhere.second = 0;
  REQUIRE(w.clearTravel({0}, {1, 0, 0}, 100, nullptr, {everywhere}) == 100);
  // A shape that is not one of the model's pieces: a zone naming a piece forgives only that piece.
  const auto brick = r.shapes.get(r.parts.get("c1x1.dat"));
  Xform into;
  into.t = {20, 0, 0};  // 10 into the wall
  everywhere.first = 1, everywhere.second = kAnyPiece;
  REQUIRE_FALSE(w.hits(*brick, into, {0}, {everywhere}).has_value());
  everywhere.first = 2;
  REQUIRE(w.hits(*brick, into, {0}, {everywhere}) == std::optional<uint32_t>(1));
}

TEST_CASE("asked only whether it gets far enough, the answer says so and names what stops it", "[collide][world][travel]") {
  Rig r;
  const Model m = r.model(piece("c1x1.dat", 0, 0, 0) + piece("c1x1.dat", 30, 0, 0) + piece("c1x1.dat", 0, 0, 300));
  const World w(m, r.parts, r.shapes);
  uint32_t blocker = 7;
  const double exact = w.clearTravel({0}, {1, 0, 0}, 100, nullptr, {}, &blocker);
  REQUIRE(blocker == 1);
  // Must get 100 and cannot: some travel short of that, never more than a point inside it could go.
  blocker = 7;
  const double enough = w.clearTravel({0}, {1, 0, 0}, 100, nullptr, {}, &blocker, {}, 0.05, 99.9);
  REQUIRE(enough < 99.9);
  REQUIRE(enough <= 30.0);  // by then its far side is well inside the wall
  REQUIRE(blocker == 1);
  // Must get only as far as the gap: it does, and nothing is named.
  blocker = 7;
  REQUIRE(w.clearTravel({0}, {1, 0, 0}, 9, nullptr, {}, &blocker, {}, 0.05, 8.9) == 9);
  REQUIRE(blocker == UINT32_MAX);
  // A zone over the whole wall forgives it, both ways of asking.
  const std::vector<Zone> all{{{30, 12, 0}, {30, 12, 0}, 60}};
  REQUIRE(w.clearTravel({0}, {1, 0, 0}, 100, nullptr, all) == 100);
  REQUIRE(w.clearTravel({0}, {1, 0, 0}, 100, nullptr, all, nullptr, {}, 0.05, 99.9) == 100);
  REQUIRE(exact >= 10.0);
}
