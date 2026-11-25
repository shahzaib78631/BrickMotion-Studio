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

  std::string sub;  ///< a submodel, placed where the first addIn was called
  /// Starts the file's next build step.
  void step() { text += "0 STEP\n"; }
  /// Starts the submodel's next build step.
  void subStep() { sub += "0 STEP\n"; }
  /// A brick in the submodel (calls to it come one after another: the submodel is placed once).
  uint32_t addIn(double x, double y, double z) {
    if (sub.empty()) text += "1 16 0 0 0 1 0 0 0 1 0 0 0 1 sub.ldr\n";
    sub += "1 4 " + std::to_string(x) + " " + std::to_string(y) + " " + std::to_string(z) + " 1 0 0 0 1 0 0 0 1 3005.dat\n";
    at.push_back({x, y, z});
    return static_cast<uint32_t>(at.size() - 1);
  }
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
  /// `b` held to `a` by a mate that lets the two cross anywhere (a tyre on its rim), `b` coming
  /// off along `leaves` over `travel`.
  void stretch(uint32_t a, uint32_t b, Vec3 leaves, double travel) {
    connect::Connection c;
    c.a = std::min(a, b), c.b = std::max(a, b);
    c.joint.kind = connect::JointKind::Fixed;
    c.firstZone = static_cast<uint32_t>(graph.zones.size());
    c.zoneCount = 1;
    graph.zones.push_back({at[a], at[a], collide::kElasticZone});
    connect::Release r;
    r.kind = connect::ReleaseKind::Along;
    r.axis = b == c.b ? leaves : -leaves;  // kept as how b leaves a
    r.travel = travel;
    graph.releases.push_back(r);
    graph.connections.push_back(c);
  }
  void finish() {
    static int counter = 0;
    const fs::path file = fs::temp_directory_path() / ("bm_plan_" + std::to_string(::getpid()) + "_" + std::to_string(counter++) + (sub.empty() ? ".ldr" : ".mpd"));
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

TEST_CASE("each use of a submodel is a unit of its own, not every use of it at once", "[plan]") {
  // "wheel pair.ldr" (two bricks, joined) is used twice in main: two units, one per use.
  const ldraw::Library lib(fs::path(BM_FIXTURES) / "lib");
  const Model model = io::load(fs::path(BM_FIXTURES) / "models" / "twice.mpd", lib);
  REQUIRE(model.pieces().size() == 6);
  connect::Graph graph;
  graph.body.resize(model.pieces().size());
  std::iota(graph.body.begin(), graph.body.end(), 0u);
  const auto useOf = [&](uint32_t p) {
    const std::string& id = model.pieces()[p].id;
    return id.find('/') == std::string::npos ? std::string{} : id.substr(0, id.find('/'));
  };
  for (uint32_t i = 0; i < model.pieces().size(); i++)
    for (uint32_t j = i + 1; j < model.pieces().size(); j++)
      if (!useOf(i).empty() && useOf(i) == useOf(j)) {
        connect::Connection pair;
        pair.a = i, pair.b = j;
        graph.connections.push_back(pair);
      }
  REQUIRE(graph.connections.size() == 2);
  const Units units = findUnits(model, graph);
  REQUIRE(units.authored.size() == 2);
  for (const Unit& u : units.authored) {
    REQUIRE(u.pieces.size() == 2);
    const std::string& a = model.pieces()[u.pieces[0]].id;
    const std::string& b = model.pieces()[u.pieces[1]].id;
    REQUIRE(a.substr(0, a.find('/')) == b.substr(0, b.find('/')));  // the same use
  }
}

TEST_CASE("a use of a submodel goes in as one only where its pieces are joined to each other", "[plan]") {
  // apart.ldr holds two stacked bricks, joined, and a third standing off by itself: carried
  // as one, the third would float. The joined two are a unit; the third is not in one.
  const ldraw::Library lib(fs::path(BM_FIXTURES) / "lib");
  const fs::path file = fs::temp_directory_path() / ("bm_plan_apart_" + std::to_string(::getpid()) + ".mpd");
  {
    std::ofstream out(file);
    out << "0 FILE main.ldr\n1 16 0 0 0 1 0 0 0 1 0 0 0 1 3005.dat\n1 16 0 0 0 1 0 0 0 1 0 0 0 1 apart.ldr\n"
           "0 FILE apart.ldr\n1 16 100 0 0 1 0 0 0 1 0 0 0 1 3005.dat\n1 16 100 -24 0 1 0 0 0 1 0 0 0 1 3005.dat\n1 16 300 0 0 1 0 0 0 1 0 0 0 1 3005.dat\n";
  }
  const Model model = io::load(file, lib);
  fs::remove(file);
  REQUIRE(model.pieces().size() == 4);
  connect::Graph graph;
  graph.body.resize(model.pieces().size());
  std::iota(graph.body.begin(), graph.body.end(), 0u);
  connect::Connection stack;
  stack.a = 1, stack.b = 2;
  graph.connections.push_back(stack);
  const Units units = findUnits(model, graph);
  REQUIRE(units.authored.size() == 1);
  REQUIRE(units.authored[0].pieces == std::vector<uint32_t>{1, 2});
  REQUIRE(units.authoredOf[3].empty());
}

TEST_CASE("a rim held only by its tyre is not let through the pin it is not joined to", "[plan][zones]") {
  // The tyre's mate lets tyre and rim cross anywhere. Up out of the tyre, the rim would pass
  // through a pin that belongs to a bigger assembly, built first. The tyre, further out, is
  // taken off before the rim.
  Scene s;
  const uint32_t rim = s.add(0, 0, 0), pin = s.add(0, -24, 0), tyre = s.add(200, 0, 0);
  const uint32_t post = s.add(-40, -24, 0), foot = s.add(-40, 0, 0);
  s.stud(foot, post);
  s.stud(post, pin, {1, 0, 0});
  s.stretch(tyre, rim, kUp, 50);
  const Plan p = s.plan();
  const Certificate cert = s.certify(p);
  REQUIRE(cert.crossings == 0);
  REQUIRE(cert.floating == 0);
  // With its tyre there, the rim cannot come up through the pin: the tyre's zone is for the tyre.
  const collide::World world(*s.model, s.parts, s.shapes);
  const Context ctx(*s.model, s.graph, world);
  Box bounds;
  for (uint32_t i = 0; i < s.at.size(); i++) bounds.merge(world.box(i));
  const Extraction e = extract(ctx, Unit{{rim}}, nullptr, bounds);
  REQUIRE_FALSE(e.ok);
  REQUIRE(e.why == Flag::Blocked);
  REQUIRE(e.blocker == pin);
}

TEST_CASE("the certifier lets a mate's zone forgive only its own two pieces", "[plan][certify][zones]") {
  // The tyre is placed, then the rim is flown down into it through a pin it is not joined to.
  Scene s;
  const uint32_t rim = s.add(0, 0, 0), pin = s.add(0, -24, 0), tyre = s.add(200, 0, 0);
  s.stretch(tyre, rim, kUp, 50);
  s.finish();
  Plan p;
  for (uint32_t piece : {pin, tyre, rim}) {
    Move m;
    m.unit = Unit{{piece}};
    m.insertion = {0, 1, 0};
    m.path = {Xform{}, Xform{Mat3::identity(), {0, -60, 0}}};
    p.moves.push_back(m);
  }
  const Certificate cert = s.certify(p);
  REQUIRE(cert.moves[0].clear);
  REQUIRE(cert.moves[1].clear);
  REQUIRE_FALSE(cert.moves[2].clear);
  REQUIRE(cert.moves[2].crossed == pin);
  REQUIRE(cert.crossings == 1);
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
  // Joined to nothing, it still has a way in and flies it: it does not appear in place.
  REQUIRE(!p.moves.back().path.empty());
  const Timeline t = buildTimeline(*s.model, s.parts, p);
  REQUIRE(t.flights.back().frames > 0);
  REQUIRE(poseAt(t.flights.back(), t.flights.back().startFrame + t.flights.back().frames).t == Vec3{});
  REQUIRE(certifyPlay(*s.model, s.graph, s.parts, s.shapes, p, t).strictCrossings == 0);
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

TEST_CASE("flight checks reuse blocked routes and discard cancelled work", "[plan][timeline]") {
  FlightCheckCache cache;
  CHECK_FALSE(cache.validate({1}, [] { return false; }));
  CHECK_FALSE(cache.validate({1}, [] { return true; }));
  CHECK(cache.hits() == 1);

  CancelToken cancelled;
  CHECK_FALSE(cache.validate({2}, [&] {
    cancelled.cancel();
    return false;
  }, &cancelled));
  CHECK(cache.validate({2}, [] { return true; }));
  CHECK(cache.hits() == 1);
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
  REQUIRE(t.flights[2].frames == 0);
  for (size_t i = 0; i < 2; i++) {
    const Flight& f = t.flights[i];
    REQUIRE(f.frames >= 13);  // at least the web's 0.85 of a slot: 0.425 s
    REQUIRE(f.route.size() >= 2);
    REQUIRE(poseAt(f, f.startFrame + f.frames).t == Vec3{});  // the seat, exactly
    REQUIRE(poseAt(f, static_cast<double>(f.startFrame + f.frames) - 1e-9).r.m[0] == 1);  // turned to its seat's way before it lands
    REQUIRE_THAT(length(poseAt(f, f.startFrame).t - f.staging.t), WithinAbs(0, 1e-9));
    // It waits on the floor (the model's lowest level, y = 24) clear of the model.
    const double bottom = s.at[p.moves[i].unit.pieces[0]].y + 24 + f.staging.t.y;
    REQUIRE_THAT(bottom, WithinAbs(24, 1e-6));
    REQUIRE(std::abs(f.staging.t.x) + std::abs(f.staging.t.z) > 30);
    // The last leg is the landing, eased on its own, from rest to rest.
    REQUIRE(f.phases.size() >= 2);
    REQUIRE(f.seatFrames > 0);
    REQUIRE_THAT(f.seatAt + f.seatFrames, WithinAbs(f.frames, 1e-9));
    double step = 0;
    for (int frame = f.startFrame; frame < f.startFrame + f.frames; frame++) step = std::max(step, length(poseAt(f, frame + 1).t - poseAt(f, frame).t));
    REQUIRE(step < 60);  // no jump: never faster than the speed cap allows
    // Above everything in the way, but not far above: a brick's clearance over what stands.
    double highest = 0;
    for (int frame = f.startFrame; frame <= f.startFrame + f.frames; frame++) highest = std::max(highest, -poseAt(f, frame).t.y);
    REQUIRE(highest < 300);
  }
  REQUIRE(t.flights[1].startFrame >= t.flights[0].startFrame + t.flights[0].frames);  // one after another
  REQUIRE(length((t.flights[0].staging.t + s.at[p.moves[0].unit.pieces[0]]) - (t.flights[1].staging.t + s.at[p.moves[1].unit.pieces[0]])) >= 20);  // each its own spot
  REQUIRE_FALSE(t.camera.empty());
  const nlohmann::json j = toJson(p, nullptr, *s.model);
  REQUIRE(j["moves"].size() == 3);
  REQUIRE(j["moves"][2]["flag"] == "blocked");
  REQUIRE(j["sweep"] == "continuous 0.001");
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

#include "bm/connect/studio.h"
#include "bm/plan/truth.h"

TEST_CASE("hand-checked insertions: pins, axles, bushes, studs from above and from the side", "[plan][truth][data]") {
  const char* dir = std::getenv("BM_LDRAW_DIR");
  const char* shadowDir = std::getenv("BM_SHADOW_DIR");
  if (!dir || !shadowDir) SKIP("BM_LDRAW_DIR / BM_SHADOW_DIR not set");
  const ldraw::Library lib(dir);
  const connect::ShadowLibrary shadow(shadowDir);
  connect::ConnectorDb db(lib, shadow);
  ldraw::PartCache parts(lib, ldraw::PartCache::defaultDirectory());
  collide::ShapeCache shapes;
  const fs::path repo = fs::path(dir).parent_path().parent_path();
  std::ifstream in(repo / "native" / "corpus" / "insertion-truth.json");
  const nlohmann::json doc = nlohmann::json::parse(in, nullptr, false);
  REQUIRE(doc.is_object());
  int cases = 0;
  for (const char* name : {"pin.ldr", "stack.ldr", "snot.ldr", "axle.ldr"}) {
    const Model model = io::load(fs::path(BM_FIXTURES) / "plan" / name, lib);
    const connect::Graph graph = connect::buildGraph(model, db);
    const Plan p = bm::plan::plan(model, graph, parts, shapes);
    const Certificate cert = certify(model, graph, parts, shapes, p);
    INFO(name);
    REQUIRE(cert.ok());
    nlohmann::json mine = nlohmann::json::array();
    for (const nlohmann::json& c : doc["cases"])
      if (fs::path(c["file"].get<std::string>()).filename().string() == name) mine.push_back(c);
    const InsertionScore score = scoreInsertion(model, parts, p, mine);
    REQUIRE(score.missing == 0);
    REQUIRE(score.unresolved == 0);
    REQUIRE(score.hit == static_cast<int>(mine.size()));
    cases += score.hit;
  }
  REQUIRE(cases == 6);
  // A wrong axis is a miss that says by how much; a piece that is not there is unresolved.
  const Model model = io::load(fs::path(BM_FIXTURES) / "plan" / "stack.ldr", lib);
  const connect::Graph graph = connect::buildGraph(model, db);
  const Plan p = bm::plan::plan(model, graph, parts, shapes);
  const auto wrong = nlohmann::json::parse(R"([{"id":"sideways","piece":{"part":"3003","at":[0,-38,0]},"axis":[1,0,0]},
                                             {"id":"nowhere","piece":{"part":"3003","at":[500,0,0]},"axis":[0,1,0]}, 7])");
  const InsertionScore score = scoreInsertion(model, parts, p, wrong);
  REQUIRE((score.missing == 1 && score.unresolved == 2));
  REQUIRE(score.lines[0].detail.find("90 degrees") != std::string::npos);
}

#include "bm/collide/pair.h"

TEST_CASE("a unit taken out of its seat stops short of what it would cross there", "[plan][data]") {
  const char* dir = std::getenv("BM_LDRAW_DIR");
  const char* shadowDir = std::getenv("BM_SHADOW_DIR");
  if (!dir || !shadowDir) SKIP("BM_LDRAW_DIR / BM_SHADOW_DIR not set");
  const ldraw::Library lib(dir);
  const connect::ShadowLibrary shadow(shadowDir);
  connect::ConnectorDb db(lib, shadow);
  ldraw::PartCache parts(lib, ldraw::PartCache::defaultDirectory());
  collide::ShapeCache shapes;
  // From OMR 9396-1, once the beam it also went through has gone: an axle pin (43093) held in a
  // 64683 leaves along its own axis, and its end meets the end of a long pin (6558) a hair
  // before it is all the way out of its seat. That is out within kTravelTol, but where it stops
  // must cross nothing: every leg after starts there.
  const fs::path file = fs::temp_directory_path() / ("bm_plan_seat_" + std::to_string(::getpid()) + ".ldr");
  {
    std::ofstream out(file);
    out << "1 1 -117.879 -147.496 120 0.923879 -0.382683 0 0.382683 0.923879 0 0 0 1 43093.dat\n"
           "1 14 -127.118 -151.323 80 0.382683 0.923879 0 -0.923879 0.382683 0 0 0 1 64683.dat\n"
           "1 1 -80 -100 110 0 0 1 1 0 0 0 1 0 6558.dat\n";
  }
  const Model model = io::load(file, lib);
  fs::remove(file);
  const connect::Graph graph = connect::buildGraph(model, db);
  const collide::World world(model, parts, shapes);
  const Context ctx(model, graph, world);
  const collide::World::Present present(model.pieces().size(), 1);
  Box bounds;
  for (uint32_t i = 0; i < model.pieces().size(); i++) bounds.merge(world.box(i));
  const uint32_t pin = 0, longPin = 2;
  const Vec3 out = normalized(Vec3{0.923879, 0.382683, 0});
  double seat = -1;
  for (const Leave& l : leaveDirections(ctx, Unit{{pin}}, &present))
    if (dot(l.direction, out) > 0.9999) seat = l.travel + kClearMargin;
  REQUIRE(seat > 0);
  Xform atSeat = world.pose(pin);
  atSeat.t = atSeat.t + out * seat;
  REQUIRE(collide::overlap(world.shape(pin), atSeat, world.shape(longPin), world.pose(longPin)));
  const Extraction e = extract(ctx, Unit{{pin}}, &present, bounds, out);
  REQUIRE(e.ok);
  REQUIRE(e.path.size() >= 2);
  const double drawn = dot(e.path[1].t, out);
  CHECK(drawn >= seat - kTravelTol - 1e-9);
  CHECK(drawn <= seat);
  REQUIRE_FALSE(collide::overlap(world.shape(pin), e.path[1] * world.pose(pin), world.shape(longPin), world.pose(longPin)));
}

TEST_CASE("a unit out of its seat rests at its seat whatever was asked before", "[plan][zones]") {
  // How far one piece gets past another is remembered, and the answer kept for a travel is
  // also given for any within 0.01 of it: here the first unit's seat, a few thousandths short of
  // the second's. Which unit is looked at first is up to the threads, so where a unit rests out
  // of its seat must not depend on it.
  Scene s;
  // Each upper brick is sunk 2 LDU into its lower one, which their mate lets them do, so that
  // the two are looked at on the way out (two pieces whose boxes only touch never are).
  const uint32_t lowerA = s.add(0, 0, 0), upperA = s.add(0, -22, 0);
  const uint32_t lowerB = s.add(200, 0, 0), upperB = s.add(200, -22, 0);
  s.stretch(lowerA, upperA, kUp, 3.997);
  s.stretch(lowerB, upperB, kUp, 4.0);
  s.finish();
  const collide::World world(*s.model, s.parts, s.shapes);
  const Context ctx(*s.model, s.graph, world);
  Box bounds;
  for (uint32_t i = 0; i < s.at.size(); i++) bounds.merge(world.box(i));
  const Extraction a = extract(ctx, Unit{{upperA}}, nullptr, bounds, kUp);
  const Extraction b = extract(ctx, Unit{{upperB}}, nullptr, bounds, kUp);
  REQUIRE(a.ok);
  REQUIRE(b.ok);
  REQUIRE(a.path.size() >= 2);
  REQUIRE(b.path.size() >= 2);
  CHECK_THAT(dot(a.path[1].t, kUp), WithinAbs(3.997 + kClearMargin, 1e-9));
  CHECK_THAT(dot(b.path[1].t, kUp), WithinAbs(4.0 + kClearMargin, 1e-9));
}

// ---- what is played ----

namespace {
Xform shiftedBy(Vec3 v) {
  Xform x;
  x.t = v;
  return x;
}
PlayCheck played(Scene& s, const Plan& p) { return certifyPlay(*s.model, s.graph, s.parts, s.shapes, p, buildTimeline(*s.model, s.parts, p)); }
}  // namespace

TEST_CASE("the play certifier passes a tower", "[plan][play]") {
  Scene s;
  const uint32_t a = s.add(0, 0, 0), b = s.add(0, -24, 0), c = s.add(0, -48, 0);
  s.stud(a, b), s.stud(b, c);
  const PlayCheck k = played(s, s.plan());
  REQUIRE(k.flights == 3);
  REQUIRE(k.crossings == 0);
  REQUIRE(k.inversions == 0);
  REQUIRE(k.underFloor == 0);  // the base brick does not go out through the floor
  REQUIRE(k.upward == 0);
}

TEST_CASE("the play certifier sees a flight through a placed piece", "[plan][play]") {
  Scene s;
  const uint32_t a = s.add(0, 0, 0), b = s.add(0, -24, 0), c = s.add(0, -48, 0);
  s.stud(a, b), s.stud(b, c);
  Plan p = s.plan();
  REQUIRE(p.moves[2].unit.pieces == std::vector<uint32_t>{c});
  p.moves[2].path = {Xform{}, shiftedBy({0, 30, 0}), shiftedBy({0, 200, 0})};  // up from under the floor, through a and b
  p.moves[2].insertion = {0, -1, 0};
  const PlayCheck k = played(s, p);
  REQUIRE(k.crossings == 1);
  REQUIRE(k.crossed == std::vector<uint32_t>{2});
  REQUIRE(std::find(k.under.begin(), k.under.end(), 2u) != k.under.end());
  REQUIRE(k.upward >= 1);
}

TEST_CASE("a flagged move is not swept", "[plan][play]") {
  Scene s;
  const uint32_t a = s.add(0, 0, 0), b = s.add(0, -24, 0), c = s.add(0, -48, 0);
  s.stud(a, b), s.stud(b, c);
  Plan p = s.plan();
  p.moves[2].flag = Flag::Blocked;
  p.moves[2].path = {Xform{}, shiftedBy({0, 200, 0})};
  const PlayCheck k = played(s, p);
  REQUIRE(k.flights == 2);
  REQUIRE(k.crossings == 0);
}

TEST_CASE("inversions count moves built against their steps", "[plan][play]") {
  Scene s;
  const uint32_t a = s.add(0, 0, 0);
  s.step();
  const uint32_t b = s.add(0, -24, 0);
  s.step();
  const uint32_t c = s.add(0, -48, 0);
  s.stud(a, b), s.stud(b, c);
  Plan p = s.plan();
  REQUIRE(s.model->pieces()[c].step == 2);
  REQUIRE(played(s, p).inversions == 0);
  std::swap(p.moves[1], p.moves[2]);  // step 2 before step 1
  REQUIRE(played(s, p).inversions == 1);
}

TEST_CASE("the strict check sees pieces waiting on the floor", "[plan][play]") {
  Scene s;
  const uint32_t a = s.add(0, 0, 0), b = s.add(0, -24, 0);
  s.stud(a, b);
  const Plan p = s.plan();
  Timeline t = buildTimeline(*s.model, s.parts, p);
  REQUIRE(t.flights.size() == 2);
  REQUIRE(certifyPlay(*s.model, s.graph, s.parts, s.shapes, p, t).strictCrossings == 0);
  // The first flight sent through where the second piece waits.
  const size_t first = piecesOf(t.flights[0], p).front() == a ? 0 : 1;
  Flight& f = t.flights[first];
  const uint32_t other = first == 0 ? b : a;
  const Flight& waits = t.flights[1 - first];
  REQUIRE(waits.startFrame > f.startFrame);
  Xform through;
  through.t = waits.staging.t + s.at[other] - s.at[piecesOf(f, p).front()];
  f.waypoints = {f.staging, through, Xform{}};
  f.at = {0, 0.5, 1};
  f.air.clear(), f.airAt.clear(), f.airLeg.clear(), f.route.clear(), f.phases.clear();
  const PlayCheck k = certifyPlay(*s.model, s.graph, s.parts, s.shapes, p, t);
  REQUIRE(k.strictCrossings == 1);
  REQUIRE(k.strict.front().other == other);
}

TEST_CASE("a turned piece waits upright as drawn, lands exactly at its seat, and keeps to its path once on it", "[plan][timeline]") {
  Scene s;
  const uint32_t a = s.add(0, 0, 0);
  // b sits on a turned a quarter about the vertical.
  s.text += "1 4 0 -24 0 0 0 1 0 1 0 -1 0 0 3005.dat\n";
  s.at.push_back({0, -24, 0});
  const uint32_t b = 1;
  s.stud(a, b);
  const Plan p = s.plan();
  const Timeline t = buildTimeline(*s.model, s.parts, p);
  REQUIRE(t.flights.size() == 2);
  for (const Flight& f : t.flights) {
    const Xform end = poseAt(f, f.startFrame + f.frames);
    REQUIRE(end.t == Vec3{});
    for (int i = 0; i < 3; i++)
      for (int j = 0; j < 3; j++) REQUIRE_THAT(end.r.m[i * 3 + j], WithinAbs(i == j ? 1 : 0, 1e-12));
    // Waiting, its vertical stays vertical: the floor turns it only about the up axis, if at all.
    const Vec3 up = f.staging.r * Vec3{0, 1, 0};
    REQUIRE_THAT(up.y, WithinAbs(1, 1e-9));
    // Once the route reaches the plan's path (straight down onto the seat), it never leaves it.
    REQUIRE(!f.route.empty());
    bool on = false;
    for (const Vec3& c : f.route) {
      const bool here = std::abs(c.x - f.pivot.x) < 1e-6 && std::abs(c.z - f.pivot.z) < 1e-6;
      if (on) REQUIRE(here);
      on = on || here;
    }
    REQUIRE(on);
    if (piecesOf(f, p).front() == b) {  // drawn turned, it waits its part's own way round and turns on the way
      REQUIRE(std::abs(f.staging.r.m[0] - 1) > 1e-6);
      REQUIRE(f.routeTurn.front() < 1);
    }
  }
  REQUIRE(certifyPlay(*s.model, s.graph, s.parts, s.shapes, p, t).strictCrossings == 0);
}

TEST_CASE("a sub-assembly is swept as one", "[plan][play]") {
  Scene s;
  const uint32_t a = s.add(0, 0, 0), b = s.add(0, -24, 0);
  s.stud(a, b);
  const Plan inner = s.plan();
  Plan p;
  Move m;
  m.unit.pieces = {a, b};
  m.source = UnitSource::Grown;
  m.insertion = {0, 1, 0};
  m.path = {Xform{}, shiftedBy({0, -30, 0}), shiftedBy({0, -300, 0})};
  m.sub = 0;
  p.moves.push_back(m);
  p.subs.push_back(inner);
  const PlayCheck k = played(s, p);
  REQUIRE(k.flights == 3);  // its two pieces, built on its spot, then the unit
  REQUIRE(k.crossings == 0);
  REQUIRE(k.underFloor == 0);
  REQUIRE(k.strictCrossings == 0);
}

TEST_CASE("a unit is built piece by piece on its spot before it flies in whole", "[plan][play]") {
  Scene s;
  const uint32_t a = s.add(0, 0, 0), b = s.add(0, -24, 0);
  s.stud(a, b);
  const Plan inner = s.plan();
  REQUIRE(inner.moves.size() == 2);
  Plan p;
  Move m;
  m.unit.pieces = {a, b};
  m.source = UnitSource::Grown;
  m.insertion = {0, 1, 0};
  m.path = {Xform{}, shiftedBy({0, -30, 0}), shiftedBy({0, -300, 0})};
  m.sub = 0;
  p.moves.push_back(m);
  p.subs.push_back(inner);
  const Timeline t = buildTimeline(*s.model, s.parts, p);
  REQUIRE(t.flights.size() == 3);
  const Flight& unit = t.flights[2];
  REQUIRE(unit.parent == -1);
  REQUIRE(unit.pieces == std::vector<uint32_t>{a, b});
  for (size_t i = 0; i < 2; i++) {
    const Flight& f = t.flights[i];
    REQUIRE(f.parent == 2);
    REQUIRE(f.depth == 1);
    REQUIRE(f.pieces.size() == 1);
    REQUIRE(f.startFrame + f.frames <= unit.startFrame);
    // Seated in the unit, the unit still on its spot: the piece stands there.
    const Xform there = motionAt(t, i, unit.startFrame);
    REQUIRE(length(there.t - unit.staging.t) < 1e-9);
    // Before its flight it waits on its own spot, not the unit's.
    REQUIRE(length(motionAt(t, i, 0).t - unit.staging.t) > 1);
  }
  // Flown in, everything is at its seat.
  for (size_t i = 0; i < 3; i++) REQUIRE(length(motionAt(t, i, t.frames).t) < 1e-9);
}

TEST_CASE("a piece hung under a bridge leaves sideways, not through the floor", "[plan][floor]") {
  Scene s;
  const uint32_t a1 = s.add(0, 0, 0), a2 = s.add(0, -24, 0), b1 = s.add(60, 0, 0), b2 = s.add(60, -24, 0);
  const uint32_t c = s.add(20, -48, 0), d = s.add(40, -48, 0), e = s.add(20, -24, 0);
  s.stud(a1, a2), s.stud(b1, b2), s.stud(a2, c), s.stud(b2, d), s.stud(c, d, {1, 0, 0});
  s.stud(e, c);  // e hangs under c, its studs in c: it comes off downward
  const Plan p = s.plan();
  const double floor = 24;  // the bottom of a1 and b1
  for (const Move& m : p.moves) {
    if (m.unit.pieces != std::vector<uint32_t>{e}) continue;
    REQUIRE(m.flag == Flag::None);
    for (const Xform& x : m.path) REQUIRE(s.at[e].y + 24 + x.t.y <= floor + m.seatTravel + kClearMargin);
  }
  const PlayCheck k = played(s, p);
  REQUIRE(k.underFloor == 0);
  REQUIRE(k.crossings == 0);
}

TEST_CASE("a piece under the base is built first on the table, the base pressed onto it", "[plan][floor]") {
  Scene s;
  const uint32_t t0 = s.add(0, 0, 0), t1 = s.add(0, -24, 0), u = s.add(0, 24, 0);
  s.stud(t0, t1);
  s.stud(u, t0);  // u is fixed under t0, its studs in t0: it comes off downward
  const Plan p = s.plan();
  REQUIRE(order(p).front() == u);
  for (const Move& m : p.moves) REQUIRE(m.flag == Flag::None);
  const PlayCheck k = played(s, p);
  REQUIRE(k.underFloor == 0);
  REQUIRE(k.upward == 0);
  REQUIRE(k.crossings == 0);
}

TEST_CASE("a step's pieces that only come off together are built last, not first", "[plan][steps]") {
  Scene s;
  const uint32_t a = s.add(0, 0, 0), d = s.add(20, 0, 0), g0 = s.add(-60, 0, 0);  // step 0
  s.step();
  const uint32_t b = s.add(0, -24, 0), f = s.add(20, -24, 0), g1 = s.add(-60, -24, 0);  // step 1
  s.step();
  s.step();
  const uint32_t c = s.add(0, -48, 0), h = s.add(0, -72, 0);  // step 3: a blade under its hub
  s.stud(a, b), s.stud(d, f), s.stud(g0, g1), s.stud(a, g0, {-1, 0, 0}), s.stud(a, d, {1, 0, 0});
  s.stud(b, f, {1, 0, 0});  // f is also joined to b sideways: b and f go on together
  s.stud(f, h);  // the hub is held up by f
  s.stud(c, h);  // the blade's studs are in the hub: it comes off downward, onto b (not joined)
  const Plan p = s.plan();
  REQUIRE(s.model->pieces()[h].step == 3);
  REQUIRE(p.subs.size() <= 2);
  REQUIRE(p.moves.back().unit.pieces == std::vector<uint32_t>{c, h});
  const std::vector<uint32_t> o = order(p);
  REQUIRE(std::find(o.begin(), o.end(), g1) < std::find(o.begin(), o.end(), c));
  REQUIRE(played(s, p).inversions == 0);
  REQUIRE(played(s, p).crossings == 0);
}

TEST_CASE("within a step, pieces go in from above", "[plan][steps]") {
  Scene s;
  const uint32_t a = s.add(0, 0, 0), b = s.add(0, -24, 0), c = s.add(0, -48, 0);
  s.stud(a, b), s.stud(b, c);
  const PlayCheck k = played(s, s.plan());
  REQUIRE(k.upward == 0);
  REQUIRE(k.inversions == 0);
}

TEST_CASE("a flight moves as the web's: up, across, and one drop into the seat", "[plan][timeline]") {
  Scene s;
  const uint32_t a = s.add(0, 0, 0), b = s.add(0, -24, 0), c = s.add(0, -48, 0);
  s.stud(a, b), s.stud(b, c);
  const Plan p = s.plan();
  Style style;
  style.fps = 30, style.piecesPerSecond = 0.25;
  style.shape = FlightShape::Web;
  const Timeline t = buildTimeline(*s.model, s.parts, p, style);
  // src/anim/timeline.ts flightPose, straight down (no side entry): minimum jerk on each leg.
  auto mj = [](double u) { u = std::clamp(u, 0.0, 1.0); return u * u * u * (10 + u * (-15 + 6 * u)); };
  for (const Flight& f : t.flights) {
    REQUIRE(f.frames == 27);  // the web's longest: 0.9 s
    REQUIRE(f.phases.size() == 3);
    REQUIRE_THAT(f.phases[0].frames / f.frames, WithinAbs(0.24, 1e-12));
    REQUIRE_THAT(f.phases[2].start / f.frames, WithinAbs(0.76, 1e-12));
    REQUIRE_THAT(f.liftAt / f.frames, WithinAbs(0.24, 1e-12));
    // Straight up, level across, straight down: the corners as the web's.
    const Vec3 p0 = poseAt(f, f.startFrame).t, p1{};
    const double sky = poseAt(f, f.startFrame + f.phases[1].start).t.y;
    REQUIRE(sky < std::min(p0.y, p1.y) - 24);
    for (int k = 0; k <= 270; k++) {
      const double u = k / 270.0;
      Vec3 w;
      if (u < 0.24) w = {p0.x, p0.y + (sky - p0.y) * mj(u / 0.24), p0.z};
      else if (u < 0.76) { const double e = mj((u - 0.24) / 0.52); w = {p0.x + (p1.x - p0.x) * e, sky, p0.z + (p1.z - p0.z) * e}; }
      else w = {p1.x, sky + (p1.y - sky) * mj((u - 0.76) / 0.24), p1.z};
      const Vec3 n = poseAt(f, f.startFrame + u * f.frames).t;
      INFO("move " << f.move << " u " << u);
      REQUIRE_THAT(length(n - w), WithinAbs(0, 1e-6));
    }
    REQUIRE(length(poseAt(f, f.startFrame + f.frames).t) == 0);
  }
  REQUIRE(certifyPlay(*s.model, s.graph, s.parts, s.shapes, p, t).crossings == 0);
}

TEST_CASE("a clear flight is carried straight to its way in, turning on the way", "[plan][timeline]") {
  Scene s;
  const uint32_t a = s.add(0, 0, 0), b = s.add(0, -24, 0), c = s.add(0, -48, 0);
  s.stud(a, b), s.stud(b, c);
  const Plan p = s.plan();
  Style style;
  style.fps = 30, style.piecesPerSecond = 0.25;
  const Timeline t = buildTimeline(*s.model, s.parts, p, style);
  int flown = 0;
  for (const Flight& f : t.flights) {
    if (f.frames == 0) continue;
    flown++;
    REQUIRE(f.direct);           // nothing stands in the way: no lift over anything
    REQUIRE(f.phases.size() <= 2);
    // Carried across as it goes: it is not floating straight up above where it lay.
    const Vec3 at0 = poseAt(f, f.startFrame).t, at = poseAt(f, f.startFrame + 0.25 * f.frames).t;
    REQUIRE(length(Vec3{at.x - at0.x, 0, at.z - at0.z}) > 1);
  }
  REQUIRE(flown > 0);
  REQUIRE(certifyPlay(*s.model, s.graph, s.parts, s.shapes, p, t).crossings == 0);
}

TEST_CASE("an arc flight sweeps up and over without stopping, then drops as the web's", "[plan][timeline]") {
  Scene s;
  const uint32_t a = s.add(0, 0, 0), b = s.add(0, -24, 0), c = s.add(0, -48, 0);
  s.stud(a, b), s.stud(b, c);
  const Plan p = s.plan();
  Style style;
  style.fps = 30, style.piecesPerSecond = 0.25;
  style.shape = FlightShape::Arc;
  const Timeline t = buildTimeline(*s.model, s.parts, p, style);
  auto mj = [](double u) { u = std::clamp(u, 0.0, 1.0); return u * u * u * (10 + u * (-15 + 6 * u)); };
  for (const Flight& f : t.flights) {
    REQUIRE(f.frames == 27);
    REQUIRE(f.phases.size() == 2);
    REQUIRE_THAT(f.phases[0].frames / f.frames, WithinAbs(0.76, 1e-12));
    // Up and over: one ease, no rest in its middle (speed never drops near zero between 15% and 85%).
    const Flight::Phase& sweep = f.phases.front();
    std::vector<double> steps;
    for (int k = 0; k < 200; k++) {
      const double a0 = f.startFrame + sweep.frames * (0.15 + 0.7 * k / 200.0), a1 = a0 + sweep.frames * 0.7 / 200.0;
      steps.push_back(length(poseAt(f, a1).t - poseAt(f, a0).t));
    }
    std::vector<double> sorted = steps;
    std::sort(sorted.begin(), sorted.end());
    REQUIRE(sorted.front() >= 0.25 * sorted[sorted.size() / 2]);
    // The corner from up to across is rounded: never straight up and level at once.
    const Vec3 p0 = poseAt(f, f.startFrame).t;
    const double sky = poseAt(f, f.startFrame + 0.76 * f.frames).t.y;
    bool rounded = false;
    for (int k = 1; k < 200; k++) {
      const Vec3 v = poseAt(f, f.startFrame + sweep.frames * k / 200.0).t;
      if (std::abs(v.x - p0.x) + std::abs(v.z - p0.z) > 1e-6 && v.y > sky + 1e-6) rounded = true;  // across before it is all the way up
    }
    REQUIRE(rounded);
    // The drop is the web's, exactly.
    for (int k = 0; k <= 60; k++) {
      const double u = 0.76 + 0.24 * k / 60.0;
      const Vec3 n = poseAt(f, f.startFrame + u * f.frames).t;
      REQUIRE_THAT(length(n - Vec3{0, sky * (1 - mj((u - 0.76) / 0.24)), 0}), WithinAbs(0, 1e-6));
    }
  }
  REQUIRE(certifyPlay(*s.model, s.graph, s.parts, s.shapes, p, t).strictCrossings == 0);
}

TEST_CASE("a submodel's own steps lead inside it", "[plan][steps]") {
  Scene s;
  const uint32_t x0 = s.addIn(0, 0, 0), x1 = s.addIn(0, -24, 0);  // the submodel's step 0: a stack
  s.subStep();
  const uint32_t y = s.addIn(40, 0, 0);  // its step 1: a low brick beside it
  s.step();
  const uint32_t z = s.add(0, -48, 0);  // the model's step 1, on the stack
  s.stud(x0, x1), s.stud(x0, y, {1, 0, 0}), s.stud(x1, z);
  const Plan p = s.plan();
  REQUIRE(s.model->pieces()[y].id == "0:0/1:0");
  REQUIRE(stepsOf(s.model->pieces()[y]) == std::vector<int>{0, 1});
  REQUIRE(laterSteps({0, 1}, {0, 0}));
  REQUIRE(laterSteps({0}, {0, 5}));  // the rest of the step that places a submodel comes after it
  REQUIRE_FALSE(laterSteps({0, 5}, {1}));
  REQUIRE(order(p) == std::vector<uint32_t>{x0, x1, y, z});
  REQUIRE(played(s, p).inversions == 0);
}

TEST_CASE("two groups standing on the table are built apart, then bridged", "[plan][ground]") {
  Scene s;
  const uint32_t l = s.add(0, 0, 0), r = s.add(60, 0, 0), b = s.add(0, -24, 0);
  s.stud(l, b), s.stud(r, b);  // b is held by both: without it, l and r are apart
  const Plan p = s.plan();
  REQUIRE(p.moves.size() == 3);
  REQUIRE(p.moves.back().unit.pieces == std::vector<uint32_t>{b});
  REQUIRE(played(s, p).crossings == 0);
  const Certificate c = s.certify(p);
  REQUIRE(c.floating == 0);  // the second one stands on the table: it is not in the air
  REQUIRE(c.certified == 3);
}

TEST_CASE("a lever clips into its base without passing through the base", "[plan][data]") {
  // The helicopter's levers (4593) hang from their bases (4592): a lever's end clips between two
  // lugs inside the base's dome. Only where they meet may they cross, not through the dome.
  const char* dir = std::getenv("BM_LDRAW_DIR");
  const char* shadowDir = std::getenv("BM_SHADOW_DIR");
  if (!dir || !shadowDir) SKIP("BM_LDRAW_DIR / BM_SHADOW_DIR not set");
  const ldraw::Library lib(dir);
  const connect::ShadowLibrary shadow(shadowDir);
  connect::ConnectorDb db(lib, shadow);
  ldraw::PartCache parts(lib, ldraw::PartCache::defaultDirectory());
  collide::ShapeCache shapes;
  const fs::path repo = fs::path(dir).parent_path().parent_path();
  const Model model = io::load(repo / "samples" / "helicopter" / "helicopter.mpd", lib, &parts);
  const connect::Graph graph = connect::buildGraph(model, db);
  const Plan p = bm::plan::plan(model, graph, parts, shapes);
  const Certificate cert = certify(model, graph, parts, shapes, p);
  const PlayCheck play = certifyPlay(model, graph, parts, shapes, p, buildTimeline(model, parts, p));
  int levers = 0;
  for (size_t i = 0; i < p.moves.size(); i++) {
    const Move& m = p.moves[i];
    const bool lever = std::any_of(m.unit.pieces.begin(), m.unit.pieces.end(), [&](uint32_t q) { return model.pieces()[q].part == "4593.dat"; });
    if (!lever || m.flag != Flag::None) continue;
    levers++;
    INFO("move " << i << " in " << m.insertion.x << " " << m.insertion.y << " " << m.insertion.z);
    REQUIRE(cert.moves[i].clear);
    REQUIRE(std::find(play.crossed.begin(), play.crossed.end(), static_cast<uint32_t>(i)) == play.crossed.end());
  }
  REQUIRE(levers >= 2);
}

TEST_CASE("pieces that cross where the model has them are let off only there", "[plan][collide][data]") {
  // A lever (4593) in its base (4592): the stick grazes the edges of the base's slot where the
  // model has them. That graze is not a move's doing; the lever's end passing out through the
  // base's dome would be.
  const char* dir = std::getenv("BM_LDRAW_DIR");
  if (!dir) SKIP("BM_LDRAW_DIR is not set");
  const ldraw::Library lib(dir);
  ldraw::PartCache parts(lib, ldraw::PartCache::defaultDirectory());
  collide::ShapeCache shapes;
  const fs::path file = fs::temp_directory_path() / ("bm_plan_lever_" + std::to_string(::getpid()) + ".ldr");
  { std::ofstream out(file); out << "1 7 84 -134 130 0 0 1 0 -1 0 1 0 0 4593.dat\n1 7 84 -134 130 0 -1 0 0 0 -1 1 0 0 4592.dat\n"; }
  const Model model = io::load(file, lib, &parts);
  fs::remove(file);
  const collide::World world(model, parts, shapes);
  REQUIRE(collide::overlap(world.shape(0), world.pose(0), world.shape(1), world.pose(1)));  // they do cross, as placed
  const collide::World::Present present{0, 1};
  REQUIRE(world.clearTravel({0}, {0, -1, 0}, 30, &present) < 4);  // up, out through the base's dome
  REQUIRE(world.clearTravel({0}, {1, 0, 0}, 30, &present) >= 30);  // out of the base's open underside
}

TEST_CASE("a tube drawn a little off its bar is listed, and set onto it only when asked", "[plan][correct][data]") {
  // Deadpool's gun: a bar tube with handle (23443) on a round plate's bar (32828), drawn 1.4 LDU
  // off the bar's line and 4 along it. Its connectors join it to nothing as drawn.
  const char* dir = std::getenv("BM_LDRAW_DIR");
  const char* shadowDir = std::getenv("BM_SHADOW_DIR");
  if (!dir || !shadowDir) SKIP("BM_LDRAW_DIR / BM_SHADOW_DIR not set");
  const ldraw::Library lib(dir);
  const connect::ShadowLibrary shadow(shadowDir);
  connect::ConnectorDb db(lib, shadow);
  ldraw::PartCache parts(lib, ldraw::PartCache::defaultDirectory());
  collide::ShapeCache shapes;
  const fs::path file = fs::temp_directory_path() / ("bm_plan_tube_" + std::to_string(::getpid()) + ".ldr");
  {
    std::ofstream out(file);
    out << "1 0 -34.17373 -9.12841 -3 0 -0.96593 0.25882 0 0.25882 0.96593 -1 0 0 23443.dat\n";
    out << "1 0 10.00004 -22.00001 -6 -0.96593 0 0.25882 0.25882 0 0.96593 0 1 0 32828.dat\n";
  }
  Model model = io::load(file, lib, &parts);
  fs::remove(file);
  REQUIRE(connect::buildGraph(model, db).connections.empty());

  // Listed without being moved.
  const Xform drawn = model.pieces()[0].world;
  const std::vector<connect::Correction> listed = correctPlacements(model, db, parts, shapes, false);
  REQUIRE(listed.size() == 1);
  CHECK((listed[0].piece == 0 && listed[0].onto == 1 && !listed[0].applied));
  CHECK(listed[0].offset > 1.0);
  CHECK(listed[0].offset < 2.0);
  REQUIRE(model.pieces()[0].world.t == drawn.t);

  // Asked, it is set there, and its own connectors join it: nothing about it is inferred.
  const std::vector<connect::Correction> applied = correctPlacements(model, db, parts, shapes, true);
  REQUIRE(applied.size() == 1);
  REQUIRE(applied[0].applied);
  CHECK(length(model.pieces()[0].world.t - listed[0].to.t) < 1e-9);
  const connect::Graph graph = connect::buildGraph(model, db);
  REQUIRE(graph.connections.size() == 1);
  CHECK(graph.connections[0].found == connect::Found::Connectors);
  // And set in place, nothing is left to correct.
  CHECK(correctPlacements(model, db, parts, shapes, false).empty());
}

TEST_CASE("a katana in a seat its scabbard's file documents slides out by its grip", "[plan][correct][data]") {
  // 19141 documents two katana seats (0 !HELP 1 ... 30173.dat). A 21459, built on the same
  // blade, in the first of them: no connector holds it; the seat does, and it leaves along its
  // own +y, toward its grip, which is the seat's +y in the scabbard: (-.01745, 0, .99985).
  const char* dir = std::getenv("BM_LDRAW_DIR");
  const char* shadowDir = std::getenv("BM_SHADOW_DIR");
  if (!dir || !shadowDir) SKIP("BM_LDRAW_DIR / BM_SHADOW_DIR not set");
  const ldraw::Library lib(dir);
  const connect::ShadowLibrary shadow(shadowDir);
  connect::ConnectorDb db(lib, shadow);
  ldraw::PartCache parts(lib, ldraw::PartCache::defaultDirectory());
  collide::ShapeCache shapes;
  const fs::path file = fs::temp_directory_path() / ("bm_plan_katana_" + std::to_string(::getpid()) + ".ldr");
  {
    std::ofstream out(file);
    out << "1 0 0 0 0 1 0 0 0 1 0 0 0 1 19141.dat\n";
    out << "1 0 -.174 -9 35.1 0 -.01745 -.99985 -1 0 0 0 .99985 -.01745 21459.dat\n";
  }
  Model model = io::load(file, lib, &parts);
  fs::remove(file);
  connect::Graph graph = connect::buildGraph(model, db);
  REQUIRE(graph.connections.empty());
  connect::Inferred inferred;
  const Plan p = planInferred(model, graph, db, parts, shapes, {}, &inferred);
  REQUIRE(inferred.documented == 1);
  REQUIRE(inferred.corrections.empty());  // exactly in its seat
  REQUIRE(graph.connections.size() == 1);
  CHECK(graph.connections[0].found == connect::Found::Documented);
  // Stored as the way b (the katana) leaves a (the scabbard).
  const connect::Release& r = graph.releases[graph.connections[0].firstZone];
  CHECK(r.kind == connect::ReleaseKind::Along);
  CHECK(dot(r.axis, Vec3{-0.01745, 0, 0.99985}) > 0.999);
  // It goes in tip first along the seat, and flies.
  const Move& m = p.moves.back();
  REQUIRE(m.unit.pieces == std::vector<uint32_t>{1});
  CHECK(m.flag == Flag::None);
  CHECK(!m.path.empty());
  CHECK(dot(m.insertion, Vec3{0.01745, 0, -0.99985}) > 0.999);
  CHECK(certify(model, graph, parts, shapes, p).ok());
}
