#pragma once
// What happens in a build, as beats a camera can film: each flight, each unit built on its spot,
// each step, how the model grows, and the reveal. Planners say what happens; the director
// decides how to film it. Frames are the timeline's.
#include <vector>
#include "bm/collide/world.h"
#include "bm/model.h"
#include "bm/plan/plan.h"
#include "bm/plan/timeline.h"
#include "bmf/tolerances.h"

namespace bm::film {

enum class BeatKind { Flight, UnitBuild, Step, Growth, Reveal, Motion };

struct Beat {
  BeatKind kind = BeatKind::Flight;
  int start = 0, end = 0;  ///< frames
  int flight = -1;         ///< the flight it is about (Flight, UnitBuild: the unit's own flight)
  double importance = 0;   ///< 0..1
  Box seat;                ///< where it ends up: the flight's pieces at rest, or what the step adds
  Box from;                ///< Flight: where its pieces are when it starts (its staging)
  std::vector<int> steps;  ///< Step: the step, level by level (plan::stepsOf)
};

struct Beats {
  std::vector<Beat> list;      ///< sorted by (start, kind, flight)
  std::vector<Box> builtBox;   ///< everything at rest in its seat, at each frame 0..frames
  Box model;                   ///< the finished model
  int frames = 0;
};

Beats beatsOf(const plan::Timeline& timeline, const plan::Plan& plan, const Model& model, const collide::World& world);

/// The box of a flight's pieces where the timeline has them at `frame`.
Box flyingBox(const plan::Timeline& timeline, const plan::Plan& plan, const collide::World& world, int flight, double frame);

/// A box's eight corners.
std::vector<Vec3> corners(const Box& box);
/// Whether the segment from `a` to `b` passes through `box`.
bool crosses(Vec3 a, Vec3 b, const Box& box);
/// Whether model piece `piece` stands in the way of the sight line from `a` to `b`: its true
/// surface, not its box, so a slope or a stud's corner does not hide what is behind it.
bool blocks(const collide::World& world, uint32_t piece, Vec3 a, Vec3 b);

}  // namespace bm::film
