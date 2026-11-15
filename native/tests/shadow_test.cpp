#include <catch2/catch_test_macros.hpp>
#include <cstdlib>
#include "bm/connect/shadow.h"

using namespace bm;
using namespace bm::connect;

TEST_CASE("a Technic pin's shadow: clear, a male profile and a bar hole", "[shadow]") {
  const ShadowInfo s = parseShadow(
      "0 LDCad shadow info for \"Technic Pin\"\n"
      "0 !LDCAD SNAP_CLEAR \n"
      "0 !LDCAD SNAP_CYL [gender=M] [caps=none] [secs=L_ 6.25 2   R 6 16   R 8 4   R 6 16   _L 6.25 2] [center=true] [slide=true] [ori=0 -1 0 1 0 0 0 0 1]\n"
      "0 !LDCAD SNAP_CYL [gender=F] [caps=none] [secs=R 4 40] [center=true] [ori=0 -1 0 1 0 0 0 0 1]\n"
      "0 //!LDCAD SNAP_CYL [gender=M] [caps=one] [secs=R 9 9]\n"
      "0 !LDCAD MIRROR_INFO [baseFlip=Z] [counterPart=self]\n");
  REQUIRE(s.clearAll);
  REQUIRE(s.snaps.size() == 2);
  const SnapDef& pin = s.snaps[0];
  REQUIRE(pin.kind == SnapKind::Cyl);
  REQUIRE(pin.gender == Gender::Male);
  REQUIRE(pin.caps == "none");
  REQUIRE((pin.center && pin.slide));
  REQUIRE(pin.sections.size() == 5);
  REQUIRE((pin.sections[0].shape == 'L' && pin.sections[0].radius == 6.25 && pin.sections[0].length == 2));
  REQUIRE((pin.sections[2].shape == 'R' && pin.sections[2].radius == 8 && pin.sections[2].length == 4));
  REQUIRE(pin.sections[4].shape == 'L');
  REQUIRE(pin.frames.size() == 1);
  REQUIRE(pin.frames[0].r.m[1] == -1);
  REQUIRE(s.snaps[1].gender == Gender::Female);
  REQUIRE_FALSE(s.snaps[1].slide);
}

TEST_CASE("ids, grids, includes, clips, fingers and ball joints", "[shadow]") {
  const ShadowInfo s = parseShadow(
      "0 !LDCAD SNAP_CYL [ID=studO] [gender=M] [caps=one] [secs=R 6 4]\n"
      "0 !LDCAD SNAP_CYL [gender=F] [caps=one] [secs=S 6 4] [pos=0 24 0] [grid=C 2 1 20 0]\n"
      "0 !LDCAD SNAP_INCL [ref=ConnHole.dat] [pos=0 10 0] [ori=1 0 0 0 0 1 0 -1 0]\n"
      "0 !LDCAD SNAP_CLP [radius=4] [length=8] [center=true] [pos=0 4 -20]\n"
      "0 !LDCAD SNAP_FGR [group=hgBrC] [genderOfs=M] [seq=18 4 18] [radius=4] [pos=0 10 0] [ori=0 -1 0 1 0 0 0 0 1]\n"
      "0 !LDCAD SNAP_FGR [genderOfs=F] [seq=4 4]\n"
      "0 !LDCAD SNAP_GEN [group=techBallJnt] [gender=M] [bounding=sph 12.7] [match=size] [placement=free]\n"
      "0 !LDCAD SNAP_CLEAR [id=StudO]\n");
  REQUIRE(s.snaps.size() == 6);
  REQUIRE(s.snaps[0].id == "studo");
  REQUIRE(s.snaps[1].frames.size() == 2);
  REQUIRE((s.snaps[1].frames[0].t == Vec3{-10, 24, 0} && s.snaps[1].frames[1].t == Vec3{10, 24, 0}));
  REQUIRE(s.snaps[1].sections[0].shape == 'S');
  REQUIRE(s.includes.size() == 1);
  REQUIRE(s.includes[0].ref == "connhole.dat");
  REQUIRE(s.includes[0].frames[0].t == Vec3{0, 10, 0});
  REQUIRE((s.snaps[2].kind == SnapKind::Clip && s.snaps[2].gender == Gender::Female && s.snaps[2].radius == 4 && s.snaps[2].length == 8 && s.snaps[2].center));
  REQUIRE((s.snaps[3].kind == SnapKind::Finger && s.snaps[3].gender == Gender::Male && s.snaps[3].group == "hgbrc"));
  REQUIRE(s.snaps[3].seq == std::vector<double>{18, 4, 18});
  REQUIRE(s.snaps[4].radius == 4);  // a finger with no radius gets the usual one
  REQUIRE((s.snaps[5].kind == SnapKind::Generic && s.snaps[5].bounding == "sph 12.7" && s.snaps[5].placement == "free" && s.snaps[5].match == "size"));
  REQUIRE_FALSE(s.clearAll);
  REQUIRE(s.clearIds == std::vector<std::string>{"studo"});
}

