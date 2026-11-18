#include "bm/plan/timeline.h"

#include <algorithm>
#include <cmath>
#include <functional>
#include <numeric>
#include "bm/plan/tolerances.h"

namespace bm::plan {
namespace {

Xform shifted(Vec3 by) {
  Xform x;
  x.t = by;
  return x;
}

}  // namespace

Timeline buildTimeline(const Model& model, ldraw::PartCache& parts, const Plan& plan, const Style& style, Vec3 down) {
  Timeline out;
  if (plan.moves.empty()) return out;
  down = length(down) > 0 ? normalized(down) : Vec3{0, 1, 0};
  const auto& pieces = model.pieces();
  std::vector<Box> boxes(pieces.size());
  Box all;
  for (size_t i = 0; i < pieces.size(); i++) {
    boxes[i] = model.mesh(pieces[i].part, parts)->bounds.transformed(pieces[i].world);
    all.merge(boxes[i]);
  }
  if (all.empty()) return out;
  // Along the floor: `along` runs beside the model, `away` leads out from it.
  const Vec3 along = normalized(cross(down, std::abs(down.x) < 0.9 ? Vec3{1, 0, 0} : Vec3{0, 0, 1})), away = cross(down, along);
  auto span = [](const Box& b, Vec3 d, double& lo, double& hi) {
    lo = std::numeric_limits<double>::infinity(), hi = -lo;
    for (int c = 0; c < 8; c++) {
      const double v = dot(d, Vec3{c & 1 ? b.max.x : b.min.x, c & 2 ? b.max.y : b.min.y, c & 4 ? b.max.z : b.min.z});
      lo = std::min(lo, v), hi = std::max(hi, v);
    }
  };
  double floorLo, floor, alongLo, alongHi, awayLo, awayHi;
  span(all, down, floorLo, floor);
  span(all, along, alongLo, alongHi);
  span(all, away, awayLo, awayHi);
  const double rowLength = std::max(alongHi - alongLo, 200.0);
  double cursor = 0, rowAway = awayHi + 2 * kExitMargin, rowDepth = 0;
  const int perFlight = std::max(1, static_cast<int>(std::lround(style.fps / std::max(0.01, style.piecesPerSecond) * std::max(0.01, style.time))));
  int frame = 0;
  // A unit's spot on the floor: its motion from its seat, in the model.
  auto spotFor = [&](const Box& box) {
    double lo, hi, depthLo, depthHi, top, bottom;
    span(box, along, lo, hi);
    span(box, away, depthLo, depthHi);
    span(box, down, top, bottom);
    const double width = hi - lo + kExitMargin, depth = depthHi - depthLo + kExitMargin;
    if (cursor > 0 && cursor + width > rowLength) cursor = 0, rowAway += rowDepth, rowDepth = 0;
    const Vec3 move = along * (alongLo + cursor - lo) + away * (rowAway - depthLo) + down * (floor - bottom);
    cursor += width;
    rowDepth = std::max(rowDepth, depth);
    return move;
  };
  // One move's flight. `base` is where the unit it helps build stands while it is built (zero at
  // the top): the flight's poses are motions from its seat in that unit, which carries them. A
  // unit that is built of moves of its own (Move::sub) is first built there, piece by piece, on
  // its own spot on the floor, and then flies in whole.
  std::function<void(const Plan&, uint32_t, int, Vec3, uint32_t, int)> fly = [&](const Plan& p, uint32_t mi, int parent, Vec3 base, uint32_t top, int level) {
    const Move& m = p.moves[mi];
    Flight f;
    f.move = top;
    f.parent = parent;
    f.depth = level;
    f.pieces = m.unit.pieces;
    f.flag = m.flag;
    f.insertion = m.insertion;
    f.seatTravel = m.seatTravel;
    Box box;
    for (uint32_t q : m.unit.pieces) box.merge(boxes[q]);
    if (m.flag != Flag::None || m.path.empty() || box.empty()) {
      f.startFrame = frame;
      f.waypoints = {Xform{}};
      f.at = {1};
      out.flights.push_back(std::move(f));
      return;
    }
    const Vec3 spot = spotFor(box);  // in the model
    const Vec3 move = spot - base;   // from its seat in the unit it helps build
    f.staging = shifted(move);
    const int self = static_cast<int>(out.flights.size());
    out.flights.push_back(Flight{});  // its place, filled in once its own build is laid out
    if (m.sub >= 0 && static_cast<size_t>(m.sub) < p.subs.size() && level < 8) {
      const Plan& sub = p.subs[static_cast<size_t>(m.sub)];
      for (uint32_t k = 0; k < sub.moves.size(); k++) fly(sub, k, self, spot, top, level + 1);
    }
    f.startFrame = frame;
    // Up, across above everything, down to where the plan's path begins, then the path.
    double unitTop, bottom;
    span(box, down, unitTop, bottom);
    const Vec3 open = m.path.back().t;
    const double clearance = (floorLo - kExitMargin) - bottom;  // along `down`: the unit's underside a margin above everything
    auto raised = [&](Vec3 t) {
      const double at = dot(t + base, down);
      return t + down * (std::min(clearance, at) - at);
    };
    f.waypoints = {f.staging, shifted(raised(move)), shifted(raised(open))};
    for (size_t k = m.path.size(); k-- > 0;) f.waypoints.push_back(m.path[k]);
    // Time by distance, except the last leg, which is the landing.
    std::vector<double> lengths;
    double total = 0;
    for (size_t k = 0; k + 2 < f.waypoints.size(); k++) lengths.push_back(length(f.waypoints[k + 1].t - f.waypoints[k].t)), total += lengths.back();
    const double landing = std::clamp(style.landing, 0.0, 0.9), hover = std::clamp(style.hover, 0.0, 0.9 - landing);
    const double travel = 1 - landing - hover;
    double sum = 0;
    f.at.push_back(0);
    for (double l : lengths) {
      sum += l;
      f.at.push_back(total > 0 ? travel * sum / total : travel);
    }
    // It holds still where the last leg begins, then lands.
    if (hover > 0 && f.waypoints.size() >= 2) {
      f.waypoints.insert(f.waypoints.end() - 1, f.waypoints[f.waypoints.size() - 2]);
      f.at.push_back(travel + hover);
    }
    f.at.push_back(1);  // the seat
    // The open air, flown as one: its own two corners (over the staging spot, over the way in)
    // rounded, then the planner's legs as they are, up to the hover.
    f.hoverAt = static_cast<uint32_t>(f.waypoints.size() - (hover > 0 ? 3 : 2));
    bool turns = false;
    for (const Xform& w : f.waypoints)
      for (int i = 0; i < 9; i++) turns = turns || std::abs(w.r.m[i] - Mat3::identity().m[i]) > 1e-9;  // an author's flight that turns: legs as they are
    if (!turns && f.hoverAt >= 1 && f.at[f.hoverAt] > 0) {
      f.air.push_back(f.waypoints[0].t), f.airLeg.push_back(0);
      for (uint32_t k = 1; k <= f.hoverAt; k++) {
        const Vec3 c = f.waypoints[k].t;
        if (k <= 2 && k < f.hoverAt) {
          const Vec3 in = c - f.waypoints[k - 1].t, out = f.waypoints[k + 1].t - c;
          const double li = length(in), lo = length(out), r = std::min({style.corner, 0.4 * li, 0.4 * lo});
          if (r > 0.5) {
            const Vec3 from = c - in * (r / li), to = c + out * (r / lo);
            const int n = std::max(2, static_cast<int>(std::ceil(2 * r)));  // about a point an LDU
            for (int i = 0; i <= n; i++) {
              const double s = static_cast<double>(i) / n;
              f.air.push_back(from * ((1 - s) * (1 - s)) + c * (2 * s * (1 - s)) + to * (s * s)), f.airLeg.push_back(k);
            }
            continue;
          }
        }
        f.air.push_back(c), f.airLeg.push_back(k);
      }
      double along = 0;
      f.airAt.push_back(0);
      for (size_t i = 1; i < f.air.size(); i++) along += length(f.air[i] - f.air[i - 1]), f.airAt.push_back(along);
      if (!(along > 0)) f.air.clear(), f.airAt.clear(), f.airLeg.clear();
    }
    f.frames = perFlight;
    f.pathAt = f.at.size() > 2 ? f.at[2] * perFlight : 0;
    f.seatAt = f.at.size() >= 2 ? f.at[f.at.size() - 2] * perFlight : 0;
    frame += perFlight;
    out.flights[static_cast<size_t>(self)] = std::move(f);
  };
  for (uint32_t mi = 0; mi < plan.moves.size(); mi++) fly(plan, mi, -1, Vec3{}, mi, 0);
  // In the order they are played; a unit's place follows its own build.
  {
    std::vector<size_t> order(out.flights.size());
    std::iota(order.begin(), order.end(), size_t{0});
    std::stable_sort(order.begin(), order.end(), [&](size_t a, size_t b) { return out.flights[a].startFrame < out.flights[b].startFrame; });
    std::vector<int> at(order.size());
    for (size_t i = 0; i < order.size(); i++) at[order[i]] = static_cast<int>(i);
    std::vector<Flight> sorted;
    sorted.reserve(order.size());
    for (size_t i : order) {
      Flight f = std::move(out.flights[i]);
      if (f.parent >= 0) f.parent = at[static_cast<size_t>(f.parent)];
      sorted.push_back(std::move(f));
    }
    out.flights = std::move(sorted);
  }
  out.frames = frame;
  // A camera that follows the build: one key a second, looking at what is being placed.
  const double radius = 0.5 * length(all.max - all.min);
  const Vec3 centre = (all.min + all.max) * 0.5;
  const int second = std::max(1, static_cast<int>(std::lround(style.fps)));
  size_t fi = 0;
  for (int at = 0; at <= out.frames; at += second) {
    while (fi + 1 < out.flights.size() && out.flights[fi].startFrame + out.flights[fi].frames < at) fi++;
    Box seat;
    for (uint32_t p : out.flights[fi].pieces) seat.merge(boxes[p]);
    const Vec3 target = seat.empty() ? centre : centre * 0.7 + (seat.min + seat.max) * 0.15;
    const double progress = out.frames > 0 ? static_cast<double>(at) / out.frames : 0;
    out.camera.push_back({at, target, 2.4 * radius + 100, 0.7854 + 1.5708 * progress, 0.4363});
  }
  return out;
}

Xform motionAt(const Timeline& t, size_t flight, double frame) {
  Xform x = poseAt(t.flights[flight], frame);
  for (int up = t.flights[flight].parent, guard = 0; up >= 0 && static_cast<size_t>(up) < t.flights.size() && guard < 64; up = t.flights[static_cast<size_t>(up)].parent, guard++)
    x = poseAt(t.flights[static_cast<size_t>(up)], frame) * x;
  return x;
}

const std::vector<uint32_t>& piecesOf(const Flight& f, const Plan& plan) {
  static const std::vector<uint32_t> none;
  if (!f.pieces.empty()) return f.pieces;
  return f.move < plan.moves.size() ? plan.moves[f.move].unit.pieces : none;
}

bool shownAt(const Flight& f, double frame) {
  const bool flies = f.frames > 0 && !f.waypoints.empty();
  return frame >= (flies ? f.appearFrame : f.startFrame);
}

std::vector<int> owners(const Timeline& t, const Plan& plan, size_t n) {
  std::vector<int> owner(n, -1);
  for (size_t fi = 0; fi < t.flights.size(); fi++)
    for (uint32_t p : piecesOf(t.flights[fi], plan))
      if (p < n && (owner[p] < 0 || t.flights[static_cast<size_t>(owner[p])].depth < t.flights[fi].depth)) owner[p] = static_cast<int>(fi);
  return owner;
}

Xform poseAt(const Flight& f, int frame) { return poseAt(f, static_cast<double>(frame)); }

Xform poseAt(const Flight& f, double frame) {
  if (f.waypoints.empty()) return {};
  if (f.frames <= 0 || frame >= f.startFrame + f.frames) return f.waypoints.back();
  if (frame <= f.startFrame) return f.waypoints.front();
  const double u = (frame - f.startFrame) / f.frames;
  if (!f.air.empty() && f.hoverAt < f.at.size() && u < f.at[f.hoverAt]) {
    double v = u / f.at[f.hoverAt];
    v = v * v * (3 - 2 * v);  // one ease in, one ease out over the whole of the open air
    const double s = v * f.airAt.back();
    const size_t i = std::min<size_t>(f.air.size() - 2, static_cast<size_t>(std::upper_bound(f.airAt.begin(), f.airAt.end(), s) - f.airAt.begin()) - 1);
    const double span = f.airAt[i + 1] - f.airAt[i], w = span > 0 ? (s - f.airAt[i]) / span : 1;
    Xform x = f.waypoints[std::min<size_t>(f.airLeg[i + 1], f.waypoints.size() - 1)];
    x.t = f.air[i] + (f.air[i + 1] - f.air[i]) * w;
    return x;
  }
  for (size_t k = 0; k + 1 < f.waypoints.size() && k + 1 < f.at.size(); k++) {
    if (u > f.at[k + 1]) continue;
    const double spanU = f.at[k + 1] - f.at[k];
    double v = spanU > 0 ? (u - f.at[k]) / spanU : 1;
    v = v * v * (3 - 2 * v);  // ease in and out of every leg
    Xform x = f.waypoints[k + 1];
    x.t = f.waypoints[k].t + (f.waypoints[k + 1].t - f.waypoints[k].t) * v;
    return x;
  }
  return f.waypoints.back();
}

std::vector<Vec3> playedPath(const Flight& f, double spacing) {
  (void)spacing;  // the rounded corners are already flown as points about an LDU apart, as poseAt plays them
  std::vector<Vec3> out;
  auto add = [&](Vec3 t) {
    if (out.empty() || length(t - out.back()) > 1e-9) out.push_back(t);
  };
  if (!f.air.empty()) {
    for (const Vec3& t : f.air) add(t);
    for (size_t k = f.hoverAt + 1; k < f.waypoints.size(); k++) add(f.waypoints[k].t);
  } else {
    for (const Xform& w : f.waypoints) add(w.t);
  }
  return out;
}

namespace {
nlohmann::json planJson(const Plan& plan, const Certificate* cert, const Model& model) {
  nlohmann::json moves = nlohmann::json::array();
  for (size_t i = 0; i < plan.moves.size(); i++) {
    const Move& m = plan.moves[i];
    nlohmann::json j;
    for (uint32_t p : m.unit.pieces) {
      j["pieces"].push_back(model.pieces()[p].id);
      j["parts"].push_back(model.pieces()[p].part);
    }
    j["source"] = name(m.source);
    j["insertion"] = {m.insertion.x, m.insertion.y, m.insertion.z};
    j["seatTravel"] = m.seatTravel;
    j["path"] = nlohmann::json::array();
    for (const Xform& x : m.path) j["path"].push_back({x.t.x, x.t.y, x.t.z});
    j["flag"] = name(m.flag);
    if (m.blocker != UINT32_MAX) j["blocker"] = model.pieces()[m.blocker].id;
    if (m.sub >= 0) j["sub"] = m.sub;
    if (cert && i < cert->moves.size()) {
      const MoveCheck& c = cert->moves[i];
      j["certified"] = c.certified();
      if (!c.certified() && !c.flagged) j["failed"] = {{"joined", c.joined}, {"clear", c.clear}, {"alongConnector", c.alongConnector}};
    }
    moves.push_back(std::move(j));
  }
  nlohmann::json out;
  out["moves"] = std::move(moves);
  out["subs"] = nlohmann::json::array();
  for (size_t i = 0; i < plan.subs.size(); i++) out["subs"].push_back(planJson(plan.subs[i], cert && i < cert->subs.size() ? &cert->subs[i] : nullptr, model));
  return out;
}
}  // namespace

nlohmann::json toJson(const Plan& plan, const Certificate* cert, const Model& model) {
  nlohmann::json out = planJson(plan, cert, model);
  out["format"] = "brickmotion-native-plan";
  out["version"] = 1;
  out["sweep"] = "continuous 0.001";  // legs are checked along their length, to collide::kCrossingResolution
  out["planMs"] = plan.planMs;
  out["complete"] = plan.complete;
  out["notes"] = plan.notes;
  if (cert) out["certificate"] = {{"moves", cert->total}, {"certified", cert->certified}, {"floating", cert->floating}, {"crossings", cert->crossings}, {"offAxis", cert->offAxis}, {"flagged", cert->flagged}, {"unjoined", cert->unjoined}};
  return out;
}

nlohmann::json toJson(const Timeline& t) {
  nlohmann::json out;
  out["frames"] = t.frames;
  out["flights"] = nlohmann::json::array();
  for (const Flight& f : t.flights) {
    nlohmann::json j{{"move", f.move}, {"startFrame", f.startFrame}, {"frames", f.frames}, {"at", f.at}};
    for (const Xform& x : f.waypoints) j["waypoints"].push_back({x.t.x, x.t.y, x.t.z});
    out["flights"].push_back(std::move(j));
  }
  out["camera"] = nlohmann::json::array();
  for (const CameraKey& k : t.camera) out["camera"].push_back({{"frame", k.frame}, {"target", {k.target.x, k.target.y, k.target.z}}, {"distance", k.distance}, {"azimuth", k.azimuth}, {"elevation", k.elevation}});
  return out;
}

}  // namespace bm::plan
