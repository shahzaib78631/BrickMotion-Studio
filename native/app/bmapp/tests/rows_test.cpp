// What the panes list: the outline of models and uses, the steps and their items, colours.
#include <catch2/catch_test_macros.hpp>
#include <chrono>
#include <cstdlib>
#include <set>
#include "structure_fixture.h"

using namespace structure;

namespace {
fs::path helicopter() { return fs::path(BM_REPO) / "samples" / "helicopter" / "helicopter.mpd"; }

template <typename F>
double bestMs(F f) {
  double best = 1e9;
  for (int i = 0; i < 3; i++) {
    const auto t0 = std::chrono::steady_clock::now();
    f();
    best = std::min(best, std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - t0).count());
  }
  return best;
}
}  // namespace

TEST_CASE("outline lists uses with stable ids", "[bmapp][rows]") {
  bmapp::Session s;
  REQUIRE(s.open(helicopter().string()).ok);
  const std::vector<bmapp::OutlineRow> rows = s.outline();
  REQUIRE(!rows.empty());
  CHECK(rows[0].id == "root");
  CHECK(rows[0].depth == 0);
  CHECK(rows[0].parent == -1);
  CHECK(rows[0].pieces == s.pieceCount());
  size_t underRoot = 0;
  for (size_t i = 1; i < rows.size(); i++) {
    if (rows[i].unused) continue;
    CHECK(rows[i].parent >= 0);
    CHECK(rows[i].parent < static_cast<int>(i));
    CHECK(rows[rows[i].parent].depth == rows[i].depth - 1);
    if (rows[i].depth == 1) underRoot += rows[i].pieces;
  }
  size_t loose = 0;
  for (uint32_t p = 0; p < s.pieceCount(); p++) loose += s.impl().refs[p].chain.size() == 1;
  CHECK(underRoot + loose == s.pieceCount());
  // A row's pieces are the pieces under that use.
  for (const bmapp::OutlineRow& r : rows)
    if (r.depth == 1) {
      CHECK(s.piecesOfRow(r.id).size() == r.pieces);
      break;
    }
  CHECK(s.piecesOfRow("root").size() == s.pieceCount());
  // A move keeps every id; Make Submodel keeps the ids of rows it did not touch.
  std::vector<std::string> ids;
  for (const auto& r : rows) ids.push_back(r.id);
  const uint64_t stamp = s.structureVersion();
  s.move({0}, {20, 0, 0}, false);
  CHECK(s.structureVersion() == stamp);
  std::vector<std::string> after;
  for (const auto& r : s.outline()) after.push_back(r.id);
  CHECK(after == ids);
  std::vector<uint32_t> loosePieces;
  for (uint32_t p = 0; p < s.pieceCount() && loosePieces.size() < 2; p++)
    if (s.impl().refs[p].chain.size() == 1) loosePieces.push_back(p);
  if (loosePieces.size() == 2) {
    s.makeSubmodel(loosePieces, "Made");
    CHECK(s.structureVersion() != stamp);
    std::set<std::string> now;
    for (const auto& r : s.outline()) now.insert(r.id);
    for (const std::string& id : ids) CHECK(now.count(id));
  }
}

TEST_CASE("shared and unused submodels are marked", "[bmapp][rows]") {
  bmapp::Session s;
  REQUIRE(s.open(fixture().string()).ok);
  s.newSubmodel("Spare");
  const auto rows = s.outline();
  REQUIRE(rows.size() == 4);  // root, two uses of Pair, Spare
  CHECK(rows[1].name == "Pair");
  CHECK(rows[1].shared);
  CHECK(rows[1].uses == 2);
  CHECK(rows[1].pieces == 2);
  CHECK(rows[1].useItem != 0);
  CHECK(rows[2].id != rows[1].id);
  CHECK(rows[3].name == "Spare");
  CHECK(rows[3].unused);
  CHECK(rows[3].id == "unused/Spare");
  CHECK(rows[3].depth == 0);
  CHECK(s.piecesOfRow(rows[3].id).empty());
  // Focused on Pair, a use row of Pair holds Pair's pieces, and the root row none.
  s.focus({"Pair"});
  CHECK(s.piecesOfRow(rows[1].id).size() == 2);
  CHECK(s.piecesOfRow("root").empty());
}

