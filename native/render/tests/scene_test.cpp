#include <catch2/catch_approx.hpp>
#include <catch2/catch_test_macros.hpp>
#include <cstring>
#include "bmr/scene.h"
#include "helpers.h"

using namespace bm;
using namespace bmr;
using bmtest::piece;

namespace {
struct Rig {
  ldraw::Library lib = bmtest::fixtureLibrary();
  ldraw::PartCache parts{lib, bmtest::cacheDir()};
};
bool sameMatrices(const Scene& a, const Scene& b, float tolerance) {
  if (a.groups.size() != b.groups.size()) return false;
  for (size_t g = 0; g < a.groups.size(); g++) {
    if (a.groups[g].instances.size() != b.groups[g].instances.size()) return false;
    for (size_t i = 0; i < a.groups[g].instances.size(); i++) {
      if (a.groups[g].instances[i].flags != b.groups[g].instances[i].flags) return false;
      for (int k = 0; k < 12; k++)
        if (std::abs(a.groups[g].instances[i].model[k] - b.groups[g].instances[i].model[k]) > tolerance) return false;
    }
  }
  return true;
}
Vec3 where(const Scene& s, uint32_t piece) {
  const Instance& in = s.groups[s.where[piece].first].instances[s.where[piece].second];
  return Vec3{in.model[3], in.model[7], in.model[11]} + s.origin;
}
}  // namespace

TEST_CASE("pieces of one part and colour share a group; opaque groups come first", "[scene]") {
  Rig r;
  // Colour 4 is red, 36 is transparent red.
  const Model m = bmtest::modelFrom(piece("3005.dat", 0, 0, 0, 4) + piece("3005.dat", 20, 0, 0, 36) + piece("3005.dat", 40, 0, 0, 4) + piece("3001.dat", 0, 0, 60, 4) + piece("3005.dat", 60, 0, 0, 36) +
                                    piece("3005.dat", 80, 0, 0, 4), r.lib);
  REQUIRE(m.library().colors().at(36).alpha < 1);
  size_t skipped = 9;
  const Scene s = buildScene(m, r.parts, &skipped);
  REQUIRE(skipped == 0);
  REQUIRE(s.groups.size() == 3);
  REQUIRE(s.groups[0].part == "3001.dat");
  REQUIRE(s.groups[0].instances.size() == 1);
  REQUIRE(s.groups[1].part == "3005.dat");
  REQUIRE(s.groups[1].instances.size() == 3);
  REQUIRE_FALSE(s.groups[1].material.transparent());
  REQUIRE(s.groups[2].instances.size() == 2);
  REQUIRE(s.groups[2].material.transparent());
  REQUIRE(s.groups[2].color == 36);
  REQUIRE(s.where.size() == 6);
  for (uint32_t p = 0; p < 6; p++) {
    REQUIRE(s.groups[s.where[p].first].instances[s.where[p].second].piece == p);
    REQUIRE(s.groups[s.where[p].first].restBoxes.size() == s.groups[s.where[p].first].instances.size());
  }
  REQUIRE(s.bounds.min.x == Catch::Approx(-40));  // the 2x4 at x = 0 is 80 wide
  REQUIRE(s.bounds.max.x == Catch::Approx(90));
}

TEST_CASE("positions are sent relative to the scene's centre", "[scene]") {
  Rig r;
  const Model m = bmtest::modelFrom(piece("3005.dat", 100000, 0, 0) + piece("3005.dat", 100040, 0, 0), r.lib);
  const Scene s = buildScene(m, r.parts);
  REQUIRE(s.origin.x == Catch::Approx(100020));
  const Group& g = s.groups.at(0);
  REQUIRE(g.instances[0].model[3] == -20.0f);
  REQUIRE(g.instances[1].model[3] == 20.0f);
  REQUIRE(g.instances[0].model[0] == 1.0f);
  REQUIRE(g.instances[0].model[5] == 1.0f);
  REQUIRE(g.instances[0].model[10] == 1.0f);
  REQUIRE(g.instances[0].model[1] == 0.0f);
}

TEST_CASE("a mirrored piece is marked; a missing part is a placeholder; a broken transform is left out", "[scene]") {
  Rig r;
  const Model m = bmtest::modelFrom(piece("3005.dat", 0, 0, 0, 4, "-1 0 0 0 1 0 0 0 1") + piece("nosuch.dat", 40, 0, 0) + piece("3005.dat", 80, 0, 0, 4, "0 0 0 0 0 0 0 0 0") + piece("3005.dat", 120, 0, 0, 987654), r.lib);
  size_t skipped = 0;
  const Scene s = buildScene(m, r.parts, &skipped);
  REQUIRE(skipped == 1);
  REQUIRE(s.where[2].first == UINT32_MAX);
  REQUIRE((s.groups[s.where[0].first].instances[s.where[0].second].flags & kMirrored) != 0);
  const Group& missing = s.groups[s.where[1].first];
  REQUIRE(missing.placeholder);
  REQUIRE(missing.material == placeholderMaterial());
  REQUIRE(missing.restBoxes[0].max.x == Catch::Approx(60));  // the 20 x 24 x 20 stand-in box at x = 40
  const Group& odd = s.groups[s.where[3].first];             // a colour nobody defined: mid grey, drawn
  REQUIRE_FALSE(odd.placeholder);
  REQUIRE(odd.material.base[0] == Catch::Approx(linearFromSrgb(0x88)));
}

