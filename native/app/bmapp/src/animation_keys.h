#pragma once

#include <array>
#include <optional>
#include <unordered_map>
#include <nlohmann/json.hpp>
#include "bm/doc/source.h"
#include "bmapp/session.h"
#include "bm/plan/timeline.h"
#include "bmr/scene.h"

namespace bmapp {

inline constexpr std::array<const char*, 10> kKeyChannels{"location.x", "location.y", "location.z", "rotation.x",
  "rotation.y", "rotation.z", "scale.x", "scale.y", "scale.z", "visibility"};
inline constexpr std::array<const char*, 3> kKeyInterpolation{"bezier", "linear", "constant"};

const nlohmann::ordered_json& animationObject(const Session::Impl& session);
KeyScene readKeyScene(const Session::Impl& session);
std::vector<KeyTrack> readKeyTracks(const Session::Impl& session);
std::optional<KeyTrack> readKeyTrack(const Session::Impl& session, uint32_t piece, bool submodel = false);
using AnimationItemIds = std::unordered_map<bm::doc::ItemId, std::string>;
AnimationItemIds animationItemIds(const bm::doc::Source& source);
std::string qualifiedKeyTarget(const AnimationItemIds& ids, const std::vector<bm::doc::ItemId>& chain);
double sampleKeys(const KeyTrack& track, KeyChannel channel, double frame);

/// Applies the hand-key layer in the viewport's model frame.
std::vector<bmr::PiecePose> keyPoses(const KeyScene& scene, const std::vector<KeyTrack>& tracks, const bmr::Scene& geometry,
                                     const bm::Model& model, const bm::plan::Timeline& timeline,
                                     const std::vector<int>& owner, double buildFrame, double sceneFrame);
KeyList bakeFlightKeys(uint32_t piece, const KeyScene& scene, const bmr::Scene& geometry,
                       const bm::Model& model, const bm::plan::Timeline& timeline,
                       const std::vector<int>& owner, double buildFPS);
bm::Vec3 keyPivot(const bmr::Scene& geometry, uint32_t piece, const bm::Xform& rest);
KeyList bakeFlightKeys(size_t leaf, bm::Vec3 pivot, const KeyScene& scene,
                       const bm::plan::Timeline& timeline, double buildFPS);
FlightPoseList flightRouteFromKeys(const KeyTrack& track, const bmr::Scene& geometry, const bm::Model& model);
/// The path a baked single-piece track flies (FlightPath), in the model's frame.
FlightPath flightPathFromKeys(const KeyTrack& track, const bmr::Scene& geometry, const bm::Model& model);

}  // namespace bmapp
