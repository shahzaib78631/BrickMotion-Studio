#include <catch2/catch_test_macros.hpp>
#include <catch2/matchers/catch_matchers_floating_point.hpp>
#include <chrono>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <sstream>
#include <unistd.h>
#include "bm/connect/studio.h"
#include "bm/io.h"
#include "bm/kin/shift.h"
#include "bm/kin/system.h"

using namespace bm;
using namespace bm::kin;
using connect::JointKind;
using Catch::Matchers::WithinAbs;
namespace fs = std::filesystem;

namespace {
Model load(const std::string& text, const ldraw::Library& lib) {
  static int counter = 0;
  const fs::path file = fs::temp_directory_path() / ("bm_kin_system_" + std::to_string(::getpid()) + "_" + std::to_string(counter++) + ".ldr");
  { std::ofstream out(file); out << text; }
  Model m = io::load(file, lib);
  fs::remove(file);
  return m;
}
std::string piece(const char* part, double x, double y, double z, const char* matrix = "1 0 0 0 1 0 0 0 1") {
  return "1 4 " + std::to_string(x) + " " + std::to_string(y) + " " + std::to_string(z) + " " + matrix + " " + part + "\n";
}

/// A model of 1x1 fixture bricks and a graph written by hand, to test the reduction alone.
struct Hand {
  ldraw::Library lib{fs::path(BM_FIXTURES) / "lib"};
  ldraw::PartCache parts{lib, fs::temp_directory_path() / "bm_kin_system_cache"};
  collide::ShapeCache shapes;
  std::string text;
  connect::Graph graph;
  uint32_t add(double x, double y = 0, double z = 0) {
    text += piece("3005.dat", x, y, z);
    return count++;
  }
  void join(uint32_t a, uint32_t b, JointKind kind, Vec3 point, Vec3 axis, bool friction = false) {
    connect::Connection c;
    c.a = std::min(a, b);
    c.b = std::max(a, b);
    c.joint = {kind, point, axis};
    c.friction = friction;
    graph.connections.push_back(c);
  }
  System build(bool travel) {
    model = std::make_unique<Model>(load(text, lib));
    graph.isSegment.assign(count, 0);
    graph.hasConnectors.assign(count, 1);
    graph.body.resize(count);
    for (uint32_t i = 0; i < count; i++) graph.body[i] = i;
    std::sort(graph.connections.begin(), graph.connections.end(), [](const auto& x, const auto& y) { return std::make_pair(x.a, x.b) < std::make_pair(y.a, y.b); });
    SystemOptions options;
    options.testTravel = travel;
    return buildSystem(*model, graph, &parts, &shapes, options);
  }
  std::unique_ptr<Model> model;
  uint32_t count = 0;
};
const Vec3 kZ{0, 0, 1};
}  // namespace

TEST_CASE("two beams on two pins are one body; on one pin they hinge", "[kin][system][focus]") {
  // Review Focus 1: every pin joint by itself may turn and slide.
  Hand h;
  const uint32_t beamA = h.add(0), beamB = h.add(0, 0, 100), pin1 = h.add(300), pin2 = h.add(400);
  h.join(beamA, pin1, JointKind::Cylindrical, {0, 0, 0}, kZ, true);
  h.join(beamB, pin1, JointKind::Cylindrical, {0, 0, 100}, kZ, true);
  h.join(beamA, pin2, JointKind::Cylindrical, {40, 0, 0}, kZ, true);
  h.join(beamB, pin2, JointKind::Cylindrical, {40, 0, 100}, kZ, true);
  const System two = h.build(false);
  REQUIRE(two.bodyOf[beamA] == two.bodyOf[beamB]);
  REQUIRE(two.bodies == 3);
  REQUIRE(two.links.size() == 2);  // each pin can still spin in its holes
  for (const Link& l : two.links) REQUIRE(l.kind == JointKind::Revolute);
  REQUIRE(two.size[two.ground] == 2);
  REQUIRE(two.heldSlides.size() == 4);

  Hand one;
  const uint32_t a = one.add(0), b = one.add(0, 0, 100), pin = one.add(300);
  one.join(a, pin, JointKind::Cylindrical, {0, 0, 0}, kZ, true);
  one.join(b, pin, JointKind::Cylindrical, {0, 0, 100}, kZ, true);
  const System hinge = one.build(false);
  REQUIRE(hinge.bodies == 3);
  REQUIRE(hinge.bodyOf[a] != hinge.bodyOf[b]);
  REQUIRE(hinge.links.size() == 2);
}

