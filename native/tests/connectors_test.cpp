#include <catch2/catch_test_macros.hpp>
#include <catch2/matchers/catch_matchers_floating_point.hpp>
#include <algorithm>
#include <cstdlib>
#include <filesystem>
#include "bm/connect/connectors.h"
#include "bm/connect/mate.h"

using namespace bm;
using namespace bm::connect;
namespace fs = std::filesystem;
using Catch::Matchers::WithinAbs;

namespace {
struct Fixture {
  ldraw::Library lib{fs::path(BM_FIXTURES) / "lib"};
  ShadowLibrary shadow{fs::path(BM_FIXTURES) / "shadow"};
  ConnectorDb db{lib, shadow};
};
bool near(Vec3 a, Vec3 b, double eps = 1e-9) { return length(a - b) < eps; }
size_t count(const std::vector<Connector>& c, Gender g) {
  return static_cast<size_t>(std::count_if(c.begin(), c.end(), [&](const Connector& x) { return x.gender == g; }));
}
}  // namespace

TEST_CASE("a 2x4 brick has 8 studs on top and 8 sockets underneath", "[connectors]") {
  Fixture f;
  const auto c = f.db.get("c2x4.dat");
  REQUIRE(c->size() == 16);
  REQUIRE(count(*c, Gender::Male) == 8);
  REQUIRE(count(*c, Gender::Female) == 8);
  for (const Connector& x : *c) {
    REQUIRE(x.kind == SnapKind::Cyl);
    REQUIRE(x.source == Source::Shadow);
    REQUIRE(near(x.axis, {0, -1, 0}));
    REQUIRE_THAT(x.radius, WithinAbs(6, 1e-9));
    REQUIRE_THAT(x.length, WithinAbs(4, 1e-9));
    REQUIRE(x.profile.size() == 1);
    REQUIRE_THAT(x.start.y, WithinAbs(x.gender == Gender::Male ? 0 : 24, 1e-9));
    REQUIRE((x.openStart && !x.openEnd));  // caps=one
    REQUIRE_THAT(dot(x.side, x.axis), WithinAbs(0, 1e-9));
  }
  REQUIRE(f.db.get("C2X4") == c);  // computed once
  const auto studs = [&] { std::vector<Vec3> s; for (const Connector& x : *c) if (x.gender == Gender::Male) s.push_back(x.start); return s; }();
  REQUIRE(std::any_of(studs.begin(), studs.end(), [](Vec3 p) { return near(p, {-30, 0, -10}); }));
  REQUIRE(std::any_of(studs.begin(), studs.end(), [](Vec3 p) { return near(p, {30, 0, 10}); }));
}

TEST_CASE("a stud on the side of a part points sideways", "[connectors][focus]") {
  Fixture f;
  const auto c = f.db.get("snot.dat");
  REQUIRE(c->size() == 2);
  const auto stud = std::find_if(c->begin(), c->end(), [](const Connector& x) { return x.gender == Gender::Male; });
  REQUIRE(stud != c->end());
  REQUIRE(near(stud->axis, {1, 0, 0}));
  REQUIRE(near(stud->start, {10, 12, 0}));
  REQUIRE(stud->id == "studc");
}

TEST_CASE("a stretched reference stretches the connector", "[connectors][focus]") {
  Fixture f;
  const auto plain = f.db.get("hole.dat");
  const auto stretched = f.db.get("stretch.dat");
  REQUIRE(plain->size() == 1);
  REQUIRE(stretched->size() == 1);
  REQUIRE_THAT(plain->at(0).length, WithinAbs(1, 1e-9));
  REQUIRE_THAT(stretched->at(0).length, WithinAbs(2, 1e-9));
  REQUIRE_THAT(stretched->at(0).profile.at(0).length, WithinAbs(2, 1e-9));
  REQUIRE_THAT(stretched->at(0).radius, WithinAbs(6, 1e-9));  // not widened
  REQUIRE(near(stretched->at(0).start, {0, 2, 0}));
  REQUIRE((stretched->at(0).openStart && stretched->at(0).openEnd && stretched->at(0).slide));
  REQUIRE(stretched->at(0).profile.at(0).shape == 'A');
}

TEST_CASE("SNAP_CLEAR drops inherited connectors, all or by id", "[connectors]") {
  Fixture f;
  const auto all = f.db.get("clearall.dat");
  REQUIRE(all->size() == 1);
  REQUIRE_THAT(all->at(0).radius, WithinAbs(4, 1e-9));
  REQUIRE(near(all->at(0).start, {0, 4, 0}));  // centred: starts half its length back along the axis
  const auto one = f.db.get("clearid.dat");
  REQUIRE(one->size() == 1);
  REQUIRE(one->at(0).id == "studc");
}

