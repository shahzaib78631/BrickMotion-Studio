#include <catch2/catch_test_macros.hpp>
#include <filesystem>
#include "bm/audit.h"

using namespace bm;
namespace fs = std::filesystem;

static fs::path fx(const char* name) { return fs::path(BM_FIXTURES) / "models" / name; }

TEST_CASE("a loaded model becomes a scoreboard row", "[audit]") {
  const ldraw::Library library(fs::path(BM_FIXTURES) / "lib");
  ldraw::PartCache cache(library, fs::temp_directory_path() / "bm_audit_test_cache");
  const audit::Row row = audit::loadRow(fx("twice.mpd"), "fixture/twice.mpd", library, cache);
  REQUIRE(row.ok);
  REQUIRE(row.error.empty());
  REQUIRE(row.id == "fixture/twice.mpd");
  REQUIRE(row.pieces == 6);
  REQUIRE(row.unknownParts.empty());
  REQUIRE(row.loadMs > 0);
  const nlohmann::json j = audit::toJson(row);
  REQUIRE(j["engine"] == "native");
  REQUIRE(j["ok"] == true);
  REQUIRE(j["error"].is_null());
  REQUIRE(j["pieces"] == 6);
  REQUIRE(j["unknownParts"].is_array());
}

TEST_CASE("unknown parts are listed the way the baseline lists them", "[audit]") {
  const ldraw::Library library(fs::path(BM_FIXTURES) / "lib");
  ldraw::PartCache cache(library, fs::temp_directory_path() / "bm_audit_test_cache");
  const audit::Row row = audit::loadRow(fx("holes.ldr"), "fixture/holes.ldr", library, cache);
  REQUIRE(row.ok);
  REQUIRE(row.pieces == 3);
  REQUIRE(row.unknownParts == std::vector<std::string>{"gone"});  // without ".dat"
  REQUIRE(row.missingSubmodels == std::vector<std::string>{"lost sub.ldr"});
}

TEST_CASE("an unreadable model is a failed row, not an exception", "[audit]") {
  const ldraw::Library library(fs::path(BM_FIXTURES) / "lib");
  ldraw::PartCache cache(library, fs::temp_directory_path() / "bm_audit_test_cache");
  const audit::Row row = audit::loadRow(fs::path(BM_FIXTURES), "fixture/dir", library, cache);
  REQUIRE_FALSE(row.ok);
  REQUIRE_FALSE(row.error.empty());
  REQUIRE(audit::toJson(row)["error"].is_string());
}

TEST_CASE("the summary totals the rows", "[audit]") {
  std::vector<audit::Row> rows(4);
  auto make = [](const char* id, bool ok, const char* error, int pieces, std::vector<std::string> unknown, std::vector<std::string> subs, double ms) {
    audit::Row r;
    r.id = id;
    r.ok = ok;
    r.error = error;
    r.pieces = pieces;
    r.unknownParts = std::move(unknown);
    r.missingSubmodels = std::move(subs);
    r.loadMs = ms;
    return r;
  };
  rows[0] = make("a", true, "", 10, {"x"}, {}, 1.0);
  rows[1] = make("b", true, "", 30, {"x", "y"}, {"s"}, 3.0);
  rows[2] = make("c", false, "boom", 0, {}, {}, 0.0);
  rows[3] = make("d", true, "", 5, {}, {}, 2.0);
  const nlohmann::json s = audit::summarize(rows);
  REQUIRE(s["engine"] == "native");
  REQUIRE(s["models"] == 4);
  REQUIRE(s["failed"] == 1);
  REQUIRE(s["totals"]["pieces"] == 45);
  REQUIRE(s["totals"]["unknownParts"] == 3);
  REQUIRE(s["totals"]["distinctUnknownParts"] == 2);
  REQUIRE(s["p50"]["loadMs"] == 2.0);
  REQUIRE(s["p95"]["loadMs"] == 3.0);
  REQUIRE(audit::summarize({})["models"] == 0);
}

TEST_CASE("joint columns are filled when a connector database is given", "[audit]") {
  const ldraw::Library library(fs::path(BM_FIXTURES) / "lib");
  ldraw::PartCache cache(library, fs::temp_directory_path() / "bm_audit_test_cache");
  const connect::ShadowLibrary shadow(fs::path(BM_FIXTURES) / "shadow");
  connect::ConnectorDb db(library, shadow);
  const fs::path file = fs::temp_directory_path() / "bm_audit_joints_test.ldr";
  { std::FILE* f = std::fopen(file.c_str(), "w"); std::fputs("1 4 0 0 0 1 0 0 0 1 0 0 0 1 c2x4.dat\n1 4 0 -24 0 1 0 0 0 1 0 0 0 1 c2x4.dat\n1 4 300 0 0 1 0 0 0 1 0 0 0 1 plain.dat\n1 4 600 0 0 1 0 0 0 1 0 0 0 1 c1x1.dat\n", f); std::fclose(f); }
  const audit::Row row = audit::loadRow(file, "x", library, cache, &db);
  fs::remove(file);
  REQUIRE(row.ok);
  REQUIRE((row.hasGraph && row.joined == 2 && row.groups == 3 && row.attached == 2 && row.bodies == 3 && row.withoutConnectors == 1));
  REQUIRE(row.joints[static_cast<int>(connect::JointKind::Fixed)] == 1);
  REQUIRE(row.noConnectorParts == std::map<std::string, int>{{"plain.dat", 1}});
  REQUIRE(row.unmatedParts == std::map<std::string, int>{{"c1x1.dat", 1}});
  const nlohmann::json j = audit::toJson(row);
  REQUIRE(j["joined"] == 2);
  REQUIRE(j["joints"]["fixed"] == 1);
  const nlohmann::json s = audit::summarize({row});
  REQUIRE(s["totals"]["joined"] == 2);
  REQUIRE(s["totals"]["attachedPercent"] == 50.0);
  REQUIRE(s["totals"]["fullyJoinedModels"] == 0);
  // Without a database the columns are absent, as in phase 1.
  REQUIRE_FALSE(audit::toJson(audit::loadRow(fs::path(BM_FIXTURES) / "models" / "twice.mpd", "y", library, cache)).contains("joined"));
}
