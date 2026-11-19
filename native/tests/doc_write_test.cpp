#include <catch2/catch_test_macros.hpp>
#include <algorithm>
#include <cmath>
#include <filesystem>
#include <fstream>
#include <sstream>
#include "bm/doc/source.h"
#include "bm/doc/write.h"
#include "bm/io.h"

using namespace bm;
namespace fs = std::filesystem;
using json = nlohmann::ordered_json;

namespace {
fs::path fixtures() { return fs::path(BM_FIXTURES); }
fs::path repo() { return fixtures().parent_path().parent_path().parent_path(); }
ldraw::Library fixtureLib() { return ldraw::Library(fixtures() / "lib"); }

std::string slurp(const fs::path& p) {
  std::ifstream in(p, std::ios::binary);
  std::ostringstream s;
  s << in.rdbuf();
  return s.str();
}

std::vector<fs::path> projectFiles() {
  std::vector<fs::path> out;
  for (const char* name : {"tests/fixtures/models/police-car.brickmotion", "models/schroder-house/schroder-house.brickmotion",
                           "models/civilmix-house/civilmix-house.brickmotion"})
    if (fs::exists(repo() / name)) out.push_back(repo() / name);
  return out;
}

/// The paths of leaves that differ between two JSON values.
void diff(const json& a, const json& b, const std::string& at, std::vector<std::string>& out) {
  if (a.type() != b.type() || (!a.is_structured() && a != b)) {
    out.push_back(at);
    return;
  }
  if (a.is_object()) {
    for (const auto& [k, v] : a.items()) {
      if (!b.contains(k)) out.push_back(at + "/" + k);
      else diff(v, b[k], at + "/" + k, out);
    }
    for (const auto& [k, v] : b.items())
      if (!a.contains(k)) out.push_back(at + "/" + k);
  } else if (a.is_array()) {
    if (a.size() != b.size()) out.push_back(at + "#size");
    for (size_t i = 0; i < std::min(a.size(), b.size()); i++) diff(a[i], b[i], at + "/" + std::to_string(i), out);
  }
}

bool near(const Xform& a, const Xform& b, double eps) {
  for (int i = 0; i < 9; i++)
    if (std::abs(a.r.m[i] - b.r.m[i]) > eps) return false;
  return std::abs(a.t.x - b.t.x) <= eps && std::abs(a.t.y - b.t.y) <= eps && std::abs(a.t.z - b.t.z) <= eps;
}

Model loadText(const std::string& text, const char* name, const ldraw::Library& library) {
  const fs::path p = fs::temp_directory_path() / name;
  { std::ofstream f(p, std::ios::binary); f << text; }
  ldraw::PartCache cache(library, fs::temp_directory_path() / "bm_doc_write_cache");
  Model m = io::load(p, library, &cache);
  fs::remove(p);
  return m;
}
}  // namespace

TEST_CASE("project round trip keeps every other field", "[doc][write][focus]") {
  const std::vector<fs::path> files = projectFiles();
  REQUIRE_FALSE(files.empty());
  for (const fs::path& file : files) {
    INFO(file.string());
    const std::string text = slurp(file);
    const doc::Project project = doc::readProjectFile(text);
    const std::string written = doc::writeProject(project, doc::fromPlan(io::readProject(text)), false);
    json before = json::parse(text), after = json::parse(written);
    REQUIRE(after.contains("savedAt"));
    before.erase("savedAt"), after.erase("savedAt");
    REQUIRE(after == before);
    REQUIRE(after.begin().key() == "format");
  }
}

TEST_CASE("edited project changes only the edited item", "[doc][write]") {
  const fs::path file = repo() / "tests/fixtures/models/police-car.brickmotion";
  REQUIRE(fs::exists(file));
  const std::string text = slurp(file);
  doc::Source source = doc::fromPlan(io::readProject(text));
  auto& items = source.root.steps[0].items;
  const auto part = std::find_if(items.begin(), items.end(), [](const doc::Item& i) { return !i.submodel; });
  REQUIRE(part != items.end());
  doc::Item& item = *part;
  item.colorText = item.color == 1 ? "4" : "1";
  item.color = std::stoi(item.colorText);
  const json before = json::parse(text), after = json::parse(doc::writeProject(doc::readProjectFile(text), source, true));
  std::vector<std::string> changed;
  diff(before["plan"], after["plan"], "plan", changed);
  REQUIRE(changed.size() == 1);
  if (before.contains("settings")) REQUIRE(after["settings"] == before["settings"]);
  REQUIRE_FALSE(after.contains("timelines"));
}

