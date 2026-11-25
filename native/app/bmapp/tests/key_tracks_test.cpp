// The Keyframes timeline's shared maths (key_tracks.h), moved down from the Swift app.
#include <catch2/catch_approx.hpp>
#include <catch2/catch_test_macros.hpp>

#include <algorithm>
#include <filesystem>

#include "bmapp/key_tracks.h"
#include "bmapp/session.h"

namespace fs = std::filesystem;
using Catch::Approx;

namespace {

fs::path helicopter() { return fs::path(BM_REPO) / "samples" / "helicopter" / "helicopter.mpd"; }

bmapp::Keyframe key(bmapp::KeyChannel channel, int frame, double value) {
  bmapp::Keyframe k;
  k.channel = channel;
  k.frame = frame;
  k.value = value;
  return k;
}

bool findItem(const bmapp::Session& s, bool submodel, bmapp::ItemRow* out) {
  for (size_t step = 0; step < s.stepCount(); ++step)
    for (const bmapp::ItemRow& item : s.stepItems(step))
      if (item.submodel == submodel && !item.pieces.empty() &&
          (submodel || s.isLocalPiece(item.pieces.front()))) {
        *out = item;
        return true;
      }
  return false;
}

}  // namespace

TEST_CASE("key objects list step items and keyed first", "[key tracks]") {
  bmapp::Session s;
  REQUIRE(s.open(helicopter().string()).ok);
  bmapp::ItemRow part;
  REQUIRE(findItem(s, false, &part));
  const uint32_t p = part.pieces.front();
  using C = bmapp::KeyChannel;
  REQUIRE(s.setKeys(p, {key(C::PositionX, 10, 1), key(C::PositionY, 10, 2), key(C::PositionX, 20, 3)}, false)
              .refused.empty());
  const bmapp::KeyObjectList objects = bmapp::keyObjects(&s);
  REQUIRE(!objects.empty());
  CHECK(objects[0].piece == p);
  CHECK_FALSE(objects[0].submodel);
  CHECK(objects[0].keyed);
  CHECK(objects[0].keys.size() == 3);
  REQUIRE(objects[0].markers.size() == 2);
  CHECK(objects[0].markers[0].frame == 10);
  CHECK(objects[0].markers[0].channels == 2);
  CHECK(objects[0].markers[1].frame == 20);
  CHECK(objects[0].markers[1].channels == 1);
  // every step item once, the rest unkeyed and ordered by piece
  size_t items = 0;
  for (size_t step = 0; step < s.stepCount(); ++step)
    for (const bmapp::ItemRow& item : s.stepItems(step))
      if (!item.pieces.empty()) ++items;
  CHECK(objects.size() <= items);
  for (size_t i = 1; i < objects.size(); ++i) {
    CHECK_FALSE(objects[i].keyed);
    if (i > 1) CHECK(objects[i - 1].piece <= objects[i].piece);
  }
  for (size_t i = 0; i < objects.size(); ++i)
    for (size_t j = i + 1; j < objects.size(); ++j)
      CHECK_FALSE((objects[i].piece == objects[j].piece && objects[i].submodel == objects[j].submodel));
}

TEST_CASE("offset limits clamp to the scene", "[key tracks]") {
  bmapp::KeyScene scene;  // 1-250
  const bmapp::OffsetLimits limits = bmapp::keyOffsetLimits(scene, 10, 40);
  CHECK(limits.lower == -9);
  CHECK(limits.upper == 210);
  CHECK(bmapp::clampOffset(limits, 300) == 210);
  CHECK(bmapp::clampOffset(limits, -50) == -9);
  CHECK(bmapp::clampOffset(limits, 7) == 7);
  const bmapp::OffsetLimits empty = bmapp::keyOffsetLimits(scene, 41, 40);
  CHECK(empty.lower == 0);
  CHECK(empty.upper == 0);
}

TEST_CASE("adjacent key frame", "[key tracks]") {
  const std::vector<int> frames{20, 10, 20};
  int out = 0;
  REQUIRE(bmapp::adjacentKeyFrame(frames, 15, true, &out));
  CHECK(out == 20);
  REQUIRE(bmapp::adjacentKeyFrame(frames, 15, false, &out));
  CHECK(out == 10);
  CHECK_FALSE(bmapp::adjacentKeyFrame(frames, 20, true, &out));
  CHECK_FALSE(bmapp::adjacentKeyFrame({}, 20, false, &out));
}

