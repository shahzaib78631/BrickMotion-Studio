// The seatings the sound hears, from a plan and its timeline.
#include <catch2/catch_test_macros.hpp>
#include <filesystem>
#include <fstream>
#include <numeric>
#include <unistd.h>
#include "bm/collide/shape.h"
#include "bm/io.h"
#include "bm/plan/plan.h"
#include "bm/plan/timeline.h"
#include "bms/snap_events.h"

using namespace bm;
namespace fs = std::filesystem;

namespace {
const Vec3 kUp{0, -1, 0};

/// Fixture 1x1 bricks (20 x 24 x 20, origin on top) and a graph written by hand, as plan_test's.
struct Scene {
  ldraw::Library lib{fs::path(BM_FIXTURES) / "lib"};
  ldraw::PartCache parts{lib, fs::temp_directory_path() / "bms_events_cache"};
  collide::ShapeCache shapes;
  std::string text;
  std::vector<Vec3> at;
  connect::Graph graph;
  std::unique_ptr<Model> model;

  uint32_t add(double x, double y, double z) {
    text += "1 4 " + std::to_string(x) + " " + std::to_string(y) + " " + std::to_string(z) + " 1 0 0 0 1 0 0 0 1 3005.dat\n";
    at.push_back({x, y, z});
    return static_cast<uint32_t>(at.size() - 1);
  }
  /// `upper` sits on `lower` by one stud, leaving upward.
  void stud(uint32_t lower, uint32_t upper) {
    connect::Connection c;
    c.a = std::min(lower, upper), c.b = std::max(lower, upper);
    c.joint.kind = connect::JointKind::Fixed;
    c.mates = 1, c.grip = 4;
    c.firstZone = static_cast<uint32_t>(graph.zones.size());
    c.zoneCount = 1;
    const Vec3 top = at[lower];
    graph.zones.push_back({top, top + kUp * 4, 8});
    connect::Release r;
    r.kind = connect::ReleaseKind::Along;
    r.axis = upper == c.b ? kUp : -kUp;
    r.travel = 4;
    graph.releases.push_back(r);
    graph.connections.push_back(c);
  }
  void finish() {
    static int counter = 0;
    const fs::path file = fs::temp_directory_path() / ("bms_events_" + std::to_string(::getpid()) + "_" + std::to_string(counter++) + ".ldr");
    { std::ofstream out(file); out << text; }
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
  }
  std::vector<Box> boxes() const {
    std::vector<Box> out;
    for (const Vec3& p : at) {
      Box b;
      b.grow(p + Vec3{-10, -4, -10});
      b.grow(p + Vec3{10, 24, 10});
      out.push_back(b);
    }
    return out;
  }
  struct Built {
    plan::Plan plan;
    plan::Timeline timeline;
    std::vector<bms::SnapEvent> events;
  };
  Built build() {
    finish();
    Built b;
    b.plan = plan::plan(*model, graph, parts, shapes);
    b.timeline = plan::buildTimeline(*model, parts, b.plan);
    const std::vector<Box> bx = boxes();
    b.events = bms::snapEvents(*model, graph, b.plan, b.timeline, bx, [](int, Vec3 p) { return p.x / 100; });
    return b;
  }
};

bool seated(const Xform& x) {
  const Vec3 axes[3] = {{1, 0, 0}, {0, 1, 0}, {0, 0, 1}};
  for (const Vec3& a : axes)
    if (length(x.apply(a) - a) > 1e-9) return false;
  return length(x.t) < 1e-9;
}
}  // namespace

TEST_CASE("a seating sounds at the first frame its unit is in its seat", "[sound][events]") {
  Scene s;
  const uint32_t a = s.add(0, 0, 0), b = s.add(0, -24, 0), c = s.add(0, -48, 0);
  s.stud(a, b), s.stud(b, c);
  const Scene::Built built = s.build();
  REQUIRE(built.events.size() == 3);
  for (size_t k = 0; k < built.events.size(); k++) {
    const bms::SnapEvent& e = built.events[k];
    const plan::Flight* flight = nullptr;
    for (const plan::Flight& f : built.timeline.flights)
      if (f.move == e.move) flight = &f;
    REQUIRE(flight);
    int first = -1;
    for (int f = flight->startFrame; f <= flight->startFrame + flight->frames && first < 0; f++)
      if (seated(plan::poseAt(*flight, f))) first = f;
    REQUIRE(e.frame == first);
    REQUIRE(e.builtPieces == k);
    REQUIRE(e.mates == (k == 0 ? 0 : 1));
    REQUIRE(e.joint == connect::JointKind::Fixed);
    REQUIRE(e.seatSeconds > 0);
    REQUIRE(e.unit.max.y - e.unit.min.y == 28);
    if (k > 0) REQUIRE_FALSE(e.touching.empty());
  }
  REQUIRE(built.events[0].frame < built.events[1].frame);
  REQUIRE(built.events[1].frame < built.events[2].frame);
}

TEST_CASE("flagged moves are silent", "[sound][events]") {
  Scene s;
  const uint32_t a = s.add(0, 0, 0), b = s.add(0, -24, 0), c = s.add(0, -48, 0);
  s.add(200, 0, 0);  // joined to nothing: Flag::Unjoined, it appears without a flight
  s.stud(a, b), s.stud(b, c);
  const Scene::Built built = s.build();
  REQUIRE(built.plan.moves.size() == 4);
  REQUIRE(built.events.size() == 3);
  for (const bms::SnapEvent& e : built.events) REQUIRE(built.plan.moves[e.move].flag == plan::Flag::None);
}
