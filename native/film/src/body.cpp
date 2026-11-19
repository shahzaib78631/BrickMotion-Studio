#include "bmf/body.h"
#include <algorithm>
#include <cmath>
#include "bmf/rules.h"
#include "bmf/tolerances.h"

namespace bm::film {

namespace {

Vec3 middle(const Box& b) { return (b.min + b.max) * 0.5; }
double wrap(double a) { return std::remainder(a, 2 * M_PI); }
/// Minimum-jerk easing: still at both ends, no jolt.
double ease(double u) {
  u = std::clamp(u, 0.0, 1.0);
  return u * u * u * (10 - 15 * u + 6 * u * u);
}
double boxDistance(Vec3 p, const Box& b) {
  const double dx = std::max({b.min.x - p.x, 0.0, p.x - b.max.x}), dy = std::max({b.min.y - p.y, 0.0, p.y - b.max.y}), dz = std::max({b.min.z - p.z, 0.0, p.z - b.max.z});
  return std::sqrt(dx * dx + dy * dy + dz * dz);
}
Rig mix(const Rig& a, const Rig& b, double w) {
  Rig r = a;
  r.target = a.target + (b.target - a.target) * w;
  r.azimuth = a.azimuth + wrap(b.azimuth - a.azimuth) * w;
  r.elevation = a.elevation + (b.elevation - a.elevation) * w;
  r.distance = a.distance + (b.distance - a.distance) * w;
  r.roll = a.roll + (b.roll - a.roll) * w;
  r.lensMm = a.lensMm + (b.lensMm - a.lensMm) * w;
  return r;
}

struct Body {
  const std::vector<Shot>& shots;
  const Beats& beats;
  const plan::Timeline& t;
  const plan::Plan& plan;
  const collide::World& world;
  const FrameShape& shape;
  double fps, front;
  std::vector<int> landed;
  std::vector<const Beat*> flights, units;  ///< top-level flight beats; unit builds by flight
  double floorY = 0;

  Body(const std::vector<Shot>& s, const Beats& b, const plan::Timeline& t_, const plan::Plan& p, const collide::World& w, const FrameShape& sh, double f, double fr)
      : shots(s), beats(b), t(t_), plan(p), world(w), shape(sh), fps(f), front(fr) {
    landed.assign(world.size(), INT32_MAX);
    for (const plan::Flight& fl : t.flights)
      if (fl.parent < 0)
        for (uint32_t piece : plan::piecesOf(fl, plan)) landed[piece] = std::min(landed[piece], fl.startFrame + fl.frames);
    units.assign(t.flights.size(), nullptr);
    for (const Beat& x : beats.list) {
      if (x.kind == BeatKind::Flight && t.flights[static_cast<size_t>(x.flight)].parent < 0) flights.push_back(&x);
      if (x.kind == BeatKind::UnitBuild) units[static_cast<size_t>(x.flight)] = &x;
    }
    floorY = beats.model.empty() ? 0 : beats.model.max.y;
  }

  /// What the shot keeps in frame at `frame`.
  Box subject(const Shot& s, int frame) const {
    Box b;
    switch (s.subject.kind) {
      case SubjectKind::Model: b = beats.model; break;
      case SubjectKind::BuiltSoFar:
        b = beats.builtBox[static_cast<size_t>(frame)];
        // What is on its way in lands in frame; its seat grows into the subject as it flies, so
        // the frame opens steadily instead of jumping when the flight starts.
        for (const Beat* x : flights)
          if (x->start <= frame && frame <= x->end) {
            if (b.empty()) {
              b = x->seat;
              continue;
            }
            Box both = b;
            both.merge(x->seat);
            const double w = ease(static_cast<double>(frame - x->start) / std::max(1, x->end - x->start));
            b.min = b.min + (both.min - b.min) * w, b.max = b.max + (both.max - b.max) * w;
          }
        if (b.empty())
          for (const Beat* x : flights)
            if (b.empty()) b = x->seat;
        break;
      case SubjectKind::Unit:
        if (s.subject.flight >= 0 && units[static_cast<size_t>(s.subject.flight)]) b = units[static_cast<size_t>(s.subject.flight)]->seat;
        if (s.subject.flight >= 0 && frame >= t.flights[static_cast<size_t>(s.subject.flight)].startFrame) b.merge(flyingBox(t, plan, world, s.subject.flight, frame));
        break;
      case SubjectKind::Piece:
        if (s.subject.flight >= 0) {
          b = flyingBox(t, plan, world, s.subject.flight, frame);
          for (const Beat* x : flights)
            if (x->flight == s.subject.flight) b.merge(x->seat);
        }
        break;
      case SubjectKind::Point: b.grow(s.subject.point); break;
    }
    if (b.empty()) b = beats.model;
    if (b.empty()) b.grow({0, 0, 0});
    return b;
  }