TEST_CASE("includes are placed, and an include loop ends", "[connectors][focus]") {
  Fixture f;
  const auto incl = f.db.get("incl.dat");
  REQUIRE(incl->size() == 1);
  REQUIRE(near(incl->at(0).start, {0, 1, 20}));
  const auto loop = f.db.get("loopa.dat");
  REQUIRE(loop->size() == 2);
  const auto clip = std::find_if(loop->begin(), loop->end(), [](const Connector& x) { return x.kind == SnapKind::Clip; });
  const auto finger = std::find_if(loop->begin(), loop->end(), [](const Connector& x) { return x.kind == SnapKind::Finger; });
  REQUIRE((clip != loop->end() && finger != loop->end()));
  REQUIRE(clip->gender == Gender::Female);
  REQUIRE_THAT(finger->length, WithinAbs(12, 1e-9));
  REQUIRE(finger->seq.size() == 3);
}

TEST_CASE("parts without shadow data, and parts that do not exist, have no connectors", "[connectors]") {
  Fixture f;
  REQUIRE(f.db.get("plain.dat")->empty());
  REQUIRE(f.db.get("nosuch.dat")->empty());
  REQUIRE(f.db.get("selfref.dat")->empty());  // a reference loop ends
}

TEST_CASE("an inline part resolves through the model's library and is not shared", "[connectors]") {
  Fixture f;
  const ldraw::Library model = f.lib.withInline(ldraw::parseMpd("0 FILE mine.dat\n0 Mine\n1 16 0 0 0 1 0 0 0 1 0 0 0 1 stud.dat\n1 16 20 0 0 1 0 0 0 1 0 0 0 1 stud.dat\n", "m.mpd"));
  REQUIRE(f.db.get("mine.dat", &model)->size() == 2);
  REQUIRE(f.db.get("mine.dat")->empty());  // the base library has no such part
}

TEST_CASE("moving a connector moves its frame and scales its size", "[connectors]") {
  Fixture f;
  const Connector c = f.db.get("c1x1.dat")->at(0);
  const Xform turn{Mat3{{0, 0, 1, 0, 1, 0, -1, 0, 0}}, {100, 0, 0}};
  const Connector t = transformed(c, turn);
  REQUIRE(near(t.start, turn.apply(c.start)));
  REQUIRE(near(t.axis, turn.r * c.axis));
  REQUIRE_THAT(t.length, WithinAbs(c.length, 1e-9));
  const Connector big = transformed(c, Xform{Mat3{{2, 0, 0, 0, 2, 0, 0, 0, 2}}, {}});
  REQUIRE_THAT(big.length, WithinAbs(2 * c.length, 1e-9));
  REQUIRE_THAT(big.radius, WithinAbs(2 * c.radius, 1e-9));
  const Connector mirrored = transformed(c, Xform{Mat3{{-1, 0, 0, 0, 1, 0, 0, 0, 1}}, {}});
  REQUIRE_THAT(length(mirrored.axis), WithinAbs(1, 1e-12));
  REQUIRE_THAT(dot(mirrored.side, mirrored.axis), WithinAbs(0, 1e-9));
}

TEST_CASE("real parts", "[connectors][data]") {
  const char* ldraw = std::getenv("BM_LDRAW_DIR");
  const char* shadowDir = std::getenv("BM_SHADOW_DIR");
  if (!ldraw || !shadowDir) SKIP("BM_LDRAW_DIR / BM_SHADOW_DIR not set");
  const ldraw::Library lib(ldraw);
  const ShadowLibrary shadow(shadowDir);
  ConnectorDb db(lib, shadow);
  const auto brick = db.get("3001.dat");
  REQUIRE(count(*brick, Gender::Male) == 8);
  REQUIRE(count(*brick, Gender::Female) >= 8);  // 8 sockets; the tubes add more
  const auto pin = db.get("3673.dat");  // its own profile and bar hole; inherited snaps are cleared
  REQUIRE(pin->size() == 2);
  const auto male = std::find_if(pin->begin(), pin->end(), [](const Connector& x) { return x.gender == Gender::Male; });
  REQUIRE(male->profile.size() == 5);
  REQUIRE_THAT(male->length, WithinAbs(40, 1e-6));
  REQUIRE(male->slide);
  const auto technic = db.get("3700.dat");
  REQUIRE(std::any_of(technic->begin(), technic->end(), [](const Connector& x) { return x.gender == Gender::Female && x.openStart && x.openEnd && x.length >= 20; }));
}

