#include <catch2/catch_test_macros.hpp>
#include <catch2/matchers/catch_matchers_floating_point.hpp>
#include <map>
#include <string>
#include "bm/plan/staging.h"

using namespace bm::plan::staging;
using Catch::Matchers::WithinAbs;

namespace {
std::vector<Item> sevenItems() {  // as the web check builds them: w 1 + i % 3, d 2 + i % 2, group i % 2
  std::vector<Item> items;
  for (uint32_t i = 0; i < 7; i++) items.push_back({i, "p" + std::to_string(i), static_cast<int>(1 + i % 3), static_cast<int>(2 + i % 2), static_cast<double>(i % 2)});
  return items;
}
using Expected = std::map<uint32_t, std::pair<double, double>>;
void same(const Layout& got, const Expected& want, std::vector<uint32_t> overflow) {
  REQUIRE(got.pos.size() == want.size());
  for (const auto& [id, at] : want) {
    REQUIRE(got.pos.count(id) == 1);
    REQUIRE(got.pos.at(id).x == at.first);
    REQUIRE(got.pos.at(id).z == at.second);
  }
  REQUIRE(got.overflow == overflow);
}
}  // namespace

TEST_CASE("the floor's hash is the web's", "[staging]") {
  // src/anim/floorLayout.ts hash01, run on the same keys
  REQUIRE_THAT(hash01("i0/i7m", 3), WithinAbs(0.41767143132165074, 1e-15));
  REQUIRE_THAT(hash01("p5", 1), WithinAbs(0.9699051475618035, 1e-15));
  REQUIRE_THAT(hash01("abc", 0), WithinAbs(0.08375681564211845, 1e-15));
}

TEST_CASE("the floor is laid out as the web lays it out, in every style", "[staging]") {
  // Expected positions from src/anim/floorLayout.ts layoutFloor on the same items, region 12 x 10.
  const Region region{0, 0, 12, 10, 0};
  const std::vector<Item> items = sevenItems();
  same(layoutFloor(items, region, 1, Style::Packed), {{2, {0, 0}}, {4, {4, 0}}, {0, {7, 0}}, {6, {9, 0}}, {5, {0, 3}}, {1, {4, 3}}, {3, {7, 3}}}, {});
  same(layoutFloor(items, region, 1, Style::Scattered), {{2, {0.5, 0}}, {4, {7, 0.5}}, {0, {12, 0.5}}, {6, {0.5, 6}}, {5, {5, 5.5}}, {1, {11, 6}}}, {3});
  same(layoutFloor(items, region, 1, Style::Fan), {{2, {0, 1}}, {4, {6, 0}}, {0, {11, 1}}}, {6, 5, 1, 3});
  same(layoutFloor(items, region, 1, Style::Grid), {{2, {0, 0}}, {4, {4, 0}}, {0, {9, 0}}, {6, {1, 4}}, {5, {4, 4}}, {1, {8, 4}}}, {3});
  same(layoutFloor(items, region, 1, Style::Rows), {{2, {0, 0}}, {4, {5, 0}}, {0, {9, 0}}, {6, {0, 4}}}, {5, 1, 3});
  same(layoutFloor(items, region, 1, Style::Showcase), {{2, {0, 0}}, {4, {6, 0}}, {0, {11, 0}}, {6, {0, 5}}, {5, {4, 5}}, {1, {10, 5}}}, {3});
}

TEST_CASE("packed pieces never touch, stay inside, and overflow when the floor is full", "[staging]") {
  // As tests/anim/floorLayout.test.ts
  const Region region{0, 0, 30, 10, 0};
  auto items = [](uint32_t n) {
    std::vector<Item> out;
    for (uint32_t i = 0; i < n; i++) out.push_back({i, "p" + std::to_string(i), 2, 4, i < n / 2.0 ? 1.0 : 0.0});
    return out;
  };
  const Layout l = layoutFloor(items(20), region);
  REQUIRE(l.pos.size() + l.overflow.size() == 20);
  REQUIRE(!l.pos.empty());
  for (const auto& [a, pa] : l.pos) {
    REQUIRE(pa.x >= 0);
    REQUIRE(pa.z >= 0);
    REQUIRE(pa.x + 2 <= 30);
    REQUIRE(pa.z + 4 <= 10);
    for (const auto& [b, pb] : l.pos)
      if (a != b) REQUIRE((pa.x + 2 + 1 <= pb.x || pb.x + 2 + 1 <= pa.x || pa.z + 4 + 1 <= pb.z || pb.z + 4 + 1 <= pa.z));
  }
  REQUIRE(!layoutFloor(items(200), region).overflow.empty());
  // Larger footprints first within a group.
  const Layout big = layoutFloor({{0, "small", 1, 1, 0}, {1, "big", 4, 4, 0}}, region);
  REQUIRE(big.pos.at(1).x < big.pos.at(0).x);
}

TEST_CASE("bands lie in front of and behind the model, a margin clear of it", "[staging]") {
  const Footprint model{-100, -60, 100, 60};  // 10 x 6 studs
  const std::vector<Region> bands = bandsAround(model, 0, Sides::FrontBack);
  REQUIRE(bands.size() == 2);
  REQUIRE(bands[0].near == 1);
  REQUIRE(bands[0].z0 + bands[0].depth == -3 - kFloorMargin);  // in front: up to two studs short of the model
  REQUIRE(bands[1].z0 == 3 + kFloorMargin);
  REQUIRE(bandsAround(model, 0, Sides::Around).size() == 4);
  REQUIRE(bandsAround(model, 0, Sides::Sides).size() == 2);
  // Windows: every piece once, in play order, each window fitting.
  std::vector<Item> items;
  for (uint32_t i = 0; i < 60; i++) items.push_back({i, "p" + std::to_string(i), 2, 4, 0});
  const std::vector<Window> windows = windowed(items, bands, Style::Packed, nullptr, 1);
  REQUIRE(windows.size() > 1);
  uint32_t next = 0;
  for (const Window& w : windows)
    for (uint32_t id : w.ids) REQUIRE(id == next++);
  REQUIRE(next == 60);
}
