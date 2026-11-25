#pragma once
// The Keyframes timeline's objects and key maths, shared by both app shells (Swift and Rust):
// the object list with its key markers, retime limits, the adjacent key, the Build link, where a
// flight's keys start, and the keys an Auto Key gizmo drag writes.

#include <cstddef>
#include <cstdint>
#include <string>
#include <vector>

#include "bmapp/types.h"

namespace bmapp {

class Session;

/// Keys on one frame of an object: how many channels have one there.
struct KeyMarker {
  int frame = 0;
  size_t channels = 0;
};

/// One row of the Keyframes object list: a keyed object, or a step item that has no keys yet.
struct KeyObject {
  uint32_t piece = UINT32_MAX;
  bool submodel = false;
  std::string name;  ///< the track's name, or the item's submodel name / part description
  bool baked = false;
  bool keyed = false;
  KeyList keys;
  PieceList members;
  std::vector<KeyMarker> markers;  ///< sorted by frame
};
using KeyObjectList = std::vector<KeyObject>;

/// Every key track, then every step item not yet listed; keyed objects first, then by piece, a
/// submodel before a part of the same piece.
KeyObjectList keyObjects(const Session* session);

/// How far picked keys may move and stay inside the scene: [first - earliest, last - latest].
struct OffsetLimits {
  int lower = 0, upper = 0;
};
/// An empty pick (`earliest > latest`) gives {0, 0}.
OffsetLimits keyOffsetLimits(const KeyScene& scene, int earliest, int latest);
int clampOffset(OffsetLimits limits, int offset);

/// The nearest frame strictly after (or before) `frame`. False when there is none.
using FrameList = std::vector<int>;
bool adjacentKeyFrame(const FrameList& frames, int frame, bool after, int* out);

/// The scene with its Build link set; linking makes the scene long enough for the Build.
KeyScene linkedKeyScene(KeyScene scene, bool enabled, double buildDuration);

/// Seconds from the scene's first frame where a flight starting `flightStart` seconds into the
/// Build plays, clamped to the scene.
double flightKeysStart(const KeyScene& scene, double flightStart);

enum class GizmoTool { Move, Rotate, Scale };

/// The Smooth keys an Auto Key drag writes at `frame`. `origin` is the three channels' values at
/// the drag's start. Move: `change` is the total drag (LDU). Scale: the total factors. Rotate: the
/// handle axis times the degrees, in engine axes.
KeyList autoKeyValues(GizmoTool tool, Vec3 origin, Vec3 change, int frame);

/// Which object an Auto Key drag keys: a lone part, or a whole submodel use.
struct AutoKeyTarget {
  bool ok = false;
  uint32_t piece = UINT32_MAX;
  bool submodel = false;
};
/// `keySubmodel` < 0: no submodel chosen for keying.
AutoKeyTarget autoKeyTarget(const Session* session, const PieceList& selection, bool autoKey, int64_t keySubmodel);

}  // namespace bmapp
