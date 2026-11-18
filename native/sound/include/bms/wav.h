#pragma once
#include <filesystem>
#include "bms/snap_synth.h"

namespace bms {

/// The whole track as 16-bit stereo PCM, written in blocks (never whole in memory). False when
/// the file cannot be written. Never throws.
bool writeWav(Mixer& mixer, const std::filesystem::path& file);

}  // namespace bms