TEST_CASE("delete drops the stale animation", "[doc][write]") {
  const std::string text = slurp(repo() / "tests/fixtures/models/police-car.brickmotion");
  doc::Source source = doc::fromPlan(io::readProject(text));
  source.root.steps[0].items.erase(source.root.steps[0].items.begin());
  const std::string written = doc::writeProject(doc::readProjectFile(text), source, true);
  const json after = json::parse(written);
  REQUIRE_FALSE(after.contains("timelines"));
  REQUIRE(io::readProject(written).json["steps"][0]["pieces"].size() + 1 == json::parse(text)["plan"]["steps"][0]["pieces"].size());
}

TEST_CASE("mpd keeps submodels and steps", "[doc][write]") {
  const ldraw::Library library = fixtureLib();
  ldraw::PartCache cache(library, fs::temp_directory_path() / "bm_doc_write_cache");
  for (const char* name : {"twice.mpd", "holes.ldr"}) {
    INFO(name);
    const fs::path file = fixtures() / "models" / name;
    const Model want = io::load(file, library, &cache);
    const std::string mpd = doc::writeMpd(doc::fromFile(file), library);
    const Model got = loadText(mpd, "bm_doc_write.mpd", library);
    REQUIRE(got.pieces().size() == want.pieces().size());
    CHECK(got.submodels() == want.submodels());
    for (size_t i = 0; i < want.pieces().size(); i++) {
      INFO("piece " << i);
      CHECK(got.pieces()[i].part == want.pieces()[i].part);
      CHECK(got.pieces()[i].color == want.pieces()[i].color);
      CHECK(got.pieces()[i].step == want.pieces()[i].step);
      CHECK(got.pieces()[i].steps == want.pieces()[i].steps);
      CHECK(got.pieces()[i].id == want.pieces()[i].id);
      CHECK(near(got.pieces()[i].world, want.pieces()[i].world, 1e-6));
    }
  }
}

TEST_CASE("a plan with grid placements and inline parts exports to MPD in place", "[doc][write]") {
  const ldraw::Library library = fixtureLib();
  ldraw::PartCache cache(library, fs::temp_directory_path() / "bm_doc_write_cache");
  const io::PlanDoc plan = io::readPlan(slurp(fixtures() / "models" / "tower.plan.json"));
  const Model want = io::fromPlan(plan, library, cache);
  const Model got = loadText(doc::writeMpd(doc::fromPlan(plan), library), "bm_doc_write_plan.mpd", library);
  REQUIRE(got.pieces().size() == want.pieces().size());
  CHECK(got.report().missing.empty());
  for (size_t i = 0; i < want.pieces().size(); i++) {
    INFO("piece " << i << " " << want.pieces()[i].part);
    CHECK(got.pieces()[i].part == want.pieces()[i].part);
    CHECK(got.pieces()[i].color == want.pieces()[i].color);
    CHECK(got.pieces()[i].step == want.pieces()[i].step);
    CHECK(near(got.pieces()[i].world, want.pieces()[i].world, 1e-6));
  }
}

TEST_CASE("new project is version 1", "[doc][write]") {
  const doc::Source source = doc::fromPlan(io::readPlan(slurp(fixtures() / "models" / "tower.plan.json")));
  const std::string written = doc::writeProject({}, source, true);
  REQUIRE_NOTHROW(io::readProject(written));
  const json j = json::parse(written);
  CHECK(j["format"] == "brickmotion-project");
  CHECK(j["version"] == 1);
  CHECK(j["savedAt"].get<std::string>().size() == 24);  // 2026-11-19T12:00:00.000Z
  REQUIRE_THROWS_AS(doc::readProjectFile("{\"format\":\"brickmotion-project\",\"version\":2,\"plan\":{}}"), io::Error);
}
