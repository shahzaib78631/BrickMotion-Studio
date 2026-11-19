#include <catch2/catch_test_macros.hpp>
#include "bmapp/keys.h"

namespace {
constexpr double kPi = 3.14159265358979323846;
bool same(bmapp::Vec3 a, bmapp::Vec3 b) { return a.x == b.x && a.y == b.y && a.z == b.z; }
bmapp::Vec3 axis(double yawDegrees, bmapp::Arrow arrow) {
  bmapp::CameraState c;
  c.yaw = yawDegrees * kPi / 180, c.pitch = 0.4;
  return bmapp::arrowAxis(c, arrow);
}
}  // namespace

TEST_CASE("arrowAxis follows the camera", "[bmapp][keys]") {
  using bmapp::Arrow;
  const bmapp::Vec3 px{1, 0, 0}, nx{-1, 0, 0}, pz{0, 0, 1}, nz{0, 0, -1};
  // From the front (the eye on -z): right is +x, up the screen is away, +z.
  CHECK(same(axis(0, Arrow::Right), px));
  CHECK(same(axis(0, Arrow::Left), nx));
  CHECK(same(axis(0, Arrow::Up), pz));
  CHECK(same(axis(0, Arrow::Down), nz));
  CHECK(same(axis(90, Arrow::Right), nz));
  CHECK(same(axis(90, Arrow::Up), px));
  CHECK(same(axis(180, Arrow::Right), nx));
  CHECK(same(axis(180, Arrow::Up), nz));
  CHECK(same(axis(270, Arrow::Right), pz));
  CHECK(same(axis(270, Arrow::Down), px));
  CHECK(same(axis(-90, Arrow::Right), pz));  // the Right view preset
  // Halfway: a tie, which goes to x.
  CHECK(same(axis(45, Arrow::Right), px));
  CHECK(same(axis(45, Arrow::Up), px));
  CHECK(same(axis(45, Arrow::Left), nx));
  CHECK(same(axis(45, Arrow::Down), nx));
  CHECK(bmapp::kStud == 20);
  CHECK(bmapp::kPlate == 8);
  CHECK(bmapp::kBrick == 24);
}

#include <filesystem>
#include <fstream>
#include "bmapp/session.h"

namespace {
std::filesystem::path twoUses() {
  const auto p = std::filesystem::temp_directory_path() / "bmapp_uses.mpd";
  std::ofstream f(p);
  f << "0 FILE main.ldr\n"
       "1 16 0 0 0 1 0 0 0 1 0 0 0 1 sub.ldr\n"
       "1 16 200 0 0 1 0 0 0 1 0 0 0 1 sub.ldr\n"
       "1 4 0 0 200 1 0 0 0 1 0 0 0 1 3001.dat\n"
       "0 FILE sub.ldr\n"
       "1 1 0 0 0 1 0 0 0 1 0 0 0 1 3001.dat\n"
       "1 2 0 -24 0 1 0 0 0 1 0 0 0 1 3001.dat\n";
  return p;
}
}  // namespace

TEST_CASE("a double-click takes the whole use", "[bmapp][keys]") {
  bmapp::Session s;
  REQUIRE(s.open(twoUses().string()).ok);
  REQUIRE(s.pieceCount() == 5);
  CHECK(s.usePieces(2) == std::vector<uint32_t>{2, 3});
  CHECK(s.usePieces(4) == std::vector<uint32_t>{4});
  s.select({0}, bmapp::SelectMode::Replace);
  const bmapp::Snapshot snap = s.snapshot();
  REQUIRE(snap.selected.size() == 1);
  CHECK(snap.selected[0].submodelPath == "sub.ldr");
  CHECK(snap.selected[0].inSharedSubmodel);
  s.select({4}, bmapp::SelectMode::Replace);
  CHECK_FALSE(s.snapshot().selected[0].inSharedSubmodel);
}

TEST_CASE("duplicate and paste select what they made; undo depth counts steps", "[bmapp][keys]") {
  bmapp::Session s;
  REQUIRE(s.open(twoUses().string()).ok);
  CHECK(s.undoDepth() == 0);
  s.select({4}, bmapp::SelectMode::Replace);
  s.duplicate({4}, {20, 0, 0});
  CHECK(s.pieceCount() == 6);
  REQUIRE(s.selection().size() == 1);
  CHECK(s.selection()[0] != 4);
  CHECK(s.undoDepth() == 1);
  s.move(s.selection(), {20, 0, 0}, true);
  s.move(s.selection(), {20, 0, 0}, true);  // one drag: one step
  CHECK(s.undoDepth() == 2);
  s.endGesture();
  const std::string text = s.copy({4});
  s.paste(text, {0, 0, 0});
  CHECK(s.pieceCount() == 7);
  CHECK(s.selection().size() == 1);
  CHECK(s.undoDepth() == 3);
  s.undo();
  CHECK(s.undoDepth() == 2);
}

TEST_CASE("parts are found by name and description", "[bmapp][keys]") {
  bmapp::Session s;
  REQUIRE(s.open(twoUses().string()).ok);
  const std::vector<bmapp::PartMatch> found = s.searchParts("brick 2 x 4", 50);
  REQUIRE_FALSE(found.empty());
  bool has3001 = false;
  for (const auto& m : found) {
    if (m.name == "3001.dat") has3001 = true;
    CHECK(m.description.find('~') != 0);  // moved and obsolete parts are left out
  }
  CHECK(has3001);
  CHECK(s.searchParts("3001", 5).front().name == "3001.dat");  // an exact name first
  CHECK(s.searchParts("", 5).empty());
}
