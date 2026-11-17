#include <catch2/catch_approx.hpp>
#include <catch2/catch_test_macros.hpp>
#include <set>
#include "bmr/scene.h"
#include "helpers.h"

using namespace bm;
using bmtest::piece;
using Catch::Approx;

TEST_CASE("a repeated model has its pieces once per copy, on a grid, with ids of their own", "[bench]") {
  const ldraw::Library lib = bmtest::fixtureLibrary();
  ldraw::PartCache parts{lib, bmtest::cacheDir()};
  const Model m = bmtest::modelFrom(piece("3005.dat", 0, 0, 0, 4) + piece("3001.dat", 50, 0, 0, 0) + piece("nosuch.dat", 0, -24, 0, 4), lib);
  const Box one = m.bounds(parts);
  const Model grid = bmr::repeated(m, parts, 3, 2, 40);
  REQUIRE(grid.pieces().size() == m.pieces().size() * 6);
  std::set<std::string> ids;
  for (const Piece& p : grid.pieces()) ids.insert(p.id);
  REQUIRE(ids.size() == grid.pieces().size());
  // Copies step by the model's width (and depth) plus the gap.
  const Box all = grid.bounds(parts);
  const double w = one.max.x - one.min.x, d = one.max.z - one.min.z;
  REQUIRE(all.max.x - all.min.x == Approx(3 * w + 2 * 40).margin(1e-6));
  REQUIRE(all.max.z - all.min.z == Approx(2 * d + 40).margin(1e-6));
  REQUIRE(all.max.y - all.min.y == Approx(one.max.y - one.min.y).margin(1e-6));
  // The same colours and parts, the same report, and the one-copy grid is the model.
  REQUIRE(grid.pieces()[m.pieces().size() + 1].part == m.pieces()[1].part);
  REQUIRE(grid.report().missing == m.report().missing);
  REQUIRE(bmr::repeated(m, parts, 1, 1, 40).pieces().size() == m.pieces().size());
  REQUIRE(bmr::repeated(m, parts, 0, 4, 40).pieces().empty());
}
