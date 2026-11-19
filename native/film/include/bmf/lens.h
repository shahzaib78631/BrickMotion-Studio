#pragma once
// The camera's lens and framing: field of view from a lens, fitting a subject into the frame
// for a frame shape, and where to aim so it sits well in it.
#include <vector>
#include "bm/math.h"
#include "bmf/tolerances.h"

namespace bm::film {

/// Vertical field of view, radians, of a lens of `lensMm` on a sensor `sensorMm` tall.
double fovY(double lensMm, double sensorMm);

/// The picture's shape: width over height, the sensor, and the share of each half of the frame
/// a subject may use.
struct FrameShape {
  double aspect = 16.0 / 9;
  double sensorMm = kSensorMm;
  double safe = kSafeFrame;
};

/// A camera as a rig: what it looks at, from which way (azimuth 0 is the front, from -z with +x
/// to the right; elevation above 0 looks down), how far, its roll and lens.
struct Rig {
  Vec3 target;
  double azimuth = 0, elevation = 0, distance = 0, roll = 0, lensMm = kLensMm;
};
Vec3 eyeOf(const Rig& rig);
/// Up on screen (LDraw: -y), turned by the rig's roll about the way it looks.
Vec3 upOf(const Rig& rig);
/// Where `p` is in the picture: x and y from -1 to 1 across the frame (x right, y up), and z its
/// depth in front of the eye (LDU; not positive: behind it).
Vec3 project(const Rig& rig, const FrameShape& shape, Vec3 p);

/// The least distance at which every point, seen from this way with the aim at `target`, is
/// within `fill` of the safe frame, across and up and down, in this frame shape. Never under
/// kMinDistance.
double fitDistance(const std::vector<Vec3>& points, Vec3 target, double azimuth, double elevation, double lensMm, const FrameShape& shape, double fill);

/// Where to aim: the points' middle as seen from this way, moved so that, at `distance`, the
/// subject sits kLeadShare behind the centre against `lead` (the way it moves, in the model; a
/// zero vector: centred).
Vec3 composedTarget(const std::vector<Vec3>& points, double azimuth, double elevation, Vec3 lead, double distance, double lensMm, const FrameShape& shape);

}  // namespace bm::film
