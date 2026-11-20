#include "animation_authoring.h"

#include <map>
#include "session_impl.h"

namespace bmapp {
namespace {

using Json = nlohmann::ordered_json;
using Chain = std::vector<bm::doc::ItemId>;

const Json& object(const Json& json, const char* key) {
  static const Json empty = Json::object();
  const auto it = json.is_object() ? json.find(key) : json.end();
  return it != json.end() && it->is_object() ? *it : empty;
}

double bounded(const Json& json, const char* key, double fallback, double low, double high) {
  if (const auto it = json.find(key); it != json.end() && it->is_number()) {
    const double value = it->get<double>();
    if (std::isfinite(value)) return std::clamp(value, low, high);
  }
  return fallback;
}

void applyMotion(AnimationAuthoring::Motion& motion, const Json& json) {
  motion.time = bounded(json, "time", motion.time, 0.25, 4);
  motion.landing = bounded(json, "landing", motion.landing, 0.1, 0.7);
  motion.hover = bounded(json, "hover", motion.hover, 0, 0.4);
  if (const auto it = json.find("ease"); it != json.end() && it->is_string())
    bm::plan::parse(it->get<std::string>(), motion.ease);
}

struct ItemLocation {
  const bm::doc::Step* step;
  const bm::doc::Item* item;
  size_t stepIndex;
};

using Scope = std::pair<Chain, size_t>;

/// Translate a hint from the item's enclosing model to the view's current model.
void transformAxis(Json& assembly, const bm::Xform& parent) {
  const auto axis = assembly.find("insertionAxis");
  if (axis == assembly.end() || !axis->is_array() || axis->size() != 3 ||
      !std::all_of(axis->begin(), axis->end(), [](const auto& v) { return v.is_number(); })) return;
  const bm::Vec3 local{(*axis)[0].get<double>(), (*axis)[1].get<double>(), (*axis)[2].get<double>()};
  const auto world = bm::normalized(parent.r * local);
  *axis = Json::array({world.x, world.y, world.z});
}

}  // namespace

AnimationAuthoring animationAuthoring(const Session& session) {
  const auto& current = session.impl();
  const auto& source = current.source;
  AnimationAuthoring out;
  if (current.base) {
    const auto& video = object(object(current.base->json, "settings"), "video");
    const auto text = [&](const char* key) {
      return video.contains(key) && video[key].is_string() ? video[key].get<std::string>() : std::string{};
    };
    bm::plan::staging::parse(text("floorStyle"), out.style.floorStyle);
    bm::plan::staging::parse(text("floorSort"), out.style.floorSort);
    bm::plan::staging::parse(text("floorSides"), out.style.floorSides);
    bm::plan::staging::parse(text("floorMatch"), out.style.floorMatch);
    out.style.floorAspect = bounded(video, "floorAspect", out.style.floorAspect, 0.25, 4);
    out.style.targetSeconds = bounded(video, "targetSeconds", 0, 0, 60 * 60);
    out.style.introSeconds = bounded(video, "introSeconds", -1, 0, 120);
    out.style.outroSeconds = bounded(video, "outroSeconds", -1, 0, 120);
    out.style.buildSeconds = bounded(video, "buildSeconds", -1, 0, 60 * 60);
    out.style.heroOrbit = video.contains("heroOrbit") && video["heroOrbit"].is_boolean() && video["heroOrbit"].get<bool>();
  }
  if (!current.model) return out;
  const auto& model = *current.model;
  const auto* visible = source.def(focusedDef(current));
  if (visible)
    for (const auto& step : visible->steps)
      out.holds.push_back(bounded(step.extra, "pauseAfter", -1, 0, 10));
  AnimationAuthoring::Motion root;
  applyMotion(root, object(source.extra, "motion"));

  std::unordered_map<bm::doc::ItemId, ItemLocation> byItem;
  auto index = [&](const bm::doc::Def& def) {
    for (size_t i = 0; i < def.steps.size(); ++i)
      for (const auto& item : def.steps[i].items) byItem.emplace(item.id, ItemLocation{&def.steps[i], &item, i});
  };
  index(source.root);
  for (const auto& [name, definition] : source.submodels) index(definition);
  std::map<std::pair<Chain, std::string>, std::string> qualified;
  for (size_t i = 0; i < current.refs.size(); ++i) {
    Chain path = current.refs[i].chain;
    if (path.empty()) continue;
    const auto& last = *byItem.at(path.back()).item;
    path.pop_back();
    if (const auto id = last.extra.find("id"); id != last.extra.end() && id->is_string())
      qualified.emplace(std::make_pair(std::move(path), id->get<std::string>()), model.pieces()[i].id);
  }
  std::map<Scope, Json> groups;
  out.motion.reserve(current.refs.size());
  for (size_t i = 0; i < current.refs.size(); ++i) {
    auto motion = root;
    Chain path;
    bm::Xform parent;
    const auto& ref = current.refs[i].chain;
    for (bm::doc::ItemId id : ref) {
      const auto& location = byItem.at(id);
      const auto& item = *location.item;
      const auto& step = location.step->extra;
      applyMotion(motion, object(step, "motion"));
      const auto& assembly = object(item.extra, "assembly");
      applyMotion(motion, object(assembly, "motion"));
      if (!item.submodel) {
        Json hints = assembly;
        transformAxis(hints, parent);
        const double floorTurn = bounded(assembly, "floorTurn", 0, -360, 360);
        if (std::abs(floorTurn) > 1e-6) out.waitingTurns.emplace_back(static_cast<uint32_t>(i), floorTurn);
        auto qualify = [&](Json& idValue) {
          if (!idValue.is_string()) return;
          const auto id = qualified.find({path, idValue.get<std::string>()});
          if (id != qualified.end()) idValue = id->second;
        };
        if (hints.contains("attachTo")) qualify(hints["attachTo"]);
        if (hints.contains("after") && hints["after"].is_array())
          for (auto& prior : hints["after"]) qualify(prior);
        auto& group = groups[{path, location.stepIndex}];
        if (step.is_object() && step.contains("pinOrder") && step["pinOrder"].is_boolean()) group["pinOrder"] = step["pinOrder"];
        group["pieces"].push_back({{"part", item.name}, {"id", model.pieces()[i].id}, {"assembly", std::move(hints)}});
      }
      path.push_back(id);
      if (item.submodel) {
        if (const auto use = current.local.find(id); use != current.local.end()) parent = parent * use->second;
      }
    }
    out.motion.push_back(motion);
  }
  bm::io::PlanDoc authored;
  authored.json = {{"steps", Json::array()}};
  for (auto& [scope, step] : groups) authored.json["steps"].push_back(std::move(step));
  out.constraints = bm::plan::readConstraints(authored, model);
  return out;
}

namespace {

bm::Mat3 floorYaw(double degrees) {
  const double angle = degrees * std::acos(-1.0) / 180;
  const double c = std::cos(angle), s = std::sin(angle);
  return {{c, 0, s, 0, 1, 0, -s, 0, c}};
}

double orientationError(const bm::Mat3& rotation) {
  return 3 - rotation.m[0] - rotation.m[4] - rotation.m[8];
}

double routeDistanceAt(const bm::plan::Flight& flight, double time) {
  for (const auto& phase : flight.phases) {
    if (time > phase.start + phase.frames || phase.frames <= 0) continue;
    return std::lerp(phase.from, phase.to, bm::plan::eased(flight.ease, (time - phase.start) / phase.frames));
  }
  return flight.routeAt.back();
}

bool canApply(const bm::plan::Flight& flight) {
  if (flight.hasLegacy || flight.parent >= 0 || flight.direct || flight.routeAt.size() < 2 || flight.phases.empty() ||
      flight.pathAt <= flight.liftAt) return false;
  return orientationError(bm::plan::poseAt(flight, flight.startFrame + flight.pathAt).r) < 1e-8;
}

bool waitingPoseIsClear(const bm::Model& model, const bm::plan::Timeline& timeline, const bm::collide::World& world,
                        const std::vector<int>& owners, uint32_t piece, const bm::plan::Flight& flight,
                        const bm::CancelToken& cancel) {
  const auto& shape = world.shape(piece);
  const auto& placed = model.pieces()[piece].world;
  if (shape.bounds.empty()) return false;
  const double checkingUntil = flight.startFrame + flight.pathAt;
  const auto& seat = world.box(piece);
  const double radius = bm::length(seat.max - seat.min) + bm::length((seat.min + seat.max) * 0.5 - flight.pivot);
  bm::Box corridor;
  const bm::Vec3 pad{radius, radius, radius};
  for (const auto& point : flight.route) corridor.merge({point - pad, point + pad});
  const auto intersects = [](const bm::Box& a, const bm::Box& b) {
    return !a.empty() && !b.empty() && a.min.x <= b.max.x && a.max.x >= b.min.x &&
        a.min.y <= b.max.y && a.max.y >= b.min.y && a.min.z <= b.max.z && a.max.z >= b.min.z;
  };
  for (uint32_t other = 0; other < owners.size(); ++other) {
    if (cancel.cancelled()) return false;
    if (other == piece || world.shape(other).bounds.empty()) continue;
    const int owner = owners[other];
    const auto check = [&](double at) {
      if (owner >= 0 && !bm::plan::shownAt(timeline.flights[static_cast<size_t>(owner)], at)) return false;
      const bm::Xform their = owner < 0 ? world.pose(other) :
          bm::plan::motionAt(timeline, static_cast<size_t>(owner), at) * world.pose(other);
      const auto& obstacle = world.shape(other);
      const bm::Box obstacleBounds = obstacle.bounds.transformed(their);
      if (!intersects(corridor, obstacleBounds)) return false;
      const auto pose = bm::plan::poseAt(flight, at) * placed;
      if (!intersects(shape.bounds.transformed(pose), obstacleBounds)) return false;
      return bm::collide::overlap(shape, pose, obstacle, their);
    };
    const double shown = owner < 0 ? 0 : timeline.flights[static_cast<size_t>(owner)].appearFrame;
    double at = std::max<double>(flight.appearFrame, shown);
    // The stationary test needs a new sample only while either part is travelling.
    for (; at < checkingUntil; ) {
      if (check(at)) return false;
      bool moving = at >= flight.startFrame;
      double next = std::max(at, static_cast<double>(flight.startFrame));
      for (int i = owner, guard = 0; i >= 0 && guard < 64; i = timeline.flights[static_cast<size_t>(i)].parent, ++guard) {
        const auto& otherFlight = timeline.flights[static_cast<size_t>(i)];
        if (at >= otherFlight.startFrame && at < otherFlight.startFrame + otherFlight.frames) moving = true;
        else if (at < otherFlight.startFrame) next = std::min(next, static_cast<double>(otherFlight.startFrame));
      }
      at = moving ? at + 0.125 : next;
    }
  }
  return true;
}

void retimeFlight(bm::plan::Flight& flight, int frames, const AnimationAuthoring::Motion& motion) {
  const int original = flight.frames;
  if (!original) return;
  flight.ease = motion.ease;
  if (motion.landing < 0 && motion.hover < 0) {
    flight.frames = frames;
    const double scale = static_cast<double>(frames) / original;
    for (auto& phase : flight.phases) {
      phase.start *= scale;
      phase.frames *= scale;
    }
    flight.liftAt *= scale, flight.pathAt *= scale, flight.seatAt *= scale, flight.seatFrames *= scale;
    return;
  }
  double split = flight.phases.empty() ? 1.0 : flight.phases.back().start / original;
  if (flight.phases.empty() && flight.at.size() > 2) split = flight.at[flight.at.size() - 2];
  if (split <= 1e-6 || split >= 1 - 1e-6) {
    retimeFlight(flight, frames, {motion.time, -1, -1, motion.ease});
    return;
  }
  flight.frames = frames;
  const double landing = motion.landing >= 0 ? motion.landing : 1 - split;
  const double hover = std::clamp(motion.hover, 0.0, std::max(0.0, 0.95 - landing));
  const double cruise = 1 - landing - hover;
  const auto send = [&](double u) {
    return u < split ? cruise * u / split : cruise + hover + landing * (u - split) / (1 - split);
  };
  if (flight.phases.size() > 1) {
    for (size_t i = 0; i < flight.phases.size(); ++i) {
      auto& phase = flight.phases[i];
      const double begin = phase.start / original, end = (phase.start + phase.frames) / original;
      const double newStart = send(begin) * frames;
      const double newEnd = i + 2 == flight.phases.size() ? cruise * frames : send(end) * frames;
      phase.start = newStart;
      phase.frames = std::max(0.0, newEnd - newStart);
    }
  } else if (flight.waypoints.size() == flight.at.size() && flight.at.size() > 2) {
    for (auto& mark : flight.at) mark = send(mark);
    if (hover > 0) {
      const auto beforeLanding = flight.waypoints[flight.waypoints.size() - 2];
      flight.waypoints.insert(flight.waypoints.end() - 2, beforeLanding);
      flight.at.insert(flight.at.end() - 2, cruise);
    }
  }
  flight.liftAt = send(flight.liftAt / original) * frames;
  flight.pathAt = send(flight.pathAt / original) * frames;
  flight.seatAt = send(flight.seatAt / original) * frames;
  flight.seatFrames = frames - flight.seatAt;
}

}  // namespace

bool canTurnOnFloor(const bm::plan::Flight& flight) { return canApply(flight); }

double waitFacingSeat(const bm::plan::Flight& flight) {
  double best = 0, error = orientationError(flight.staging.r);
  for (double quarter : {90.0, -90.0, 180.0}) {
    const double gap = orientationError(floorYaw(quarter) * flight.staging.r);
    if (gap < error - 1e-6) best = quarter, error = gap;
  }
  return best;
}

void orientWaitingParts(const bm::Model& model, const bm::plan::Plan& plan, bm::plan::Timeline& timeline,
                        const AnimationAuthoring& authored, bm::ldraw::PartCache& parts, bm::collide::ShapeCache& shapes,
                        std::vector<std::string>& notes, const bm::CancelToken& cancel) {
  if (authored.waitingTurns.empty() || cancel.cancelled()) return;
  const auto owners = bm::plan::owners(timeline, plan, model.pieces().size());
  const bm::collide::World world(model, parts, shapes);
  for (const auto& [piece, turn] : authored.waitingTurns) {
    const int owner = owners[piece];
    if (owner < 0 || cancel.cancelled()) continue;
    auto& base = timeline.flights[static_cast<size_t>(owner)];
    if (bm::plan::piecesOf(base, plan).size() == 1 && canApply(base)) {
      auto adjusted = base;
      adjusted.turnFrom = floorYaw(turn) * base.staging.r;
      adjusted.staging.r = adjusted.turnFrom;
      adjusted.staging.t = base.staging.apply(base.pivot) - adjusted.staging.r * base.pivot;
      adjusted.waypoints.front() = adjusted.staging;
      adjusted.turnPhase = -1;
      adjusted.routeTurn.clear();
      adjusted.turnStart = routeDistanceAt(base, base.liftAt);
      adjusted.turnEnd = routeDistanceAt(base, base.pathAt);
      if (adjusted.turnEnd > adjusted.turnStart + 1e-6 && waitingPoseIsClear(model, timeline, world, owners, piece, adjusted, cancel)) {
        base = std::move(adjusted);
        continue;
      }
    }
    notes.push_back(model.pieces()[piece].part + " needs its original waiting orientation to clear the approach.");
  }
}

void retimeAnimation(const bm::Model& model, const bm::plan::Plan& plan, bm::plan::Timeline& timeline,
                     const AnimationAuthoring& authored) {
  std::vector<int> appearances;
  const size_t count = timeline.flights.size();
  if (!count) return;
  appearances.reserve(count);
  std::vector<size_t> last(authored.holds.size(), count);
  for (size_t i = 0; i < count; ++i) {
    const auto& flight = timeline.flights[i];
    const auto& unit = bm::plan::piecesOf(flight, plan);
    if (flight.depth != 0 || unit.empty()) continue;
    const size_t step = static_cast<size_t>(model.pieces()[unit.front()].step);
    if (step < last.size()) last[step] = i;
  }
  std::map<int, int> clock;
  clock.emplace(0, 0);
  int previousSourceEnd = 0, previousEnd = 0, delay = 0;
  for (size_t i = 0; i < count; ++i) {
    auto& flight = timeline.flights[i];
    const int sourceStart = flight.startFrame;
    const int sourceEnd = sourceStart + flight.frames;
    appearances.push_back(flight.appearFrame);
    const auto& unit = bm::plan::piecesOf(flight, plan);
    const size_t piece = unit.empty() ? authored.motion.size() : unit.front();
    const auto motion = piece < authored.motion.size() ? authored.motion[piece] : AnimationAuthoring::Motion{};
    const auto frames = flight.frames > 0 ? std::max(1, static_cast<int>(std::lround(flight.frames * motion.time))) : 0;
    flight.startFrame = previousEnd + std::max(0, sourceStart - previousSourceEnd) + delay;
    retimeFlight(flight, frames, motion);
    previousSourceEnd = sourceEnd;
    previousEnd = flight.startFrame + flight.frames;
    clock[sourceStart] = flight.startFrame;
    if (sourceEnd > sourceStart) clock[sourceEnd] = previousEnd;
    delay = 0;
    const size_t step = piece < model.pieces().size() ? static_cast<size_t>(model.pieces()[piece].step) : last.size();
    if (step < last.size() && last[step] == i && authored.holds[step] >= 0)
      delay = static_cast<int>(std::lround(authored.style.fps * authored.holds[step]));
  }
  const auto remap = [&](int frame) {
    if (frame <= 0) return 0;
    const auto after = clock.lower_bound(frame);
    if (after == clock.end()) return previousEnd + frame - previousSourceEnd;
    if (after == clock.begin() || after->first == frame) return after->second;
    const auto before = std::prev(after);
    const double u = static_cast<double>(frame - before->first) / (after->first - before->first);
    return static_cast<int>(std::lround(std::lerp(before->second, after->second, u)));
  };
  for (size_t i = 0; i < count; ++i)
    timeline.flights[i].appearFrame = std::min(timeline.flights[i].startFrame, remap(appearances[i]));
  for (auto& key : timeline.camera) key.frame = remap(key.frame);
  timeline.frames = previousEnd + std::max(0, timeline.frames - previousSourceEnd) + delay;
}

}  // namespace bmapp
