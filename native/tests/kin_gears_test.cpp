#include <catch2/catch_test_macros.hpp>
#include <catch2/matchers/catch_matchers_floating_point.hpp>
#include <cmath>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <sstream>
#include <nlohmann/json.hpp>
#include "bm/io.h"
#include "bm/kin/gears.h"

using namespace bm;
using namespace bm::kin;
using Catch::Matchers::WithinAbs;
namespace fs = std::filesystem;

namespace {
Toothed spur(int teeth, Vec3 centre, Vec3 axis = {0, 0, 1}, double width = 9.5) {
  Toothed t;
  t.kind = ToothKind::Spur;
  t.teeth = teeth;
  t.pitchRadius = teeth * 1.25;
  t.axis = axis;
  t.centre = centre;
  t.width = width;
  return t;
}
Toothed bevel(int teeth, Vec3 centre, Vec3 axis, Vec3 facing) {
  Toothed t = spur(teeth, centre, axis, 10);
  t.kind = ToothKind::Bevel;
  t.facing = facing;
  return t;
}
double offLine(Vec3 p, Vec3 origin, Vec3 axis) {
  const Vec3 v = p - origin;
  return length(v - axis * dot(v, axis));
}
std::string slurp(const fs::path& file) {
  std::ifstream in(file);
  std::stringstream text;
  text << in.rdbuf();
  return text.str();
}
}  // namespace

TEST_CASE("gears side by side mesh at the sum of their pitch radii", "[kin][gears]") {
  // 8 teeth (radius 10) and 24 teeth (radius 30): 40 apart.
  const auto meshes = findMeshes({{0, spur(8, {0, 0, 0}), false}, {1, spur(24, {40, 0, 0}), false}});
  REQUIRE(meshes.size() == 1);
  const GearMesh& m = meshes[0];
  REQUIRE((m.a == 0 && m.b == 1 && m.kind == MeshKind::Parallel && m.teethA == 8 && m.teethB == 24));
  // The contact point divides the line of centres exactly as the tooth counts.
  REQUIRE_THAT(m.point.x, WithinAbs(10, 1e-12));
  REQUIRE_THAT(offLine(m.point, m.pointA, m.axisA) * m.teethB, WithinAbs(offLine(m.point, m.pointB, m.axisB) * m.teethA, 1e-9));
  REQUIRE_THAT(std::abs(m.tangent.y), WithinAbs(1, 1e-12));

  REQUIRE(findMeshes({{0, spur(8, {0, 0, 0}), false}, {1, spur(24, {43, 0, 0}), false}}).empty());   // too far
  REQUIRE(findMeshes({{0, spur(8, {0, 0, 0}), false}, {1, spur(24, {36, 0, 0}), false}}).empty());   // jammed together
  REQUIRE(findMeshes({{0, spur(8, {0, 0, 0}), false}, {1, spur(24, {40, 0, 20}), false}}).empty());  // on the next plane along
  REQUIRE(findMeshes({{0, spur(8, {0, 0, 0}), false}, {1, spur(24, {0, 0, 10}), false}}).empty());   // stacked on one shaft
  REQUIRE(findMeshes({{0, spur(8, {0, 0, 0}), false}, {0, spur(24, {40, 0, 0}), false}}).empty());   // the same piece
}

TEST_CASE("a builder's diagonal mesh is accepted, a loose one is not", "[kin][gears]") {
  REQUIRE(findMeshes({{0, spur(16, {0, 0, 0}), false}, {1, spur(16, {40, 10, 0}), false}}).size() == 1);  // 41.2 for 40
  REQUIRE(findMeshes({{0, spur(16, {0, 0, 0}), false}, {1, spur(16, {40, 20, 0}), false}}).empty());      // 44.7
}

TEST_CASE("three gears in a row are two meshes", "[kin][gears]") {
  const auto meshes = findMeshes({{0, spur(8, {0, 0, 0}), false}, {1, spur(24, {40, 0, 0}), false}, {2, spur(8, {80, 0, 0}), false}});
  REQUIRE(meshes.size() == 2);
  REQUIRE((meshes[0].a == 0 && meshes[0].b == 1 && meshes[1].a == 1 && meshes[1].b == 2));
}