TEST_CASE("an included shadow file brings its SNAP_CLEAR with it", "[connectors][review]") {
  Fixture f;
  REQUIRE(f.db.get("pinbase.dat")->size() == 1);
  const auto variant = f.db.get("pinvar.dat");  // includes pinbase; must not also inherit the stud
  REQUIRE(variant->size() == 1);
  REQUIRE_THAT(variant->at(0).length, WithinAbs(40, 1e-9));
}

TEST_CASE("hinge fingers are centred on their position unless told otherwise", "[connectors][review]") {
  const ShadowInfo s = parseShadow("0 !LDCAD SNAP_FGR [genderOfs=M] [seq=6 4 6] [radius=4]\n0 !LDCAD SNAP_FGR [genderOfs=M] [seq=4] [radius=4] [center=false]\n");
  REQUIRE(s.snaps.at(0).center);
  REQUIRE_FALSE(s.snaps.at(1).center);
}

TEST_CASE("a part embedded in a model as '<set> - <part>.dat' uses that part's connector data", "[connectors][embedded]") {
  Fixture f;
  const ldraw::Library model = f.lib.withInline(ldraw::parseMpd(
      "0 FILE 42131 - c1x1.dat\n0 c1x1\n1 16 0 0 0 10 0 0 0 24 0 0 0 10 box.dat\n1 16 0 0 0 1 0 0 0 1 0 0 0 1 stud.dat\n", "m.mpd"));
  const auto c = f.db.get("42131 - c1x1.dat", &model);
  REQUIRE(c->size() == 2);  // the inherited stud and the socket from c1x1's shadow file
  REQUIRE(count(*c, Gender::Female) == 1);
}

TEST_CASE("extra connectors can be registered for a part", "[connectors][seats]") {
  Fixture f;
  REQUIRE(loadWheelSeats(R"({"seats":[{"part":"tyre","role":"tyre","axis":[0,0,1],"radius":13.85,"width":16},
                                      {"part":"rim","role":"rim","axis":[0,0,1],"radius":12.5,"width":20},
                                      {"part":"bad","role":"??","axis":[0,0,0],"radius":-1,"width":2}, 7]})", f.db) == 2);
  const auto tyre = f.db.get("tyre.dat");
  REQUIRE(tyre->size() == 1);
  REQUIRE(tyre->at(0).gender == Gender::Female);
  REQUIRE(tyre->at(0).source == Source::Geometry);
  REQUIRE(near(tyre->at(0).axis, {0, 0, 1}));
  REQUIRE(near(tyre->at(0).start, {0, 0, -8}));  // centred on the part's origin
  REQUIRE(tyre->at(0).profile.at(0).shape == 'T');
  REQUIRE(f.db.get("rim.dat")->at(0).gender == Gender::Male);
  REQUIRE(loadWheelSeats("not json", f.db) == 0);
}

#include <fstream>
#include "bm/connect/studio.h"

namespace {
/// A Studio grid record with an identity frame, as bytes.
std::string studioGrid(int32_t code, float x, float y, float z, int nx, int nz) {
  std::string out;
  auto put = [&](auto v) { out.append(reinterpret_cast<const char*>(&v), sizeof v); };
  put(code);
  for (float v : {1.f, 0.f, 0.f, 0.f, 1.f, 0.f, 0.f, 0.f, 1.f, x, y, z}) put(v);
  put(static_cast<int16_t>(nz * 2));
  put(static_cast<int16_t>(nx * 2));
  out.append(static_cast<size_t>(8 + 16 * nx * nz + 8 * (nx + nz) - 4), '\0');
  return out;
}
}  // namespace

