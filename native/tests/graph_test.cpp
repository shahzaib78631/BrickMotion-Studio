#include <catch2/catch_test_macros.hpp>
#include <chrono>
#include <filesystem>
#include <fstream>
#include <string>
#include <unistd.h>
#include "bm/connect/graph.h"
#include "bm/io.h"

using namespace bm;
using namespace bm::connect;
namespace fs = std::filesystem;

namespace {
struct World {
  ldraw::Library lib{fs::path(BM_FIXTURES) / "lib"};
  ShadowLibrary shadow{fs::path(BM_FIXTURES) / "shadow"};
  ConnectorDb db{lib, shadow};

  Graph graph(const std::string& ldrawText) {
    static int counter = 0;
    const fs::path file = fs::temp_directory_path() / ("bm_graph_test_" + std::to_string(::getpid()) + "_" + std::to_string(counter++) + ".ldr");
    { std::ofstream out(file); out << ldrawText; }
    const Model model = io::load(file, lib);
    fs::remove(file);
    return buildGraph(model, db);
  }
};
const char* kId = "1 0 0 0 1 0 0 0 1";
std::string piece(const char* part, double x, double y, double z, const char* matrix = kId) {
  return "1 4 " + std::to_string(x) + " " + std::to_string(y) + " " + std::to_string(z) + " " + matrix + " " + part + "\n";
}
}  // namespace

TEST_CASE("two stacked bricks are one rigid body", "[graph]") {
  World w;
  const Graph g = w.graph(piece("c2x4.dat", 0, 0, 0) + piece("c2x4.dat", 0, -24, 0));
  REQUIRE(g.connections.size() == 1);
  REQUIRE((g.connections[0].a == 0 && g.connections[0].b == 1));
  REQUIRE(g.connections[0].joint.kind == JointKind::Fixed);
  REQUIRE(g.connections[0].mates == 8);
  REQUIRE((g.groups == 1 && g.bodies == 1 && g.largestGroup == 2 && g.attached == 2 && g.withoutConnectors == 0));
  REQUIRE(g.group[0] == g.group[1]);
  REQUIRE(g.body[0] == g.body[1]);
}

TEST_CASE("a brick on a single stud can turn: one group, two bodies", "[graph]") {
  World w;
  const Graph g = w.graph(piece("c2x4.dat", 0, 0, 0) + piece("c1x1.dat", -30, -24, -10));
  REQUIRE(g.connections.size() == 1);
  REQUIRE(g.connections[0].joint.kind == JointKind::Revolute);
  REQUIRE((g.groups == 1 && g.bodies == 2));
  REQUIRE(g.body[0] != g.body[1]);
}

TEST_CASE("a brick on a sideways stud joins", "[graph]") {
  World w;
  const Graph g = w.graph(piece("snot.dat", 0, 0, 0) + piece("c1x1.dat", 34, 12, 0, "0 -1 0 1 0 0 0 0 1"));
  REQUIRE(g.connections.size() == 1);
  REQUIRE(g.groups == 1);
}

TEST_CASE("separate stacks are separate groups", "[graph]") {
  World w;
  const Graph g = w.graph(piece("c2x4.dat", 0, 0, 0) + piece("c2x4.dat", 0, -24, 0) + piece("c2x4.dat", 500, 0, 0) + piece("c2x4.dat", 500, -24, 0) + piece("c1x1.dat", 1000, 0, 0));
  REQUIRE(g.connections.size() == 2);
  REQUIRE((g.groups == 3 && g.largestGroup == 2 && g.attached == 4));
  REQUIRE(g.group[0] != g.group[2]);
}

