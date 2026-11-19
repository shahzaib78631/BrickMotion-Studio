#include "bmf/director.h"
#include <algorithm>
#include <cmath>
#include "bmf/lens.h"
#include "bmf/tolerances.h"

namespace bm::film {

DirectorStyle referenceStyle() {
  constexpr double d = M_PI / 180;
  return {60 * d, 15 * d, 10 * d, 0.8, 0.6, 50};
}

namespace {

Vec3 middle(const Box& b) { return (b.min + b.max) * 0.5; }
double wrap(double a) { return std::remainder(a, 2 * M_PI); }

/// One camera angle: a run of flights that land on one side, or a unit built on its spot.
struct Scene {
  int launch = 0, land = 0;  ///< frames: its first flight leaves, its last lands
  std::vector<int> flights;  ///< what it shows landing (a unit's: the flights inside it)
  Box seats;
  Vec3 sum;        ///< the seats' middles added up, and how many: where on the model it lands
  int count = 0;
  int unit = -1;  ///< a unit built on its spot: the unit's own flight
};

struct Director {
  const Beats& beats;
  const plan::Timeline& t;
  const plan::Plan& plan;
  const collide::World& world;
  const DirectorStyle& style;
  double fps, front;
  std::vector<int> landed;  ///< frame each piece is at rest in its seat (INT32_MAX: never)
  Vec3 centre;
  double radius = 1, height = 1;  ///< height: what it has reached by the cut to the front, where the descent ends

  Director(const Beats& b, const plan::Timeline& t_, const plan::Plan& p, const collide::World& w, const DirectorStyle& s, double f, double fr)
      : beats(b), t(t_), plan(p), world(w), style(s), fps(f), front(fr) {
    landed.assign(world.size(), INT32_MAX);
    for (const plan::Flight& fl : t.flights)
      if (fl.parent < 0)
        for (uint32_t piece : plan::piecesOf(fl, plan)) landed[piece] = std::min(landed[piece], fl.startFrame + fl.frames);
    if (!b.model.empty()) {
      centre = middle(b.model);
      radius = std::max(1.0, std::hypot(b.model.max.x - b.model.min.x, b.model.max.z - b.model.min.z) / 2);
      height = std::max(1.0, b.model.max.y - b.model.min.y);
    }
  }

  /// The way round the model (azimuth, absolute) that faces what lands around `c` (the middle of
  /// a scene's seats, on average); NaN: no side.
  double sideOf(Vec3 c) const {
    const double x = c.x - centre.x, z = c.z - centre.z;
    if (std::hypot(x, z) < kNoSide * radius) return NAN;
    return std::atan2(-x, -z);  // the eye at -sin(a), -cos(a) is on that side
  }

  double elevationAt(double frame) const {
    const int f = std::clamp(static_cast<int>(std::lround(frame)), 0, beats.frames);
    const Box& b = beats.builtBox[static_cast<size_t>(f)];
    const double h = b.empty() ? 0 : std::clamp((b.max.y - b.min.y) / height, 0.0, 1.0);
    return style.elStart + (style.elEnd - style.elStart) * h;
  }

  /// The angle (absolute azimuth) a scene is filmed from: the most of its seats in view, toward
  /// its side, not far from the angle before.
  double chooseAzimuth(const Scene& sc, double before) const {
    std::vector<std::pair<Vec3, int>> points;  // seat point, and the flight it is of
    for (int f : sc.flights) {
      const Box s = flyingBox(t, plan, world, f, t.flights[static_cast<size_t>(f)].startFrame + t.flights[static_cast<size_t>(f)].frames);
      points.push_back({middle(s), f});
      for (Vec3 c : corners(s)) points.push_back({c, f});
    }
    if (points.size() > static_cast<size_t>(kVisibilityPoints)) {
      std::vector<std::pair<Vec3, int>> kept;
      for (int i = 0; i < kVisibilityPoints; i++) kept.push_back(points[points.size() * static_cast<size_t>(i) / static_cast<size_t>(kVisibilityPoints)]);
      points.swap(kept);
    }
    const double side = sc.count ? sideOf(sc.sum * (1.0 / sc.count)) : NAN, el = elevationAt(sc.land);
    const Box& built = beats.builtBox[static_cast<size_t>(std::clamp(sc.land, 0, beats.frames))];
    const Box subject = built.empty() ? sc.seats : built;
    double best = before, bestScore = -1e300;
    std::vector<uint32_t> near;
    for (int k = 0; k < kCoverageAzimuths; k++) {
      const double az = front + 2 * M_PI * k / kCoverageAzimuths;
      Rig rig{middle(subject), az, el, 0};
      rig.distance = fitDistance(corners(subject), rig.target, az, el, style.lensMm, FrameShape{}, kFill[0]);
      const Vec3 eye = eyeOf(rig);
      int seen = 0;
      for (const auto& [p, f] : points) {
        const Vec3 end = p + (eye - p) * 0.03;  // stop short of its own surface
        Box span;
        span.grow(eye), span.grow(end);
        near.clear();
        world.near(span, nullptr, near);
        const auto& own = plan::piecesOf(t.flights[static_cast<size_t>(f)], plan);
        bool hidden = false;
        for (uint32_t q : near) {
          if (landed[q] > t.flights[static_cast<size_t>(f)].startFrame + t.flights[static_cast<size_t>(f)].frames || std::find(own.begin(), own.end(), q) != own.end()) continue;
          if (blocks(world, q, eye, end)) {
            hidden = true;
            break;
          }
        }
        seen += hidden ? 0 : 1;
      }
      double score = points.empty() ? 0 : double(seen) / double(points.size());
      if (!std::isnan(side)) score += kSidePull * std::cos(az - side);
      score -= kStayPull * (1 - std::cos(az - before));
      if (score > bestScore + 1e-12) bestScore = score, best = az;
    }
    return best;
  }

