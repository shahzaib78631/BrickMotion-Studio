#include "animation_keys.h"

#include <map>
#include <numbers>
#include <set>
#include "session_impl.h"

namespace bmapp {
namespace {

using Json = nlohmann::ordered_json;

std::string text(const Json& object, const char* key) {
  return object.is_object() && object.contains(key) && object[key].is_string() ? object[key].get<std::string>() : "";
}

int integer(const Json& object, const char* key, int value, int lo, int hi) {
  if (!object.is_object() || !object.contains(key) || !object[key].is_number_integer()) return value;
  return std::clamp(object[key].get<int>(), lo, hi);
}

KeyList decodeKeys(const Json& channelMap, const KeyScene& scene) {
  KeyList result;
  if (!channelMap.is_object()) return result;
  for (size_t channel = 0; channel < kKeyChannels.size(); ++channel) {
    const auto lane = channelMap.find(kKeyChannels[channel]);
    if (lane == channelMap.end() || !lane->is_array()) continue;
    std::map<int, Keyframe> merged;
    for (const auto& entry : *lane) {
      const int frame = integer(entry, "frame", -1, scene.first, scene.last);
      if (frame < 0 || !entry.contains("value") || !entry["value"].is_number()) continue;
      const double value = entry["value"].get<double>();
      if (!std::isfinite(value)) continue;
      const auto ease = text(entry, "interpolation");
      const auto it = std::find(kKeyInterpolation.begin(), kKeyInterpolation.end(), ease);
      const auto interpolation = it == kKeyInterpolation.end() ? KeyInterpolation::Smooth :
          static_cast<KeyInterpolation>(it - kKeyInterpolation.begin());
      merged[frame] = {static_cast<KeyChannel>(channel), frame, value, interpolation};
    }
    for (const auto& [frame, key] : merged) result.push_back(key);
  }
  return result;
}

double slope(const Keyframe* left, const Keyframe* center, const Keyframe* right) {
  if (!left || !right) return 0;
  const double a = (center->value - left->value) / (center->frame - left->frame);
  const double b = (right->value - center->value) / (right->frame - center->frame);
  if (a * b <= 0) return 0;
  const double middle = (right->value - left->value) / (right->frame - left->frame);
  return std::copysign(std::min(std::abs(middle), 3 * std::min(std::abs(a), std::abs(b))), middle);
}

}  // namespace

const nlohmann::ordered_json& animationObject(const Session::Impl& session) {
  static const Json empty = Json::object();
  const auto& plan = session.source.extra;
  if (plan.is_object() && plan.contains("animation") && plan["animation"].is_object()) return plan["animation"];
  return empty;
}

KeyScene readKeyScene(const Session::Impl& session) {
  const auto& doc = animationObject(session);
  KeyScene scene;
  scene.fps = integer(doc, "fps", 24, 1, 120);
  scene.first = integer(doc, "startFrame", 1, 0, 19999);
  scene.last = integer(doc, "endFrame", 250, scene.first + 1, 20000);
  if (doc.contains("buildLayers") && doc["buildLayers"].is_object()) {
    const auto layer = doc["buildLayers"].find(focusedDef(session));
    if (layer != doc["buildLayers"].end() && layer->is_object()) {
      scene.buildLinked = true;
      scene.buildStart = integer(*layer, "startFrame", scene.first, scene.first, scene.last);
      if (layer->contains("speed") && (*layer)["speed"].is_number()) {
        const double speed = (*layer)["speed"].get<double>();
        if (std::isfinite(speed)) scene.buildSpeed = std::clamp(speed, 0.1, 4.0);
      }
    }
  }
  return scene;
}

std::vector<KeyTrack> readKeyTracks(const Session::Impl& current) {
  std::vector<KeyTrack> result;
  if (!current.model) return result;
  const auto& animation = animationObject(current);
  const auto target = focusedDef(current);
  const auto* def = current.source.def(target);
  if (!def || !animation.contains("tracks") || !animation["tracks"].is_array()) return result;
  std::unordered_map<std::string, bm::doc::ItemId> named;
  for (const auto& step : def->steps)
    for (const auto& item : step.items)
      if (auto id = text(item.extra, "id"); !id.empty()) named.emplace(std::move(id), item.id);
  std::unordered_map<std::string, uint32_t> flat;
  for (uint32_t p = 0; p < current.model->pieces().size(); ++p) flat.emplace(current.model->pieces()[p].id, p);
  const auto scene = readKeyScene(current);
  for (const auto& track : animation["tracks"]) {
    if (text(track, "kind") != "object" || text(track, "model") != target || !track.contains("channels")) continue;
    const auto id = text(track, "target");
    const bool baked = text(track, "source") == "baked-flight";
    if (baked) {
      const auto piece = flat.find(id);
      if (piece != flat.end())
        result.push_back({piece->second, current.model->pieces()[piece->second].part, true, decodeKeys(track["channels"], scene), {piece->second}});
      continue;
    }
    const auto stored = named.find(id);
    if (stored == named.end()) continue;
    const auto selected = current.piecesOf.find(stored->second);
    if (selected == current.piecesOf.end()) continue;
    if (selected->second.empty()) continue;
    const auto p = selected->second.front();
    std::string name = current.model->pieces()[p].part;
    if (current.refs[p].chain.size() > 1 && !current.model->pieces()[p].path.empty())
      name = current.model->pieces()[p].path.front();
    result.push_back({p, std::move(name), false, decodeKeys(track["channels"], scene), selected->second});
  }
  return result;
}

double sampleKeys(const KeyTrack& track, KeyChannel channel, double frame) {
  const auto channelLess = [](const Keyframe& key, KeyChannel type) { return key.channel < type; };
  const auto first = std::lower_bound(track.keys.begin(), track.keys.end(), channel, channelLess);
  auto last = first;
  while (last != track.keys.end() && last->channel == channel) ++last;
  if (first == last) return channel >= KeyChannel::ScaleX ? 1 : 0;
  const auto right = std::upper_bound(first, last, frame, [](double t, const Keyframe& key) { return t < key.frame; });
  if (right == first) return first->value;
  const auto left = std::prev(right);
  if (right == last || left->interpolation == KeyInterpolation::Hold || channel == KeyChannel::Visibility) return left->value;
  const double span = right->frame - left->frame;
  const double t = (frame - left->frame) / span;
  if (left->interpolation == KeyInterpolation::Linear) return std::lerp(left->value, right->value, t);
  const double a = span * slope(left == first ? nullptr : &*std::prev(left), &*left, &*right);
  const double b = span * slope(&*left, &*right, std::next(right) == last ? nullptr : &*std::next(right));
  return std::lerp(left->value, right->value, t * t * (3 - 2 * t)) + t * (1 - t) * ((1 - t) * a - t * b);
}

namespace {

bm::Box partBox(const bmr::Scene& geometry, uint32_t piece) {
  if (piece >= geometry.where.size()) return {};
  const auto group = geometry.where[piece].first;
  return group < geometry.groups.size() ? geometry.groups[group].partBox : bm::Box{};
}

bm::Xform offset(const KeyTrack& track, double frame, bm::Vec3 pivot) {
  const auto value = [&](KeyChannel channel) { return sampleKeys(track, channel, frame); };
  constexpr double rad = std::numbers::pi / 180;
  const double x = value(KeyChannel::RotationX) * rad, y = -value(KeyChannel::RotationY) * rad, z = -value(KeyChannel::RotationZ) * rad;
  const double a = std::cos(x), b = std::sin(x), c = std::cos(y), d = std::sin(y), e = std::cos(z), f = std::sin(z);
  const double sx = value(KeyChannel::ScaleX), sy = value(KeyChannel::ScaleY), sz = value(KeyChannel::ScaleZ);
  const bm::Mat3 linear{{c * e * sx, -c * f * sy, d * sz,
                         (a * f + b * e * d) * sx, (a * e - b * f * d) * sy, -b * c * sz,
                         (b * f - a * e * d) * sx, (b * e + a * f * d) * sy, a * c * sz}};
  const bm::Vec3 translation{20 * value(KeyChannel::PositionX), -20 * value(KeyChannel::PositionY), -20 * value(KeyChannel::PositionZ)};
  return {linear, pivot + translation - linear * pivot};
}

}  // namespace

std::vector<bmr::PiecePose> keyPoses(const KeyScene& scene, const std::vector<KeyTrack>& tracks, const bmr::Scene& geometry,
                                     const bm::Model& model, const bm::plan::Timeline& timeline,
                                     const std::vector<int>& owner, double buildFrame, double sceneFrame) {
  std::map<uint32_t, bmr::PiecePose> keyed;
  for (bool baked : {true, false}) {
    for (const auto& track : tracks) {
      if (track.baked != baked) continue;
      bm::Box box;
      for (uint32_t piece : track.members) {
        if (piece >= model.pieces().size()) continue;
        auto it = keyed.find(piece);
        if (it == keyed.end()) {
          bm::Xform pose = model.pieces()[piece].world;
          bool hidden = false;
          if (!baked && scene.buildLinked && piece < owner.size() && owner[piece] >= 0) {
            const size_t i = static_cast<size_t>(owner[piece]);
            pose = bm::plan::motionAt(timeline, i, buildFrame) * pose;
            hidden = !bm::plan::shownAt(timeline.flights[i], buildFrame);
          }
          it = keyed.emplace(piece, bmr::PiecePose{piece, pose, hidden}).first;
        }
        box.merge(partBox(geometry, piece).transformed(it->second.world));
      }
      const bm::Vec3 pivot = box.empty() ? bm::Vec3{} : (box.min + box.max) * 0.5;
      const auto delta = offset(track, sceneFrame, pivot);
      const bool invisible = sampleKeys(track, KeyChannel::Visibility, sceneFrame) < 0.5;
      for (uint32_t piece : track.members) {
        const auto found = keyed.find(piece);
        if (found == keyed.end()) continue;
        auto& pose = found->second;
        pose.world = delta * pose.world;
        pose.hidden = pose.hidden || invisible;
      }
    }
  }
  std::vector<bmr::PiecePose> out;
  out.reserve(keyed.size());
  for (const auto& [piece, pose] : keyed) out.push_back(pose);
  return out;
}

KeyList bakeFlightKeys(uint32_t piece, const KeyScene& scene, const bmr::Scene& geometry,
                       const bm::Model& model, const bm::plan::Timeline& timeline,
                       const std::vector<int>& owner, double buildFPS) {
  if (piece >= owner.size() || owner[piece] < 0 || piece >= model.pieces().size() || buildFPS <= 0) return {};
  const auto& rest = model.pieces()[piece].world;
  const auto box = partBox(geometry, piece).transformed(rest);
  const bm::Vec3 pivot = box.empty() ? rest.t : (box.min + box.max) * 0.5;
  const size_t leaf = static_cast<size_t>(owner[piece]);
  const double rate = scene.fps / (buildFPS * scene.buildSpeed);
  const auto toFrame = [&](int build) { return scene.buildStart + static_cast<int>(std::ceil(build * rate - 1e-8)); };
  std::set<int> sample{scene.first, scene.last};
  const int appear = std::clamp(toFrame(timeline.flights[leaf].appearFrame), scene.first, scene.last);
  sample.insert(appear);
  sample.insert(std::max(scene.first, appear - 1));
  for (int fi = static_cast<int>(leaf); fi >= 0;) {
    const auto& flight = timeline.flights[static_cast<size_t>(fi)];
    const int a = std::max(scene.first, toFrame(flight.startFrame) - 1);
    const int b = std::min(scene.last, toFrame(flight.startFrame + flight.frames));
    for (int frame = a; frame <= b; ++frame) sample.insert(frame);
    fi = flight.parent;
  }
  if (sample.size() > 5000) return {};
  KeyList out;
  std::array<double, 3> previous{};
  for (int at : sample) {
    const double build = std::max(0.0, (at - scene.buildStart) / rate);
    const auto move = bm::plan::motionAt(timeline, leaf, build);
    const auto slide = (move.apply(pivot) - pivot) * 0.05;
    const double* m = move.r.m;
    constexpr double deg = 180 / std::numbers::pi;
    const double y = -std::asin(std::clamp(m[2], -1.0, 1.0)) * deg;
    const bool pole = std::abs(m[2]) >= 0.9999999;
    std::array<double, 3> euler{
      (pole ? std::atan2(m[7], m[4]) : std::atan2(-m[5], m[8])) * deg,
      y, pole ? 0 : -std::atan2(-m[1], m[0]) * deg};
    if (!out.empty()) {
      auto other = std::array{euler[0] + 180, 180 - euler[1], euler[2] + 180};
      const auto distance = [&](auto& angles) {
        double sum = 0;
        for (size_t i = 0; i < angles.size(); ++i) {
          const double nearest = std::remainder(angles[i] - previous[i], 360.0);
          angles[i] = previous[i] + nearest;
          sum += nearest * nearest;
        }
        return sum;
      };
      const double primary = distance(euler);
      if (distance(other) < primary) euler = other;
    }
    previous = euler;
    const bool shown = at >= scene.buildStart && bm::plan::shownAt(timeline.flights[leaf], build);
    const std::array values{slide.x, -slide.y, -slide.z, euler[0], euler[1], euler[2], 1.0, 1.0, 1.0, shown ? 1.0 : 0.0};
    for (size_t i = 0; i < values.size(); ++i)
      out.push_back({static_cast<KeyChannel>(i), at, values[i], i == 9 ? KeyInterpolation::Hold : KeyInterpolation::Linear});
  }
  return out;
}

}  // namespace bmapp
