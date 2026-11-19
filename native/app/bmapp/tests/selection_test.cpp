#include <catch2/catch_test_macros.hpp>
#include <filesystem>
#include <fstream>
#include <set>
#include "bmapp/session.h"
#include "bmapp/viewport.h"

namespace fs = std::filesystem;

namespace {
/// Four 2x4 bricks, apart, seen from the top: pieces 0 1 on the near row, 2 3 behind.
fs::path grid() {
  const fs::path p = fs::temp_directory_path() / "bmapp_grid.ldr";
  std::ofstream f(p);
  f << "0 Grid\n"
       "1 4 0 0 0 1 0 0 0 1 0 0 0 1 3001.dat\n"
       "1 1 120 0 0 1 0 0 0 1 0 0 0 1 3001.dat\n"
       "1 2 0 0 160 1 0 0 0 1 0 0 0 1 3001.dat\n"
       "1 14 120 0 160 1 0 0 0 1 0 0 0 1 3001.dat\n";
  return p;
}

struct Rect {
  double x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
};

/// Where each piece shows, found by picking every second point.
std::vector<Rect> shown(bmapp::Viewport& v, int w, int h, std::set<uint32_t>* seen = nullptr) {
  std::vector<Rect> out(4);
  for (int y = 0; y < h; y += 2)
    for (int x = 0; x < w; x += 2) {
      const uint32_t p = v.pick(x, y);
      if (p == UINT32_MAX) continue;
      if (seen) seen->insert(p);
      if (p >= out.size()) continue;
      Rect& r = out[p];
      r.x0 = std::min(r.x0, double(x)), r.y0 = std::min(r.y0, double(y)), r.x1 = std::max(r.x1, double(x)), r.y1 = std::max(r.y1, double(y));
    }
  return out;
}

struct Rig {
  bmapp::Session session;
  std::unique_ptr<bmapp::Viewport> view;
  static constexpr int W = 320, H = 240;
  Rig() {
    REQUIRE(session.open(grid().string()).ok);
    view = std::make_unique<bmapp::Viewport>(session);
    if (!view->ok()) return;
    view->resize(W, H, 1);
    view->view(bmapp::ViewPreset::Top);
    view->draw(nullptr);
  }
};
}  // namespace

TEST_CASE("marquee wholly inside", "[bmapp][selection]") {
  Rig rig;
  if (!rig.view->ok()) SKIP("no Metal device");
  const std::vector<Rect> at = shown(*rig.view, Rig::W, Rig::H);
  const Rect& r = at[0];
  REQUIRE(r.x1 > r.x0);
  CHECK(rig.view->marquee(r.x0 - 6, r.y0 - 6, r.x1 + 6, r.y1 + 6, false) == std::vector<uint32_t>{0});
  CHECK(rig.view->marquee(r.x1 + 6, r.y1 + 6, r.x0 - 6, r.y0 - 6, false) == std::vector<uint32_t>{0});  // dragged either way
}

TEST_CASE("touching returns neighbours too", "[bmapp][selection]") {
  Rig rig;
  if (!rig.view->ok()) SKIP("no Metal device");
  const std::vector<Rect> at = shown(*rig.view, Rig::W, Rig::H);
  // From the middle of piece 0 to the middle of piece 1: touches both, holds neither.
  const double x0 = (at[0].x0 + at[0].x1) / 2, y0 = (at[0].y0 + at[0].y1) / 2, x1 = (at[1].x0 + at[1].x1) / 2, y1 = (at[1].y0 + at[1].y1) / 2;
  CHECK(rig.view->marquee(x0, y0 - 2, x1, y1 + 2, true) == std::vector<uint32_t>{0, 1});
  CHECK(rig.view->marquee(x0, y0 - 2, x1, y1 + 2, false).empty());
}

TEST_CASE("hidden pieces are neither drawn nor picked", "[bmapp][selection]") {
  Rig rig;
  if (!rig.view->ok()) SKIP("no Metal device");
  rig.session.hide({0});
  rig.view->draw(nullptr);
  std::set<uint32_t> seen;
  shown(*rig.view, Rig::W, Rig::H, &seen);
  CHECK(seen == std::set<uint32_t>{1, 2, 3});
  CHECK(rig.view->marquee(0, 0, Rig::W, Rig::H, false) == std::vector<uint32_t>{1, 2, 3});
  CHECK(rig.session.snapshot().hidden == 1);
  rig.session.showAll();
  rig.view->draw(nullptr);
  seen.clear();
  shown(*rig.view, Rig::W, Rig::H, &seen);
  CHECK(seen == std::set<uint32_t>{0, 1, 2, 3});
}

