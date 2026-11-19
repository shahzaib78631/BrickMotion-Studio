// Submodel commands: new, make from pieces, extract, move to another model, rename, delete.
#include <catch2/catch_test_macros.hpp>
#include <algorithm>
#include <cmath>
#include <set>
#include <tuple>
#include "structure_fixture.h"

using namespace structure;

namespace {
fs::path helicopter() { return fs::path(BM_REPO) / "samples" / "helicopter" / "helicopter.mpd"; }

/// Every piece's part, colour and world placement, in one order that does not depend on indexes.
using Pose = std::tuple<std::string, int, std::vector<double>>;
std::vector<Pose> poses(const bmapp::Session& s) {
  std::vector<Pose> out;
  for (const bm::Piece& p : s.impl().model->pieces()) {
    std::vector<double> v(p.world.r.m, p.world.r.m + 9);
    v.push_back(p.world.t.x), v.push_back(p.world.t.y), v.push_back(p.world.t.z);
    out.emplace_back(p.part, p.color, v);
  }
  std::sort(out.begin(), out.end(), [](const Pose& a, const Pose& b) {
    const auto& va = std::get<2>(a);
    const auto& vb = std::get<2>(b);
    // Ordered by rounded position so tiny float differences do not reorder the list.
    auto key = [](const std::vector<double>& v) { return std::make_tuple(std::lround(v[9]), std::lround(v[10]), std::lround(v[11])); };
    return std::tie(std::get<0>(a), std::get<1>(a)) != std::tie(std::get<0>(b), std::get<1>(b))
               ? std::tie(std::get<0>(a), std::get<1>(a)) < std::tie(std::get<0>(b), std::get<1>(b))
               : key(va) < key(vb);
  });
  return out;
}

void samePoses(const std::vector<Pose>& a, const std::vector<Pose>& b) {
  REQUIRE(a.size() == b.size());
  for (size_t i = 0; i < a.size(); i++) {
    CHECK(std::get<0>(a[i]) == std::get<0>(b[i]));
    CHECK(std::get<1>(a[i]) == std::get<1>(b[i]));
    for (size_t k = 0; k < 12; k++) CHECK(std::abs(std::get<2>(a[i])[k] - std::get<2>(b[i])[k]) < 1e-6);
  }
}

/// Plan ids of every item in one model, with repeats.
std::vector<std::string> allIds(const Json& model) {
  std::vector<std::string> out;
  for (const Json& step : model["steps"])
    for (const Json& i : step["pieces"])
      if (i.contains("id")) out.push_back(i["id"]);
  return out;
}

bool unique(std::vector<std::string> v) {
  std::sort(v.begin(), v.end());
  return std::adjacent_find(v.begin(), v.end()) == v.end();
}
}  // namespace

TEST_CASE("make submodel keeps every world placement", "[bmapp][submodel]") {
  bmapp::Session s;
  REQUIRE(s.open(helicopter().string()).ok);
  std::vector<uint32_t> loose;
  for (uint32_t p = 0; p < s.pieceCount() && loose.size() < 6; p++)
    if (s.impl().refs[p].chain.size() == 1) loose.push_back(p);
  REQUIRE(loose.size() >= 2);
  const auto before = poses(s);
  const std::string original = plan(s).dump();
  const size_t count = s.pieceCount();
  const std::string name = s.freeSubmodelName("Submodel");
  CHECK(name == "Submodel");
  const bmapp::Changed made = s.makeSubmodel(loose, name);
  REQUIRE(made.refused.empty());
  CHECK(s.undoName() == "Make Submodel");
  CHECK(s.pieceCount() == count);
  samePoses(poses(s), before);
  CHECK(s.freeSubmodelName("Submodel") == "Submodel 2");
  CHECK(s.selection().size() == loose.size());  // the pieces stay selected, now inside it
  s.undo();
  CHECK(plan(s).dump() == original);
  CHECK(s.makeSubmodel({loose[0]}, "One").refused == "Choose at least two pieces.");
}

TEST_CASE("extract inverts make", "[bmapp][submodel]") {
  bmapp::Session s;
  REQUIRE(s.open(fixture().string()).ok);
  const auto before = poses(s);
  REQUIRE(s.makeSubmodel({pieces(s, "a")[0], pieces(s, "b")[0]}, "AB").refused.empty());
  const Json made = plan(s);
  CHECK(allIds(made["submodels"]["AB"]) == std::vector<std::string>{"a", "b"});
  REQUIRE(s.extract(pieces(s, "a")[0]).refused.empty());
  CHECK(s.undoName() == "Extract AB");
  samePoses(poses(s), before);
  const Json p = plan(s);
  CHECK(p["submodels"].contains("AB"));  // kept, though unused now
  CHECK(unique(allIds(p)));
  CHECK_FALSE(s.extract(pieces(s, "c")[0]).refused.empty());  // c is in the model itself
}

