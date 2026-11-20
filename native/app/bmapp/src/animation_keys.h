#pragma once

#include <array>
#include <nlohmann/json.hpp>
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
double sampleKeys(const KeyTrack& track, KeyChannel channel, double frame);

/// Applies the hand-key layer in the viewport's model frame.
std::vector<bmr::PiecePose> keyPoses(const KeyScene& scene, const std::vector<KeyTrack>& tracks, const bmr::Scene& geometry,
                                     const bm::Model& model, const bm::plan::Timeline& timeline,
                                     const std::vector<int>& owner, double buildFrame, double sceneFrame);
KeyList bakeFlightKeys(uint32_t piece, const KeyScene& scene, const bmr::Scene& geometry,
                       const bm::Model& model, const bm::plan::Timeline& timeline,
                       const std::vector<int>& owner, double buildFPS);

}  // namespace bmapp