TEST_CASE("bevels mesh on shafts that meet, when their teeth face each other", "[kin][gears]") {
  // Two 12-tooth bevels (radius 15) whose shafts meet at the origin.
  const Toothed a = bevel(12, {0, 0, -15}, {0, 0, 1}, {0, 0, 1});
  const Toothed b = bevel(12, {-15, 0, 0}, {1, 0, 0}, {1, 0, 0});
  const auto meshes = findMeshes({{0, a, false}, {1, b, false}});
  REQUIRE(meshes.size() == 1);
  REQUIRE(meshes[0].kind == MeshKind::Crossed);
  REQUIRE_THAT(offLine(meshes[0].point, a.centre, a.axis), WithinAbs(offLine(meshes[0].point, b.centre, b.axis), 1e-9));
  REQUIRE_THAT(std::abs(meshes[0].tangent.y), WithinAbs(1, 1e-12));

  // The same gear turned to face away.
  REQUIRE(findMeshes({{0, a, false}, {1, bevel(12, {-15, 0, 0}, {1, 0, 0}, {-1, 0, 0}), false}}).empty());
  // Shafts that pass each other without meeting.
  REQUIRE(findMeshes({{0, a, false}, {1, bevel(12, {-15, 8, 0}, {1, 0, 0}, {1, 0, 0}), false}}).empty());
  // Unequal bevels: 12 and 20 teeth; the point's distances to the shafts are as 12 : 20.
  const Toothed c = bevel(20, {-15, 0, 0}, {1, 0, 0}, {1, 0, 0});
  const Toothed d = bevel(12, {0, 0, -25}, {0, 0, 1}, {0, 0, 1});
  const auto uneven = findMeshes({{0, d, false}, {1, c, false}});
  REQUIRE(uneven.size() == 1);
  REQUIRE_THAT(offLine(uneven[0].point, d.centre, d.axis) * 20, WithinAbs(offLine(uneven[0].point, c.centre, c.axis) * 12, 1e-9));
}

TEST_CASE("a worm drives a gear beside it", "[kin][gears]") {
  Toothed worm;
  worm.kind = ToothKind::Worm;
  worm.teeth = 1;
  worm.axis = {0, 0, 1};
  worm.pitchRadius = 10;
  worm.width = 40;
  worm.lead = 8;
  const Toothed gear = spur(24, {40, 0, 0}, {0, 1, 0});
  const auto meshes = findMeshes({{0, gear, false}, {1, worm, true}});
  REQUIRE(meshes.size() == 1);
  REQUIRE((meshes[0].kind == MeshKind::Worm && meshes[0].a == 1 && meshes[0].b == 0 && meshes[0].teethA == 1 && meshes[0].teethB == 24));
  REQUIRE_THAT(meshes[0].travel, WithinAbs(8, 1e-12));
  REQUIRE(findMeshes({{0, spur(24, {40, 0, 0}, {0, 0, 1}), false}, {1, worm, true}}).empty());  // parallel to the worm
  REQUIRE(findMeshes({{0, spur(24, {40, 0, 60}, {0, 1, 0}), false}, {1, worm, true}}).empty());  // past its end
}

TEST_CASE("a gear on a rack moves it one circumference a turn", "[kin][gears]") {
  Toothed rack;
  rack.kind = ToothKind::Rack;
  rack.teeth = 10;
  rack.axis = {1, 0, 0};
  rack.centre = {0, -4, 0};
  rack.length = 80;
  rack.width = 20;
  rack.face = {0, -1, 0};
  const auto meshes = findMeshes({{0, rack, false}, {1, spur(8, {20, -14, 0}), false}});
  REQUIRE(meshes.size() == 1);
  REQUIRE((meshes[0].kind == MeshKind::Rack && meshes[0].a == 1 && meshes[0].b == 0 && meshes[0].teethB == 0));
  REQUIRE_THAT(meshes[0].travel, WithinAbs(2 * 3.14159265358979323846 * 10, 1e-9));
  REQUIRE_THAT(meshes[0].point.y, WithinAbs(-4, 1e-12));
  REQUIRE(findMeshes({{0, rack, false}, {1, spur(8, {20, -17, 0}), false}}).size() == 1);         // 3 high, as 8880's rack is
  REQUIRE(findMeshes({{0, rack, false}, {1, spur(8, {20, -20, 0}), false}}).empty());             // 6 high
  REQUIRE(findMeshes({{0, rack, false}, {1, spur(8, {20, 6, 0}), false}}).empty());               // under the rack
  REQUIRE(findMeshes({{0, rack, false}, {1, spur(8, {60, -14, 0}), false}}).empty());             // off its end
  REQUIRE(findMeshes({{0, rack, false}, {1, spur(8, {20, -14, 0}, {1, 0, 0}), false}}).empty());  // turned along it
  REQUIRE(findMeshes({{0, rack, true}, {1, spur(8, {20, -14, 0}), false}}).empty());              // a worm's thread, not a rack
}