TEST_CASE("steps and items match the file", "[bmapp][rows]") {
  bmapp::Session s;
  REQUIRE(s.open(fixture().string()).ok);
  const auto steps = s.steps();
  REQUIRE(steps.size() == 2);
  CHECK(steps[0].title == "First");
  CHECK(steps[0].notes == "one");
  CHECK(steps[0].items == 2);
  CHECK(steps[0].pieces == 2);
  CHECK(steps[1].pauseAfter == 2);
  CHECK(steps[1].items == 3);
  CHECK(steps[1].pieces == 5);
  const auto items = s.stepItems(1);
  REQUIRE(items.size() == 3);
  CHECK(items[0].submodel);
  CHECK(items[0].name == "Pair");
  CHECK(items[0].pieces.size() == 2);
  CHECK(items[2].name == "3001.dat");
  CHECK(items[2].colorName == "Yellow");
  CHECK_FALSE(items[2].description.empty());
  CHECK(items[2].pieces == pieces(s, "c"));
  CHECK(s.piecesOfStep(0).size() == 2);
  CHECK(s.piecesOfStep(1).size() == 5);
}

TEST_CASE("select similar", "[bmapp][rows]") {
  bmapp::Session s;
  REQUIRE(s.open(fixture().string()).ok);
  const uint32_t a = pieces(s, "a")[0];  // red 3001
  s.select({a}, bmapp::SelectMode::Replace);
  s.selectSimilar(bmapp::Similar::Part);
  CHECK(s.selection().size() == 5);  // a, b, c and p1 in both uses
  s.select({a}, bmapp::SelectMode::Replace);
  s.selectSimilar(bmapp::Similar::Color);
  CHECK(s.selection() == std::vector<uint32_t>{a});
  s.select({pieces(s, "c")[0]}, bmapp::SelectMode::Replace);
  s.selectSimilar(bmapp::Similar::PartAndColor);
  CHECK(s.selection() == pieces(s, "c"));
  s.select({a}, bmapp::SelectMode::Replace);
  s.selectSimilar(bmapp::Similar::Step);
  CHECK(s.selection().size() == 2);
  s.hide(pieces(s, "b"));
  s.select({a}, bmapp::SelectMode::Replace);
  s.selectSimilar(bmapp::Similar::Step);
  CHECK(s.selection() == std::vector<uint32_t>{a});  // hidden pieces are left out
}

TEST_CASE("colors are grouped", "[bmapp][rows]") {
  bmapp::Session s;
  REQUIRE(s.open(fixture().string()).ok);
  const auto colors = s.colors();
  REQUIRE(colors.size() > 50);
  auto find = [&](int code) {
    for (const auto& c : colors)
      if (c.code == code) return c;
    bmapp::ColorInfo none;
    none.code = -1;
    return none;
  };
  CHECK(find(4).name == "Red");
  CHECK(find(4).group == 0);
  CHECK(find(36).group == 1);
  CHECK(find(383).group == 2);
  CHECK(find(16).code == -1);
  CHECK(find(24).code == -1);
  for (size_t i = 1; i < colors.size(); i++)
    CHECK(std::make_pair(colors[i - 1].group, colors[i - 1].code) < std::make_pair(colors[i].group, colors[i].code));
}

TEST_CASE("rows are fast on 10030 x4 and a move keeps the structure stamp", "[bmapp][rows][.slow]") {
  const fs::path repo(BM_REPO);
  const fs::path bmshot = repo / "native" / "build" / "render" / "bmshot";
  const fs::path source = repo / "public" / "data" / "omr" / "10030-1" / "10030-1.mpd";
  if (!fs::exists(bmshot) || !fs::exists(source)) SKIP("needs native/build's bmshot and the 10030-1 model");
  const fs::path dir = fs::temp_directory_path() / "bmapp_rows_big";
  fs::create_directories(dir);
  const fs::path big = dir / "10030-x4.ldr";
  if (!fs::exists(big)) {
    const std::string cmd = "'" + bmshot.string() + "' '" + source.string() + "' --out '" + (dir / "x4.png").string() +
                            "' --size 64x64 --repeat 2x2 --save-model '" + big.string() + "' > /dev/null";
    REQUIRE(std::system(cmd.c_str()) == 0);
  }
  bmapp::Session s;
  REQUIRE(s.open(big.string()).ok);
  REQUIRE(s.pieceCount() > 12000);
  // Cached rows are free; what counts is making them after a structural change.
  const double outline = bestMs([&] { s.insertStep(0), s.undo(), (void)s.outline(); });
  const double steps = bestMs([&] { s.insertStep(0), s.undo(), (void)s.steps(); });
  const double edit = bestMs([&] { s.insertStep(0), s.undo(); });
  WARN("outline " << (outline - edit) << " ms, steps " << (steps - edit) << " ms (each after an edit of " << edit << " ms)");
  CHECK(outline - edit <= 50);
  CHECK(steps - edit <= 50);
  const uint64_t stamp = s.structureVersion();
  s.move({0}, {20, 0, 0}, false);
  CHECK(s.structureVersion() == stamp);
}
