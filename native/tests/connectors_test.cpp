#include <catch2/catch_test_macros.hpp>
#include <catch2/matchers/catch_matchers_floating_point.hpp>
#include <algorithm>
#include <cstdlib>
#include <filesystem>
#include "bm/connect/connectors.h"

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