  Rig solve(const Shot& s, int frame) const {
    const double time = frame / fps, span = std::max(1e-9, s.end - s.start), u = ease((time - s.start) / span);
    const auto [a0, e0] = startAngles(s);
    const auto [a1, e1] = endAngles(s);
    Rig r;
    r.azimuth = front + a0 + wrap(a1 - a0) * u;
    if (s.move.kind == MoveKind::ArcReveal) r.azimuth = front + a0 + (a1 - a0) * u;  // the whole arc, not the short way
    r.elevation = e0 + (e1 - e0) * u;
    r.lensMm = s.lensMm;
    const std::vector<Vec3> pts = corners(subject(s, frame));
    const Vec3 centred = composedTarget(pts, r.azimuth, r.elevation, {}, 1, r.lensMm, shape);
    r.distance = fitDistance(pts, centred, r.azimuth, r.elevation, r.lensMm, shape, kFill[static_cast<int>(s.size)]);
    if (s.move.kind == MoveKind::Push && s.move.amount > 0) r.distance *= 1 + (s.move.amount - 1) * u;
    Vec3 lead;
    if (s.move.kind == MoveKind::Follow && s.subject.flight >= 0) {
      const int last = beats.frames;
      lead = middle(flyingBox(t, plan, world, s.subject.flight, std::min(frame + 1, last))) - middle(flyingBox(t, plan, world, s.subject.flight, std::max(frame - 1, 0)));
    }
    r.target = composedTarget(pts, r.azimuth, r.elevation, lead, r.distance, r.lensMm, shape);
    return r;
  }

  bool clear(Vec3 eye, int frame) const {
    if (eye.y > floorY - kEyeClearance) return false;
    Box around;
    around.grow(eye - Vec3{kEyeClearance, kEyeClearance, kEyeClearance}), around.grow(eye + Vec3{kEyeClearance, kEyeClearance, kEyeClearance});
    std::vector<uint32_t> near;
    world.near(around, nullptr, near);
    for (uint32_t q : near)
      if (landed[q] <= frame && boxDistance(eye, world.box(q)) < kEyeClearance) return false;
    return true;
  }

  /// The rig moved, as little as will do, until its eye is clear: round the target, then up,
  /// then back.
  Rig avoid(Rig r, int frame) const {
    if (clear(eyeOf(r), frame)) return r;
    for (int k = 1; k <= kAvoidSteps; k++)
      for (double sign : {1.0, -1.0}) {
        Rig x = r;
        x.azimuth += sign * k * kAvoidStep;
        if (clear(eyeOf(x), frame)) return x;
      }
    for (int k = 1; k <= kAvoidSteps; k++) {
      Rig x = r;
      x.elevation = std::min(1.5, r.elevation + k * kAvoidStep);
      if (clear(eyeOf(x), frame)) return x;
    }
    for (int k = 0; k < 60 && !clear(eyeOf(r), frame); k++) r.distance *= 1.1;
    return r;
  }

  int shotAt(int frame) const {
    const double time = frame / fps;
    for (size_t i = 0; i < shots.size(); i++)
      if (time < shots[i].end) return static_cast<int>(i);
    return static_cast<int>(shots.size()) - 1;
  }

