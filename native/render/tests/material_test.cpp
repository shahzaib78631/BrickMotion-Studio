#include <catch2/catch_approx.hpp>
#include <catch2/catch_test_macros.hpp>
#include <cmath>
#include "bmr/material.h"

using namespace bmr;
using bm::ldraw::Color;
using bm::ldraw::Finish;

TEST_CASE("sRGB becomes linear by the sRGB curve", "[material]") {
  Color c;
  c.rgb = 0x808080;
  REQUIRE(materialFor(c).base[0] == Catch::Approx(0.21586).margin(1e-4));
  c.rgb = 0x000000;
  REQUIRE(materialFor(c).base[1] == 0.0f);
  c.rgb = 0xFFFFFF;
  REQUIRE(materialFor(c).base[2] == Catch::Approx(1.0f));
  c.rgb = 0xFF8000;
  c.edge = 0x0000FF;
  const Material m = materialFor(c);
  REQUIRE(m.base[0] == Catch::Approx(1.0f));
  REQUIRE(m.base[1] == Catch::Approx(0.21586).margin(1e-4));
  REQUIRE(m.base[2] == 0.0f);
  REQUIRE(m.edge[2] == Catch::Approx(1.0f));
  REQUIRE(m.edge[0] == 0.0f);
  REQUIRE(linearFromSrgb(10) == Catch::Approx(10 / 255.0 / 12.92));  // the straight part of the curve
  REQUIRE(linearFromSrgb(999) == Catch::Approx(1.0f));
}

TEST_CASE("each finish has its own surface; alpha below one is transparent", "[material]") {
  struct Want {
    Finish finish;
    float roughness, metalness, clearcoat;
  };
  for (const Want& w : {Want{Finish::Solid, 0.38f, 0.0f, 0.35f}, Want{Finish::Trans, 0.05f, 0.0f, 0.35f}, Want{Finish::Chrome, 0.08f, 1.0f, 0.35f}, Want{Finish::Metal, 0.20f, 0.7f, 0.35f},
                        Want{Finish::Pearl, 0.10f, 0.5f, 0.35f}, Want{Finish::Rubber, 0.86f, 0.0f, 0.0f}}) {
    Color c;
    c.finish = w.finish;
    const Material m = materialFor(c);
    REQUIRE(m.roughness == w.roughness);
    REQUIRE(m.metalness == w.metalness);
    REQUIRE(m.clearcoat == w.clearcoat);
    REQUIRE_FALSE(m.transparent());
  }
  Color glass;
  glass.finish = Finish::Trans;
  glass.alpha = 0.5f;
  REQUIRE(materialFor(glass).transparent());
  glass.alpha = 7;
  REQUIRE(materialFor(glass).alpha == 1.0f);
  glass.alpha = std::nanf("");
  REQUIRE(materialFor(glass).alpha == 1.0f);
  const Material missing = placeholderMaterial();
  REQUIRE(missing.transparent());
  REQUIRE(missing.alpha == Catch::Approx(0.6f));
  REQUIRE(missing.roughness == Catch::Approx(0.6f));
}