TEST_CASE("linking extends the scene", "[key tracks]") {
  bmapp::KeyScene scene;
  scene.fps = 24, scene.first = 1, scene.last = 50, scene.buildStart = 1, scene.buildSpeed = 1;
  const bmapp::KeyScene linked = bmapp::linkedKeyScene(scene, true, 4.0);
  CHECK(linked.buildLinked);
  CHECK(linked.last == 97);
  const bmapp::KeyScene unlinked = bmapp::linkedKeyScene(linked, false, 4.0);
  CHECK_FALSE(unlinked.buildLinked);
  CHECK(unlinked.last == 97);
  // never shortens
  scene.last = 400;
  CHECK(bmapp::linkedKeyScene(scene, true, 4.0).last == 400);
}

TEST_CASE("flight keys start", "[key tracks]") {
  bmapp::KeyScene scene;
  scene.fps = 24, scene.first = 1, scene.last = 250, scene.buildStart = 25, scene.buildSpeed = 2;
  CHECK(bmapp::flightKeysStart(scene, 3.0) == Approx(2.5));
  scene.last = 49;
  CHECK(bmapp::flightKeysStart(scene, 30.0) == Approx(2.0));
}

TEST_CASE("auto key values", "[key tracks]") {
  using C = bmapp::KeyChannel;
  const bmapp::KeyList move = bmapp::autoKeyValues(bmapp::GizmoTool::Move, {1, 2, 3}, {20, 40, -60}, 12);
  REQUIRE(move.size() == 3);
  CHECK(move[0].channel == C::PositionX);
  CHECK(move[1].channel == C::PositionY);
  CHECK(move[2].channel == C::PositionZ);
  CHECK(move[0].value == Approx(2));
  CHECK(move[1].value == Approx(0));
  CHECK(move[2].value == Approx(6));
  for (const bmapp::Keyframe& k : move) {
    CHECK(k.frame == 12);
    CHECK(k.interpolation == bmapp::KeyInterpolation::Smooth);
  }
  const bmapp::KeyList scale = bmapp::autoKeyValues(bmapp::GizmoTool::Scale, {1, 1, 2}, {2, 1, 0.5}, 3);
  REQUIRE(scale.size() == 3);
  CHECK(scale[0].channel == C::ScaleX);
  CHECK(scale[0].value == Approx(2));
  CHECK(scale[1].value == Approx(1));
  CHECK(scale[2].value == Approx(1));
  const bmapp::KeyList rotate = bmapp::autoKeyValues(bmapp::GizmoTool::Rotate, {0, 10, 0}, {0, 30, 0}, 3);
  REQUIRE(rotate.size() == 3);
  CHECK(rotate[0].channel == C::RotationX);
  CHECK(rotate[1].value == Approx(-20));
  CHECK(rotate[2].value == Approx(0));
}

TEST_CASE("auto key target", "[key tracks]") {
  bmapp::Session s;
  REQUIRE(s.open(helicopter().string()).ok);
  bmapp::ItemRow part;
  REQUIRE(findItem(s, false, &part));
  const uint32_t p = part.pieces.front();
  CHECK_FALSE(bmapp::autoKeyTarget(&s, {p}, false, -1).ok);
  CHECK_FALSE(bmapp::autoKeyTarget(&s, {}, true, -1).ok);
  const bmapp::AutoKeyTarget one = bmapp::autoKeyTarget(&s, {p}, true, -1);
  CHECK(one.ok);
  CHECK(one.piece == p);
  CHECK_FALSE(one.submodel);
  bmapp::ItemRow other;
  bool found = false;
  for (size_t step = 0; step < s.stepCount() && !found; ++step)
    for (const bmapp::ItemRow& item : s.stepItems(step))
      if (!item.submodel && !item.pieces.empty() && item.pieces.front() != p && s.isLocalPiece(item.pieces.front())) {
        other = item;
        found = true;
        break;
      }
  REQUIRE(found);
  CHECK_FALSE(bmapp::autoKeyTarget(&s, {p, other.pieces.front()}, true, -1).ok);

  bmapp::ItemRow use;
  if (!findItem(s, true, &use)) SKIP("no submodel use in the sample");
  const uint32_t q = use.pieces.front();
  const std::vector<uint32_t> members = s.usePieces(q);
  const bmapp::AutoKeyTarget sub = bmapp::autoKeyTarget(&s, members, true, q);
  CHECK(sub.ok);
  CHECK(sub.piece == members.front());
  CHECK(sub.submodel);
}
