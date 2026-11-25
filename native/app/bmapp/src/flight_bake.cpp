#include "flight_bake_impl.h"

#include <cmath>
#include <unordered_set>

void bmappRetainFlightBake(bmapp::FlightBake* bake) { ++bake->refs_; }
void bmappReleaseFlightBake(bmapp::FlightBake* bake) { if (--bake->refs_ == 0) delete bake; }

namespace bmapp {
namespace {

using Json = nlohmann::ordered_json;

std::string field(const Json& row, const char* key) {
  const auto it = row.find(key);
  return it != row.end() && it->is_string() ? it->get<std::string>() : "";
}

bool reproducible(const Keyframe& a, const Keyframe& b, const Keyframe& c) {
  if (a.interpolation == KeyInterpolation::Hold) return a.value == b.value;
  const double t = (b.frame - a.frame) / static_cast<double>(c.frame - a.frame);
  return std::abs(std::lerp(a.value, c.value, t) - b.value) < 1e-10;
}

Json encodeFlight(const KeyList& keys, int& count) {
  std::array<KeyList, kKeyChannels.size()> lanes;
  for (const auto& key : keys) {
    auto& lane = lanes[static_cast<size_t>(key.channel)];
    if (lane.size() >= 2 && reproducible(lane[lane.size() - 2], lane.back(), key)) lane.back() = key;
    else lane.push_back(key);
  }
  Json channels = Json::object();
  for (size_t i = 0; i < lanes.size(); ++i) {
    Json lane = Json::array();
    for (const auto& key : lanes[i])
      lane.push_back({{"frame", key.frame}, {"value", key.value},
                      {"interpolation", kKeyInterpolation[static_cast<size_t>(key.interpolation)]}});
    count += static_cast<int>(lane.size());
    channels[kKeyChannels[i]] = std::move(lane);
  }
  return channels;
}

int keyCount(const Json& track) {
  const auto channels = track.find("channels");
  if (channels == track.end() || !channels->is_object()) return 0;
  int keys = 0;
  for (const auto& lane : *channels)
    if (lane.is_array()) keys += static_cast<int>(lane.size());
  return keys;
}

}  // namespace

FlightBake::FlightBake(std::unique_ptr<Impl> impl) : impl_(std::move(impl)) {}
FlightBake::~FlightBake() = default;
bool FlightBake::replacesKeys() const { return impl_->replace; }

FlightBakeResult FlightBake::prepare() {
  auto& bake = *impl_;
  const std::lock_guard lock(bake.mutex);
  if (bake.result) return *bake.result;
  const auto fail = [&](std::string message) {
    bake.result = FlightBakeResult{0, 0, std::move(message)};
    return *bake.result;
  };
  if (bake.targets.empty()) return fail("There are no selected flights to bake.");
  auto& scene = bake.scene;
  if (!scene.buildLinked) {
    scene.buildStart = scene.first;
    scene.buildSpeed = 1;
  }
  const auto end = scene.buildStart + std::ceil(bake.timeline.frames * scene.fps / (bake.buildFPS * scene.buildSpeed));
  if (end > 20000) return fail("The build exceeds the 20,000-frame scene range. Reduce the scene FPS or increase Build speed.");
  scene.last = std::max(scene.last, static_cast<int>(end));

  auto& animation = bake.command.planField->after;
  std::unordered_set<std::string> targets;
  for (const auto& target : bake.targets) {
    targets.insert(target.id);
    if (!target.previousId.empty()) targets.insert(target.previousId);
  }
  Json tracks = Json::array();
  int existingKeys = 0;
  for (auto& track : animation["tracks"]) {
    if (field(track, "kind") == "object" && field(track, "model") == bake.scope && targets.contains(field(track, "target"))) continue;
    existingKeys += keyCount(track);
    tracks.push_back(std::move(track));
  }
  if (tracks.size() + bake.targets.size() > 2000) return fail("This bake would exceed the 2,000-track project limit.");

  int keys = 0;
  size_t sampled = 0;
  for (const auto& target : bake.targets) {
    if (target.owner < 0) return fail("A selected piece has no planned flight. Replan Build and run the bake again.");
    const auto poses = bakeFlightKeys(static_cast<size_t>(target.owner), target.pivot, scene, bake.timeline, bake.buildFPS);
    if (poses.empty()) return fail("A flight exceeds the per-piece sample limit. Reduce the scene FPS or increase Build speed.");
    sampled += poses.size() / kKeyChannels.size();
    if (sampled > 300000) return fail("This bake exceeds 300,000 sampled poses. Reduce the scene FPS or bake a smaller selection.");
    auto channels = encodeFlight(poses, keys);
    if (keys + existingKeys > 380000) return fail("This bake would exceed the 380,000-key project limit.");
    tracks.push_back({{"kind", "object"}, {"model", bake.scope}, {"target", target.id},
                      {"source", "baked-flight"}, {"channels", std::move(channels)}});
  }
  animation["tracks"] = std::move(tracks);
  animation["endFrame"] = scene.last;
  auto& layers = animation["buildLayers"];
  if (!layers.is_object()) layers = Json::object();
  if (bake.detach) layers.erase(bake.scope);
  else layers[bake.scope] = {{"startFrame", scene.buildStart}, {"speed", scene.buildSpeed}};
  if (layers.empty()) animation.erase("buildLayers");
  bake.result = FlightBakeResult{static_cast<int>(bake.targets.size()), keys, {}};
  return *bake.result;
}

}  // namespace bmapp