  Track run() {
    Track out;
    out.shape = shape, out.fps = fps;
    const int n = beats.frames + 1;
    std::vector<Rig> rigs(static_cast<size_t>(n));
    std::vector<int> which(static_cast<size_t>(n));
    std::vector<uint8_t> cut(static_cast<size_t>(n), 0);
    for (int f = 0; f < n; f++) {
      const int i = shotAt(f);
      const Shot& s = shots[static_cast<size_t>(i)];
      Rig r = solve(s, f);
      const double into = f / fps - s.start;
      if (i > 0 && s.enter == EnterKind::Blend && into < s.blendSeconds) r = mix(solve(shots[static_cast<size_t>(i - 1)], f), r, ease(into / std::max(1e-9, s.blendSeconds)));
      rigs[static_cast<size_t>(f)] = avoid(r, f);
      which[static_cast<size_t>(f)] = i;
      cut[static_cast<size_t>(f)] = f > 0 && i != which[static_cast<size_t>(f - 1)] && s.enter == EnterKind::Cut;
    }
    // Smoothed between cuts: a centred average, twice, the edge frame standing in past each end of a
    // segment, so the ends are smoothed as fully as the middle.
    const int half = std::max(1, static_cast<int>(std::lround(kSmoothSeconds * fps / 2)));
    for (int pass = 0; pass < 2; pass++) {
      int from = 0;
      for (int f = 1; f <= n; f++) {
        if (f < n && !cut[static_cast<size_t>(f)]) continue;
        // Unwrapped azimuths, so averaging never goes the long way round.
        std::vector<Rig> seg(rigs.begin() + from, rigs.begin() + f);
        for (size_t k = 1; k < seg.size(); k++) seg[k].azimuth = seg[k - 1].azimuth + wrap(seg[k].azimuth - seg[k - 1].azimuth);
        const int len = f - from;
        for (int k = 0; k < len; k++) {
          const int w = half;
          Rig sum = seg[static_cast<size_t>(k)];
          sum.target = {}, sum.azimuth = sum.elevation = sum.distance = sum.roll = sum.lensMm = 0;
          for (int j = k - w; j <= k + w; j++) {
            const Rig& x = seg[static_cast<size_t>(std::clamp(j, 0, len - 1))];
            sum.target = sum.target + x.target, sum.azimuth += x.azimuth, sum.elevation += x.elevation, sum.distance += x.distance, sum.roll += x.roll, sum.lensMm += x.lensMm;
          }
          const double c = 2.0 * w + 1;
          Rig& r = rigs[static_cast<size_t>(from + k)];
          r.target = sum.target * (1 / c), r.azimuth = sum.azimuth / c, r.elevation = sum.elevation / c, r.distance = sum.distance / c, r.roll = sum.roll / c, r.lensMm = sum.lensMm / c;
        }
        from = f;
      }
    }
    out.frames.resize(static_cast<size_t>(n));
    for (int f = 0; f < n; f++) {
      Rig r = rigs[static_cast<size_t>(f)];
      for (int k = 0; k < 60 && !clear(eyeOf(r), f); k++) r.distance *= 1.02;  // smoothing must not bring it back in
      Frame& fr = out.frames[static_cast<size_t>(f)];
      fr.eye = eyeOf(r), fr.target = r.target, fr.up = upOf(r);
      fr.fovY = fovY(r.lensMm, shape.sensorMm);
      fr.focus = r.distance, fr.aperture = kFocusAperture, fr.shutter = kShutter;
      fr.shot = which[static_cast<size_t>(f)], fr.cut = cut[static_cast<size_t>(f)] != 0;
    }
    return out;
  }
};

}  // namespace

Track shoot(const std::vector<Shot>& shots, const Beats& beats, const plan::Timeline& timeline, const plan::Plan& plan, const collide::World& world, const FrameShape& shape,
            double fps, double front) {
  if (shots.empty()) {
    Track t;
    t.shape = shape, t.fps = fps;
    return t;
  }
  return Body(shots, beats, timeline, plan, world, shape, fps, front).run();
}

Frame cameraAt(const Track& track, double frame) {
  if (track.frames.empty()) return {};
  if (!(frame > 0)) return track.frames.front();
  const size_t i = static_cast<size_t>(std::floor(frame));
  if (i + 1 >= track.frames.size()) return track.frames.back();
  const Frame &a = track.frames[i], &b = track.frames[i + 1];
  if (b.cut) return a;
  const double w = frame - static_cast<double>(i);
  Frame out = a;
  out.eye = a.eye + (b.eye - a.eye) * w;
  out.target = a.target + (b.target - a.target) * w;
  out.up = normalized(a.up + (b.up - a.up) * w);
  out.fovY = a.fovY + (b.fovY - a.fovY) * w;
  out.focus = a.focus + (b.focus - a.focus) * w;
  return out;
}

Rig rigOf(const Frame& f, double sensorMm) {
  Rig r;
  const Vec3 d = f.target - f.eye;
  r.target = f.target;
  r.distance = length(d);
  const Vec3 v = r.distance > 0 ? d * (1 / r.distance) : Vec3{0, 0, 1};
  r.elevation = std::asin(std::clamp(v.y, -1.0, 1.0));
  r.azimuth = std::atan2(v.x, v.z);
  r.lensMm = std::max(1.0, sensorMm) / (2 * std::tan(f.fovY / 2));
  return r;
}

}  // namespace bm::film
