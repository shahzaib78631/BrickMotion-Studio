#include <catch2/catch_test_macros.hpp>
#include <cmath>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <sstream>
#include "bm/doc/source.h"
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

/// The plan and project files the tests already read, from the fixtures and the app's data.
std::vector<fs::path> planFiles() {
  std::vector<fs::path> out{fixtures() / "models" / "tower.plan.json"};
  for (const char* name : {"public/data/test-small.plan.json", "public/data/mini-jet.plan.json",
                           "tests/fixtures/models/police-car.brickmotion", "models/schroder-house/schroder-house.brickmotion"})
    if (fs::exists(repo() / name)) out.push_back(repo() / name);
  return out;
}

io::PlanDoc readAny(const fs::path& p) {
  const std::string text = slurp(p);
  return p.extension() == ".brickmotion" ? io::readProject(text) : io::readPlan(text);
}

/// The real LDraw library when this checkout has it, for the app's own plans.
std::optional<ldraw::Library> realLib() {
  if (const char* dir = std::getenv("BM_LDRAW_DIR")) return ldraw::Library(dir);
  if (fs::exists(repo() / "public" / "ldraw" / "parts")) return ldraw::Library(repo() / "public" / "ldraw");
  return std::nullopt;
}

bool near(const Xform& a, const Xform& b, double eps) {
  for (int i = 0; i < 9; i++)
    if (std::abs(a.r.m[i] - b.r.m[i]) > eps) return false;
  return std::abs(a.t.x - b.t.x) <= eps && std::abs(a.t.y - b.t.y) <= eps && std::abs(a.t.z - b.t.z) <= eps;
}

void samePieces(const Model& got, const Model& want, double eps, bool idsAndSteps) {
  REQUIRE(got.pieces().size() == want.pieces().size());
  for (size_t i = 0; i < want.pieces().size(); i++) {
    const Piece &g = got.pieces()[i], &w = want.pieces()[i];
    INFO("piece " << i << " " << w.id << " " << w.part);
    CHECK(g.part == w.part);
    CHECK(g.color == w.color);
    CHECK(near(g.world, w.world, eps));
    if (idsAndSteps) {
      CHECK(g.id == w.id);
      CHECK(g.step == w.step);
      CHECK(g.path == w.path);
      CHECK(g.steps == w.steps);
    }
  }
  CHECK(got.report().missing == want.report().missing);
  CHECK(got.report().cycles == want.report().cycles);
  CHECK(got.report().unknownColors == want.report().unknownColors);
}
}  // namespace

TEST_CASE("plan round trip is identical", "[doc][source]") {
  for (const fs::path& file : planFiles()) {
    INFO(file.string());
    const io::PlanDoc plan = readAny(file);
    const io::PlanDoc back = doc::toPlan(doc::fromPlan(plan));
    REQUIRE(back.json.dump() == plan.json.dump());
  }
}

TEST_CASE("ldraw import places pieces as io::load does", "[doc][source]") {
  const ldraw::Library library = fixtureLib();
  ldraw::PartCache cache(library, fs::temp_directory_path() / "bm_doc_source_cache");
  int seen = 0;
  for (const char* dir : {"models", "plan"})
    for (const auto& entry : fs::directory_iterator(fixtures() / dir)) {
      const fs::path p = entry.path();
      if (p.extension() != ".ldr" && p.extension() != ".mpd") continue;
      INFO(p.string());
      const Model want = io::load(p, library, &cache);
      const doc::Flat flat = doc::flatten(doc::fromFile(p), library, cache);
      samePieces(flat.model, want, 1e-9, true);
      REQUIRE(flat.refs.size() == flat.model.pieces().size());
      seen++;
    }
  REQUIRE(seen >= 6);
}

TEST_CASE("source keeps unknown part and colour names", "[doc][source][focus]") {
  const std::string text = R"({"format":"brickmotion-plan","version":1,"name":"x","steps":[{"pieces":[)"
                           R"({"part":"nosuch.dat","color":"Mauve Sparkle","x":0,"y":0,"z":0,"rot":0}]}]})";
  const io::PlanDoc plan = io::readPlan(text);
  const doc::Source source = doc::fromPlan(plan);
  REQUIRE(doc::toPlan(source).json.dump() == plan.json.dump());
  REQUIRE(source.root.steps[0].items[0].colorText == "Mauve Sparkle");
  const ldraw::Library library = fixtureLib();
  ldraw::PartCache cache(library, fs::temp_directory_path() / "bm_doc_source_cache");
  const doc::Flat flat = doc::flatten(source, library, cache);
  REQUIRE(flat.model.pieces().size() == 1);
  CHECK(flat.model.report().missing == std::vector<std::string>{"nosuch.dat"});
  CHECK(flat.model.report().unknownColors == std::vector<std::string>{"Mauve Sparkle"});
}

TEST_CASE("flatten ids are stable across an insert", "[doc][source]") {
  doc::Source source = doc::fromPlan(io::readPlan(slurp(fixtures() / "models" / "tower.plan.json")));
  std::vector<doc::ItemId> before;
  auto ids = [&] {
    std::vector<doc::ItemId> out;
    for (const doc::Step& s : source.root.steps)
      for (const doc::Item& i : s.items) out.push_back(i.id);
    for (const auto& [name, def] : source.submodels)
      for (const doc::Step& s : def.steps)
        for (const doc::Item& i : s.items) out.push_back(i.id);
    return out;
  };
  before = ids();
  doc::Item added = source.root.steps[0].items[0];
  added.id = source.newId();
  added.extra = json::object();
  source.root.steps[0].items.insert(source.root.steps[0].items.begin(), added);
  std::vector<doc::ItemId> after = ids();
  REQUIRE(after.front() == added.id);
  after.erase(after.begin());
  REQUIRE(after == before);
  for (doc::ItemId id : before) CHECK(id != added.id);

  const ldraw::Library library = fixtureLib();
  ldraw::PartCache cache(library, fs::temp_directory_path() / "bm_doc_source_cache");
  const doc::Flat flat = doc::flatten(source, library, cache);
  REQUIRE(flat.refs.front().chain == std::vector<doc::ItemId>{added.id});
}

TEST_CASE("flatten matches fromPlan", "[doc][source]") {
  const ldraw::Library fixtureLibrary = fixtureLib();
  const std::optional<ldraw::Library> real = realLib();
  for (const fs::path& file : planFiles()) {
    const bool fixture = file.filename() == "tower.plan.json";
    if (!fixture && !real) continue;
    const ldraw::Library& library = fixture ? fixtureLibrary : *real;
    INFO(file.string());
    ldraw::PartCache cache(library, fs::temp_directory_path() / (fixture ? "bm_doc_source_cache" : "bm_doc_source_cache_real"));
    const io::PlanDoc plan = readAny(file);
    const Model want = io::fromPlan(plan, library, cache);
    const doc::Flat flat = doc::flatten(doc::fromPlan(plan), library, cache);
    samePieces(flat.model, want, 1e-12, true);
    for (size_t i = 0; i < flat.refs.size(); i++) CHECK(flat.refs[i].chain.size() == flat.model.pieces()[i].path.size() + 1);
  }
}
