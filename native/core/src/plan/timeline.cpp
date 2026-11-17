#include "bm/plan/timeline.h"

#include <algorithm>
#include <cmath>
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
  for (uint32_t mi = 0; mi < plan.moves.size(); mi++) {
    const Move& m = plan.moves[mi];
    Flight f;
    f.move = mi;
    f.startFrame = frame;
    Box box;
    for (uint32_t p : m.unit.pieces) box.merge(boxes[p]);
    if (m.flag != Flag::None || m.path.empty() || box.empty()) {
      f.waypoints = {Xform{}};
      f.at = {1};
      out.flights.push_back(std::move(f));
      continue;
    }
    // Its spot on the floor.
    double lo, hi, depthLo, depthHi, top, bottom;
    span(box, along, lo, hi);
    span(box, away, depthLo, depthHi);
    span(box, down, top, bottom);
    const double width = hi - lo + kExitMargin, depth = depthHi - depthLo + kExitMargin;
    if (cursor > 0 && cursor + width > rowLength) cursor = 0, rowAway += rowDepth, rowDepth = 0;
    const Vec3 move = along * (alongLo + cursor - lo) + away * (rowAway - depthLo) + down * (floor - bottom);
    cursor += width;
    rowDepth = std::max(rowDepth, depth);
    f.staging = shifted(move);
    // Up, across above everything, down to where the plan's path begins, then the path.
    const Vec3 open = m.path.back().t;
    const double clearance = (floorLo - kExitMargin) - top;  // along `down`: negative is up
    auto raised = [&](Vec3 t) { return t + down * (std::min(clearance, dot(t, down)) - dot(t, down)); };
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
    f.frames = perFlight;
    frame += perFlight;
    out.flights.push_back(std::move(f));
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
    for (uint32_t p : plan.moves[out.flights[fi].move].unit.pieces) seat.merge(boxes[p]);
    const Vec3 target = seat.empty() ? centre : centre * 0.7 + (seat.min + seat.max) * 0.15;
    const double progress = out.frames > 0 ? static_cast<double>(at) / out.frames : 0;
    out.camera.push_back({at, target, 2.4 * radius + 100, 0.7854 + 1.5708 * progress, 0.4363});
  }
  return out;
}

Xform poseAt(const Flight& f, int frame) {
  if (f.waypoints.empty()) return {};
  if (f.frames <= 0 || frame >= f.startFrame + f.frames) return f.waypoints.back();
  if (frame <= f.startFrame) return f.waypoints.front();
  const double u = static_cast<double>(frame - f.startFrame) / f.frames;
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