TEST_CASE("a frame's poses depend only on the frame", "[scene][playback]") {
  Rig r;
  const Model m = bmtest::modelFrom(piece("3005.dat", 0, 0, 0) + piece("3005.dat", 0, -24, 0) + piece("3005.dat", 0, -48, 0) + piece("3005.dat", 0, -72, 0), r.lib);
  // Written by hand: three units that fly in one after another (the second a pair), and one that does not fly.
  plan::Plan plan;
  plan.moves.resize(3);
  plan.moves[0].unit.pieces = {0};
  plan.moves[1].unit.pieces = {1, 2};
  plan.moves[2].unit.pieces = {3};
  plan::Timeline t;
  for (uint32_t i = 0; i < 2; i++) {
    plan::Flight f;
    f.move = i, f.startFrame = static_cast<int>(i) * 10, f.frames = 10;
    f.staging.t = {200, 0, 50.0 * i};
    Xform above;
    above.t = {0, -100, 0};
    f.waypoints = {f.staging, above, Xform{}};
    f.at = {0, 0.5, 1};
    t.flights.push_back(f);
  }
  plan::Flight still;
  still.move = 2, still.startFrame = 20, still.frames = 0;
  t.flights.push_back(still);
  t.frames = 20;

  Scene s = buildScene(m, r.parts);
  const Scene rest = s;
  applyFrame(s, m, plan, t, 0);
  REQUIRE(length(where(s, 0) - Vec3{200, 0, 0}) < 1e-3);        // waiting at its staging spot
  REQUIRE(length(where(s, 1) - Vec3{200, -24, 50}) < 1e-3);     // the pair keeps its shape
  REQUIRE(length(where(s, 2) - Vec3{200, -48, 50}) < 1e-3);
  REQUIRE((s.groups[s.where[3].first].instances[s.where[3].second].flags & kHidden) != 0);  // does not fly: not there yet
  applyFrame(s, m, plan, t, t.frames);
  REQUIRE(sameMatrices(s, rest, 0));                              // the finished model
  applyFrame(s, m, plan, t, 7);
  Scene fresh = buildScene(m, r.parts);
  const auto changed = applyFrame(fresh, m, plan, t, 7);
  REQUIRE(sameMatrices(s, fresh, 1e-5f));
  REQUIRE(changed.size() == 4);                                   // three away from rest, one hidden
  REQUIRE(applyFrame(fresh, m, plan, t, 7).empty());              // the same frame again changes nothing
  REQUIRE(length(where(s, 0) - plan::poseAt(t.flights[0], 7).t) < 1e-3);  // where the timeline says, on the last leg
  REQUIRE(where(s, 0).y < -1);
  REQUIRE(std::abs(where(s, 0).x) < 1e-3);
  // Rest again, by name.
  REQUIRE_FALSE(applyRest(s, m).empty());
  REQUIRE(sameMatrices(s, rest, 0));
  // A flight that names a move or a piece that is not there is ignored.
  plan::Timeline bad = t;
  bad.flights[0].move = 99;
  plan.moves[1].unit.pieces.push_back(12345);
  applyFrame(s, m, plan, bad, 3);
  REQUIRE(length(where(s, 0) - Vec3{0, 0, 0}) < 1e-3);
}

TEST_CASE("selecting marks exactly the pieces named", "[scene]") {
  Rig r;
  const Model m = bmtest::modelFrom(piece("3005.dat", 0, 0, 0) + piece("3005.dat", 40, 0, 0) + piece("3005.dat", 80, 0, 0), r.lib);
  Scene s = buildScene(m, r.parts);
  REQUIRE(applySelection(s, {1, 77}).size() == 1);
  REQUIRE((s.groups[0].instances[1].flags & kSelected) != 0);
  REQUIRE(applySelection(s, {2}).size() == 2);
  REQUIRE((s.groups[0].instances[1].flags & kSelected) == 0);
  REQUIRE((s.groups[0].instances[2].flags & kSelected) != 0);
  REQUIRE(applySelection(s, {2}).empty());
}

TEST_CASE("an empty model gives an empty scene", "[scene]") {
  Rig r;
  const Model m = bmtest::modelFrom("0 nothing here\n", r.lib);
  Scene s = buildScene(m, r.parts);
  REQUIRE(s.groups.empty());
  REQUIRE(s.where.empty());
  REQUIRE(s.bounds.empty());
  REQUIRE(applyFrame(s, m, plan::Plan{}, plan::Timeline{}, 5).empty());
}
