#pragma once
// The camera body: films a shot list for a frame shape, frame by frame. It fits each shot's
// subject with the shot's lens, keeps the eye clear of the model and above the floor, blends
// between shots that blend, and smooths the motion without lag; a cut starts afresh.
#include <vector>
#include "bmf/beats.h"
#include "bmf/lens.h"
#include "bmf/shots.h"

namespace bm::film {

struct Frame {
  Vec3 eye, target, up{0, -1, 0};
  double fovY = 0.6;
  double focus = 0, aperture = 0, shutter = 0;  ///< stored for the path tracer
  int shot = 0;      ///< index into the shot list
  bool cut = false;  ///< the first frame of a shot that comes in by a cut
};

struct Track {
  std::vector<Frame> frames;  ///< one per timeline frame, 0..frames
  FrameShape shape;
  double fps = 30;
};

Track shoot(const std::vector<Shot>& shots, const Beats& beats, const plan::Timeline& timeline, const plan::Plan& plan, const collide::World& world, const FrameShape& shape,
            double fps, double front = 0);

/// The camera between frames: between the two either side, never across a cut.
Frame cameraAt(const Track& track, double frame);

/// A frame as a rig (target, way round, distance, lens on this sensor).
Rig rigOf(const Frame& frame, double sensorMm = kSensorMm);

}  // namespace bm::film
