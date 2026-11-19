#pragma once
// A small model written in the test, joined by hand, planned and played: what the camera films.
#include <algorithm>
#include <filesystem>
#include <fstream>
#include <memory>
#include <numeric>
#include <string>
#include <unistd.h>
#include <vector>
#include "bm/collide/world.h"
#include "bm/io.h"
#include "bm/plan/plan.h"
#include "bm/plan/timeline.h"

namespace filmtest {

using namespace bm;
namespace fs = std::filesystem;

/// Fixture parts (tests/fixtures/lib): 3005 a 1x1 brick (20 x 24 x 20), 3001 a 2x4 (80 along x,
/// 40 along z), both with their origin in the middle of the top; +y is down.
struct Scene {
  ldraw::Library lib{fs::path(BM_FIXTURES) / "lib"};
  ldraw::PartCache parts{lib, fs::temp_directory_path() / "bm_film_cache"};
  collide::ShapeCache shapes;
  std::string text, sub;
  std::vector<Vec3> at;
  connect::Graph graph;
  std::unique_ptr<Model> model;
  std::unique_ptr<collide::World> world;
  plan::Plan p;
  plan::Timeline t;

  void step() { text += "0 STEP\n"; }
  void subStep() { sub += "0 STEP\n"; }
  uint32_t add(double x, double y, double z, const char* part = "3005.dat") {
    text += "1 4 " + std::to_string(x) + " " + std::to_string(y) + " " + std::to_string(z) + " 1 0 0 0 1 0 0 0 1 " + part + "\n";
    at.push_back({x, y, z});
    return static_cast<uint32_t>(at.size() - 1);
  }
  /// A brick in the submodel, which is placed once, where the first of these is called.
  uint32_t addIn(double x, double y, double z) {
    if (sub.empty()) text += "1 16 0 0 0 1 0 0 0 1 0 0 0 1 sub.ldr\n";
    sub += "1 4 " + std::to_string(x) + " " + std::to_string(y) + " " + std::to_string(z) + " 1 0 0 0 1 0 0 0 1 3005.dat\n";
    at.push_back({x, y, z});
    return static_cast<uint32_t>(at.size() - 1);
  }
  /// `upper` sits on `lower` by a stud and leaves straight up.
  void stud(uint32_t lower, uint32_t upper) {
    connect::Connection c;
    c.a = std::min(lower, upper), c.b = std::max(lower, upper);
    c.joint.kind = connect::JointKind::Fixed;
    c.firstZone = static_cast<uint32_t>(graph.zones.size());
    c.zoneCount = 1;
    const Vec3 top = at[lower], up{0, -1, 0};
    graph.zones.push_back({top, top + up * 4, 8});
    connect::Release r;
    r.kind = connect::ReleaseKind::Along;
    r.axis = upper == c.b ? up : -up;
    r.travel = 4;
    graph.releases.push_back(r);
    graph.connections.push_back(c);
  }
  /// Loads, plans and plays it.
  void finish(const plan::Style& style = {}) {
    static int counter = 0;
    const fs::path file = fs::temp_directory_path() / ("bm_film_" + std::to_string(::getpid()) + "_" + std::to_string(counter++) + (sub.empty() ? ".ldr" : ".mpd"));
    { std::ofstream out(file); out << (sub.empty() ? text : "0 FILE main.ldr\n" + text + "0 FILE sub.ldr\n" + sub); }
    model = std::make_unique<Model>(io::load(file, lib));
    fs::remove(file);
    const uint32_t n = static_cast<uint32_t>(at.size());
    std::sort(graph.connections.begin(), graph.connections.end(), [](const auto& x, const auto& y) { return std::make_pair(x.a, x.b) < std::make_pair(y.a, y.b); });
    std::vector<uint32_t> parent(n);
    std::iota(parent.begin(), parent.end(), 0u);
    auto find = [&](uint32_t x) {
      while (parent[x] != x) x = parent[x] = parent[parent[x]];
      return x;
    };
    for (const auto& c : graph.connections) parent[find(c.a)] = find(c.b);
    graph.group.resize(n);
    graph.body.resize(n);
    std::vector<uint32_t> id(n, UINT32_MAX);
    graph.groups = 0;
    for (uint32_t i = 0; i < n; i++) {
      if (id[find(i)] == UINT32_MAX) id[find(i)] = graph.groups++;
      graph.group[i] = id[find(i)];
      graph.body[i] = i;
    }
    graph.isSegment.assign(n, 0);
    graph.hasConnectors.assign(n, 1);
    p = plan::plan(*model, graph, parts, shapes);
    t = plan::buildTimeline(*model, parts, p, style);
    world = std::make_unique<collide::World>(*model, parts, shapes);
  }
};

/// A tower of `n` 1x1 bricks, one a step.
inline void tower(Scene& s, int n) {
  for (int i = 0; i < n; i++) {
    if (i) s.step();
    s.add(0, -24.0 * i, 0);
    if (i) s.stud(static_cast<uint32_t>(i - 1), static_cast<uint32_t>(i));
  }
  s.finish();
}

}  // namespace filmtest
