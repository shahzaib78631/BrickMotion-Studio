#include <catch2/catch_test_macros.hpp>
#include <catch2/matchers/catch_matchers_floating_point.hpp>
#include <filesystem>
#include <fstream>
#include <numeric>
#include <unistd.h>
#include "bm/io.h"
#include "bm/plan/certify.h"
#include "bm/plan/plan.h"
#include "bm/plan/timeline.h"
#include "bm/plan/tolerances.h"

using namespace bm;
using namespace bm::plan;
using Catch::Matchers::WithinAbs;
namespace fs = std::filesystem;

namespace {
const Vec3 kUp{0, -1, 0};

/// Fixture 1x1 bricks (20 x 24 x 20, origin on top) and a graph written by hand.
struct Scene {
  ldraw::Library lib{fs::path(BM_FIXTURES) / "lib"};
  ldraw::PartCache parts{lib, fs::temp_directory_path() / "bm_plan_cache"};
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
  /// `upper` sits on `lower` by a stud: it leaves along `leaves` (up unless said otherwise).
  void stud(uint32_t lower, uint32_t upper, Vec3 leaves = kUp) {
    connect::Connection c;
    c.a = std::min(lower, upper), c.b = std::max(lower, upper);
    c.joint.kind = connect::JointKind::Fixed;
    c.firstZone = static_cast<uint32_t>(graph.zones.size());
    c.zoneCount = 1;
    const Vec3 top = at[lower];  // the fixture brick's origin is the middle of its top
    graph.zones.push_back({top, top + leaves * 4, 8});
    connect::Release r;
    r.kind = connect::ReleaseKind::Along;
    r.axis = upper == c.b ? leaves : -leaves;  // kept as how b leaves a
    r.travel = 4;
    graph.releases.push_back(r);
    graph.connections.push_back(c);
  }
  void finish() {
    static int counter = 0;
    const fs::path file = fs::temp_directory_path() / ("bm_plan_" + std::to_string(::getpid()) + "_" + std::to_string(counter++) + ".ldr");
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
  Plan plan(const Options& options = {}) {
    if (!model) finish();
    return bm::plan::plan(*model, graph, parts, shapes, options);
  }
  Certificate certify(const Plan& p) { return bm::plan::certify(*model, graph, parts, shapes, p); }
};

std::vector<uint32_t> order(const Plan& p) {
  std::vector<uint32_t> out;
  for (const Move& m : p.moves) out.insert(out.end(), m.unit.pieces.begin(), m.unit.pieces.end());
  return out;
}
}  // namespace

TEST_CASE("a tower is built from the bottom, each brick pressed down onto the last", "[plan]") {
  Scene s;
  const uint32_t a = s.add(0, 0, 0), b = s.add(0, -24, 0), c = s.add(0, -48, 0);
  s.stud(a, b);
  s.stud(b, c);
  const Plan p = s.plan();
  REQUIRE(p.complete);
  REQUIRE(order(p) == std::vector<uint32_t>{a, b, c});
  for (size_t i = 1; i < p.moves.size(); i++) {
    REQUIRE(p.moves[i].flag == Flag::None);
    REQUIRE_THAT(p.moves[i].insertion.y, WithinAbs(1, 1e-9));  // down onto the stud
    REQUIRE(p.moves[i].path.size() >= 2);
    REQUIRE_THAT(p.moves[i].seatTravel, WithinAbs(4, 1e-9));
  }
  const Certificate cert = s.certify(p);
  REQUIRE(cert.ok());
  REQUIRE(cert.certified == 3);
}

TEST_CASE("the certifier catches what breaks each rule", "[plan][certify]") {
  Scene s;
  const uint32_t a = s.add(0, 0, 0), b = s.add(0, -24, 0), c = s.add(0, -48, 0);
  s.stud(a, b);
  s.stud(b, c);
  const Plan good = s.plan();
  REQUIRE(s.certify(good).ok());
  // Rule 1: the top brick before the one under it lands joined to nothing built.
  Plan swapped = good;
  std::swap(swapped.moves[1], swapped.moves[2]);
  const Certificate floating = s.certify(swapped);
  REQUIRE_FALSE(floating.ok());
  REQUIRE(floating.floating == 1);
  REQUIRE_FALSE(floating.moves[1].joined);
  // Rule 2: a flight that comes up through the brick below.
  Plan through = good;
  through.moves[2].path = {Xform{}, Xform{}, Xform{}};
  through.moves[2].path[1].t = {0, -4, 0};
  through.moves[2].path[2].t = {0, 200, 0};  // from under the tower
  const Certificate crossing = s.certify(through);
  REQUIRE(crossing.crossings == 1);
  REQUIRE_FALSE(crossing.moves[2].clear);
  REQUIRE(crossing.moves[2].crossed != UINT32_MAX);
  // Rule 3: onto a stud from the side.
  Plan sideways = good;
  sideways.moves[2].path = {Xform{}, Xform{}};
  sideways.moves[2].path[1].t = {200, 0, 0};
  const Certificate off = s.certify(sideways);
  REQUIRE(off.offAxis == 1);
  REQUIRE_FALSE(off.moves[2].alongConnector);
  // A flagged move is counted and never certified.
  Plan flagged = good;
  flagged.moves[2].flag = Flag::Blocked;
  const Certificate f = s.certify(flagged);
  REQUIRE((f.flagged == 1 && f.certified == 2 && !f.ok()));
}

TEST_CASE("a brick shut in under another goes in first", "[plan]") {
  // A base, a brick on it, and a lid over that brick held up by two posts either side.
  Scene s;
  const uint32_t base = s.add(0, 0, 0), baseL = s.add(-20, 0, 0), baseR = s.add(20, 0, 0);
  const uint32_t inner = s.add(0, -24, 0), postL = s.add(-20, -24, 0), postR = s.add(20, -24, 0);
  const uint32_t lidL = s.add(-20, -48, 0), lid = s.add(0, -48, 0), lidR = s.add(20, -48, 0);
  s.stud(base, inner), s.stud(baseL, postL), s.stud(baseR, postR);
  s.stud(postL, lidL), s.stud(postR, lidR), s.stud(inner, lid);
  // The bottom and top rows are each one rigid course.
  s.stud(base, baseL, {-1, 0, 0}), s.stud(base, baseR, {1, 0, 0});
  const Plan p = s.plan();
  const std::vector<uint32_t> built = order(p);
  auto when = [&](uint32_t piece) { return std::find(built.begin(), built.end(), piece) - built.begin(); };
  REQUIRE(when(inner) < when(lid));
  REQUIRE(when(base) < when(inner));
  const Certificate cert = s.certify(p);
  REQUIRE(cert.floating == 0);
  REQUIRE(cert.crossings == 0);
}

TEST_CASE("empty, one piece, separate assemblies, and a piece joined to nothing", "[plan][focus]") {
  Scene empty;
  const Plan none = empty.plan();
  REQUIRE((none.moves.empty() && none.complete));
  REQUIRE(empty.certify(none).ok());

  Scene one;
  one.add(0, 0, 0);
  const Plan single = one.plan();
  REQUIRE(single.moves.size() == 1);
  REQUIRE(single.moves[0].flag == Flag::None);
  REQUIRE(one.certify(single).ok());

  // Two towers, the taller first; then a brick lying beside them joined to nothing.
  Scene s;
  const uint32_t a0 = s.add(0, 0, 0), a1 = s.add(0, -24, 0);
  const uint32_t b0 = s.add(200, 0, 0), b1 = s.add(200, -24, 0), b2 = s.add(200, -48, 0);
  const uint32_t loose = s.add(400, 0, 0);
  s.stud(a0, a1), s.stud(b0, b1), s.stud(b1, b2);
  const Plan p = s.plan();
  REQUIRE(order(p) == std::vector<uint32_t>{b0, b1, b2, a0, a1, loose});
  REQUIRE(p.moves.back().flag == Flag::Unjoined);
  const Certificate cert = s.certify(p);
  REQUIRE(cert.certified == 5);
  REQUIRE((cert.flagged == 1 && cert.unjoined == 1 && cert.floating == 0));
}

TEST_CASE("a piece that cannot be shown going in is flagged, and the rest is still planned", "[plan][focus]") {
  // A brick held by two studs that leave along lines square to each other.
  Scene s;
  const uint32_t base = s.add(0, 0, 0), side = s.add(40, -24, 0), held = s.add(0, -24, 0), top = s.add(0, -48, 0);
  s.stud(base, held);                 // leaves upward
  s.stud(side, held, {-1, 0, 0});     // and must also leave sideways
  s.stud(held, top);
  s.stud(base, side, {1, 0, 0});
  const Plan p = s.plan();
  REQUIRE(p.complete);
  size_t pieces = 0, flagged = 0;
  for (const Move& m : p.moves) pieces += m.unit.pieces.size(), flagged += m.flag != Flag::None;
  REQUIRE(pieces == 4);
  // Either it went in grouped with a neighbour, or it says it could not: never silently.
  const Certificate cert = s.certify(p);
  REQUIRE(cert.crossings == 0);
  REQUIRE(cert.floating == 0);
  REQUIRE(cert.total == cert.certified + cert.flagged + cert.offAxis);
  REQUIRE(leaveDirections(Context(*s.model, s.graph, collide::World(*s.model, s.parts, s.shapes)), Unit{{held}}, nullptr).empty());
}

TEST_CASE("the same plan on one thread and on eight; cancelled plans say so", "[plan]") {
  Scene s;
  std::vector<uint32_t> last(9, UINT32_MAX);
  for (int layer = 0; layer < 6; layer++)
    for (int i = 0; i < 9; i++) {
      const uint32_t p = s.add(20.0 * (i % 3), -24.0 * layer, 20.0 * (i / 3));
      if (last[i] != UINT32_MAX) s.stud(last[i], p);
      last[i] = p;
    }
  // Tie the nine columns into one group along the bottom course.
  for (int i = 1; i < 9; i++) s.stud(static_cast<uint32_t>(i - 1), static_cast<uint32_t>(i), {1, 0, 0});
  JobPool one(1), eight(8);
  Options a, b;
  a.pool = &one, b.pool = &eight;
  const Plan first = s.plan(a), second = s.plan(b);
  REQUIRE(order(first) == order(second));
  REQUIRE(first.moves.size() == second.moves.size());
  for (size_t i = 0; i < first.moves.size(); i++) REQUIRE(first.moves[i].flag == second.moves[i].flag);
  CancelToken stop;
  stop.cancel();
  Options cancelled;
  cancelled.cancel = &stop;
  const Plan partial = s.plan(cancelled);
  REQUIRE_FALSE(partial.complete);
  REQUIRE(order(partial).size() == 54);
  for (const Move& m : partial.moves) REQUIRE(m.flag == Flag::Budget);
  REQUIRE(s.certify(partial).certified == 0);
}

TEST_CASE("the timeline stages units on the floor and flies each to its seat", "[plan][timeline]") {
  Scene s;
  const uint32_t a = s.add(0, 0, 0), b = s.add(0, -24, 0), c = s.add(0, -48, 0);
  s.stud(a, b), s.stud(b, c);
  Plan p = s.plan();
  p.moves[2].flag = Flag::Blocked;  // a flagged move does not fly
  Style style;
  style.fps = 30, style.piecesPerSecond = 2;
  const Timeline t = buildTimeline(*s.model, s.parts, p, style);
  REQUIRE(t.flights.size() == 3);
  REQUIRE(t.frames == 30);  // two flights of 15 frames
  REQUIRE(t.flights[2].frames == 0);
  for (size_t i = 0; i < 2; i++) {
    const Flight& f = t.flights[i];
    REQUIRE(f.frames == 15);
    REQUIRE(f.waypoints.size() == f.at.size());
    REQUIRE(length(f.waypoints.back().t) == 0);  // the seat
    REQUIRE(length(poseAt(f, f.startFrame + f.frames).t) == 0);
    REQUIRE_THAT(length(poseAt(f, f.startFrame).t - f.staging.t), WithinAbs(0, 1e-9));
    // It waits on the floor (the model's lowest level, y = 24) clear of the model.
    const double bottom = s.at[p.moves[i].unit.pieces[0]].y + 24 + f.staging.t.y;
    REQUIRE_THAT(bottom, WithinAbs(24, 1e-6));
    REQUIRE(std::abs(f.staging.t.x) + std::abs(f.staging.t.z) > 30);
    // The last leg is the landing: the seat leg of the plan.
    REQUIRE_THAT(f.at[f.at.size() - 2], WithinAbs(1 - style.landing, 1e-9));
    // Before it, the hover: two waypoints at the same pose.
    REQUIRE_THAT(f.at[f.at.size() - 3], WithinAbs(1 - style.landing - style.hover, 1e-9));
    REQUIRE(length(f.waypoints[f.waypoints.size() - 2].t - f.waypoints[f.waypoints.size() - 3].t) == 0);
    double step = 0;
    for (int frame = f.startFrame; frame < f.startFrame + f.frames; frame++) step = std::max(step, length(poseAt(f, frame + 1).t - poseAt(f, frame).t));
    REQUIRE(step < 400);  // no jump
  }
  REQUIRE(length((t.flights[0].staging.t + s.at[p.moves[0].unit.pieces[0]]) - (t.flights[1].staging.t + s.at[p.moves[1].unit.pieces[0]])) >= 20);  // each its own spot
  REQUIRE_FALSE(t.camera.empty());
  const nlohmann::json j = toJson(p, nullptr, *s.model);
  REQUIRE(j["moves"].size() == 3);
  REQUIRE(j["moves"][2]["flag"] == "blocked");
  REQUIRE(j["sweep"] == "sampled 0.5");
}

#include "bm/plan/constraints.h"

TEST_CASE("what the author fixed is read from the plan file", "[plan][constraints]") {
  const ldraw::Library lib(fs::path(BM_FIXTURES) / "lib");
  ldraw::PartCache parts(lib, fs::temp_directory_path() / "bm_plan_cache");
  const io::PlanDoc doc = io::readPlan(R"({"format":"brickmotion-plan","version":1,"name":"t","steps":[
    {"pinOrder":true,"pieces":[
      {"id":"a","part":"3005","color":4,"ldu":[0,0,0],"matrix":[1,0,0,0,1,0,0,0,1]},
      {"id":"b","part":"3005","color":4,"ldu":[100,0,0],"matrix":[1,0,0,0,1,0,0,0,1],
       "assembly":{"after":["c","nobody"],"insertionAxis":[0,-2,0],
                   "flight":[[0,-100,0,0,0,0,1],[0,0,0,0,0,0,1]]}},
      {"id":"c","part":"3005","color":4,"ldu":[200,0,0],"matrix":[1,0,0,0,1,0,0,0,1],
       "assembly":{"insertionAxis":[0,0,0],"flight":[[0,0,0]]}}]}]})");
  const Model model = io::fromPlan(doc, lib, parts);
  REQUIRE(model.pieces().size() == 3);
  const Constraints c = readConstraints(doc, model);
  REQUIRE(c.pinned == std::vector<std::vector<uint32_t>>{{0, 1, 2}});
  REQUIRE(c.after == std::vector<std::pair<uint32_t, uint32_t>>{{2, 1}});
  REQUIRE_THAT(c.insertionAxis[1].y, WithinAbs(-1, 1e-12));
  REQUIRE(length(c.insertionAxis[2]) == 0);  // a zero axis is no axis
  REQUIRE(c.flight[1].size() == 2);
  REQUIRE_THAT(c.flight[1][0].t.y, WithinAbs(-100, 1e-9));  // starts 100 above its seat
  REQUIRE(length(c.flight[1][1].t) == 0);
  REQUIRE(c.flight[2].empty());  // a malformed flight is left out
}

