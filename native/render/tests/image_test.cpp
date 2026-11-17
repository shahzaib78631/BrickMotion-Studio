#include <catch2/catch_approx.hpp>
#include <catch2/catch_test_macros.hpp>
#include <filesystem>
#include "bmr/image.h"

TEST_CASE("an image written as a PNG reads back the same", "[image]") {
  bmr::Image img{3, 2, {}};
  img.rgba = {255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 10, 20, 30, 255, 40, 50, 60, 128, 0, 0, 0, 0};
  const auto file = std::filesystem::temp_directory_path() / "bmr_image_test.png";
  REQUIRE(bmr::writePng(img, file));
  const bmr::Image back = bmr::readPng(file);
  REQUIRE(back.width == 3);
  REQUIRE(back.height == 2);
  REQUIRE(back.rgba == img.rgba);  // straight alpha, no premultiplying on the way
  std::filesystem::remove(file);
}

TEST_CASE("an empty image is not written; a missing file reads as empty", "[image]") {
  REQUIRE_FALSE(bmr::writePng({}, std::filesystem::temp_directory_path() / "bmr_none.png"));
  REQUIRE_FALSE(bmr::writePng(bmr::Image{2, 2, {1, 2, 3}}, std::filesystem::temp_directory_path() / "bmr_none.png"));  // too few bytes
  REQUIRE(bmr::readPng("/nonexistent/x.png").empty());
  bmr::Image one{1, 1, {9, 9, 9, 255}};
  REQUIRE_FALSE(bmr::writePng(one, "/nonexistent-directory/x.png"));
  REQUIRE(one.at(0, 0) != nullptr);
  REQUIRE(one.at(1, 0) == nullptr);
  REQUIRE(one.at(0, -1) == nullptr);
}

TEST_CASE("a small wrong patch shows in the worst block, not only the mean", "[image]") {
  bmr::Image a{64, 64, std::vector<uint8_t>(64 * 64 * 4, 100)}, b = a;
  for (int y = 0; y < 16; y++)
    for (int x = 0; x < 16; x++) b.rgba[static_cast<size_t>(y * 64 + x) * 4] = 200;  // one block, red channel
  const auto d = bmr::compare(a, b);
  REQUIRE(d.sameSize);
  REQUIRE(d.meanAbs < 2.0);
  REQUIRE(d.worstBlock == Catch::Approx(25.0));
  REQUIRE_FALSE(bmr::compare(a, bmr::Image{8, 8, std::vector<uint8_t>(256, 0)}).sameSize);
  REQUIRE(bmr::compare(a, a).meanAbs == 0);
  REQUIRE(bmr::compare({}, {}).sameSize);
}
