#include <catch2/catch_test_macros.hpp>
#include <filesystem>
#include <fstream>
#include <unistd.h>
#include "bm/io.h"
#include "bm/kin/truth.h"

using namespace bm;
using namespace bm::kin;
using connect::JointKind;
namespace fs = std::filesystem;

TEST_CASE("a hand-checked list is scored against the freedoms found", "[kin][truth]") {
  // Four 1x1 fixture bricks: a frame, a wheel turning about z, a slider along x, and a bystander.
  const ldraw::Library lib(fs::path(BM_FIXTURES) / "lib");
  ldraw::PartCache parts(lib, fs::temp_directory_path() / "bm_kin_truth_cache");
  const fs::path file = fs::temp_directory_path() / ("bm_kin_truth_" + std::to_string(::getpid()) + ".ldr");
  {
    std::ofstream out(file);
    for (int x : {0, 100, 200, 300}) out << "1 4 " << x << " 0 0 1 0 0 0 1 0 0 0 1 3005.dat\n";
  }
  const Model model = io::load(file, lib);
  fs::remove(file);
  System sys;
  sys.bodies = 4;
  sys.size = {10, 1, 1, 1};
  sys.bodyOf = {0, 1, 2, 3};
  sys.pieces = {{0}, {1}, {2}, {3}};
  sys.links.push_back({0, 1, JointKind::Revolute, {100, 12, 0}, {0, 0, 1}, 0, 1});
  sys.links.push_back({0, 2, JointKind::Prismatic, {200, 12, 0}, {1, 0, 0}, 0, 2});
  const Mobility mob = mobility(sys);
  connect::Graph graph;
  GearMesh mesh;
  mesh.a = 1;
  mesh.b = 2;
  mesh.teethA = 8;
  mesh.teethB = 24;
  graph.meshes.push_back(mesh);

  // A piece is named by the centre of its box: the fixture brick's is 12 below its origin.
  const auto expected = nlohmann::json::parse(R"({"mechanisms": [{"id": "m", "checks": [
    {"type": "rotates", "label": "wheel", "part": {"part": "3005", "at": [100, 12, 0]}, "axis": [0, 0, 1]},
    {"type": "rotates", "label": "wheel, wrong axis", "part": {"part": "3005", "at": [100, 12, 0]}, "axis": [1, 0, 0]},
    {"type": "rotates", "label": "bystander", "part": {"part": "3005", "at": [300, 12, 0]}, "axis": [0, 0, 1]},
    {"type": "slides", "label": "slider", "part": {"part": "3005", "at": [203, 12, 0]}, "axis": [-1, 0, 0]},
    {"type": "slides", "label": "wheel does not slide", "part": {"part": "3005", "at": [100, 12, 0]}, "axis": [1, 0, 0]},
    {"type": "rotates", "label": "no such piece", "part": {"part": "3005", "at": [150, 12, 0]}, "axis": [0, 0, 1]},
    {"type": "rotates", "label": "no such part", "part": {"part": "9999", "at": [100, 12, 0]}, "axis": [0, 0, 1]},
    {"type": "gearMesh", "label": "meshed 8:24", "a": {"part": "3005", "at": [100, 12, 0]}, "b": {"part": "3005", "at": [200, 12, 0]}, "kind": "spur", "ratio": 3},
    {"type": "gearMesh", "label": "wrong ratio", "a": {"part": "3005", "at": [100, 12, 0]}, "b": {"part": "3005", "at": [200, 12, 0]}, "kind": "spur", "ratio": 2},
    {"type": "gearMesh", "label": "not meshed", "a": {"part": "3005", "at": [100, 12, 0]}, "b": {"part": "3005", "at": [300, 12, 0]}, "kind": "spur"},
    {"type": "rackPinion", "label": "meshed, not a rack", "pinion": {"part": "3005", "at": [100, 12, 0]}, "rack": {"part": "3005", "at": [200, 12, 0]}},
    {"type": "function", "label": "wheel alone", "kinds": [], "driver": {"part": "3005", "at": [100, 12, 0]}, "moves": [], "stays": [{"part": "3005.dat", "at": [200, 12, 0]}]},
    {"type": "function", "label": "wheel does not move the slider", "kinds": [], "driver": {"part": "3005", "at": [100, 12, 0]}, "moves": [{"part": "3005", "at": [200, 12, 0]}]},
    {"type": "function", "label": "the frame is no driver", "kinds": [], "driver": {"part": "3005", "at": [0, 12, 0]}, "moves": []},
    {"type": "vehicle", "label": "not judged here", "wheels": 4},
    7
  ]}, "not a mechanism", {"id": "empty"}]})");
  const TruthScore s = score(model, graph, sys, mob, parts, expected);
  const std::vector<TruthResult> want = {TruthResult::Hit, TruthResult::Missing, TruthResult::Missing, TruthResult::Hit, TruthResult::Missing, TruthResult::Unresolved, TruthResult::Unresolved, TruthResult::Hit,
                                         TruthResult::Missing, TruthResult::Missing, TruthResult::Missing, TruthResult::Hit, TruthResult::Missing, TruthResult::Missing, TruthResult::NotScored, TruthResult::Unresolved};
  REQUIRE(s.lines.size() == want.size());
  for (size_t i = 0; i < want.size(); i++) {
    INFO(s.lines[i].label << ": " << name(s.lines[i].result) << " " << s.lines[i].detail);
    REQUIRE(s.lines[i].result == want[i]);
  }
  REQUIRE((s.hit == 4 && s.missing == 8 && s.notScored == 1 && s.unresolved == 3 && s.scored() == 12));
  REQUIRE(s.lines[0].mechanism == "m");

  // A file with its own tolerance, and files that are not lists at all.
  auto tight = expected;
  tight["toleranceLdu"] = 1;
  REQUIRE(score(model, graph, sys, mob, parts, tight).lines[3].result == TruthResult::Unresolved);  // the slider was named 3 off
  REQUIRE(score(model, graph, sys, mob, parts, nlohmann::json::parse("[]")).lines.empty());
  REQUIRE(score(model, graph, sys, mob, parts, nlohmann::json::parse(R"({"mechanisms": 3})")).lines.empty());
  REQUIRE(score(model, graph, System{}, mob, parts, expected).lines.empty());  // a system of another model
}

