#include <catch2/catch_approx.hpp>
#include <catch2/catch_test_macros.hpp>
#include <catch2/matchers/catch_matchers_floating_point.hpp>
#include <algorithm>
#include <cstdlib>
#include <filesystem>
#include "bm/ldraw/mesh.h"

using namespace bm;
using namespace bm::ldraw;
using Catch::Matchers::WithinAbs;

static Library fixtureLib() { return Library(std::filesystem::path(BM_FIXTURES) / "lib"); }

static double signedVolume(const Mesh& m) {
  double v = 0;
  for (size_t t = 0; t < m.triangles.size(); t += 3) {
    auto p = [&](size_t i) {
      const uint32_t k = m.triangles[t + i] * 3;
      return Vec3{m.positions[k], m.positions[k + 1], m.positions[k + 2]};
    };
    v += dot(p(0), cross(p(1), p(2))) / 6.0;
  }
  return v;
}

TEST_CASE("a box part becomes 12 outward triangles on 8 welded corners", "[ldraw][flatten]") {
  const Library lib = fixtureLib();
  const Mesh m = flatten("3005.dat", lib);
  REQUIRE(m.triangles.size() == 36);
  REQUIRE(m.positions.size() == 24);
  REQUIRE(m.triColor.size() == 12);
  REQUIRE((m.bounds.min == Vec3{-10, 0, -10} && m.bounds.max == Vec3{10, 24, 10}));
  REQUIRE_THAT(signedVolume(m), WithinAbs(20.0 * 24.0 * 20.0, 1e-6));
  REQUIRE(m.edges.size() == 6);
  REQUIRE(m.missing.empty());
  REQUIRE(m.sourceHash != 0);
}

TEST_CASE("subfiles are placed and summed", "[ldraw][flatten]") {
  const Library lib = fixtureLib();
  const Mesh m = flatten("3001", lib);  // ".dat" may be left off
  REQUIRE_THAT(signedVolume(m), WithinAbs(80.0 * 24 * 40 + 12.0 * 4 * 12, 1e-6));
  REQUIRE((m.bounds.min == Vec3{-40, -4, -20} && m.bounds.max == Vec3{40, 24, 20}));
  REQUIRE((m.body.min == Vec3{-40, 0, -20} && m.body.max == Vec3{40, 24, 20}));  // without the stud on top
}

TEST_CASE("a mirrored reference still faces outward", "[ldraw][flatten]") {
  const Library lib = fixtureLib();
  REQUIRE_THAT(signedVolume(flatten("mirror.dat", lib)), WithinAbs(20.0 * 24 * 20, 1e-6));
}

TEST_CASE("INVERTNEXT turns the next subfile inside out, and only that one", "[ldraw][flatten]") {
  const Library lib = fixtureLib();
  const Mesh m = flatten("inv.dat", lib);
  REQUIRE(m.triangles.size() == 3 * 36);
  // The origin-centred signed volume of each box is its volume, whatever its position.
  REQUIRE_THAT(signedVolume(m), WithinAbs(9600.0 - 9600.0 + 9600.0, 1e-6));
}

TEST_CASE("a CW-certified file is rewound, and NOCLIP geometry is two-sided", "[ldraw][flatten]") {
  const Library lib = fixtureLib();
  const Mesh m = flatten("cw.dat", lib);
  REQUIRE(m.triangles.size() == 9);  // one rewound triangle + one emitted in both windings
  // First triangle (0,0,0)(0,0,1)(1,0,0) written CW, so stored as its reverse: normal -y... i.e. +y after reversal.
  const uint32_t* t = m.triangles.data();
  auto p = [&](uint32_t i) { return Vec3{m.positions[i * 3], m.positions[i * 3 + 1], m.positions[i * 3 + 2]}; };
  const Vec3 n = cross(p(t[1]) - p(t[0]), p(t[2]) - p(t[0]));
  REQUIRE(n.y < 0);
}

TEST_CASE("an uncertified file is two-sided", "[ldraw][flatten]") {
  const Library lib = fixtureLib();
  const Mesh m = flatten("uncertified.dat", lib);
  REQUIRE(m.triangles.size() == 6);
  REQUIRE_THAT(signedVolume(m), WithinAbs(0, 1e-12));
}

TEST_CASE("colour 16 inherits and explicit colours stay", "[ldraw][flatten]") {
  const Library lib = fixtureLib();
  const Mesh m = flatten("colors.dat", lib);
  REQUIRE(m.triColor.size() == 14);
  REQUIRE(m.triColor[0] == 4);  // 16 under a red reference
  REQUIRE(m.triColor[1] == 1);  // explicit blue
  REQUIRE(std::all_of(m.triColor.begin() + 2, m.triColor.end(), [](int c) { return c == 4; }));
  const Mesh root = flatten("inner.dat", lib);
  REQUIRE(root.triColor[0] == 16);  // nothing to inherit from at the top
}

