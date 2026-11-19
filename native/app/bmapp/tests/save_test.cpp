#include <catch2/catch_test_macros.hpp>
#include <filesystem>
#include <fstream>
#include <set>
#include <sstream>
#include <nlohmann/json.hpp>
#include "bm/doc/source.h"
#include "bm/io.h"
#include "bmapp/session.h"
#include "bmapp/viewport.h"
#include "session_impl.h"

namespace fs = std::filesystem;

namespace {
fs::path police() { return fs::path(BM_REPO) / "tests" / "fixtures" / "models" / "police-car.brickmotion"; }
std::string text(const fs::path& p) {
  std::ifstream f(p, std::ios::binary);
  std::stringstream s;
  s << f.rdbuf();
  return s.str();
}
nlohmann::ordered_json planOf(const bmapp::Session& s) { return bm::doc::toPlan(s.impl().source).json; }
}  // namespace

TEST_CASE("save then reopen is the same document", "[bmapp][save]") {
  bmapp::Session s;
  REQUIRE(s.open(police().string()).ok);
  CHECK_FALSE(s.imported());
  s.move({0}, {20, 0, 0}, false);
  s.remove({3});
  const std::string bytes = s.projectBytes();
  bmapp::Session t;
  const bmapp::OpenResult r = t.openBytes(bytes, "police-car.brickmotion");
  REQUIRE(r.ok);
  CHECK(planOf(t) == planOf(s));
  CHECK(t.pieceCount() == s.pieceCount());
  CHECK(t.title() == "police-car");
  CHECK_FALSE(t.imported());
  const auto json = nlohmann::ordered_json::parse(bytes);
  CHECK_FALSE(json.contains("timelines"));  // edited: the web plans again
  CHECK(json["format"] == nlohmann::ordered_json::parse(text(police()))["format"]);
}

TEST_CASE("an unedited save keeps the web's timelines", "[bmapp][save]") {
  bmapp::Session s;
  REQUIRE(s.open(police().string()).ok);
  CHECK(nlohmann::ordered_json::parse(s.projectBytes()).contains("timelines"));
  s.move({0}, {20, 0, 0}, false);
  s.markSaved();  // saved edited: that file has no timelines, and neither has the next save
  CHECK_FALSE(nlohmann::ordered_json::parse(s.projectBytes()).contains("timelines"));
}

TEST_CASE("reopening resets the log", "[bmapp][save]") {
  bmapp::Session s;
  REQUIRE(s.open(police().string()).ok);
  s.move({0}, {20, 0, 0}, false);
  s.select({1, 2}, bmapp::SelectMode::Replace);
  s.hide({4});
  const uint64_t generation = s.generation();
  REQUIRE(s.openBytes(s.projectBytes(), police().string()).ok);
  CHECK_FALSE(s.canUndo());
  CHECK(s.selection().empty());
  CHECK(s.hidden().empty());
  CHECK_FALSE(s.dirty());
  CHECK(s.generation() != generation);
  CHECK_FALSE(s.openBytes("{not json", "bad.brickmotion").ok);
  CHECK(s.pieceCount() > 0);  // a failed open leaves the document as it was
}

TEST_CASE("an LDraw import saved as a project keeps its colours", "[bmapp][save]") {
  const fs::path p = fs::temp_directory_path() / "bmapp_inherit.mpd";
  std::ofstream(p) << "0 FILE main.ldr\n"
                      "1 4 0 0 0 1 0 0 0 1 0 0 0 1 sub.ldr\n"
                      "1 16 0 -24 0 1 0 0 0 1 0 0 0 1 3001.dat\n"
                      "0 FILE sub.ldr\n"
                      "1 16 0 0 0 1 0 0 0 1 0 0 0 1 3001.dat\n"
                      "1 1 40 0 0 1 0 0 0 1 0 0 0 1 3001.dat\n";
  bmapp::Session s;
  REQUIRE(s.open(p.string()).ok);
  std::multiset<int> before;
  // A 16 part in the root has no holder: LDraw's main colour, which a plan shows as its default.
  for (const auto& piece : s.impl().model->pieces()) before.insert(piece.color == 16 ? bm::doc::kPlanDefaultColor : piece.color);
  bmapp::Session t;
  REQUIRE(t.openBytes(s.projectBytes(), "inherit.brickmotion").ok);
  std::multiset<int> after;
  for (const auto& piece : t.impl().model->pieces()) after.insert(piece.color);
  CHECK(after == before);
  // The source file is not touched by saving elsewhere.
  CHECK(text(p).find("1 16 0 0 0") != std::string::npos);
}

TEST_CASE("export LDraw writes an MPD that opens to the same pieces", "[bmapp][save]") {
  bmapp::Session s;
  REQUIRE(s.open(police().string()).ok);
  s.move({0}, {20, 0, 0}, false);
  const std::string mpd = s.mpdBytes();
  REQUIRE(mpd.rfind("0 FILE ", 0) == 0);
  const fs::path out = fs::temp_directory_path() / "bmapp_export.mpd";
  std::ofstream(out, std::ios::binary) << mpd;
  bmapp::Session t;
  REQUIRE(t.open(out.string()).ok);
  CHECK(t.pieceCount() == s.pieceCount());
  t.select({0}, bmapp::SelectMode::Replace);
  s.select({0}, bmapp::SelectMode::Replace);
  CHECK(t.snapshot().selected[0].position.x == s.snapshot().selected[0].position.x);
}

TEST_CASE("a viewport follows its session into a reopened document", "[bmapp][save]") {
  bmapp::Session s;
  REQUIRE(s.open(police().string()).ok);
  bmapp::Viewport v(s);
  if (!v.ok()) SKIP("no Metal device");
  v.resize(320, 240, 1);
  v.draw(nullptr);
  const fs::path one = fs::temp_directory_path() / "bmapp_one.ldr";
  std::ofstream(one) << "1 4 0 0 0 1 0 0 0 1 0 0 0 1 3001.dat\n";
  REQUIRE(s.open(one.string()).ok);
  v.fitAll();
  v.draw(nullptr);
  std::set<uint32_t> seen;
  for (int y = 0; y < 240; y += 3)
    for (int x = 0; x < 320; x += 3)
      if (const uint32_t p = v.pick(x, y); p != UINT32_MAX) seen.insert(p);
  CHECK(seen == std::set<uint32_t>{0});
  CHECK(v.planState() == bmapp::PlanState::Idle);
}