TEST_CASE("two pins that are not friction fits leave the beams sliding along them", "[kin][system]") {
  Hand h;
  const uint32_t beamA = h.add(0), beamB = h.add(0, 0, 100), pin1 = h.add(300), pin2 = h.add(400);
  for (uint32_t pin : {pin1, pin2}) {
    const double x = pin == pin1 ? 0 : 40;
    h.join(beamA, pin, JointKind::Cylindrical, {x, 0, 0}, kZ);
    h.join(beamB, pin, JointKind::Cylindrical, {x, 0, 100}, kZ);
  }
  const System sys = h.build(false);
  REQUIRE(sys.bodyOf[beamA] != sys.bodyOf[beamB]);  // nothing says the slide is held
  REQUIRE(sys.heldSlides.empty());
}

TEST_CASE("fixed and flexible connections, empty models and single pieces", "[kin][system][focus]") {
  {
    Hand h;  // Review Focus 3
    const System sys = h.build(true);
    REQUIRE((sys.bodies == 0 && sys.links.empty() && sys.bodyOf.empty()));
  }
  {
    Hand h;
    h.add(0);
    const System sys = h.build(true);
    REQUIRE((sys.bodies == 1 && sys.links.empty() && sys.ground == 0 && sys.size[0] == 1));
  }
  Hand h;
  const uint32_t a = h.add(0), b = h.add(100), c = h.add(200), d = h.add(300);
  h.join(a, b, JointKind::Fixed, {}, kZ);
  h.join(b, c, JointKind::Flexible, {}, kZ);
  h.join(c, d, JointKind::Revolute, {250, 0, 0}, kZ);
  const System sys = h.build(true);
  REQUIRE(sys.bodies == 3);
  REQUIRE(sys.bodyOf[a] == sys.bodyOf[b]);
  REQUIRE(sys.bodyOf[b] != sys.bodyOf[c]);  // a hose holds nothing rigidly
  REQUIRE(sys.links.size() == 1);
  REQUIRE((sys.links[0].kind == JointKind::Revolute && sys.links[0].a < sys.links[0].b));
  REQUIRE(sys.bodyOf[sys.links[0].pieceA] == sys.links[0].a);
  REQUIRE(sys.pieces[sys.ground].size() == 2);
}

TEST_CASE("a slide is real only where there is room to travel", "[kin][system][travel]") {
  // A 1x1 brick (20 wide) that may slide along x on a far-away rail, between two stops.
  auto build = [](double leftGap, double rightGap, bool friction, bool travel) {
    Hand h;
    const uint32_t slider = h.add(0), rail = h.add(0, 200, 0);
    h.add(-20 - leftGap);
    h.add(20 + rightGap);
    h.join(slider, rail, JointKind::Prismatic, {0, 0, 0}, {1, 0, 0}, friction);
    const System sys = h.build(travel);
    return sys.bodyOf[slider] != sys.bodyOf[rail];  // still slides
  };
  REQUIRE_FALSE(build(0, 0, false, true));  // stopped both ways
  REQUIRE(build(0, 10, false, true));       // room one way
  REQUIRE(build(10, 10, false, true));
  REQUIRE(build(0, 0, false, false));       // untested: taken as real
  // A friction fit stays where it was pushed, room or not.
  REQUIRE_FALSE(build(10, 10, true, true));
  REQUIRE_FALSE(build(10, 10, true, false));
  // Play of less than kMinTravel is not travel.
  REQUIRE_FALSE(build(1, 1, false, true));
}

TEST_CASE("links on lines that differ by the file's rounding share one line", "[kin][system][focus]") {
  // Review Focus 2.
  Hand h;
  const uint32_t frame = h.add(0), shaft = h.add(100), wheel = h.add(200);
  const Vec3 tilted = normalized(Vec3{0.035, 0, 1});  // 2 degrees off
  h.join(frame, shaft, JointKind::Revolute, {0, 0, 0}, kZ);
  h.join(shaft, wheel, JointKind::Revolute, {0.6, 0, 80}, tilted);
  const System sys = h.build(false);
  REQUIRE(sys.links.size() == 2);
  REQUIRE_THAT(std::abs(dot(sys.links[0].axis, sys.links[1].axis)), WithinAbs(1, 1e-12));
  REQUIRE_THAT(sys.links[1].point.x, WithinAbs(sys.links[0].point.x, 1e-12));
  // 10 degrees off is another line.
  Hand other;
  const uint32_t f = other.add(0), s = other.add(100), w = other.add(200);
  other.join(f, s, JointKind::Revolute, {0, 0, 0}, kZ);
  other.join(s, w, JointKind::Revolute, {0, 0, 80}, normalized(Vec3{0.18, 0, 1}));
  const System apart = other.build(false);
  REQUIRE(std::abs(dot(apart.links[0].axis, apart.links[1].axis)) < 0.99);
}

