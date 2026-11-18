#include <catch2/catch_test_macros.hpp>
#include <catch2/matchers/catch_matchers_floating_point.hpp>
#include <algorithm>
#include <filesystem>
#include <fstream>
#include "bm/io.h"
#include "bm/model.h"

using namespace bm;
namespace fs = std::filesystem;
using Catch::Matchers::WithinAbs;

static fs::path fx(const char* name) { return fs::path(BM_FIXTURES) / "models" / name; }
static ldraw::Library lib() { return ldraw::Library(fs::path(BM_FIXTURES) / "lib"); }

TEST_CASE("a submodel used twice is expanded twice, with composed placements", "[model]") {
  const ldraw::Library library = lib();
  const Model m = io::load(fx("twice.mpd"), library);
  REQUIRE(m.pieces().size() == 6);  // 3001, 2 x (3005, 3005), custom
  REQUIRE(m.submodels() == std::vector<std::string>{"wheel pair.ldr"});
  REQUIRE(m.stepCount() == 3);
  const Piece& a = m.pieces()[1];
  REQUIRE(a.part == "3005.dat");
  REQUIRE(a.color == 16);  // 16 under a 16 reference stays 16
  REQUIRE((a.world.t == Vec3{100, 0, 0}));
  REQUIRE(a.step == 1);
  REQUIRE(a.path == std::vector<std::string>{"wheel pair.ldr"});
  const Piece& b = m.pieces()[4];  // second 3005 of the second, turned, use
  REQUIRE(b.part == "3005.dat");
  REQUIRE(b.color == 1);  // explicit colour kept
  REQUIRE(m.pieces()[3].color == 2);  // 16 inherits the reference's colour
  // (20,0,0) through x' = z, z' = -x, then +(0,0,200)
  REQUIRE_THAT(b.world.t.x, WithinAbs(0, 1e-9));
  REQUIRE_THAT(b.world.t.z, WithinAbs(180, 1e-9));
  REQUIRE(b.step == 2);
  REQUIRE(m.pieces()[5].part == "custom.dat");  // an inline part is a piece, not a submodel
  std::vector<std::string> ids;
  for (const Piece& p : m.pieces()) ids.push_back(p.id);
  std::sort(ids.begin(), ids.end());
  REQUIRE(std::adjacent_find(ids.begin(), ids.end()) == ids.end());  // ids are unique
  REQUIRE(m.report().missing.empty());
}

TEST_CASE("bounds cover every piece, inline parts included", "[model]") {
  const ldraw::Library library = lib();
  const Model m = io::load(fx("twice.mpd"), library);
  ldraw::PartCache cache(library, fs::temp_directory_path() / "bm_model_test_cache");
  const Box b = m.bounds(cache);
  REQUIRE_THAT(b.min.x, WithinAbs(-40, 1e-6));
  REQUIRE_THAT(b.max.x, WithinAbs(130, 1e-6));
  REQUIRE_THAT(b.min.y, WithinAbs(-24, 1e-6));  // the custom part sits at y -24, 5 tall
  REQUIRE_THAT(b.max.z, WithinAbs(210, 1e-6));
}

TEST_CASE("missing parts and submodels are reported and the pieces kept", "[model][focus]") {
  const ldraw::Library library = lib();
  const Model m = io::load(fx("holes.ldr"), library);
  REQUIRE(m.pieces().size() == 3);
  REQUIRE(m.report().missing == std::vector<std::string>{"gone.dat", "lost sub.ldr"});
  REQUIRE(m.report().skippedLines == 1);
  ldraw::PartCache cache(library, fs::temp_directory_path() / "bm_model_test_cache");
  REQUIRE_FALSE(m.bounds(cache).empty());
}

TEST_CASE("a submodel loop is cut and reported", "[model][focus]") {
  const ldraw::Library library = lib();
  const Model m = io::load(fx("cycle.mpd"), library);
  REQUIRE(m.pieces().size() == 2);  // a's brick and b's brick, once each
  REQUIRE(m.report().cycles.size() == 2);  // a -> a, and a -> b -> a
  REQUIRE(std::find(m.report().cycles.begin(), m.report().cycles.end(), "a.ldr > a.ldr") != m.report().cycles.end());
  REQUIRE(std::find(m.report().cycles.begin(), m.report().cycles.end(), "a.ldr > b.ldr > a.ldr") != m.report().cycles.end());
}

TEST_CASE("a model survives a round trip through LDraw text", "[model]") {
  const ldraw::Library library = lib();
  const Model m = io::load(fx("twice.mpd"), library);
  const fs::path out = fs::temp_directory_path() / "bm_roundtrip_test.mpd";
  { std::ofstream f(out); f << io::toLDraw(m); }
  const Model again = io::load(out, library);
  REQUIRE(again.pieces().size() == m.pieces().size());
  REQUIRE(again.stepCount() == m.stepCount());
  for (size_t i = 0; i < m.pieces().size(); i++) {
    const Piece& a = m.pieces()[i];
    const Piece& b = again.pieces()[i];
    INFO(i);
    REQUIRE(a.part == b.part);
    REQUIRE(a.color == b.color);
    REQUIRE(a.step == b.step);
    for (int k = 0; k < 9; k++) REQUIRE_THAT(b.world.r.m[k], WithinAbs(a.world.r.m[k], 1e-6));
    REQUIRE_THAT(length(a.world.t - b.world.t), WithinAbs(0, 1e-6));
  }
  ldraw::PartCache cache(library, fs::temp_directory_path() / "bm_model_test_cache");
  REQUIRE_THAT(again.bounds(cache).min.y, WithinAbs(-24, 1e-6));  // the inline part's geometry came along
  fs::remove(out);
}

TEST_CASE("an empty file is an empty model; a missing file is an error", "[model]") {
  const ldraw::Library library = lib();
  const fs::path empty = fs::temp_directory_path() / "bm_empty_test.ldr";
  { std::ofstream f(empty); }
  REQUIRE(io::load(empty, library).pieces().empty());
  fs::remove(empty);
  REQUIRE_THROWS_AS(io::load("/nonexistent/x.ldr", library), io::Error);
  REQUIRE_THROWS_AS(io::load(fs::path(BM_FIXTURES), library), io::Error);  // a directory
}

TEST_CASE("inline part meshes are cached per model and shared by model copies", "[model][cache]") {
  const ldraw::Library library = lib();
  Model m = io::load(fx("twice.mpd"), library);
  ldraw::PartCache cache(library, fs::temp_directory_path() / "bm_model_test_cache");
  REQUIRE(m.library().isInline("custom.dat"));
  const auto a = m.mesh("custom.dat", cache);
  const auto b = m.mesh("custom.dat", cache);
  REQUIRE(a == b);
  REQUIRE(m.mesh(" CUSTOM.DAT ", cache) == a);
  REQUIRE_FALSE(a->triangles.empty());
  const Model copy = m;
  REQUIRE(copy.mesh("custom.dat", cache) == a);
}
