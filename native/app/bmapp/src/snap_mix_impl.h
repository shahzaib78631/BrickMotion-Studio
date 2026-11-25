#pragma once
#include "bmapp/snap_mix.h"
#include "bms/snap_synth.h"
#include <nlohmann/json.hpp>

namespace bmapp {
SnapMix readSnapMix(const nlohmann::ordered_json& video);
bool validSnapMix(const SnapMix& mix);
void writeSnapMix(nlohmann::ordered_json& video, const SnapMix& mix);
bms::SoundOptions snapOptions(const SnapMix& mix, const std::string& recordings);
}  // namespace bmapp
