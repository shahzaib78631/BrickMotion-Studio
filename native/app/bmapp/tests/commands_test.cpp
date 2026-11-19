#include <catch2/catch_test_macros.hpp>
#include <chrono>
#include <cmath>
#include <filesystem>
#include <fstream>
#include <thread>
#include "bm/doc/source.h"
#include "bmapp/session.h"
#include "bmapp/viewport.h"
#include "session_impl.h"

namespace fs = std::filesystem;
using bmapp::Vec3;

namespace {
fs::path tower() { return fs::path(BM_FIXTURES) / "models" / "tower.plan.json"; }

/// A wheel (a 2x4 brick with a 2x2 on top) used four times: plain, moved, mirrored, turned.
fs::path wheels() {
  const fs::path p = fs::temp_directory_path() / "bmapp_wheels.mpd";
  std::ofstream f(p);
  f << "0 FILE main.ldr\n0 Wheels\n"
       "1 16 0 0 0 1 0 0 0 1 0 0 0 1 wheel.ldr\n"
       "1 16 100 0 0 1 0 0 0 1 0 0 0 1 wheel.ldr\n"
       "1 16 0 0 100 -1 0 0 0 1 0 0 0 1 wheel.ldr\n"
       "1 16 100 0 100 0 0 1 0 1 0 -1 0 0 wheel.ldr\n"
       "0 FILE wheel.ldr\n0 Wheel\n"
       "1 4 0 0 0 1 0 0 0 1 0 0 0 1 3001.dat\n"
       "1 1 0 -24 0 1 0 0 0 1 0 0 0 1 3003.dat\n";
  return p;
}

std::string planText(const bmapp::Session& s) { return bm::doc::toPlan(s.impl().source).json.dump(); }
const std::vector<bm::Piece>& pieces(const bmapp::Session& s) { return s.impl().model->pieces(); }
std::vector<bm::Xform> worlds(const bmapp::Session& s) {
  std::vector<bm::Xform> out;
  for (const bm::Piece& p : pieces(s)) out.push_back(p.world);
  return out;
}
bool same(const bm::Xform& a, const bm::Xform& b) {
  for (int i = 0; i < 9; i++)
    if (a.r.m[i] != b.r.m[i]) return false;
  return a.t.x == b.t.x && a.t.y == b.t.y && a.t.z == b.t.z;
}
uint32_t firstInSubmodel(const bmapp::Session& s) {
  for (uint32_t i = 0; i < pieces(s).size(); i++)
    if (!pieces(s)[i].path.empty()) return i;
  FAIL("no piece in a submodel");
  return 0;
}
void open(bmapp::Session& s, const fs::path& p) {
  const bmapp::OpenResult r = s.open(p.string());
  if (!r.ok) FAIL(r.error);
}

/// The in-place model and a full flatten of the document agree exactly.
void matchesFlatten(const bmapp::Session& s) {
  const bmapp::Session::Impl& impl = s.impl();
  const bm::doc::Flat full = bm::doc::flatten(impl.source, *impl.library, *impl.full);
  REQUIRE(full.model.pieces().size() == pieces(s).size());
  for (size_t i = 0; i < pieces(s).size(); i++) {
    INFO("piece " << i);
    CHECK(pieces(s)[i].id == full.model.pieces()[i].id);
    CHECK(pieces(s)[i].part == full.model.pieces()[i].part);
    CHECK(pieces(s)[i].color == full.model.pieces()[i].color);
    CHECK(same(pieces(s)[i].world, full.model.pieces()[i].world));
    CHECK(impl.refs[i].chain == full.refs[i].chain);
  }
}
}  // namespace

TEST_CASE("every command undoes exactly", "[bmapp][commands]") {
  for (int edit = 0; edit <= static_cast<int>(bmapp::Edit::ReorderInStep); edit++) {
    INFO("edit " << edit);
    bmapp::Session s;
    open(s, tower());
    const std::string before = planText(s);
    const uint32_t inSub = firstInSubmodel(s);
    switch (static_cast<bmapp::Edit>(edit)) {
      case bmapp::Edit::Move: s.move({0, inSub}, {30, -8, 20}, false); break;
      case bmapp::Edit::Rotate: s.rotate({0}, {0, 1, 0}, 45, {10, 0, 10}, false); break;
      case bmapp::Edit::Recolor: s.recolor({0, inSub}, 14); break;
      case bmapp::Edit::Delete: s.remove({0, inSub}); break;
      case bmapp::Edit::Duplicate: s.duplicate({0, inSub}, {0, 0, 40}); break;
      case bmapp::Edit::Paste: s.paste(s.copy({0, 1}), {200, 0, 0}); break;
      case bmapp::Edit::ReplacePart: s.replacePart({0}, "3003.dat"); break;
      case bmapp::Edit::MakeUnique: s.makeUnique(inSub); break;
      case bmapp::Edit::AddStep: s.insertStep(1); break;
      case bmapp::Edit::DeleteStep: s.deleteStep(1); break;
      case bmapp::Edit::MoveStep: s.moveStep(0, 1); break;
      case bmapp::Edit::SplitStep: s.splitStep(0, {0}); break;
      case bmapp::Edit::MergeSteps: s.mergeSteps(0); break;
      case bmapp::Edit::StepFields: s.setStepFields(0, {"Base", "Notes", 1.5, true}, false); break;
      case bmapp::Edit::MoveToStep: s.moveToStep({0}, 1); break;
      case bmapp::Edit::ReorderInStep: s.reorderInStep(0, 0, 1); break;
    }
    const std::string after = planText(s);
    REQUIRE(after != before);
    REQUIRE(s.canUndo());
    s.undo();
    CHECK(planText(s) == before);
    matchesFlatten(s);
    REQUIRE(s.canRedo());
    s.redo();
    CHECK(planText(s) == after);
    matchesFlatten(s);
  }
}

