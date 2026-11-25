// Step commands: insert, delete, move, split, merge, fields, move pieces to a step, reorder.
#include <catch2/catch_test_macros.hpp>
#include "bmapp/session.h"
#include "commands.h"
#include "session_impl.h"

#include "structure_fixture.h"

using namespace structure;


namespace {
struct Fixture {
  bmapp::Session s;
  Fixture() { REQUIRE(s.open(fixture().string()).ok); }
};
}  // namespace

TEST_CASE("insert, delete, move steps and undo", "[bmapp][structure]") {
  Fixture f;
  bmapp::Session& s = f.s;
  const std::string original = plan(s).dump();
  REQUIRE(s.stepCount() == 2);
  s.insertStep(1);
  CHECK(s.stepCount() == 3);
  CHECK(s.undoName() == "Insert Step");
  s.undo();
  CHECK(plan(s).dump() == original);

  s.deleteStep(0);
  CHECK(s.stepCount() == 1);
  CHECK(s.undoName() == "Delete Step");
  const Json p = plan(s);
  CHECK(ids(p["steps"][0]) == std::vector<std::string>{"a", "b", "u1", "u2", "c"});
  CHECK(p["steps"][0]["notes"] == "one\ntwo");
  const uint64_t v = s.version();
  const bmapp::Changed refused = s.deleteStep(0);
  CHECK(refused.refused == "A model needs at least one step.");
  CHECK(s.version() == v);
  s.undo();
  CHECK(plan(s).dump() == original);

  s.moveStep(0, 1);
  CHECK(s.undoName() == "Move Step");
  CHECK(ids(plan(s)["steps"][1]) == std::vector<std::string>{"a", "b"});
  s.undo();
  CHECK(plan(s).dump() == original);
}

TEST_CASE("split and merge", "[bmapp][structure]") {
  Fixture f;
  bmapp::Session& s = f.s;
  const std::string original = plan(s).dump();
  s.splitStep(0, pieces(s, "b"));
  CHECK(s.undoName() == "Split Step");
  Json p = plan(s);
  CHECK(ids(p["steps"][0]) == std::vector<std::string>{"a"});
  CHECK(ids(p["steps"][1]) == std::vector<std::string>{"b"});
  CHECK(p["steps"][0]["title"] == "First");
  CHECK_FALSE(p["steps"][1].contains("title"));
  s.mergeSteps(0);
  CHECK(s.undoName() == "Merge Steps");
  p = plan(s);
  CHECK(ids(p["steps"][0]) == std::vector<std::string>{"a", "b"});
  CHECK(p["steps"][0]["title"] == "First");
  CHECK(s.stepCount() == 2);
  s.undo();
  s.undo();
  CHECK(plan(s).dump() == original);
  CHECK_FALSE(s.splitStep(0, pieces(s, "c")).refused.empty());  // none of that step's pieces
  CHECK_FALSE(s.splitStep(0, {pieces(s, "a")[0], pieces(s, "b")[0]}).refused.empty());  // all of them
}

TEST_CASE("timeline split and new-step moves preserve order and undo atomically", "[bmapp][structure]") {
  Fixture f;
  bmapp::Session& s = f.s;
  auto f0 = s.stepFields(0);
  f0.pauseAfter = 1.6;
  s.setStepFields(0, f0, false);
  const auto original = plan(s).dump();
  const auto depth = s.undoDepth();

  REQUIRE(s.splitStepAt(0, 1).refused.empty());
  CHECK(s.undoDepth() == depth + 1);
  CHECK(s.stepFields(0).pauseAfter == 0);
  CHECK(s.stepFields(1).pauseAfter == 1.6);
  CHECK(ids(plan(s)["steps"][1]) == std::vector<std::string>{"b"});
  s.undo();
  CHECK(plan(s).dump() == original);

  auto moving = pieces(s, "b");
  const auto c = pieces(s, "c");
  moving.insert(moving.end(), c.begin(), c.end());
  REQUIRE(s.moveToNewStep(moving, 1).refused.empty());
  CHECK(s.undoDepth() == depth + 1);
  CHECK(s.stepCount() == 3);
  CHECK(ids(plan(s)["steps"][1]) == std::vector<std::string>{"b", "c"});
  s.undo();
  CHECK(plan(s).dump() == original);
}

TEST_CASE("step fields coalesce while continuing", "[bmapp][structure]") {
  Fixture f;
  bmapp::Session& s = f.s;
  const size_t depth = s.undoDepth();
  bmapp::StepFields fields = s.stepFields(0);
  CHECK(fields.title == "First");
  fields.title = "A";
  s.setStepFields(0, fields, true);  // every call of one editing session continues, as a drag's do
  fields.title = "Ab";
  s.setStepFields(0, fields, true);
  fields.title = "Abc";
  s.setStepFields(0, fields, true);
  s.endGesture();
  CHECK(s.undoDepth() == depth + 1);
  CHECK(s.undoName() == "Edit Step");
  CHECK(plan(s)["steps"][0]["title"] == "Abc");
  s.undo();
  CHECK(plan(s)["steps"][0]["title"] == "First");

  fields = s.stepFields(0);
  fields.pauseAfter = 12.34;
  s.setStepFields(0, fields, false);
  CHECK(plan(s)["steps"][0]["pauseAfter"] == 10);
  fields.pauseAfter = 0.25;
  s.setStepFields(0, fields, false);
  CHECK(plan(s)["steps"][0]["pauseAfter"] == 0.3);
  fields.pauseAfter = 0;
  s.setStepFields(0, fields, false);
  CHECK_FALSE(plan(s)["steps"][0].contains("pauseAfter"));
  fields.title = std::string(100, 'x');
  s.setStepFields(0, fields, false);
  CHECK(plan(s)["steps"][0]["title"].get<std::string>().size() == 80);
  fields.title = "  ";
  s.setStepFields(0, fields, false);
  CHECK_FALSE(plan(s)["steps"][0].contains("title"));
  const uint64_t v = s.version();
  s.setStepFields(0, s.stepFields(0), false);  // no change: no undo step
  CHECK(s.version() == v);
}

