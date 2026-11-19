#include "bmf/measure.h"
#include <algorithm>
#include <climits>
#include <cmath>
#include "bmf/tolerances.h"

namespace bm::film {

namespace {

Vec3 middle(const Box& b) { return (b.min + b.max) * 0.5; }

bool inside(Vec3 p, const Box& b) { return p.x > b.min.x && p.x < b.max.x && p.y > b.min.y && p.y < b.max.y && p.z > b.min.z && p.z < b.max.z; }

}  // namespace

Report measure(const Track& track, const std::vector<Shot>& shots, const Beats& beats, const plan::Timeline& t, const plan::Plan& plan, const collide::World& world) {
  Report r;
  const std::vector<Frame>& fr = track.frames;
  std::vector<int> landed(world.size(), INT_MAX);
  for (const plan::Flight& fl : t.flights)
    if (fl.parent < 0)
      for (uint32_t piece : plan::piecesOf(fl, plan)) landed[piece] = std::min(landed[piece], fl.startFrame + fl.frames);

  // Each landing: its seat in the frame it lands, and some of it not behind what is already built.
  std::vector<uint32_t> near;
  for (size_t fi = 0; fi < t.flights.size(); fi++) {
    const plan::Flight& fl = t.flights[fi];
    if (fl.parent >= 0) continue;
    r.landings++;
    const int land = fl.startFrame + fl.frames;
    bool shown = false;
    if (!fr.empty()) {
      const Frame& cam = fr[static_cast<size_t>(std::clamp(land, 0, static_cast<int>(fr.size()) - 1))];
      const Rig rig = rigOf(cam, track.shape.sensorMm);
      const Box seat = flyingBox(t, plan, world, static_cast<int>(fi), land);
      std::vector<Vec3> points = corners(seat);
      bool framed = true;
      for (Vec3 p : points) {
        const Vec3 q = project(rig, track.shape, p);
        framed = framed && q.z > 0 && std::abs(q.x) <= 1 + 1e-6 && std::abs(q.y) <= 1 + 1e-6;
      }
      points.push_back(middle(seat));
      const auto& own = plan::piecesOf(fl, plan);
      for (size_t k = 0; framed && !shown && k < points.size(); k++) {
        const Vec3 end = points[k] + (cam.eye - points[k]) * 0.03;  // stop short of its own surface
        Box span;
        span.grow(cam.eye), span.grow(end);
        near.clear();
        world.near(span, nullptr, near);
        bool hidden = false;
        for (uint32_t q : near) {
          if (landed[q] > land || std::find(own.begin(), own.end(), q) != own.end()) continue;
          Box b = world.box(q);
          b.min = b.min + Vec3{kOcclusionInset, kOcclusionInset, kOcclusionInset}, b.max = b.max - Vec3{kOcclusionInset, kOcclusionInset, kOcclusionInset};
          if (!b.empty() && crosses(cam.eye, end, b)) {
            hidden = true;
            break;
          }
        }
        shown = !hidden;
      }
    }
    if (shown)
      r.landingsInFrame++;
    else
      r.missed.push_back(static_cast<int>(fi));
  }

  // The eye: never inside what is built, never under the floor.
  const double floorY = beats.model.empty() ? 0 : beats.model.max.y;
  for (size_t f = 0; f < fr.size(); f++) {
    bool in = fr[f].eye.y > floorY;
    Box around;
    around.grow(fr[f].eye);
    near.clear();
    world.near(around, nullptr, near);
    for (uint32_t q : near) in = in || (landed[q] <= static_cast<int>(f) && inside(fr[f].eye, world.box(q)));
    r.insideFrames += in ? 1 : 0;
  }

  // Motion within a shot: angular jerk (the eye's third difference over its distance) and the
  // target's largest step.
  const double fps = track.fps;
  for (size_t f = 1; f < fr.size(); f++) {
    if (fr[f].cut) continue;
    r.maxTargetJump = std::max(r.maxTargetJump, length(fr[f].target - fr[f - 1].target));
    if (f < 3 || fr[f - 1].cut || fr[f - 2].cut) continue;
    const Vec3 j = fr[f].eye - fr[f - 1].eye * 3 + fr[f - 2].eye * 3 - fr[f - 3].eye;
    const double d = std::max(1.0, length(fr[f - 1].eye - fr[f - 1].target));
    r.maxJerk = std::max(r.maxJerk, length(j) / d * fps * fps * fps);
  }

  const double seconds = fr.size() > 1 ? (fr.size() - 1) / fps : 0;
  int cuts = 0;
  for (const Frame& x : fr) cuts += x.cut ? 1 : 0;
  r.cutsPerMinute = seconds > 0 ? cuts * 60.0 / seconds : 0;
  r.shortestShot = shots.empty() ? 0 : 1e300;
  for (const Shot& s : shots) r.shortestShot = std::min(r.shortestShot, s.end - s.start);
  r.rules = checkEditing(shots, beats, fps);
  return r;
}

}  // namespace bm::film