TEST_CASE("ids stay unique and references stay inside their model", "[bmapp][submodel]") {
  const fs::path path = fs::temp_directory_path() / "bmapp_refs.json";
  {
    std::ofstream f(path);
    f << R"({"format":"brickmotion-plan","version":1,"name":"Refs","steps":[{"pieces":[
      {"id":"a","part":"3001.dat","color":4,"x":0,"y":0,"z":0,"rot":0},
      {"id":"b","part":"3001.dat","color":4,"x":0,"y":3,"z":0,"rot":0,"assembly":{"attachTo":"a"}},
      {"id":"c","part":"3001.dat","color":4,"x":0,"y":6,"z":0,"rot":0,"assembly":{"after":["b"]}}]}]})";
  }
  bmapp::Session s;
  REQUIRE(s.open(path.string()).ok);
  REQUIRE(s.makeSubmodel({pieces(s, "a")[0], pieces(s, "b")[0]}, "AB").refused.empty());
  Json p = plan(s);
  const Json& sub = p["submodels"]["AB"]["steps"][0]["pieces"];
  CHECK(sub[1]["assembly"]["attachTo"] == "a");
  for (const Json& i : p["steps"][0]["pieces"])
    if (i.value("id", "") == "c") CHECK_FALSE(i.contains("assembly"));
  // Two uses of AB extracted into the same model: the second copies get fresh ids, and their
  // reference follows them.
  s.duplicate(s.selection(), {0, 0, 200});  // the whole use is selected: the use is duplicated
  REQUIRE(s.extract(s.selection()[0]).refused.empty());
  uint32_t other = UINT32_MAX;
  for (uint32_t q : pieces(s, "a"))
    if (s.impl().refs[q].chain.size() == 2) other = q;
  REQUIRE(other != UINT32_MAX);
  REQUIRE(s.extract(other).refused.empty());
  p = plan(s);
  CHECK(unique(allIds(p)));
  const std::vector<std::string> root = allIds(p);
  CHECK(std::count(root.begin(), root.end(), "a-2") == 1);
  for (const Json& i : p["steps"][0]["pieces"])
    if (i.value("id", "") == "b-2") CHECK(i["assembly"]["attachTo"] == "a-2");
}

TEST_CASE("move to model re-expresses and refuses loops", "[bmapp][submodel]") {
  bmapp::Session s;
  REQUIRE(s.open(fixture().string()).ok);
  const size_t count = s.pieceCount();
  const uint32_t c = pieces(s, "c")[0];
  const bm::Xform world = s.impl().model->pieces()[c].world;
  REQUIRE(s.moveToModel({c}, "Pair").refused.empty());
  CHECK(s.undoName() == "Move Piece to Pair");
  CHECK(s.pieceCount() == count + 1);  // one piece left the root; each of Pair's two uses gained one
  // Under the first use it is where it was.
  bool found = false;
  for (uint32_t p : pieces(s, "c"))
    if (idOf(s, p, 0) == "u1") {
      found = true;
      const bm::Xform now = s.impl().model->pieces()[p].world;
      CHECK(std::abs(now.t.x - world.t.x) < 1e-6);
      CHECK(std::abs(now.t.y - world.t.y) < 1e-6);
      CHECK(std::abs(now.t.z - world.t.z) < 1e-6);
    }
  CHECK(found);
  s.undo();
  // A use of Pair moved into Pair: refused.
  std::vector<uint32_t> use;
  for (uint32_t p = 0; p < s.pieceCount(); p++)
    if (idOf(s, p, 0) == "u1") use.push_back(p);
  CHECK_FALSE(s.moveToModel(use, "Pair").refused.empty());
  CHECK_FALSE(s.moveToModel({c}, "Nowhere").refused.empty());
}

TEST_CASE("rename and delete", "[bmapp][submodel]") {
  bmapp::Session s;
  REQUIRE(s.open(fixture().string()).ok);
  REQUIRE(s.newSubmodel("Spare").refused.empty());
  CHECK(s.undoName() == "New Submodel");
  REQUIRE(s.renameSubmodel("Pair", "Twin").refused.empty());
  CHECK(s.undoName() == "Rename Pair");
  Json p = plan(s);
  std::vector<std::string> names;
  for (const auto& [k, v] : p["submodels"].items()) names.push_back(k);
  CHECK(names == std::vector<std::string>{"Twin", "Spare"});
  CHECK(p["steps"][1]["pieces"][0]["submodel"] == "Twin");
  CHECK(p["steps"][1]["pieces"][1]["submodel"] == "Twin");
  CHECK_FALSE(s.renameSubmodel("Twin", "Spare").refused.empty());
  CHECK_FALSE(s.renameSubmodel("Twin", "").refused.empty());
  CHECK_FALSE(s.renameSubmodel("Twin", "x.dat").refused.empty());
  CHECK(s.deleteSubmodel("Twin").refused == "Twin is used 2 times. Remove its uses first.");
  REQUIRE(s.deleteSubmodel("Spare").refused.empty());
  CHECK(s.undoName() == "Delete Spare");
  CHECK_FALSE(plan(s)["submodels"].contains("Spare"));
  s.undo();
  names.clear();
  p = plan(s);
  for (const auto& [k, v] : p["submodels"].items()) names.push_back(k);
  CHECK(names == std::vector<std::string>{"Twin", "Spare"});
  CHECK_FALSE(s.newSubmodel("Twin").refused.empty());
}
