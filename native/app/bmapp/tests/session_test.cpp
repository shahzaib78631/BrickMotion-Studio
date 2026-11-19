#include <catch2/catch_test_macros.hpp>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include "bm/io.h"
#include "bm/ldraw/library.h"
#include "bm/ldraw/part_cache.h"
#include "bmapp/session.h"

namespace fs = std::filesystem;

namespace {
fs::path repo() { return fs::path(BM_REPO); }
fs::path helicopter() { return repo() / "samples" / "helicopter" / "helicopter.mpd"; }
}  // namespace

TEST_CASE("open reads the helicopter and reports nothing missing", "[bmapp]") {
  bmapp::Session session;
  const bmapp::OpenResult r = session.open(helicopter().string());
  REQUIRE(r.ok);
  CHECK(r.error.empty());
  CHECK(session.title() == "helicopter");
  CHECK(session.imported());

  const bm::ldraw::Library lib(bmapp::Session::ldrawDirectory());
  bm::ldraw::PartCache parts(lib, bm::ldraw::PartCache::defaultDirectory());
  const bm::Model model = bm::io::load(helicopter(), lib, &parts);
  CHECK(session.pieceCount() == model.pieces().size());
}

TEST_CASE("a project is not an import", "[bmapp]") {
  const fs::path dir = fs::temp_directory_path() / "bmapp_session_test";
  fs::create_directories(dir);
  std::ifstream in(fs::path(BM_FIXTURES) / "models" / "tower.plan.json");
  const std::string plan((std::istreambuf_iterator<char>(in)), std::istreambuf_iterator<char>());
  const fs::path project = dir / "tower.brickmotion";
  std::ofstream(project) << R"({"format":"brickmotion-project","version":1,"plan":)" << plan << "}";

  bmapp::Session session;
  const bmapp::OpenResult r = session.open(project.string());
  REQUIRE(r.ok);
  CHECK_FALSE(session.imported());
  CHECK(session.title() == "tower");
  CHECK(session.pieceCount() > 0);
}

TEST_CASE("open fails with a sentence", "[bmapp]") {
  bmapp::Session session;
  const bmapp::OpenResult r = session.open("/nonexistent/nothing.ldr");
  CHECK_FALSE(r.ok);
  CHECK_FALSE(r.error.empty());
  CHECK(session.pieceCount() == 0);
}

TEST_CASE("summarize names the distinct parts of some pieces", "[bmapp]") {
  bmapp::Session session;
  REQUIRE(session.open(helicopter().string()).ok);
  const bmapp::Summary none = session.summarize({});
  CHECK(none.count == 0);
  CHECK(none.parts.empty());
  const bmapp::Summary two = session.summarize({0, 0, 1, 999999});
  CHECK(two.count == 2);  // duplicates and unknown pieces dropped
  CHECK_FALSE(two.parts.empty());
  CHECK(two.parts.size() <= 2);
}

#include "bm/version.h"
TEST_CASE("the engine version reaches Swift", "[bmapp]") {
  CHECK(bmapp::Session::engineVersion() == std::string(bm::version()));
  CHECK_FALSE(bmapp::Session::engineVersion().empty());
}