  std::vector<Scene> scenes() const {
    struct Item {
      int start;
      int flight;  // a top-level flight, or a unit build (unit >= 0)
      bool unit;
    };
    std::vector<Item> items;
    for (const Beat& b : beats.list) {
      if (b.kind == BeatKind::UnitBuild) items.push_back({b.start, b.flight, true});
      if (b.kind == BeatKind::Flight && t.flights[static_cast<size_t>(b.flight)].parent < 0) items.push_back({b.start, b.flight, false});
    }
    std::stable_sort(items.begin(), items.end(), [](const Item& a, const Item& b) { return a.start < b.start; });
    std::vector<Scene> out;
    for (const Item& it : items) {
      const plan::Flight& f = t.flights[static_cast<size_t>(it.flight)];
      if (it.unit) {
        Scene sc;
        sc.unit = it.flight;
        sc.launch = INT32_MAX, sc.land = 0;
        for (size_t k = 0; k < t.flights.size(); k++)
          if (t.flights[k].parent == it.flight) {
            sc.flights.push_back(static_cast<int>(k));
            sc.launch = std::min(sc.launch, t.flights[k].startFrame), sc.land = std::max(sc.land, t.flights[k].startFrame + t.flights[k].frames);
            const Box spot = flyingBox(t, plan, world, static_cast<int>(k), t.flights[k].startFrame + t.flights[k].frames);
            sc.seats.merge(spot), sc.sum = sc.sum + middle(spot), sc.count++;
          }
        out.push_back(sc);
        continue;
      }
      const Box seat = flyingBox(t, plan, world, it.flight, f.startFrame + f.frames);
      bool join = !out.empty() && out.back().unit < 0;
      if (join) {
        const Scene& cur = out.back();
        const double a = cur.count ? sideOf(cur.sum * (1.0 / cur.count)) : NAN, b = sideOf(middle(seat));
        const bool sameSide = std::isnan(a) || std::isnan(b) || std::abs(wrap(a - b)) <= kSceneSpread;
        join = sameSide || (cur.land - cur.launch) / fps < kMinSceneSeconds;
      }
      if (!join) {
        out.push_back({});
        out.back().launch = f.startFrame;
      }
      Scene& sc = out.back();
      sc.flights.push_back(it.flight);
      sc.seats.merge(seat);
      sc.sum = sc.sum + middle(seat), sc.count++;
      sc.land = std::max(sc.land, f.startFrame + f.frames);
    }
    // A last scene too short to stand alone goes with the one before.
    while (out.size() > 1 && out.back().unit < 0 && out[out.size() - 2].unit < 0 && (out.back().land - out.back().launch) / fps < kMinSceneSeconds) {
      Scene last = out.back();
      out.pop_back();
      for (int f : last.flights) out.back().flights.push_back(f);
      out.back().seats.merge(last.seats);
      out.back().sum = out.back().sum + last.sum, out.back().count += last.count;
      out.back().land = std::max(out.back().land, last.land);
    }
    return out;
  }

  /// Sets a main shot's elevation and crane from how tall the model is at its start and end.
  void craneOf(Shot& s) const {
    if (s.subject.kind == SubjectKind::Unit) {  // from the height of its moment, held: it grows apart from the model
      s.elevation = elevationAt(s.start * fps);
      return;
    }
    if (s.subject.kind != SubjectKind::BuiltSoFar) return;
    s.elevation = elevationAt(s.start * fps);
    s.move = {MoveKind::Crane, elevationAt(s.end * fps) - s.elevation};
  }

