#include <catch2/catch_test_macros.hpp>
#include <cstdlib>
#include <filesystem>
#include <thread>
#include <vector>
#include "bm/ldraw/library.h"

using namespace bm::ldraw;
namespace fs = std::filesystem;

static fs::path fixtureLib() { return fs::path(BM_FIXTURES) / "lib"; }

TEST_CASE("names resolve the way LDraw tools resolve them", "[ldraw][library][focus]") {
  const Library lib(fixtureLib());
  REQUIRE(lib.find("3001.dat") != nullptr);
  REQUIRE(lib.find("3001.dat")->description == "Brick  2 x  4");
  REQUIRE(lib.find("s\\3001S01.DAT") != nullptr);
  REQUIRE(lib.find("48\\1-4cyli.dat") != nullptr);
  REQUIRE(lib.find("STUD.DAT") != nullptr);
  REQUIRE(lib.find("  Stud.dat ") != nullptr);
  REQUIRE(lib.find("car.ldr") != nullptr);       // models/
  REQUIRE(lib.find("nope.dat") == nullptr);
  REQUIRE(lib.find("") == nullptr);
  REQUIRE(lib.find("../lib/parts/3001.dat") == nullptr);  // never escapes the roots
  REQUIRE(lib.resolve("s/3001s01.dat")->filename() == "3001s01.dat");
  REQUIRE_FALSE(lib.resolve("nope.dat").has_value());
}

TEST_CASE("the same name gives the same parsed file", "[ldraw][library]") {
  const Library lib(fixtureLib());
  REQUIRE(lib.find("3001.dat") == lib.find("3001.DAT"));
  REQUIRE(lib.contentHash("3001.dat") != 0);
  REQUIRE(lib.contentHash("3001.dat") != lib.contentHash("3005.dat"));
  REQUIRE(lib.contentHash("nope.dat") == 0);
}

TEST_CASE("inline files shadow the disk, in a copy that leaves the original alone", "[ldraw][library]") {
  const Library lib(fixtureLib());
  const Library with = lib.withInline(parseMpd("0 FILE 3001.dat\n0 My own brick\n0 FILE extra.ldr\n0 Extra\n", "m.mpd"));
  REQUIRE(with.find("3001.dat")->description == "My own brick");
  REQUIRE(with.find("extra.ldr") != nullptr);
  REQUIRE(with.find("3005.dat") == lib.find("3005.dat"));  // disk files are shared, parsed once
  REQUIRE(lib.find("3001.dat")->description == "Brick  2 x  4");
  REQUIRE(lib.find("extra.ldr") == nullptr);
  REQUIRE(with.contentHash("3001.dat") != lib.contentHash("3001.dat"));
  REQUIRE(with.isInline("3001.dat"));
  REQUIRE_FALSE(with.isInline("3005.dat"));
}

TEST_CASE("a second search root adds parts without replacing the first", "[ldraw][library]") {
  const fs::path extra = fs::temp_directory_path() / "bm_lib_extra_test";
  fs::remove_all(extra);
  fs::create_directories(extra / "parts");
  { std::FILE* f = std::fopen((extra / "parts" / "9999.dat").c_str(), "w"); std::fputs("0 Unofficial\n", f); std::fclose(f); }
  { std::FILE* f = std::fopen((extra / "parts" / "3001.dat").c_str(), "w"); std::fputs("0 Impostor\n", f); std::fclose(f); }
  Library lib(fixtureLib());
  lib.addSearchRoot(extra);
  REQUIRE(lib.find("9999.dat")->description == "Unofficial");
  REQUIRE(lib.find("3001.dat")->description == "Brick  2 x  4");
  fs::remove_all(extra);
}

TEST_CASE("the colour table is read from LDConfig", "[ldraw][library]") {
  const Library lib(fixtureLib());
  const auto& colors = lib.colors();
  REQUIRE(colors.size() == 4);  // the malformed line is ignored
  REQUIRE(colors.at(4).name == "Red");
  REQUIRE(colors.at(4).rgb == 0xB40000u);
  REQUIRE(colors.at(4).edge == 0x333333u);
  REQUIRE(colors.at(4).alpha == 1.0f);
  REQUIRE(colors.at(4).finish == Finish::Solid);
  REQUIRE(colors.at(36).alpha == 128.0f / 255.0f);
  REQUIRE(colors.at(36).finish == Finish::Trans);
  REQUIRE(colors.at(334).finish == Finish::Chrome);
}

TEST_CASE("a missing library directory is empty, not an error", "[ldraw][library]") {
  const Library lib("/nonexistent/ldraw");
  REQUIRE(lib.find("3001.dat") == nullptr);
  REQUIRE(lib.colors().empty());
}

TEST_CASE("lookups from many threads agree", "[ldraw][library]") {
  const Library lib(fixtureLib());
  const std::vector<std::string> names = {"3001.dat", "3005.dat", "stud.dat", "box.dat", "s/3001s01.dat", "48/1-4cyli.dat", "nope.dat"};
  std::vector<std::vector<const File*>> seen(8);
  std::vector<std::thread> threads;
  for (int t = 0; t < 8; t++)
    threads.emplace_back([&, t] {
      for (int round = 0; round < 50; round++)
        for (const auto& n : names) seen[t].push_back(lib.find(n));
    });
  for (auto& th : threads) th.join();
  for (int t = 1; t < 8; t++) REQUIRE(seen[t] == seen[0]);
}

TEST_CASE("the real library has brick 3001 and red", "[ldraw][library][data]") {
  const char* dir = std::getenv("BM_LDRAW_DIR");
  if (!dir) SKIP("BM_LDRAW_DIR is not set");
  const Library lib(dir);
  REQUIRE(lib.find("3001.dat") != nullptr);
  REQUIRE(lib.find("stud.dat") != nullptr);
  REQUIRE(lib.colors().at(4).name == "Red");
}