TEST_CASE("arrival pins survive hold edits and a picked group moves in one undo", "[bmapp][structure]") {
  Fixture f;
  auto& s = f.s;
  const auto original = plan(s).dump();
  const auto a = pieces(s, "a");
  const auto c = pieces(s, "c");
  REQUIRE_FALSE(a.empty());
  REQUIRE_FALSE(c.empty());
  REQUIRE(s.setArrivalPinned(a, true).refused.empty());
  CHECK(s.arrivalPins() == a);
  auto fields = s.stepFields(0);
  fields.pauseAfter = 0.8;
  REQUIRE(s.setStepFields(0, fields, false).refused.empty());
  CHECK(s.arrivalPins() == a);
  s.undo();
  s.undo();
  CHECK(plan(s).dump() == original);

  auto group = a;
  group.insert(group.end(), c.begin(), c.end());
  const size_t depth = s.undoDepth();
  REQUIRE(s.moveArrival(group, 0, 1, true).refused.empty());
  CHECK(s.undoDepth() == depth + 1);
  CHECK(ids(plan(s)["steps"][0]) == std::vector<std::string>{"a", "c", "b"});
  CHECK(s.arrivalPins().size() == group.size());
  s.undo();
  CHECK(plan(s).dump() == original);
}

TEST_CASE("placing a catalogue part at a timeline insertion is one undo", "[bmapp][structure]") {
  Fixture fixture;
  auto& s = fixture.s;
  const auto original = plan(s).dump();
  const auto depth = s.undoDepth();
  const auto revision = s.version();
  const bmapp::PartPose pose{{}, {160, -24, 0}};
  REQUIRE(s.placePartBefore("3005.dat", 14, pose, 0, 1, s.generation(), revision).refused.empty());
  const auto items = s.stepItems(0);
  REQUIRE(items.size() == 3);
  CHECK(items[1].name == "3005.dat");
  CHECK(items[1].color == 14);
  CHECK(s.selection() == items[1].pieces);
  CHECK(s.undoDepth() == depth + 1);
  s.undo();
  CHECK(plan(s).dump() == original);
}

TEST_CASE("pin order marks the items", "[bmapp][structure]") {
  Fixture f;
  bmapp::Session& s = f.s;
  bmapp::StepFields fields = s.stepFields(0);
  fields.pinOrder = true;
  s.setStepFields(0, fields, false);
  Json p = plan(s);
  CHECK(p["steps"][0]["pinOrder"] == true);
  for (const Json& i : p["steps"][0]["pieces"]) CHECK(i["assembly"]["root"] == true);
  CHECK(s.stepFields(0).pinOrder);
  fields.pinOrder = false;
  s.setStepFields(0, fields, false);
  p = plan(s);
  CHECK_FALSE(p["steps"][0].contains("pinOrder"));
  for (const Json& i : p["steps"][0]["pieces"]) CHECK_FALSE(i.contains("assembly"));
}

TEST_CASE("move pieces to step", "[bmapp][structure]") {
  Fixture f;
  bmapp::Session& s = f.s;
  s.moveToStep(pieces(s, "a"), 1);
  CHECK(s.undoName() == "Move Piece to Step 2");
  CHECK(ids(plan(s)["steps"][1]) == std::vector<std::string>{"u1", "u2", "c", "a"});
  s.undo();
  // The whole of one use: the use moves.
  std::vector<uint32_t> use;
  for (uint32_t p = 0; p < s.pieceCount(); p++)
    if (idOf(s, p, 0) == "u2") use.push_back(p);
  REQUIRE(use.size() == 2);
  s.moveToStep(use, 0);
  CHECK(ids(plan(s)["steps"][0]) == std::vector<std::string>{"a", "b", "u2"});
  s.undo();
  // Part of a use: refused.
  const bmapp::Changed refused = s.moveToStep({use[0]}, 0);
  CHECK(refused.refused == "Pieces inside a submodel move with it. Open the submodel to change its steps.");
}

TEST_CASE("reorder in step", "[bmapp][structure]") {
  Fixture f;
  bmapp::Session& s = f.s;
  const std::string original = plan(s).dump();
  s.reorderInStep(0, 0, 1);
  CHECK(ids(plan(s)["steps"][0]) == std::vector<std::string>{"b", "a"});
  s.undo();
  CHECK(plan(s).dump() == original);
}

TEST_CASE("step edits in a shared submodel undo exactly", "[bmapp][structure]") {
  Fixture f;
  bmapp::Session& s = f.s;
  const std::string original = plan(s).dump();
  const size_t count = s.pieceCount();
  // Pair's step 1 (p2) merged into step 0, then p2 split back out on its own: both uses follow.
  bmapp::mergeStepsCommand(s.impl(), "Pair", 0);
  Json p = plan(s);
  REQUIRE(p["submodels"]["Pair"]["steps"].size() == 1);
  CHECK(s.pieceCount() == count);
  bmapp::splitStepCommand(s.impl(), "Pair", 0, pieces(s, "p2"));
  p = plan(s);
  CHECK(p["submodels"]["Pair"]["steps"].size() == 2);
  CHECK(ids(p["submodels"]["Pair"]["steps"][1]) == std::vector<std::string>{"p2"});
  s.undo();
  s.undo();
  CHECK(plan(s).dump() == original);
}