TEST_CASE("a rod that stands still slides in a cylinder that moves", "[kin][truth]") {
  const ldraw::Library lib(fs::path(BM_FIXTURES) / "lib");
  ldraw::PartCache parts(lib, fs::temp_directory_path() / "bm_kin_truth_cache");
  const fs::path file = fs::temp_directory_path() / ("bm_kin_truth_rod_" + std::to_string(::getpid()) + ".ldr");
  {
    std::ofstream out(file);
    for (int x : {0, 100, 200}) out << "1 4 " << x << " 0 0 1 0 0 0 1 0 0 0 1 3005.dat\n";
  }
  const Model model = io::load(file, lib);
  fs::remove(file);
  // Frame 0; cylinder 1 slides on the frame along x; rod 2 is pinned to the frame and runs in the cylinder.
  System sys;
  sys.bodies = 3;
  sys.size = {10, 1, 1};
  sys.bodyOf = {0, 1, 2};
  sys.pieces = {{0}, {1}, {2}};
  sys.links.push_back({0, 1, JointKind::Prismatic, {100, 12, 0}, {1, 0, 0}, 0, 1});
  sys.links.push_back({0, 2, JointKind::Revolute, {200, 12, 0}, {0, 0, 1}, 0, 2});
  sys.links.push_back({1, 2, JointKind::Cylindrical, {150, 12, 0}, {1, 0, 0}, 1, 2});
  const Mobility mob = mobility(sys);
  const auto expected = nlohmann::json::parse(R"({"mechanisms": [{"id": "m", "checks": [
    {"type": "slides", "label": "rod", "part": {"part": "3005", "at": [200, 12, 0]}, "axis": [1, 0, 0]},
    {"type": "slides", "label": "rod, wrong axis", "part": {"part": "3005", "at": [200, 12, 0]}, "axis": [0, 1, 0]},
    {"type": "slides", "label": "cylinder", "part": {"part": "3005", "at": [100, 12, 0]}, "axis": [1, 0, 0]}
  ]}]})");
  const TruthScore s = score(model, connect::Graph{}, sys, mob, parts, expected);
  REQUIRE(s.lines.size() == 3);
  REQUIRE(s.lines[0].result == TruthResult::Hit);
  REQUIRE(s.lines[1].result == TruthResult::Missing);
  REQUIRE(s.lines[2].result == TruthResult::Hit);
}
