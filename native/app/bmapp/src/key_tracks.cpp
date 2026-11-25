#include "bmapp/key_tracks.h"

#include <algorithm>
#include <cmath>
#include <map>
#include <utility>

#include "bmapp/session.h"

namespace bmapp {

KeyObjectList keyObjects(const Session* session) {
  if (!session) return {};
  using Id = std::pair<uint32_t, bool>;
  std::map<Id, KeyObject> known;
  for (const KeyTrack& track : session->keyTracks()) {
    KeyObject object;
    object.piece = track.object;
    object.submodel = !track.baked && !session->isLocalPiece(track.object);
    object.name = track.name;
    object.baked = track.baked;
    object.keyed = true;
    object.keys = track.keys;
    object.members = track.members;
    std::map<int, size_t> counts;
    for (const Keyframe& key : track.keys) ++counts[key.frame];
    for (const auto& [frame, channels] : counts) object.markers.push_back({frame, channels});
    const Id id{object.piece, object.submodel};
    auto found = known.find(id);
    if (found == known.end()) known.emplace(id, std::move(object));
    else if (!found->second.baked) found->second = std::move(object);  // a baked track wins
  }
  for (size_t step = 0; step < session->stepCount(); ++step) {
    for (const ItemRow& item : session->stepItems(step)) {
      if (item.pieces.empty()) continue;
      const Id id{item.pieces.front(), item.submodel};
      if (known.count(id)) continue;
      KeyObject object;
      object.piece = id.first;
      object.submodel = id.second;
      object.name = item.submodel ? item.name : item.description;
      object.members = item.pieces;
      known.emplace(id, std::move(object));
    }
  }
  KeyObjectList objects;
  objects.reserve(known.size());
  for (auto& entry : known) objects.push_back(std::move(entry.second));
  std::stable_sort(objects.begin(), objects.end(), [](const KeyObject& a, const KeyObject& b) {
    if (a.keyed != b.keyed) return a.keyed;
    if (a.piece != b.piece) return a.piece < b.piece;
    return a.submodel && !b.submodel;
  });
  return objects;
}

OffsetLimits keyOffsetLimits(const KeyScene& scene, int earliest, int latest) {
  if (earliest > latest) return {};
  return {scene.first - earliest, scene.last - latest};
}

int clampOffset(OffsetLimits limits, int offset) { return std::min(limits.upper, std::max(limits.lower, offset)); }

bool adjacentKeyFrame(const FrameList& frames, int frame, bool after, int* out) {
  bool found = false;
  int best = 0;
  for (const int f : frames) {
    if (after ? f <= frame : f >= frame) continue;
    if (!found || (after ? f < best : f > best)) best = f, found = true;
  }
  if (found && out) *out = best;
  return found;
}

KeyScene linkedKeyScene(KeyScene scene, bool enabled, double buildDuration) {
  scene.buildLinked = enabled;
  if (enabled && scene.buildSpeed > 0 && std::isfinite(buildDuration)) {
    const double length = buildDuration / scene.buildSpeed * double(scene.fps);
    scene.last = std::max(scene.last, scene.buildStart + int(std::ceil(length)));
  }
  return scene;
}

double flightKeysStart(const KeyScene& scene, double flightStart) {
  const double fps = double(std::max(1, scene.fps));
  const double start = double(scene.buildStart - scene.first) / fps + flightStart / scene.buildSpeed;
  return std::min(start, double(scene.last - scene.first) / fps);
}

KeyList autoKeyValues(GizmoTool tool, Vec3 origin, Vec3 change, int frame) {
  KeyChannel channels[3];
  Vec3 offset;
  switch (tool) {
    case GizmoTool::Move:
      channels[0] = KeyChannel::PositionX, channels[1] = KeyChannel::PositionY, channels[2] = KeyChannel::PositionZ;
      offset = {change.x / 20, -change.y / 20, -change.z / 20};
      break;
    case GizmoTool::Scale:
      channels[0] = KeyChannel::ScaleX, channels[1] = KeyChannel::ScaleY, channels[2] = KeyChannel::ScaleZ;
      offset = {origin.x * (change.x - 1), origin.y * (change.y - 1), origin.z * (change.z - 1)};
      break;
    case GizmoTool::Rotate:
      channels[0] = KeyChannel::RotationX, channels[1] = KeyChannel::RotationY, channels[2] = KeyChannel::RotationZ;
      offset = {change.x, -change.y, -change.z};
      break;
  }
  const double values[3] = {origin.x + offset.x, origin.y + offset.y, origin.z + offset.z};
  KeyList keys;
  for (int i = 0; i < 3; ++i) {
    Keyframe key;
    key.channel = channels[i];
    key.frame = frame;
    key.value = values[i];
    key.interpolation = KeyInterpolation::Smooth;
    keys.push_back(key);
  }
  return keys;
}

AutoKeyTarget autoKeyTarget(const Session* session, const PieceList& selection, bool autoKey, int64_t keySubmodel) {
  AutoKeyTarget target;
  if (!session || !autoKey || selection.empty()) return target;
  const uint32_t piece = selection.front();
  const bool local = session->isLocalPiece(piece);
  const bool submodel = !local && (keySubmodel == int64_t(piece) || selection.size() > 1 ||
                                   !session->hasEditableFlightKeys(piece));
  if (submodel ? session->usePieces(piece) != selection : selection.size() != 1) return target;
  target.ok = true;
  target.piece = piece;
  target.submodel = submodel;
  return target;
}

}  // namespace bmapp
