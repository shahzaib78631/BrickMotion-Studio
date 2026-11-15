#include <catch2/catch_test_macros.hpp>
#include <catch2/matchers/catch_matchers_floating_point.hpp>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <sstream>
#include "bm/io.h"

using namespace bm;
namespace fs = std::filesystem;
using Catch::Matchers::WithinAbs;
using json = nlohmann::ordered_json;

static fs::path fx(const char* name) { return fs::path(BM_FIXTURES) / "models" / name; }
static ldraw::Library lib() { return ldraw::Library(fs::path(BM_FIXTURES) / "lib"); }
static std::string slurp(const fs::path& p) {
  std::ifstream in(p, std::ios::binary);
  std::ostringstream s;
  s << in.rdbuf();
  return s.str();
}

TEST_CASE("a plan file round-trips, unknown fields included", "[io][plan]") {
  const std::string text = slurp(fx("tower.plan.json"));
  const io::PlanDoc doc = io::readPlan(text);
  const json before = json::parse(text), after = json::parse(io::writePlan(doc));
  REQUIRE(before == after);
  REQUIRE(after["futureTop"]["keep"].size() == 3);
  REQUIRE(after["steps"][0]["futureStep"] == true);
  REQUIRE(after["steps"][0]["pieces"][0]["futurePiece"] == "x");
  // Key order is kept, so a saved file diffs cleanly against the one that was opened.
  REQUIRE(after.begin().key() == "format");
}

TEST_CASE("the app's own plan files round-trip", "[io][plan][data]") {
  const char* dir = std::getenv("BM_LDRAW_DIR");
  if (!dir) SKIP("BM_LDRAW_DIR is not set");
  for (const char* name : {"test-small.plan.json", "mini-jet.plan.json"}) {
    const fs::path file = fs::path(dir).parent_path() / "data" / name;
    const std::string text = slurp(file);
    REQUIRE_FALSE(text.empty());
    REQUIRE(json::parse(text) == json::parse(io::writePlan(io::readPlan(text))));
    const ldraw::Library library(dir);
    ldraw::PartCache cache(library, fs::temp_directory_path() / "bm_io_test_cache_real");
    const Model m = io::fromPlan(io::readPlan(text), library, cache);
    REQUIRE(m.pieces().size() > 5);
    REQUIRE(m.report().missing.empty());
  }
}

TEST_CASE("grid placements follow the app's rule", "[io][plan]") {
  const ldraw::Library library = lib();
  ldraw::PartCache cache(library, fs::temp_directory_path() / "bm_io_test_cache");
  const Model m = io::fromPlan(io::readPlan(slurp(fx("tower.plan.json"))), library, cache);
  REQUIRE(m.pieces().size() == 6);
  REQUIRE(m.stepCount() == 2);

  // A 2x4 brick (body 80 x 24 x 40 LDU) at grid 0,0,0: min corner on the origin, bottom at y 0.
  const Piece& brick = m.pieces()[0];
  REQUIRE(brick.part == "3001.dat");
  REQUIRE(brick.color == 4);
  const Box wb = cache.get(brick.part)->body.transformed(brick.world);
  REQUIRE_THAT(wb.min.x, WithinAbs(0, 1e-9));
  REQUIRE_THAT(wb.max.x, WithinAbs(80, 1e-9));
  REQUIRE_THAT(wb.min.z, WithinAbs(0, 1e-9));
  REQUIRE_THAT(wb.max.z, WithinAbs(40, 1e-9));
  REQUIRE_THAT(wb.max.y, WithinAbs(0, 1e-9));
  REQUIRE_THAT(wb.min.y, WithinAbs(-24, 1e-9));

  REQUIRE(m.pieces()[1].color == 4);  // "Red" by name
  REQUIRE_THAT(m.pieces()[1].world.t.x, WithinAbs(90, 1e-9));  // x = 4 studs, 1 wide: centre at 4.5 studs

  // The submodel "cap" (two 1x1s side by side: 2 x 1 studs) turned 90 at grid 0, 3 plates up.
  const Piece& capA = m.pieces()[2];
  REQUIRE(capA.path == std::vector<std::string>{"cap"});
  REQUIRE(capA.color == 71);  // 16 in a plan is the default grey
  REQUIRE(capA.step == 1);
  Box cap;
  cap.merge(cache.get("3005.dat")->body.transformed(capA.world));
  cap.merge(Box{{-10, 0, -10}, {10, 8, 10}}.transformed(m.pieces()[3].world));
  REQUIRE_THAT(cap.min.x, WithinAbs(0, 1e-9));
  REQUIRE_THAT(cap.max.x, WithinAbs(20, 1e-9));
  REQUIRE_THAT(cap.min.z, WithinAbs(0, 1e-9));
  REQUIRE_THAT(cap.max.z, WithinAbs(40, 1e-9));
  REQUIRE_THAT(cap.max.y, WithinAbs(-24, 1e-9));  // bottom at 3 plates
  REQUIRE(m.pieces()[3].part == "mine.dat");  // an inline part from the plan's "parts"

  const Piece& raw = m.pieces()[4];
  REQUIRE(raw.id == "raw1");
  REQUIRE((raw.world.t == Vec3{100, -24, 0}));

  REQUIRE(m.pieces()[5].color == 71);
  REQUIRE(m.report().unknownColors == std::vector<std::string>{"no-such-colour"});
}

