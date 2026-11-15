#include <catch2/catch_test_macros.hpp>
#include <catch2/matchers/catch_matchers_floating_point.hpp>
#include <algorithm>
#include <cstdlib>
#include <cstring>
#include <filesystem>
#include "bm/connect/mate.h"
#include "bm/connect/studio.h"

using namespace bm;
using namespace bm::connect;
namespace fs = std::filesystem;
using Catch::Matchers::WithinAbs;

namespace {
template <typename T>
void put(std::string& out, T v) { out.append(reinterpret_cast<const char*>(&v), sizeof v); }

/// One record head: code, a rotation whose -Y row is `axis`, position.
void head(std::string& out, int32_t code, Vec3 axis, Vec3 pos) {
  put(out, code);
  // Rows: any right-handed frame whose second row is -axis.
  const Vec3 y = axis * -1.0;
  const Vec3 x = std::abs(y.x) < 0.9 ? normalized(cross(y, Vec3{1, 0, 0})) : normalized(cross(y, Vec3{0, 0, 1}));
  const Vec3 z = cross(x, y);
  for (Vec3 row : {x, y, z})
    for (double v : {row.x, row.y, row.z}) put(out, static_cast<float>(v));
  for (double v : {pos.x, pos.y, pos.z}) put(out, static_cast<float>(v));
}
/// A grid record (studs, anti-studs) with identity frame: `corner` is the first cell's corner.
void grid(std::string& out, int32_t code, Vec3 corner, int nx, int nz) {
  put(out, code);
  for (float v : {1.f, 0.f, 0.f, 0.f, 1.f, 0.f, 0.f, 0.f, 1.f}) put(out, v);
  for (double v : {corner.x, corner.y, corner.z}) put(out, static_cast<float>(v));
  put(out, static_cast<int16_t>(nz * 2));
  put(out, static_cast<int16_t>(nx * 2));
  out.append(static_cast<size_t>(8 + 16 * nx * nz + 8 * (nx + nz) - 4), '\0');
}
void plain(std::string& out, int32_t code, Vec3 axis, Vec3 pos, float length, uint16_t flagsA = 0) {
  head(out, code, axis, pos);
  put(out, flagsA);
  put(out, length);
  put(out, static_cast<uint16_t>(0));
}
void paired(std::string& out, int32_t code, Vec3 axis, Vec3 pos) {
  head(out, code, axis, pos);
  out.append(17, '\0');
}
bool near(Vec3 a, Vec3 b) { return length(a - b) < 1e-4; }
}  // namespace

TEST_CASE("stud and anti-stud grids are written out cell by cell", "[studio]") {
  std::string bytes;
  grid(bytes, 0x2, {-40, 24, 20}, 4, 2);       // underside of a 2x4
  grid(bytes, 0x170003, {-40, 0, 20}, 4, 2);   // its studs
  bool complete = false;
  const auto c = parseStudioConn(bytes, &complete);
  REQUIRE(complete);
  REQUIRE(c.size() == 16);
  REQUIRE(std::count_if(c.begin(), c.end(), [](const Connector& x) { return x.gender == Gender::Male; }) == 8);
  for (const Connector& x : c) {
    REQUIRE(x.source == Source::Studio);
    REQUIRE(near(x.axis, {0, -1, 0}));
    REQUIRE_THAT(x.start.y, WithinAbs(x.gender == Gender::Male ? 0 : 24, 1e-4));
    REQUIRE((x.radius == 6 && x.length == 4 && x.openStart && !x.openEnd));
  }
  REQUIRE(std::any_of(c.begin(), c.end(), [](const Connector& x) { return near(x.start, {-30, 0, 10}); }));
  REQUIRE(std::any_of(c.begin(), c.end(), [](const Connector& x) { return near(x.start, {30, 24, -10}); }));
}