TEST_CASE("a gear mesh between two bodies is a gearing; inside one body it is nothing", "[kin][system]") {
  Hand h;
  const uint32_t frame = h.add(0), g1 = h.add(100), g2 = h.add(200), g3 = h.add(300);
  h.join(frame, g1, JointKind::Revolute, {100, 0, 0}, kZ);
  h.join(frame, g2, JointKind::Revolute, {200, 0, 0}, kZ);
  h.join(g2, g3, JointKind::Fixed, {}, kZ);
  GearMesh m;
  m.a = g1;
  m.b = g2;
  m.teethA = 8;
  m.teethB = 24;
  h.graph.meshes.push_back(m);
  m.a = g2;
  m.b = g3;
  h.graph.meshes.push_back(m);
  h.graph.meshZones.resize(2);
  const System sys = h.build(false);
  REQUIRE(sys.gearings.size() == 1);
  REQUIRE((sys.gearings[0].a == sys.bodyOf[g1] && sys.gearings[0].b == sys.bodyOf[g2]));
}

TEST_CASE("ten thousand rigidly joined pieces reduce in well under a second", "[kin][system][focus]") {
  // Review Focus 5: the reduction is what keeps the algebra small.
  Hand h;
  for (int i = 0; i < 10000; i++) h.add(30.0 * (i % 100), 0, 30.0 * (i / 100));
  for (uint32_t i = 1; i < 10000; i++) h.join(i - 1, i, JointKind::Fixed, {}, kZ);
  h.model = std::make_unique<Model>(load(h.text, h.lib));
  h.graph.isSegment.assign(h.count, 0);
  h.graph.body.assign(h.count, 0);
  const auto started = std::chrono::steady_clock::now();
  const System sys = buildSystem(*h.model, h.graph, &h.parts, &h.shapes);
  const double ms = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - started).count();
  REQUIRE((sys.bodies == 1 && sys.links.empty()));
#ifndef BM_SANITIZED
  REQUIRE(ms < 1000);
#endif
}

TEST_CASE("real beams, pins, an axle and its bushes", "[kin][system][data]") {
  const char* dir = std::getenv("BM_LDRAW_DIR");
  const char* shadowDir = std::getenv("BM_SHADOW_DIR");
  if (!dir || !shadowDir) SKIP("BM_LDRAW_DIR / BM_SHADOW_DIR not set");
  const ldraw::Library lib(dir);
  const connect::ShadowLibrary shadow(shadowDir);
  connect::ConnectorDb db(lib, shadow);
  const connect::StudioLibrary studio(connect::StudioLibrary::defaultDirectory());
  db.setStudio(&studio);
  ldraw::PartCache parts(lib, ldraw::PartCache::defaultDirectory());
  collide::ShapeCache shapes;
  auto system = [&](const std::string& text, bool travel = true) {
    const Model model = load(text, lib);
    const connect::Graph graph = connect::buildGraph(model, db);
    SystemOptions options;
    options.testTravel = travel;
    return buildSystem(model, graph, &parts, &shapes, options);
  };
  // A 7-long beam lies along z with its holes along y; the pin and axle are turned to stand along y.
  const char* upright = "0 -1 0 1 0 0 0 0 1";
  const std::string beams = piece("32524.dat", 0, 0, 0) + piece("32524.dat", 0, 20, 0);
  const System two = system(beams + piece("2780.dat", 0, 10, -40, upright) + piece("2780.dat", 0, 10, 40, upright));
  REQUIRE(two.bodyOf[0] == two.bodyOf[1]);
  REQUIRE(two.bodies == 3);
  const System one = system(beams + piece("2780.dat", 0, 10, -40, upright));
  REQUIRE(one.bodyOf[0] != one.bodyOf[1]);
  REQUIRE(one.links.size() == 2);
  for (const Link& l : one.links) REQUIRE(l.kind == JointKind::Revolute);  // the pin's collar and lip stop it sliding

  // An axle through one beam hole with a bush against each face: it turns and cannot slide.
  const char* bushUp = "1 0 0 0 0 1 0 -1 0";
  const std::string axle = piece("32524.dat", 0, 0, 0) + piece("3705.dat", 0, 0, 0, upright);
  const System bushed = system(axle + piece("3713.dat", 0, -20, 0, bushUp) + piece("3713.dat", 0, 20, 0, bushUp));
  REQUIRE(bushed.bodies == 2);
  REQUIRE(bushed.links.size() == 1);
  REQUIRE(bushed.links[0].kind == JointKind::Revolute);
  // With one bush moved away it can slide that far.
  const System loose = system(axle + piece("3713.dat", 0, -20, 0, bushUp) + piece("3713.dat", 0, 30, 0, bushUp));
  REQUIRE(loose.links.size() == 1);
  REQUIRE(loose.links[0].kind == JointKind::Cylindrical);
  // Untested, the axle's slide is taken as real, but the bushes' friction fit still holds them.
  const System untested = system(axle + piece("3713.dat", 0, -20, 0, bushUp) + piece("3713.dat", 0, 20, 0, bushUp), false);
  REQUIRE(untested.bodies == 2);
  REQUIRE(untested.links[0].kind == JointKind::Cylindrical);
}

