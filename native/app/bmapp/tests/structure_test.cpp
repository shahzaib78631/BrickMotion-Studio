// Step commands: insert, delete, move, split, merge, fields, move pieces to a step, reorder.
#include <catch2/catch_test_macros.hpp>
#include <filesystem>
#include <fstream>
#include <nlohmann/json.hpp>
#include "bmapp/session.h"
#include "commands.h"
#include "session_impl.h"

namespace fs = std::filesystem;
using Json = nlohmann::json;

namespace {
/// Root: step 0 a, b; step 1 u1, u2 (uses of Pair), c. Pair: step 0 p1; step 1 p2.
fs::path fixture() {
  const fs::path p = fs::temp_directory_path() / "bmapp_structure.json";
  std::ofstream f(p);
  f << R"({"format":"brickmotion-plan","version":1,"name":"Structure",
  "steps":[
    {"title":"First","notes":"one","pieces":[
      {"id":"a","part":"3001.dat","color":4,"x":0,"y":0,"z":0,"rot":0},
      {"id":"b","part":"3001.dat","color":1,"x":6,"y":0,"z":0,"rot":0}]},
    {"notes":"two","pauseAfter":2,"pieces":[
      {"id":"u1","submodel":"Pair","x":0,"y":0,"z":10,"rot":0},
      {"id":"u2","submodel":"Pair","x":10,"y":0,"z":10,"rot":0},
      {"id":"c","part":"3001.dat","color":14,"x":12,"y":0,"z":0,"rot":0}]}],
  "submodels":{"Pair":{"steps":[
    {"pieces":[{"id":"p1","part":"3001.dat","color":2,"x":0,"y":0,"z":0,"rot":0}]},
    {"pieces":[{"id":"p2","part":"3003.dat","color":14,"x":0,"y":3,"z":0,"rot":0}]}]}}})";
  return p;
}

/// The plan id of the item a piece is made of, at `level` of its chain (last = its own part).
std::string idOf(const bmapp::Session& s, uint32_t piece, size_t level) {
  const auto& chain = s.impl().refs[piece].chain;
  const auto find = [&](const bm::doc::Def& def) -> std::string {
    for (const auto& step : def.steps)
      for (const auto& item : step.items)
        if (item.id == chain[level]) return item.extra.value("id", std::string());
    return {};
  };
  if (std::string id = find(s.impl().source.root); !id.empty()) return id;
  for (const auto& [name, def] : s.impl().source.submodels)
    if (std::string id = find(def); !id.empty()) return id;
  return {};
}

/// The pieces whose own part item has plan id `id` (more than one for a shared submodel).
std::vector<uint32_t> pieces(const bmapp::Session& s, const std::string& id) {
  std::vector<uint32_t> out;
  for (uint32_t p = 0; p < s.pieceCount(); p++)
    if (idOf(s, p, s.impl().refs[p].chain.size() - 1) == id) out.push_back(p);
  return out;
}

Json plan(const bmapp::Session& s) { return Json::parse(s.projectBytes())["plan"]; }

std::vector<std::string> ids(const Json& step) {
  std::vector<std::string> out;
  for (const Json& i : step["pieces"]) out.push_back(i.value("id", ""));
  return out;
}

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