TEST_CASE("move inside a shared submodel moves every use, undo restores", "[bmapp][commands][focus]") {
  bmapp::Session s;
  open(s, wheels());
  REQUIRE(pieces(s).size() == 8);
  const std::vector<bm::Xform> before = worlds(s);
  const bmapp::Changed c = s.move({0}, {0, 0, 20}, false);
  CHECK_FALSE(c.structure);
  CHECK(c.moved.size() == 4);  // the 3001 in every use
  const std::vector<bm::Xform> after = worlds(s);
  for (uint32_t p : {0u, 2u, 4u, 6u}) CHECK_FALSE(same(after[p], before[p]));
  for (uint32_t p : {1u, 3u, 5u, 7u}) CHECK(same(after[p], before[p]));
  CHECK(std::abs(after[0].t.z - before[0].t.z - 20) < 1e-9);
  matchesFlatten(s);
  s.undo();
  const std::vector<bm::Xform> undone = worlds(s);
  for (size_t p = 0; p < before.size(); p++) CHECK(same(undone[p], before[p]));
}

TEST_CASE("a drag is one undo step", "[bmapp][commands]") {
  bmapp::Session s;
  open(s, wheels());
  const std::string before = planText(s);
  s.move({1}, {7, 0, 0}, true);
  s.move({1}, {7, 0, 0}, true);
  s.move({1}, {6, 0, 0}, true);
  s.endGesture();
  CHECK(s.undoName() == "Move Piece");
  s.undo();
  CHECK(planText(s) == before);
  CHECK_FALSE(s.canUndo());
}

TEST_CASE("grid stays grid on whole-stud moves", "[bmapp][commands]") {
  bmapp::Session s;
  open(s, tower());
  const bm::doc::Item& item = s.impl().source.root.steps[0].items[0];
  REQUIRE(item.at.grid);
  s.move({0}, {20, 0, 0}, false);
  CHECK(s.impl().source.root.steps[0].items[0].at.grid);
  CHECK(s.impl().source.root.steps[0].items[0].at.x == 1);
  s.undo();
  s.move({0}, {7, 0, 0}, true);
  s.move({0}, {13, 0, 0}, true);  // the gesture's total is whole: still grid
  s.endGesture();
  CHECK(s.impl().source.root.steps[0].items[0].at.grid);
  s.undo();
  s.move({0}, {10, 0, 0}, false);
  CHECK_FALSE(s.impl().source.root.steps[0].items[0].at.grid);
  matchesFlatten(s);
}

TEST_CASE("dirty follows the saved mark through undo", "[bmapp][commands]") {
  bmapp::Session s;
  open(s, tower());
  CHECK_FALSE(s.dirty());
  s.move({0}, {20, 0, 0}, false);
  CHECK(s.dirty());
  s.markSaved();
  CHECK_FALSE(s.dirty());
  s.undo();
  CHECK(s.dirty());
  s.redo();
  CHECK_FALSE(s.dirty());
  s.undo();
  s.recolor({0}, 1);  // a new branch: the saved state can never come back
  CHECK(s.dirty());
  const uint64_t v = s.version();
  s.undo();
  CHECK(s.version() > v);
  CHECK(s.dirty());
}

TEST_CASE("make unique forks one use", "[bmapp][commands]") {
  bmapp::Session s;
  open(s, wheels());
  const bmapp::Changed c = s.makeUnique(0);
  CHECK(c.structure);
  CHECK(s.impl().source.submodels.size() == 2);
  CHECK(s.impl().source.submodels[1].first == "wheel 2.ldr");
  CHECK(s.undoName() == "Make Unique");
  const std::vector<bm::Xform> before = worlds(s);
  s.move({0}, {0, 0, 20}, false);
  const std::vector<bm::Xform> after = worlds(s);
  CHECK_FALSE(same(after[0], before[0]));
  for (uint32_t p = 1; p < 8; p++) CHECK(same(after[p], before[p]));
}