TEST_CASE("grid copies", "[shadow]") {
  const auto a = gridOffsets("C 4 C 2 20 20");
  REQUIRE(a.size() == 8);
  REQUIRE((a.front() == Vec3{-30, 0, -10} && a.back() == Vec3{30, 0, 10}));
  const auto b = gridOffsets("1 2 0 20");
  REQUIRE(b.size() == 2);
  REQUIRE((b[0] == Vec3{0, 0, 0} && b[1] == Vec3{0, 0, 20}));
  REQUIRE(gridOffsets("").size() == 1);
  REQUIRE(gridOffsets("C x 2").size() == 1);       // malformed: one copy at the position
  REQUIRE(gridOffsets("100000 100000 1 1").size() == 1);  // absurd: refused, not allocated
}

TEST_CASE("malformed shadow lines are skipped, the rest is kept", "[shadow][focus]") {
  const ShadowInfo s = parseShadow(
      "0 !LDCAD SNAP_CYL [gender=X] [caps=one] [secs=R 6 4]\n"
      "0 !LDCAD SNAP_CYL [gender=M] [caps=one] [secs=R six 4]\n"
      "0 !LDCAD SNAP_CYL [gender=M] [caps=one]\n"
      "0 !LDCAD SNAP_CYL [gender=M] [caps=one] [secs=R 6 4] [pos=1 2] [ori=1 0 0] [grid=C]\n"
      "0 !LDCAD SNAP_CLP [length=8]\n"
      "0 !LDCAD SNAP_FGR [genderOfs=M] [radius=4]\n"
      "0 !LDCAD SNAP_GEN [bounding=sph 3]\n"
      "0 !LDCAD SNAP_INCL [pos=0 0 0]\n"
      "0 !LDCAD SNAP_CYL [gender=F [caps=one] [secs=R 6 4\n"
      "0 !LDCAD\n"
      "garbage \xff\xfe\n");
  REQUIRE(s.snaps.size() == 1);  // only the fourth: bad pos/ori/grid fall back to the origin
  REQUIRE(s.snaps[0].frames.size() == 1);
  REQUIRE(s.snaps[0].frames[0].t == Vec3{0, 0, 0});
  REQUIRE(s.includes.empty());
  REQUIRE(parseShadow("").snaps.empty());
}

TEST_CASE("the real shadow library", "[shadow][data]") {
  const char* dir = std::getenv("BM_SHADOW_DIR");
  if (!dir) SKIP("BM_SHADOW_DIR is not set");
  const ShadowLibrary lib(dir);
  REQUIRE(lib.size() > 4000);
  const ShadowInfo* stud = lib.find("STUD.dat");
  REQUIRE(stud != nullptr);
  REQUIRE(stud->snaps.size() == 1);
  REQUIRE((stud->snaps[0].gender == Gender::Male && stud->snaps[0].sections[0].radius == 6 && stud->snaps[0].sections[0].length == 4));
  REQUIRE(lib.find("s\\3001s01.dat") != nullptr);
  REQUIRE(lib.find("nosuch.dat") == nullptr);
  REQUIRE(ShadowLibrary("/nonexistent").size() == 0);
}