TEST_CASE("what a sliding piece is linked to does not stop it; what it merely touches does", "[kin][system][travel]") {
  const Vec3 x{1, 0, 0};
  auto slideKind = [&](bool neighboursLinked) {
    Hand h;
    // A slider between two neighbours that touch its sides; it slides along x in a far partner.
    const uint32_t slider = h.add(0), left = h.add(-20), right = h.add(20), partner = h.add(0, 0, 200);
    h.join(slider, partner, JointKind::Cylindrical, {0, 0, 0}, x);
    if (neighboursLinked) {
      // Rods hinged to the slider: whether they let it go is for the equations.
      h.join(slider, left, JointKind::Revolute, {-10, 0, 0}, kZ);
      h.join(slider, right, JointKind::Revolute, {10, 0, 0}, kZ);
    } else {
      h.join(partner, left, JointKind::Fixed, {}, kZ);
      h.join(partner, right, JointKind::Fixed, {}, kZ);
    }
    const System sys = h.build(true);
    for (const Link& l : sys.links)
      if ((l.pieceA == slider && l.pieceB == partner) || (l.pieceA == partner && l.pieceB == slider)) return l.kind;
    return JointKind::Fixed;
  };
  REQUIRE(slideKind(true) == JointKind::Cylindrical);
  REQUIRE(slideKind(false) == JointKind::Revolute);
}

TEST_CASE("a driving ring clicks along its joiner and takes the clutch gear it is pushed into", "[kin][system][shift][data]") {
  const char* dir = std::getenv("BM_LDRAW_DIR");
  const char* shadowDir = std::getenv("BM_SHADOW_DIR");
  if (!dir || !shadowDir) SKIP("BM_LDRAW_DIR / BM_SHADOW_DIR not set");
  const ldraw::Library lib(dir);
  const connect::ShadowLibrary shadow(shadowDir);
  connect::ConnectorDb db(lib, shadow);
  ldraw::PartCache parts(lib, ldraw::PartCache::defaultDirectory());
  collide::ShapeCache shapes;
  // The selector of set 42000: joiner and ring between two clutch gears, on two axles along x.
  const char *alongX = "0 0 1 0 1 0 -1 0 0", *alongXBack = "0 0 -1 0 1 0 1 0 0";
  const std::string text = piece("3737.dat", 0, 0, 0, "-1 0 0 0 1 0 0 0 -1") + piece("32073.dat", -150, 0, 0) + piece("6538b.dat", -100, 0, 0, alongX) + piece("6539.dat", -100.25, 0, 0, alongX) +
                           piece("6542b.dat", -70, 0, 0, alongXBack) + piece("6542b.dat", -130, 0, 0, alongX);
  const Model model = load(text, lib);
  const connect::Graph graph = connect::buildGraph(model, db);
  const System sys = buildSystem(model, graph, &parts, &shapes);
  const uint32_t ring = sys.bodyOf[3], nearGear = sys.bodyOf[4], farGear = sys.bodyOf[5];
  REQUIRE(ring != sys.bodyOf[2]);  // the ring is not held on the joiner
  REQUIRE((nearGear != farGear && nearGear != sys.bodyOf[2] && farGear != sys.bodyOf[2]));
  const std::vector<Shift> shifts = findShifts(model, graph, sys, parts, shapes);
  REQUIRE(shifts.size() == 2);
  for (const Shift& s : shifts) {
    REQUIRE(s.body == ring);
    REQUIRE_THAT(std::abs(s.move.x), WithinAbs(10, 0.3));
    REQUIRE(s.turnsWith == std::vector<uint32_t>{s.move.x > 0 ? nearGear : farGear});
  }
  // With the ring pushed in, the gear is coupled to it.
  const System in = shifted(sys, {shifts[0]});
  REQUIRE(in.gearings.size() == sys.gearings.size() + 1);
  REQUIRE(in.gearings.back().mesh.kind == MeshKind::Clutch);
}
