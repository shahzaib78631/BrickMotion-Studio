#include <catch2/catch_test_macros.hpp>
#include <atomic>
#include <filesystem>
#include <fstream>
#include <thread>
#include <unistd.h>
#include <vector>
#include "bm/ldraw/part_cache.h"

using namespace bm::ldraw;
namespace fs = std::filesystem;

namespace {
/// A private copy of the fixture library and an empty cache directory, removed afterwards.
struct Sandbox {
  fs::path root, lib, cache;
  Sandbox() {
    static std::atomic<int> counter{0};
    root = fs::temp_directory_path() / ("bm_part_cache_" + std::to_string(::getpid()) + "_" + std::to_string(counter++));
    fs::remove_all(root);
    lib = root / "lib";
    cache = root / "cache";
    fs::create_directories(root);
    fs::copy(fs::path(BM_FIXTURES) / "lib", lib, fs::copy_options::recursive);
  }
  ~Sandbox() { fs::remove_all(root); }
  fs::path cacheFile() const {
    for (const auto& e : fs::directory_iterator(cache))
      if (e.path().filename().string().rfind("3001.dat", 0) == 0) return e.path();
    return {};
  }
};

bool sameMesh(const Mesh& a, const Mesh& b) {
  return a.positions == b.positions && a.triangles == b.triangles && a.triColor == b.triColor && a.edges == b.edges && a.missing == b.missing &&
         a.deps == b.deps && a.sourceHash == b.sourceHash && a.bounds.min == b.bounds.min && a.bounds.max == b.bounds.max;
}
}  // namespace

TEST_CASE("a part is flattened once and then read from disk", "[ldraw][cache]") {
  Sandbox box;
  const Library lib(box.lib);
  std::shared_ptr<const Mesh> first;
  {
    PartCache cache(lib, box.cache);
    first = cache.get("3001.dat");
    REQUIRE(first->triangles.size() == 72);
    REQUIRE(cache.get("3001") == first);  // same object from memory, with or without ".dat"
    const auto s = cache.stats();
    REQUIRE((s.flattened == 1 && s.memoryHits == 1 && s.diskHits == 0 && s.rebuilt == 0));
  }
  PartCache again(lib, box.cache);
  const auto second = again.get("3001.dat");
  REQUIRE(sameMesh(*first, *second));
  const auto s = again.stats();
  REQUIRE((s.diskHits == 1 && s.flattened == 0 && s.rebuilt == 0));
}

TEST_CASE("changing a subfile rebuilds the parts made of it", "[ldraw][cache]") {
  Sandbox box;
  { const Library lib(box.lib); PartCache(lib, box.cache).get("3001.dat"); }
  { std::ofstream out(box.lib / "p" / "stud.dat"); out << "0 Taller stud\n0 BFC CERTIFY CCW\n1 16 0 -8 0 6 0 0 0 8 0 0 0 6 box.dat\n"; }
  const Library lib(box.lib);
  PartCache cache(lib, box.cache);
  const auto mesh = cache.get("3001.dat");
  REQUIRE(mesh->bounds.min.y == -8);
  const auto s = cache.stats();
  REQUIRE((s.rebuilt == 1 && s.diskHits == 0));
  // And the rebuilt file is good for the next run.
  PartCache next(lib, box.cache);
  REQUIRE(next.get("3001.dat")->bounds.min.y == -8);
  REQUIRE(next.stats().diskHits == 1);
}

TEST_CASE("a damaged cache file is rebuilt, never trusted", "[ldraw][cache][focus]") {
  Sandbox box;
  const Library lib(box.lib);
  std::shared_ptr<const Mesh> good;
  { PartCache cache(lib, box.cache); good = cache.get("3001.dat"); }
  const fs::path file = box.cacheFile();
  REQUIRE(fs::exists(file));
  const auto size = fs::file_size(file);

  auto expectRebuild = [&](const char* what) {
    INFO(what);
    PartCache cache(lib, box.cache);
    const auto mesh = cache.get("3001.dat");
    REQUIRE(sameMesh(*good, *mesh));
    REQUIRE(cache.stats().rebuilt == 1);
    REQUIRE(fs::file_size(file) == size);  // written back whole
  };

  fs::resize_file(file, size / 2);
  expectRebuild("truncated to half");

  { std::fstream f(file, std::ios::in | std::ios::out | std::ios::binary); f.seekp(static_cast<std::streamoff>(size - 5)); f.put('\x5A'); }
  expectRebuild("one payload byte changed");

  { std::fstream f(file, std::ios::in | std::ios::out | std::ios::binary); f.seekp(4); const uint32_t v = 99; f.write(reinterpret_cast<const char*>(&v), 4); }
  expectRebuild("unknown version");

  fs::resize_file(file, 0);
  expectRebuild("empty file");

  { std::ofstream f(file, std::ios::binary); f << "not a cache file at all, just some text that is long enough to hold a header........................"; }
  expectRebuild("wrong magic");
}

TEST_CASE("options get their own cache entries", "[ldraw][cache]") {
  Sandbox box;
  const Library lib(box.lib);
  { PartCache cache(lib, box.cache); cache.get("3001.dat"); }
  PartCache hi(lib, box.cache, FlattenOptions{.hiResPrimitives = true});
  hi.get("3001.dat");
  REQUIRE(hi.stats().flattened == 1);  // not served from the standard-detail file
}

TEST_CASE("an unknown part is an empty mesh and is not written", "[ldraw][cache]") {
  Sandbox box;
  const Library lib(box.lib);
  PartCache cache(lib, box.cache);
  const auto mesh = cache.get("nosuch.dat");
  REQUIRE(mesh->triangles.empty());
  REQUIRE(mesh->missing == std::vector<std::string>{"nosuch.dat"});
  REQUIRE((!fs::exists(box.cache) || fs::is_empty(box.cache)));
}

TEST_CASE("an inline part is flattened but never written to the shared cache", "[ldraw][cache]") {
  Sandbox box;
  const Library base(box.lib);
  const Library lib = base.withInline(parseMpd("0 FILE mine.dat\n0 Mine\n0 BFC CERTIFY CCW\n1 16 0 0 0 1 0 0 0 1 0 0 0 1 3005.dat\n", "m.mpd"));
  PartCache cache(lib, box.cache);
  REQUIRE(cache.get("mine.dat")->triangles.size() == 36);
  REQUIRE((!fs::exists(box.cache) || fs::is_empty(box.cache)));
}

TEST_CASE("an unwritable cache directory still gives meshes", "[ldraw][cache]") {
  Sandbox box;
  const Library lib(box.lib);
  PartCache cache(lib, "/dev/null/not-a-directory");
  REQUIRE(cache.get("3001.dat")->triangles.size() == 72);
}

TEST_CASE("many threads asking for the same parts flatten each once", "[ldraw][cache]") {
  Sandbox box;
  const Library lib(box.lib);
  PartCache cache(lib, box.cache);
  const std::vector<std::string> names = {"3001.dat", "3005.dat", "mirror.dat", "inv.dat", "colors.dat", "cw.dat"};
  std::vector<std::thread> threads;
  for (int t = 0; t < 8; t++)
    threads.emplace_back([&] {
      for (int round = 0; round < 20; round++)
        for (const auto& n : names) REQUIRE(cache.get(n) != nullptr);
    });
  for (auto& th : threads) th.join();
  const auto s = cache.stats();
  REQUIRE(s.flattened == names.size());
  REQUIRE(s.flattened + s.memoryHits == 8 * 20 * names.size());
}