TEST_CASE("the gear table: variants, placement and bad rows", "[kin][gears]") {
  GearDb db;
  const size_t added = db.load(R"({"parts": {
    "3648": [{"kind": "spur", "teeth": 24, "axis": [0, 0, 2], "centre": [0, 0, 0], "pitchRadius": 30, "width": 9.5}],
    "6589": [{"kind": "bevel", "teeth": 12, "axis": [0, 0, 1], "centre": [0, 0, 2.5], "pitchRadius": 15, "width": 10, "facing": [0, 0, 1]}],
    "bad1": [{"kind": "spur", "teeth": 0, "axis": [0, 0, 1], "centre": [0, 0, 0], "pitchRadius": 30, "width": 9}],
    "bad2": [{"kind": "cog", "teeth": 8, "axis": [0, 0, 1], "centre": [0, 0, 0], "pitchRadius": 10, "width": 9}],
    "bad3": [{"kind": "spur", "teeth": 8, "axis": [0, 0, 0], "centre": [0, 0, 0], "pitchRadius": 10, "width": 9}],
    "bad4": [{"kind": "rack", "teeth": 8, "axis": [1, 0, 0], "centre": [0, 0, 0], "width": 9}],
    "bad5": "nonsense",
    "bad6": [{"kind": "spur", "teeth": 8, "axis": [0, 0, 1], "centre": [0, "x", 0], "pitchRadius": 10, "width": 9}]
  }})");
  REQUIRE(added == 2);
  REQUIRE(db.get("3648.dat").size() == 1);
  REQUIRE_THAT(db.get("3648").front().axis.z, WithinAbs(1, 1e-12));
  REQUIRE(db.get("3648A.DAT").size() == 1);
  REQUIRE(db.get("6589p01").size() == 1);
  REQUIRE(db.get("3001.dat").empty());
  REQUIRE(db.get("bad1").empty());
  REQUIRE(db.get("").empty());
  REQUIRE(GearDb().load("not json") == 0);
  REQUIRE(GearDb().load("[]") == 0);

  // Placed a quarter turn about y and moved: the axis and centre follow.
  Xform xf;
  xf.r = Mat3{{0, 0, 1, 0, 1, 0, -1, 0, 0}};
  xf.t = {100, 0, 0};
  const Toothed t = placed(db.get("6589").front(), xf);
  REQUIRE_THAT(t.axis.x, WithinAbs(1, 1e-12));
  REQUIRE_THAT(t.centre.x, WithinAbs(102.5, 1e-12));
  REQUIRE_THAT(t.facing.x, WithinAbs(1, 1e-12));
}

TEST_CASE("the reference sets contain their hand-checked gear meshes", "[kin][gears][data]") {
  const char* dir = std::getenv("BM_LDRAW_DIR");
  if (!dir) SKIP("BM_LDRAW_DIR is not set");
  const fs::path repo = fs::path(dir).parent_path().parent_path();
  GearDb db;
  REQUIRE(db.load(slurp(repo / "native" / "data" / "gears.json")) > 100);
  const ldraw::Library library(dir);
  for (const char* set : {"8880", "42000", "5590"}) {
    const auto expected = nlohmann::json::parse(slurp(repo / "benchmarks" / "mechanisms" / (std::string(set) + ".expected.json")), nullptr, false);
    if (!expected.is_object()) SKIP("no expected file for " << set);
    const fs::path file = repo / expected["model"]["file"].get<std::string>();
    if (!fs::exists(file)) SKIP(file.string() << " is not here");
    const Model model = io::load(file, library);
    const auto meshes = findMeshes(model, db);
    auto pieceAt = [&](const nlohmann::json& ref) -> int {
      const std::string part = ref["part"].get<std::string>() + ".dat";
      const Vec3 at{ref["at"][0].get<double>(), ref["at"][1].get<double>(), ref["at"][2].get<double>()};
      int best = -1;
      double bestD = 3.0;
      for (size_t i = 0; i < model.pieces().size(); i++) {
        if (model.pieces()[i].part != part) continue;
        const double d = length(model.pieces()[i].world.t - at);
        if (d < bestD) bestD = d, best = static_cast<int>(i);
      }
      return best;
    };
    int checked = 0;
    for (const auto& mechanism : expected["mechanisms"])
      for (const auto& check : mechanism["checks"]) {
        const std::string type = check["type"].get<std::string>();
        if (type != "gearMesh" && type != "rackPinion") continue;
        const auto& refA = type == "gearMesh" ? check["a"] : check["pinion"];
        const auto& refB = type == "gearMesh" ? check["b"] : check["rack"];
        INFO(set << ": " << check["label"].get<std::string>());
        const int a = pieceAt(refA), b = pieceAt(refB);
        REQUIRE(a >= 0);
        REQUIRE(b >= 0);
        const GearMesh* found = nullptr;
        for (const GearMesh& m : meshes)
          if ((int(m.a) == a && int(m.b) == b) || (int(m.a) == b && int(m.b) == a)) found = &m;
        REQUIRE(found != nullptr);
        if (check.contains("ratio") && check["ratio"].is_number()) {
          const int ta = int(found->a) == a ? found->teethA : found->teethB, tb = int(found->a) == a ? found->teethB : found->teethA;
          REQUIRE_THAT(double(tb) / ta, WithinAbs(check["ratio"].get<double>(), 0.002));
        }
        checked++;
      }
    REQUIRE(checked > 0);
  }
}

TEST_CASE("screw rows are read, and bad ones skipped", "[kin][gears][screw]") {
  bm::kin::GearDb db;
  REQUIRE(db.loadScrews(R"({"parts":{"92693c01":{"input":"92695.dat","piston":"92696","leadLduPerTurn":3.0},
    "1":{"input":"2","piston":"3","leadLduPerTurn":0}, "4":{"input":"5"}, "6":7}})") == 1);
  const auto* s = db.screw("92693C01.dat");
  REQUIRE(s);
  REQUIRE((s->input == "92695" && s->piston == "92696" && s->lead == 3.0));
  REQUIRE(db.screw("1") == nullptr);
  REQUIRE(db.loadScrews("not json") == 0);
}