  std::vector<Shot> run() {
    const double length = beats.frames / fps;
    int lastLanding = 0;
    for (const plan::Flight& f : t.flights) lastLanding = std::max(lastLanding, f.startFrame + f.frames);
    std::vector<Shot> shots;
    double az = front;
    for (const Scene& sc : scenes()) {
      Shot s;
      az = chooseAzimuth(sc, az);
      s.azimuth = wrap(az - front);
      s.lensMm = style.lensMm;
      if (sc.unit >= 0) {
        s.subject = {SubjectKind::Unit, sc.unit, {}};
        s.size = Size::Medium;
      } else {
        s.subject = {SubjectKind::BuiltSoFar, -1, {}};
        s.size = Size::Wide;
      }
      if (shots.empty()) {
        s.start = 0, s.enter = EnterKind::Cut;
      } else {
        s.start = std::max(sc.launch / fps - kAnticipateSeconds - kBlendSeconds, shots.back().start + kMinShotSeconds);
        s.enter = EnterKind::Blend, s.blendSeconds = kBlendSeconds;
      }
      shots.push_back(s);
    }
    if (shots.empty()) {
      Shot s;
      s.subject = {SubjectKind::BuiltSoFar, -1, {}};
      s.lensMm = style.lensMm;
      shots.push_back(s);
    }

    // The finish: a cut to the front for the last details, arcing onto it.
    Shot finish;
    finish.subject = {SubjectKind::Model, -1, {}};
    finish.size = Size::Medium;
    finish.azimuth = 0, finish.elevation = style.finishEl;
    finish.move = {MoveKind::ArcReveal, kRevealArc};
    finish.lensMm = style.lensMm;
    finish.enter = EnterKind::Cut;
    if (length < 2 * kMinShotSeconds) {
      finish.start = length / 2;
      shots.resize(1);
    } else {
      finish.start = std::clamp(style.cutAt * lastLanding / fps, kMinShotSeconds, length - kMinShotSeconds);
      while (shots.size() > 1 && shots.back().start > finish.start - kMinShotSeconds) shots.pop_back();
      finish.start = std::max(finish.start, shots.back().start + kMinShotSeconds);
    }
    finish.end = length;
    // The descent ends where the cut to the front comes: as tall as the model is by then.
    const Box& atCut = beats.builtBox[static_cast<size_t>(std::clamp(static_cast<int>(std::lround(finish.start * fps)), 0, beats.frames))];
    if (!atCut.empty()) height = std::max(1.0, atCut.max.y - atCut.min.y);
    for (size_t i = 0; i < shots.size(); i++) shots[i].end = i + 1 < shots.size() ? shots[i + 1].start : finish.start;
    shots.push_back(finish);
    for (Shot& s : shots) craneOf(s);

    // A cut that breaks a rule comes in as a move instead.
    for (Shot& s : shots) s.id = shotId(s);
    if (shots.size() > 1 && !checkEditing(shots, beats, fps, front).empty()) {
      Shot& f = shots.back();
      bool broke = false;
      for (const RuleMiss& m : checkEditing(shots, beats, fps, front)) broke |= m.shot == f.id && (m.rule == "jump-cut" || m.rule == "line");
      if (broke) f.enter = EnterKind::Blend, f.blendSeconds = std::min(kBlendSeconds, f.end - f.start);
    }

    // Close shots of what matters most, where the rules allow.
    for (const Beat& b : beats.list) {
      if (b.kind != BeatKind::Flight || b.importance <= style.insertThreshold || t.flights[static_cast<size_t>(b.flight)].parent >= 0) continue;
      const double end = b.end / fps + kInsertAfter, start = end - kInsertSeconds;
      for (size_t i = 0; i < shots.size(); i++) {
        const Shot& main = shots[i];
        if (main.subject.kind != SubjectKind::BuiltSoFar || start - main.start < kMinShotSeconds || main.end - end < kMinShotSeconds) continue;
        bool placed = false;
        for (double turn : {kInsertTurn, -kInsertTurn}) {
          std::vector<Shot> trial(shots.begin(), shots.begin() + static_cast<long>(i));
          Shot before = main, insert = main, after = main;
          before.end = start;
          insert.start = start, insert.end = end, insert.subject = {SubjectKind::Piece, b.flight, {}}, insert.size = Size::Close;
          insert.azimuth = wrap(main.azimuth + turn), insert.elevation = elevationAt(start * fps), insert.move = {MoveKind::Follow, 0}, insert.enter = EnterKind::Cut;
          after.start = end, after.enter = EnterKind::Cut;
          craneOf(before), craneOf(after);
          for (Shot* s : {&before, &insert, &after}) s->id = shotId(*s), trial.push_back(*s);
          trial.insert(trial.end(), shots.begin() + static_cast<long>(i) + 1, shots.end());
          if (checkEditing(trial, beats, fps, front).size() <= checkEditing(shots, beats, fps, front).size()) {
            shots.swap(trial);
            placed = true;
            break;
          }
        }
        if (placed) break;
      }
    }
    for (Shot& s : shots) s.id = shotId(s);
    return shots;
  }
};

}  // namespace

std::vector<Shot> direct(const Beats& beats, const plan::Timeline& timeline, const plan::Plan& plan, const collide::World& world, const DirectorStyle& style, double fps, double front) {
  return Director(beats, timeline, plan, world, style, fps, front).run();
}

}  // namespace bm::film