TEST_CASE("pinned order and the author's own flight are kept", "[plan][constraints]") {
  // Three bricks side by side on a base: the planner alone would take them outside-in.
  Scene s;
  const uint32_t base = s.add(0, 0, 0), baseL = s.add(-20, 0, 0), baseR = s.add(20, 0, 0);
  const uint32_t left = s.add(-20, -24, 0), mid = s.add(0, -24, 0), right = s.add(20, -24, 0);
  s.stud(base, baseL, {-1, 0, 0}), s.stud(base, baseR, {1, 0, 0});
  s.stud(baseL, left), s.stud(base, mid), s.stud(baseR, right);
  s.finish();
  Constraints authored;
  authored.pinned = {{right, mid, left}};
  authored.flight.resize(6);
  Xform high;
  high.t = {0, -300, 0};
  authored.flight[mid] = {high, Xform{}};  // straight down from far above
  Options options;
  options.authored = &authored;
  const Plan p = s.plan(options);
  const std::vector<uint32_t> built = order(p);
  auto when = [&](uint32_t piece) { return std::find(built.begin(), built.end(), piece) - built.begin(); };
  REQUIRE(when(right) < when(mid));
  REQUIRE(when(mid) < when(left));
  const Move& m = p.moves[static_cast<size_t>(when(mid))];
  REQUIRE(m.authoredFlight);
  REQUIRE(m.path.size() == 2);
  REQUIRE_THAT(m.path[1].t.y, WithinAbs(-300, 1e-9));
  REQUIRE(m.flag == Flag::None);
  // A flight that comes in through the base is the author's, kept, and flagged.
  Xform under, below;
  under.t = {0, 300, 0}, below.t = {0, 10, 0};
  authored.flight[mid] = {under, below, Xform{}};
  const Plan crossing = s.plan(options);
  const std::vector<uint32_t> again = order(crossing);
  const Move& bad = crossing.moves[static_cast<size_t>(std::find(again.begin(), again.end(), mid) - again.begin())];
  REQUIRE(bad.authoredFlight);
  REQUIRE(bad.path.size() == 3);
  REQUIRE(bad.flag == Flag::AuthoredCrossing);
}