TEST_CASE("deleting a whole use deletes the use, not the submodel", "[bmapp][commands]") {
  bmapp::Session s;
  open(s, wheels());
  const bmapp::Changed c = s.remove({0, 1});
  CHECK(c.structure);
  CHECK(pieces(s).size() == 6);
  CHECK(s.impl().source.root.steps[0].items.size() == 3);
  CHECK(s.impl().source.submodels[0].second.steps[0].items.size() == 2);
  CHECK(s.undoName() == "Delete 2 Pieces");
  s.undo();
  CHECK(pieces(s).size() == 8);
}

TEST_CASE("an item reached twice is edited once", "[bmapp][commands]") {
  bmapp::Session s;
  open(s, wheels());
  const bmapp::Changed c = s.recolor({0, 2}, 2);
  CHECK_FALSE(c.structure);
  CHECK(c.recolored.size() == 4);
  CHECK(s.impl().source.submodels[0].second.steps[0].items[0].colorText == "2");
  s.undo();
  CHECK(s.impl().source.submodels[0].second.steps[0].items[0].colorText == "4");
  CHECK_FALSE(s.canUndo());
  for (uint32_t p : {0u, 2u, 4u, 6u}) CHECK(pieces(s)[p].color == 4);
}

TEST_CASE("select all and move gives one world delta", "[bmapp][commands]") {
  bmapp::Session s;
  open(s, wheels());
  const std::vector<bm::Xform> before = worlds(s);
  s.move({0, 1, 2, 3, 4, 5, 6, 7}, {20, 0, 0}, false);
  const std::vector<bm::Xform> after = worlds(s);
  for (size_t p = 0; p < 8; p++) {
    INFO("piece " << p);
    CHECK(std::abs(after[p].t.x - before[p].t.x - 20) < 1e-9);
    CHECK(std::abs(after[p].t.y - before[p].t.y) < 1e-9);
    CHECK(std::abs(after[p].t.z - before[p].t.z) < 1e-9);
    for (int i = 0; i < 9; i++) CHECK(std::abs(after[p].r.m[i] - before[p].r.m[i]) < 1e-12);
  }
  matchesFlatten(s);
}

TEST_CASE("a whole use and part of another use of the same submodel: the whole use moves", "[bmapp][commands]") {
  bmapp::Session s;
  open(s, wheels());
  const std::vector<bm::Xform> before = worlds(s);
  s.move({0, 1, 2}, {20, 0, 0}, false);
  const std::vector<bm::Xform> after = worlds(s);
  CHECK(std::abs(after[0].t.x - before[0].t.x - 20) < 1e-9);
  CHECK(std::abs(after[1].t.x - before[1].t.x - 20) < 1e-9);
  for (uint32_t p = 2; p < 8; p++) CHECK(same(after[p], before[p]));  // nothing moves twice, nothing else moves
}

TEST_CASE("in-place edits equal a full flatten", "[bmapp][commands]") {
  bmapp::Session s;
  open(s, tower());
  const uint32_t inSub = firstInSubmodel(s);
  s.move({inSub}, {20, 0, 0}, false);  // inside cap, whose use is grid-placed
  matchesFlatten(s);
  s.recolor({0}, 1);
  matchesFlatten(s);
  s.rotate({inSub}, {0, 1, 0}, 90, {0, 0, 0}, false);
  matchesFlatten(s);
  s.undo(), s.undo(), s.undo();
  matchesFlatten(s);

  bmapp::Session w;
  open(w, wheels());
  w.move({4}, {5, 3, 1}, false);  // through the mirrored use
  w.rotate({6}, {1, 0, 0}, 30, {0, 0, 0}, false);  // through the turned use
  matchesFlatten(w);
}

TEST_CASE("copy and paste places the copy where it was, offset", "[bmapp][commands]") {
  bmapp::Session s;
  open(s, wheels());
  const std::string text = s.copy({4});
  CHECK(text.rfind("1 4 ", 0) == 0);
  const bmapp::Changed c = s.paste(text, {0, 0, 0});
  CHECK(c.structure);
  REQUIRE(pieces(s).size() == 9);
  CHECK(same(pieces(s)[8].world, pieces(s)[4].world));
  CHECK(s.undoName() == "Paste Piece");
}

TEST_CASE("an edit during planning cancels it", "[bmapp][commands][viewport]") {
  bmapp::Session s;
  open(s, fs::path(BM_REPO) / "samples" / "helicopter" / "helicopter.mpd");
  bmapp::Viewport view(s);
  if (!view.ok()) SKIP("no Metal device");
  view.resize(200, 150, 1);
  view.play(true);
  REQUIRE(view.planState() == bmapp::PlanState::Planning);
  s.move({0}, {20, 0, 0}, false);
  view.draw(nullptr);
  CHECK(view.planState() == bmapp::PlanState::Idle);
  view.play(true);
  const auto deadline = std::chrono::steady_clock::now() + std::chrono::minutes(3);
  while (view.planState() == bmapp::PlanState::Planning && std::chrono::steady_clock::now() < deadline) {
    view.draw(nullptr);
    std::this_thread::sleep_for(std::chrono::milliseconds(20));
  }
  REQUIRE(view.planState() == bmapp::PlanState::Ready);
  CHECK(view.plannedVersion() == s.version());
}