TEST_CASE("a missing subfile is reported and the rest is kept", "[ldraw][flatten][focus]") {
  const Library lib = fixtureLib();
  const Mesh m = flatten("missing.dat", lib);
  REQUIRE(m.triangles.size() == 36);
  REQUIRE(m.missing == std::vector<std::string>{"gone.dat"});
  const Mesh none = flatten("nosuchpart.dat", lib);
  REQUIRE(none.triangles.empty());
  REQUIRE(none.bounds.empty());
  REQUIRE(none.missing == std::vector<std::string>{"nosuchpart.dat"});
}

TEST_CASE("a part that references itself ends", "[ldraw][flatten][focus]") {
  const Library lib = fixtureLib();
  const Mesh m = flatten("selfref.dat", lib);
  REQUIRE(m.triangles.size() == 3);
  REQUIRE(m.missing == std::vector<std::string>{"selfref.dat"});
}

TEST_CASE("the source hash follows every file a part is made of", "[ldraw][flatten]") {
  const Library lib = fixtureLib();
  const Mesh a = flatten("3001.dat", lib), b = flatten("3001.dat", lib);
  REQUIRE(a.sourceHash == b.sourceHash);
  REQUIRE(a.deps.size() == 4);  // 3001, s/3001s01, stud, box
  const Library changed = lib.withInline(parseMpd("0 FILE box.dat\n0 changed\n", "x.mpd"));
  REQUIRE(flatten("3001.dat", changed).sourceHash != a.sourceHash);
  REQUIRE(flatten("3001.dat", lib, FlattenOptions{.hiResPrimitives = true}).sourceHash == a.sourceHash);
}

TEST_CASE("real bricks have the documented size and face outward", "[ldraw][flatten][data]") {
  const char* dir = std::getenv("BM_LDRAW_DIR");
  if (!dir) SKIP("BM_LDRAW_DIR is not set");
  const Library lib(dir);
  const Mesh b = flatten("3005.dat", lib);
  REQUIRE_THAT(b.bounds.min.x, WithinAbs(-10, 1e-3));
  REQUIRE_THAT(b.bounds.max.x, WithinAbs(10, 1e-3));
  REQUIRE_THAT(b.bounds.min.y, WithinAbs(-4, 1e-3));
  REQUIRE_THAT(b.bounds.max.y, WithinAbs(24, 1e-3));
  REQUIRE_THAT(b.bounds.min.z, WithinAbs(-10, 1e-3));
  REQUIRE_THAT(b.bounds.max.z, WithinAbs(10, 1e-3));
  REQUIRE(b.missing.empty());
  const Mesh m = flatten("3001.dat", lib);
  REQUIRE(signedVolume(m) > 0);
  REQUIRE(m.triangles.size() > 300);
  const Mesh hi = flatten("3001.dat", lib, FlattenOptions{.hiResPrimitives = true});
  REQUIRE(hi.triangles.size() > m.triangles.size());
}

TEST_CASE("low-resolution primitives are used where they exist", "[ldraw][flatten][data]") {
  const char* dir = std::getenv("BM_LDRAW_DIR");
  if (!dir) SKIP("BM_LDRAW_DIR is not set");
  const Library lib(dir);
  FlattenOptions low;
  low.lowResPrimitives = true;
  const Mesh full = flatten("3941.dat", lib), coarse = flatten("3941.dat", lib, low);  // a 2x2 round brick
  REQUIRE(coarse.triangles.size() < full.triangles.size());
  REQUIRE_FALSE(coarse.triangles.empty());
  REQUIRE(coarse.missing.empty());
  // Low wins when both are asked for.
  FlattenOptions both = low;
  both.hiResPrimitives = true;
  REQUIRE(flatten("3941.dat", lib, both).triangles.size() == coarse.triangles.size());
  // How far the coarse curves may be: the largest thing replaced on a 2x2 round brick is its
  // round body, radius 20; a plain 2x4 brick's are the tubes underneath, radius 8 (its studs
  // are 6); the full mesh says 0.
  REQUIRE(full.lowError == 0);
  REQUIRE(coarse.lowError == Catch::Approx(kLowResError * 20).margin(0.05));
  REQUIRE(flatten("3001.dat", lib, low).lowError == Catch::Approx(kLowResError * 8).margin(0.02));
}