TEST_CASE("bricks side by side, or just not touching, are not joined", "[graph]") {
  World w;
  REQUIRE(w.graph(piece("c2x4.dat", 0, 0, 0) + piece("c2x4.dat", 80, 0, 0)).connections.empty());
  REQUIRE(w.graph(piece("c2x4.dat", 0, 0, 0) + piece("c2x4.dat", 0, -30, 0)).connections.empty());   // 6 LDU of air between
  REQUIRE(w.graph(piece("c2x4.dat", 0, 0, 0) + piece("c2x4.dat", 10, -24, 0)).connections.empty());   // half a stud off
}

TEST_CASE("a duplicated piece is not joined to its twin", "[graph][focus]") {
  World w;
  const Graph g = w.graph(piece("c2x4.dat", 0, 0, 0) + piece("c2x4.dat", 0, 0, 0) + piece("c2x4.dat", 0, -24, 0));
  REQUIRE(g.connections.size() == 2);
  for (const Connection& c : g.connections) REQUIRE(c.b == 2);
  REQUIRE(g.groups == 1);
}

TEST_CASE("a part with no connector data is counted", "[graph]") {
  World w;
  const Graph g = w.graph(piece("plain.dat", 0, 0, 0) + piece("c1x1.dat", 0, -24, 0) + piece("nosuch.dat", 0, -48, 0));
  REQUIRE(g.withoutConnectors == 2);
  REQUIRE(g.connections.empty());
  REQUIRE(g.groups == 3);
  REQUIRE(w.graph("").groups == 0);
}

TEST_CASE("ten thousand bricks build quickly", "[graph][focus]") {
  World w;
  std::string text;
  for (int i = 0; i < 100; i++)
    for (int j = 0; j < 50; j++) text += piece("c2x4.dat", i * 80, 0, j * 40) + piece("c2x4.dat", i * 80, -24, j * 40);
  const auto t0 = std::chrono::steady_clock::now();
  const Graph g = w.graph(text);
  const double seconds = std::chrono::duration<double>(std::chrono::steady_clock::now() - t0).count();
  REQUIRE(g.connections.size() == 5000);
  REQUIRE((g.groups == 5000 && g.bodies == 5000));
  REQUIRE(seconds < 2.0);
}

TEST_CASE("flexible segments and primitives placed as pieces are marked", "[graph][segments]") {
  World w;
  const Graph g = w.graph(piece("c2x4.dat", 0, 0, 0) + piece("seg.dat", 200, 0, 0) + piece("segold.dat", 300, 0, 0) + piece("box.dat", 400, 0, 0) + piece("plain.dat", 500, 0, 0));
  REQUIRE(g.isSegment == std::vector<uint8_t>{0, 1, 1, 1, 0});
  REQUIRE(g.segments == 3);
}

TEST_CASE("anything the library marks as not for use on its own is a segment", "[graph][segments]") {
  World w;
  const ldraw::Library model = w.lib.withInline(ldraw::parseMpd("0 FILE main.ldr\n1 4 0 0 0 1 0 0 0 1 0 0 0 1 8258 - ls70.dat\n1 4 50 0 0 1 0 0 0 1 0 0 0 1 cable.dat\n1 4 90 0 0 1 0 0 0 1 0 0 0 1 mine.dat\n0 FILE 8258 - ls70.dat\n3 16 0 0 0 1 0 0 0 0 1\n0 FILE mine.dat\n0 My own part\n3 16 0 0 0 1 0 0 0 0 1\n", "m.mpd"));
  const Graph g = w.graph("0 FILE main.ldr\n1 4 0 0 0 1 0 0 0 1 0 0 0 1 8258 - ls70.dat\n1 4 50 0 0 1 0 0 0 1 0 0 0 1 cable.dat\n1 4 90 0 0 1 0 0 0 1 0 0 0 1 mine.dat\n0 FILE 8258 - ls70.dat\n3 16 0 0 0 1 0 0 0 0 1\n0 FILE mine.dat\n0 My own part\n3 16 0 0 0 1 0 0 0 0 1\n");
  REQUIRE(g.isSegment == std::vector<uint8_t>{1, 1, 0});
}