TEST_CASE("pin holes, pins, axles and axle holes", "[studio]") {
  std::string bytes;
  plain(bytes, 0x20000, {0, 0, 1}, {0, 10, -10}, 20);         // a hole through a Technic brick
  plain(bytes, 0x30000, {-1, 0, 0}, {20, 0, 0}, 20, 0x0100);  // half a pin: tip at x=20, base at 0
  plain(bytes, 0x70000, {-1, 0, 0}, {40, 0, 0}, 80);          // an axle 4
  plain(bytes, 0x60000, {0, -1, 0}, {0, 9.5, 0}, 19);         // an axle hole
  bool complete = false;
  const auto c = parseStudioConn(bytes, &complete);
  REQUIRE(complete);
  REQUIRE(c.size() == 4);
  REQUIRE((c[0].gender == Gender::Female && c[0].profile.at(0).shape == 'R' && c[0].length == 20 && c[0].openStart && c[0].openEnd && c[0].slide));
  REQUIRE(near(c[0].start, {0, 10, -10}));
  REQUIRE((c[1].gender == Gender::Male && c[1].length == 20));
  REQUIRE(near(c[1].start, {0, 0, 0}));  // from its base
  REQUIRE(near(c[1].axis, {1, 0, 0}));   // towards its tip
  REQUIRE((c[2].gender == Gender::Male && c[2].profile.at(0).shape == 'A' && c[2].length == 80));
  REQUIRE((c[3].gender == Gender::Female && c[3].profile.at(0).shape == 'A'));
  // The decoded pin half fits the decoded hole.
  const Connector hole = transformed(c[0], Xform{Mat3{{0, 0, 1, 0, 1, 0, -1, 0, 0}}, {10, -10, 0}});  // along x from 0
  REQUIRE(mate(c[1], hole).has_value());
}

TEST_CASE("paired records: hinge halves turn, a tyre is held by its rim", "[studio]") {
  std::string a, b, tyre, rim, other;
  paired(a, 0x3a0006, {1, 0, 0}, {0, 10, 0});
  paired(b, 0x3b0006, {1, 0, 0}, {0, 10, 0});
  paired(other, 0xae0006, {1, 0, 0}, {0, 10, 0});
  head(tyre, 0x600004, {0, 0, 1}, {0, 0, 0});
  tyre.append(56, '\x01');  // a tail this reader does not know
  head(rim, 0x610004, {0, 0, 1}, {0, 0, 0});
  rim.append(30, '\x01');
  bool complete = true;
  const auto ha = parseStudioConn(a), hb = parseStudioConn(b), ho = parseStudioConn(other), t = parseStudioConn(tyre, &complete), r = parseStudioConn(rim);
  REQUIRE_FALSE(complete);  // the rest of a wheel record is not understood, but its head is kept
  REQUIRE((ha.size() == 1 && hb.size() == 1 && t.size() == 1 && r.size() == 1));
  REQUIRE(ha[0].gender != hb[0].gender);
  const auto hinge = mate(ha[0], hb[0]);
  REQUIRE(hinge.has_value());
  REQUIRE((hinge->freedom.rotates && !hinge->freedom.ball && !hinge->freedom.slides));
  REQUIRE_FALSE(mate(ha[0], ho[0]).has_value());  // another hinge family
  REQUIRE_FALSE(mate(ha[0], ha[0]).has_value());  // two of the same half
  const auto wheel = mate(t[0], r[0]);
  REQUIRE(wheel.has_value());
  REQUIRE((!wheel->freedom.rotates && !wheel->freedom.ball));
  REQUIRE_FALSE(mate(t[0], hb[0]).has_value());
}

TEST_CASE("damaged or unknown connectivity data never crashes and keeps what came before", "[studio][focus]") {
  std::string bytes;
  grid(bytes, 0x170003, {-10, 0, 10}, 1, 1);
  const size_t good = bytes.size();
  bytes += "this is not a record at all, just bytes long enough to look like one......................";
  bool complete = true;
  REQUIRE(parseStudioConn(bytes, &complete).size() == 1);
  REQUIRE_FALSE(complete);
  REQUIRE(parseStudioConn(std::string_view(bytes).substr(0, good - 7), &complete).size() <= 1);  // truncated tail
  REQUIRE(parseStudioConn("", &complete).empty());
  REQUIRE(complete);
  std::string huge;
  put(huge, static_cast<int32_t>(0x2));
  for (float v : {1.f, 0.f, 0.f, 0.f, 1.f, 0.f, 0.f, 0.f, 1.f, 0.f, 0.f, 0.f}) put(huge, v);
  put(huge, static_cast<int16_t>(30000));
  put(huge, static_cast<int16_t>(30000));  // a 15000 x 15000 grid in a 60-byte file
  REQUIRE(parseStudioConn(huge).size() <= 1);
  std::string unknown;
  plain(unknown, 0xd0000, {0, -1, 0}, {0, 0, 0}, 5);  // a record type that is not imported
  plain(unknown, 0x20000, {0, 0, 1}, {0, 10, -10}, 20);
  REQUIRE(parseStudioConn(unknown).size() == 1);  // skipped, and the walk goes on
}

