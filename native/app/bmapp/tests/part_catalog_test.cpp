#include <catch2/catch_test_macros.hpp>
#include <algorithm>
#include "bmapp/part_catalog.h"
#include "bmapp/session.h"

TEST_CASE("the parts catalogue browses independently of a document", "[bmapp][parts]") {
  const auto directory = bmapp::Session::ldrawDirectory();
  REQUIRE_FALSE(directory.empty());
  const auto categories = bmapp::partCategories(directory);
  CHECK(std::is_sorted(categories.begin(), categories.end()));
  CHECK(categories.size() <= 60);
  CHECK(std::find(categories.begin(), categories.end(), "Bricks") != categories.end());
  CHECK(std::find(categories.begin(), categories.end(), "Plates") != categories.end());
  const auto common = bmapp::commonParts(directory);
  REQUIRE_FALSE(common.empty());
  CHECK(common.front().name == "3001.dat");
  CHECK(common.front().category == "Bricks");
  const auto exact = bmapp::libraryParts(directory, "  3001.DAT  ", "", 2);
  REQUIRE_FALSE(exact.empty());
  CHECK(exact.front().name == "3001.dat");
  CHECK(bmapp::libraryParts(directory, "3001.dat", "Plates", 2).empty());
  const auto plates = bmapp::libraryParts(directory, "", "Plates", 10);
  REQUIRE(plates.size() == 10);
  CHECK(std::all_of(plates.begin(), plates.end(), [](const auto& p) { return p.category == "Plates"; }));
  const auto fallback = bmapp::libraryParts(directory, "6141.dat", "", 1);
  REQUIRE_FALSE(fallback.empty());
  CHECK(fallback.front().category == "Plates Round Curved and Dishes");
  const auto decorated = bmapp::libraryParts(directory, "3001pb028", "", 1);
  REQUIRE_FALSE(decorated.empty());
  CHECK(decorated.front().description.starts_with("Brick 2 x 4 with 6 White Circles"));
  CHECK(decorated.front().category == "Brick");
  CHECK(bmapp::libraryParts(directory, "", "", 0).empty());
  CHECK(bmapp::partCategories("").empty());
}