TEST_CASE("user-hidden pieces stay hidden through playback and rest", "[bmapp][selection]") {
  Rig rig;
  if (!rig.view->ok()) SKIP("no Metal device");
  rig.session.hide({3});
  rig.view->play(true);
  for (int i = 0; i < 3000 && rig.view->planState() != bmapp::PlanState::Ready; i++) rig.view->draw(nullptr);
  REQUIRE(rig.view->planState() == bmapp::PlanState::Ready);
  rig.view->seek(rig.view->length() / 2);
  rig.view->draw(nullptr);
  std::set<uint32_t> seen;
  shown(*rig.view, Rig::W, Rig::H, &seen);
  CHECK_FALSE(seen.count(3));
  rig.view->seek(rig.view->length());
  rig.view->draw(nullptr);
  seen.clear();
  shown(*rig.view, Rig::W, Rig::H, &seen);
  CHECK_FALSE(seen.count(3));
  CHECK(seen.count(0));
}

TEST_CASE("selection is remapped after delete", "[bmapp][selection]") {
  bmapp::Session s;
  REQUIRE(s.open(grid().string()).ok);
  s.select({3}, bmapp::SelectMode::Replace);
  s.remove({0});
  CHECK(s.snapshot().selection == std::vector<uint32_t>{2});
  s.select({0, 1}, bmapp::SelectMode::Add);
  CHECK(s.snapshot().selection == std::vector<uint32_t>{0, 1, 2});
  s.select({1}, bmapp::SelectMode::Toggle);
  CHECK(s.snapshot().selection == std::vector<uint32_t>{0, 2});
  s.remove({0});  // a selected piece deleted is dropped
  CHECK(s.snapshot().selection == std::vector<uint32_t>{1});
  s.undo();
  s.selectAll();
  CHECK(s.snapshot().selection.size() == 3);
  s.selectNone();
  CHECK(s.snapshot().selection.empty());
}

TEST_CASE("snapshot version changes on every command and not on a redraw", "[bmapp][selection]") {
  Rig rig;
  bmapp::Session& s = rig.session;
  const bmapp::Snapshot a = s.snapshot();
  CHECK(a.pieces == 4);
  CHECK_FALSE(a.dirty);
  if (rig.view->ok()) rig.view->draw(nullptr);
  CHECK(s.snapshot().version == a.version);
  s.move({1}, {20, 0, 0}, false);
  const bmapp::Snapshot b = s.snapshot();
  CHECK(b.version != a.version);
  CHECK(b.undoName == "Move Piece");
  CHECK(b.dirty);
  s.select({1}, bmapp::SelectMode::Replace);
  const bmapp::Snapshot c = s.snapshot();
  REQUIRE(c.selected.size() == 1);
  CHECK(c.selected[0].part == "3001.dat");
  CHECK(c.selected[0].color == 1);
  CHECK_FALSE(c.selected[0].colorName.empty());
  CHECK(c.selected[0].position.x == 140);
  CHECK_FALSE(c.selected[0].inSharedSubmodel);
  s.recolor({1}, 4);
  CHECK(s.snapshot().version != c.version);
}

TEST_CASE("the viewport draws what an edit left", "[bmapp][selection]") {
  Rig rig;
  if (!rig.view->ok()) SKIP("no Metal device");
  rig.session.select({3}, bmapp::SelectMode::Replace);
  rig.session.remove({0});
  rig.view->draw(nullptr);
  std::set<uint32_t> seen;
  const std::vector<Rect> at = shown(*rig.view, Rig::W, Rig::H, &seen);
  CHECK(seen == std::set<uint32_t>{0, 1, 2});
  rig.session.move({2}, {0, 0, -400}, false);  // far off: drawn somewhere else now
  rig.view->draw(nullptr);
  const std::vector<Rect> after = shown(*rig.view, Rig::W, Rig::H);
  CHECK((after[2].x0 != at[2].x0 || after[2].y0 != at[2].y0));
}
