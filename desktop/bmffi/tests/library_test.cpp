// Library catalog and part preview tests over bmffi.
#include <catch2/catch_test_macros.hpp>
#include <string>
#include "bmffi.h"

TEST_CASE("search finds 3001 first") {
  BmParts* p = bm_library_parts("3001", "", 20);
  REQUIRE(p != nullptr);
  REQUIRE(bm_parts_len(p) >= 1);
  BmPartMatch m = bm_parts_at(p, 0);
  CHECK(std::string(m.name) == "3001.dat");
  CHECK(std::string(m.description).size() > 0);
  bm_parts_free(p);
}

TEST_CASE("categories are listed") {
  BmStrings* s = bm_part_categories();
  REQUIRE(s != nullptr);
  REQUIRE(bm_strings_len(s) > 10);
  bool hasBrick = false;
  for (size_t i = 0; i < bm_strings_len(s); ++i) {
    if (std::string(bm_strings_at(s, i)) == "Brick") hasBrick = true;
  }
  CHECK(hasBrick);
  CHECK(std::string(bm_strings_at(s, bm_strings_len(s) + 5)).empty());
  bm_strings_free(s);
}

TEST_CASE("common parts") {
  BmParts* p = bm_common_parts();
  REQUIRE(p != nullptr);
  CHECK(bm_parts_len(p) > 0);
  bm_parts_free(p);
}

TEST_CASE("preview renders a square and unknown part renders nothing") {
  BmPartPreview* pv = bm_part_preview_new();
  if (!bm_metal_available()) {
    CHECK(pv == nullptr);
    return;
  }
  REQUIRE(pv != nullptr);

  BmPicture* pic = bm_part_preview_render(pv, "3001.dat", 4, true);
  REQUIRE(pic != nullptr);
  int w = 0, h = 0;
  bm_picture_info(pic, &w, &h);
  CHECK(w > 0);
  CHECK(w == h);
  const uint8_t* rgba = bm_picture_rgba(pic);
  REQUIRE(rgba != nullptr);
  size_t centre = (static_cast<size_t>(h / 2) * static_cast<size_t>(w) + static_cast<size_t>(w / 2)) * 4;
  CHECK(rgba[centre + 3] > 0);
  bm_picture_free(pic);

  BmPicture* empty = bm_part_preview_render(pv, "no-such-part-999999.dat", 4, true);
  if (empty) {
    int ew = -1, eh = -1;
    bm_picture_info(empty, &ew, &eh);
    CHECK(ew == 0);
    bm_picture_free(empty);
  }

  bm_part_preview_free(pv);
}

TEST_CASE("library struct size") {
  CHECK(bm_struct_size("BmPartMatch") == sizeof(BmPartMatch));
}