TEST_CASE("Studio data fills in what the shadow library lacks, without doubling what it has", "[connectors][studio]") {
  const fs::path dir = fs::temp_directory_path() / "bm_studio_merge_test";
  fs::remove_all(dir);
  fs::create_directories(dir);
  auto write = [&](const char* name, const std::string& bytes) { std::ofstream(dir / name, std::ios::binary) << bytes; };
  write("plain.conn", studioGrid(0x170003, -10, 0, 10, 1, 1) + studioGrid(0x2, -10, 24, 10, 1, 1));  // a part with no shadow data
  write("c1x1.conn", studioGrid(0x170003, -10, 0, 10, 1, 1) + studioGrid(0x2, -10, 24, 10, 1, 1));   // same as its shadow data
  write("c2x4.conn", studioGrid(0x2, -40, 12, 20, 1, 1));                                             // one socket the shadow data does not have
  Fixture f;
  const StudioLibrary studio(dir);
  f.db.setStudio(&studio);
  const auto plain = f.db.get("plain.dat");
  REQUIRE(plain->size() == 2);
  REQUIRE(plain->at(0).source == Source::Studio);
  REQUIRE(f.db.get("c1x1.dat")->size() == 2);  // nothing added
  const auto brick = f.db.get("c2x4.dat");
  REQUIRE(brick->size() == 17);
  REQUIRE(std::count_if(brick->begin(), brick->end(), [](const Connector& x) { return x.source == Source::Studio; }) == 1);
  // An embedded copy of the part gets the same data.
  const ldraw::Library model = f.lib.withInline(ldraw::parseMpd("0 FILE 999 - plain.dat\n0 plain\n3 16 0 0 0 1 0 0 0 0 1\n", "m.mpd"));
  REQUIRE(f.db.get("999 - plain.dat", &model)->size() == 2);
  fs::remove_all(dir);
}

TEST_CASE("BrickNet hinge and ball rows become connectors", "[connectors][bricknet]") {
  Fixture f;
  REQUIRE(loadBricknetJoints(R"({"parts":{"plain":[["hinge",3,0,-32,5,60,0,-90],["ball",1,1,0,10,0]],
                                          "c1x1":[["hinge",3,1,0,0,0,90,0]],
                                          "bad":[["hinge",3],["what",1,0,0,0,0],7]}})", f.db) == 3);
  const auto c = f.db.get("plain.dat");
  REQUIRE(c->size() == 2);
  const Connector& hinge = c->at(0);
  REQUIRE((hinge.kind == SnapKind::Generic && hinge.source == Source::BrickNet && hinge.placement == "hinge" && hinge.group == "bricknet-hinge-3"));
  REQUIRE(hinge.gender == Gender::Male);  // "in"
  REQUIRE(near(hinge.start, {-32, 5, 60}));
  REQUIRE(near(hinge.axis, {-1, 0, 0}, 1e-6));  // roll -90 lays the frame's -Y along -x
  const Connector& ball = c->at(1);
  REQUIRE((ball.gender == Gender::Female && ball.placement == "free" && ball.group == "bricknet-ball-1"));
  const auto brick = f.db.get("c1x1.dat");
  const auto added = std::find_if(brick->begin(), brick->end(), [](const Connector& x) { return x.source == Source::BrickNet; });
  REQUIRE(added != brick->end());
  REQUIRE(near(added->axis, {0, 0, -1}, 1e-6));  // pitch 90
  REQUIRE(loadBricknetJoints("[]", f.db) == 0);
}

TEST_CASE("extra connector rows: balls and sockets for parts no source covers", "[connectors][extra]") {
  Fixture f;
  REQUIRE(loadExtraConnectors(R"({"parts":{
      "plain":[{"kind":"ball","at":[-10,0,0],"radius":8,"note":"measured"},
               {"kind":"socket","at":[0,0,160],"radius":8},
               {"kind":"ball","at":[0,0],"radius":8},
               {"kind":"ball","at":[0,0,0],"radius":0},
               {"kind":"ball","at":[0,"y",0],"radius":8},
               {"kind":"wedge","at":[0,0,0],"radius":8},
               "nonsense"],
      "bad":7}})", f.db) == 2);
  const auto c = f.db.get("plain.dat");
  REQUIRE(c->size() == 2);
  REQUIRE((c->at(0).gender == Gender::Male && c->at(0).source == Source::Override && near(c->at(0).start, {-10, 0, 0}) && c->at(0).radius == 8));
  REQUIRE((c->at(1).gender == Gender::Female && near(c->at(1).start, {0, 0, 160})));
  // A ball in a socket of its size is a ball joint; in a socket of another size it is nothing.
  Connector ball = c->at(0), socket = c->at(1);
  socket.start = ball.start;
  const auto m = mate(ball, socket);
  REQUIRE((m && m->freedom.ball));
  socket.radius = 5;
  REQUIRE_FALSE(mate(ball, socket));
  REQUIRE(loadExtraConnectors("nope", f.db) == 0);
}