TEST_CASE("the real Studio library agrees with known parts", "[studio][data]") {
  const char* dir = std::getenv("BM_STUDIO_DIR");
  if (!dir || !fs::exists(fs::path(dir) / "3001.conn")) SKIP("BM_STUDIO_DIR is not set");
  const StudioLibrary lib(dir);
  REQUIRE(lib.size() > 9000);
  const auto brick = lib.find("3001.dat");
  REQUIRE(brick->size() == 16);
  REQUIRE(std::any_of(brick->begin(), brick->end(), [](const Connector& x) { return x.gender == Gender::Male && near(x.start, {-30, 0, 10}); }));
  const auto technic = lib.find("3700");
  REQUIRE(std::any_of(technic->begin(), technic->end(), [](const Connector& x) { return x.gender == Gender::Female && x.length == 20 && std::abs(x.axis.z) > 0.99; }));
  const auto axle = lib.find("3705.dat");
  REQUIRE((axle->size() == 1 && axle->at(0).length == 80 && axle->at(0).profile.at(0).shape == 'A'));
  const auto base = lib.find("3937.dat"), top = lib.find("3938.dat");
  bool hinge = false;
  for (const Connector& x : *base)
    for (const Connector& y : *top)
      if (const auto m = mate(x, y); m && m->freedom.rotates) hinge = true;
  REQUIRE(hinge);
  REQUIRE(lib.find("nosuchpart.dat")->empty());
}

TEST_CASE("a Studio pin hole takes a real pin with its collar at the mouth", "[studio][review]") {
  std::string bytes;
  plain(bytes, 0x20000, {0, 0, 1}, {60, 10, -60}, 20);  // a frame's hole: z from -60 to -40
  const auto hole = parseStudioConn(bytes);
  REQUIRE(hole.size() == 1);
  REQUIRE(hole[0].profile.size() == 3);  // countersunk at both ends, like every Technic hole
  REQUIRE((hole[0].profile[0].radius == 8 && hole[0].profile[0].length == 2 && hole[0].profile[1].radius == 6 && hole[0].profile[1].length == 16));
  // A friction pin, 40 long with a collar in the middle, centred on the hole's mouth.
  Connector pin;
  pin.kind = SnapKind::Cyl;
  pin.gender = Gender::Male;
  pin.start = {60, 10, -80};
  pin.axis = {0, 0, 1};
  pin.side = {1, 0, 0};
  pin.length = 40;
  pin.radius = 8;
  pin.profile = {{'L', 6.25, 0, 2}, {'R', 6, 2, 16}, {'R', 8, 18, 4}, {'R', 6, 22, 16}, {'L', 6.25, 38, 2}};
  pin.openStart = pin.openEnd = true;
  pin.slide = true;
  const auto m = mate(pin, hole[0]);
  REQUIRE(m.has_value());
  REQUIRE(m->grip >= 16);
  // A short hole (a thin liftarm, 10 deep) is countersunk too; a very short one is left plain.
  std::string thin;
  plain(thin, 0x20000, {0, 0, 1}, {0, 0, 0}, 10);
  plain(thin, 0x20000, {0, 0, 1}, {0, 0, 0}, 3);
  const auto t = parseStudioConn(thin);
  REQUIRE((t[0].profile.size() == 3 && t[0].profile[1].length == 6));
  REQUIRE(t[1].profile.size() == 1);
}