TEST_CASE("bad plan files are errors with a message, never a crash", "[io][plan]") {
  auto fails = [](const std::string& text) {
    try {
      io::readPlan(text);
    } catch (const io::Error& e) {
      return std::string(e.what()).size() > 0;
    }
    return false;
  };
  REQUIRE(fails(""));
  REQUIRE(fails("[1,2,3]"));
  REQUIRE(fails("{\"format\":\"brickmotion-plan\",\"version\":1,\"name\":\"x\"}"));  // no steps
  REQUIRE(fails("{\"format\":\"something-else\",\"steps\":[]}"));
  REQUIRE(fails("{\"format\":\"brickmotion-plan\",\"version\":1,\"name\":\"x\",\"steps\":{}}"));
  REQUIRE(fails(std::string("{\"format\":\"brickmotion-plan\",\"name\":\"\xff\xfe\",\"steps\":[]}")));  // not UTF-8
  REQUIRE(fails("{\"format\":\"brickmotion-plan\",\"version\":1,\"name\":\"x\",\"steps\":[{\"pieces\":[{\"part\":3}]}]}"));
  // A turn that is not a quarter turn has no grid placement.
  REQUIRE(fails("{\"format\":\"brickmotion-plan\",\"version\":1,\"name\":\"x\",\"steps\":[{\"pieces\":[{\"part\":\"3001\",\"x\":0,\"y\":0,\"z\":0,\"rot\":45}]}]}"));
  REQUIRE(fails("{\"format\":\"brickmotion-plan\",\"version\":1,\"name\":\"x\",\"steps\":[{\"pieces\":[{\"part\":\"3001\",\"color\":4}]}]}"));  // no placement
}

TEST_CASE("a plan with a submodel loop or a missing submodel still loads", "[io][plan][focus]") {
  const ldraw::Library library = lib();
  ldraw::PartCache cache(library, fs::temp_directory_path() / "bm_io_test_cache");
  const char* text = R"({"format":"brickmotion-plan","version":1,"name":"x",
    "steps":[{"pieces":[{"part":"3005","color":4,"x":0,"y":0,"z":0,"rot":0},{"submodel":"a","x":2,"y":0,"z":0,"rot":0},{"submodel":"nowhere","x":5,"y":0,"z":0,"rot":0}]}],
    "submodels":{"a":{"steps":[{"pieces":[{"part":"3005","color":1,"x":0,"y":0,"z":0,"rot":0},{"submodel":"a","x":0,"y":3,"z":0,"rot":0}]}]}}})";
  const Model m = io::fromPlan(io::readPlan(text), library, cache);
  REQUIRE(m.pieces().size() == 2);
  REQUIRE(m.report().cycles == std::vector<std::string>{"a > a"});
  REQUIRE(m.report().missing == std::vector<std::string>{"nowhere"});
}

TEST_CASE("formats are told apart by content, not by file name", "[io]") {
  REQUIRE(io::sniff("a.txt", "0 A model\n1 4 0 0 0 1 0 0 0 1 0 0 0 1 3001.dat\n") == io::Format::LDraw);
  REQUIRE(io::sniff("a.ldr", "  {\"format\":\"brickmotion-plan\",\"version\":1") == io::Format::Plan);
  REQUIRE(io::sniff("a.ldr", "{\"format\":\"brickmotion-project\",\"version\":1,\"plan\":{\"format\":\"brickmotion-plan\"") == io::Format::Project);
  REQUIRE(io::sniff("a.ldr", std::string("PK\x03\x04....", 8)) == io::Format::StudioIo);
  REQUIRE(io::sniff("a.io", "") == io::Format::LDraw);
}

TEST_CASE("plan and project files load through io::load", "[io]") {
  const ldraw::Library library = lib();
  REQUIRE(io::load(fx("tower.plan.json"), library).pieces().size() == 6);
  const fs::path project = fs::temp_directory_path() / "bm_io_test.brickmotion";
  { std::ofstream f(project); f << "{\"format\":\"brickmotion-project\",\"version\":1,\"timelines\":[],\"plan\":" << slurp(fx("tower.plan.json")) << "}"; }
  REQUIRE(io::load(project, library).pieces().size() == 6);
  { std::ofstream f(project); f << "{\"format\":\"brickmotion-project\",\"version\":7,\"plan\":{}}"; }
  REQUIRE_THROWS_AS(io::load(project, library), io::Error);
  fs::remove(project);
}

TEST_CASE("Studio files: plain and password-protected archives", "[io][studio][data]") {
  const char* data = std::getenv("BM_DATA_DIR");
  const fs::path dir = fs::path(data ? data : "/Users/mac/Projects/BrickMotion-Data") / "MOC";
  if (!fs::exists(dir / "Kombi Pickup.io")) SKIP("no Studio files in BM_DATA_DIR/MOC");
  for (const char* name : {"Kombi Pickup.io", "Injector Drill STUDIO file.io", "MOC-273843_Legopharos_Bell_Tower.io"}) {
    INFO(name);
    const std::string bytes = slurp(dir / name);
    REQUIRE(io::sniff(dir / name, bytes.substr(0, 64)) == io::Format::StudioIo);
    const std::string text = io::readStudioIo(bytes);
    REQUIRE(text.find("\n1 ") != std::string::npos);  // it holds part references
  }
}

TEST_CASE("damaged Studio archives are errors", "[io][studio]") {
  REQUIRE_THROWS_AS(io::readStudioIo("PK\x03\x04 not really a zip"), io::Error);
  REQUIRE_THROWS_AS(io::readStudioIo(""), io::Error);
  std::string junk(4096, 'P');
  REQUIRE_THROWS_AS(io::readStudioIo(junk), io::Error);
}
