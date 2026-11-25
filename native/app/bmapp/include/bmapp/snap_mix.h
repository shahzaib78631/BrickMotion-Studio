#pragma once

#include <string>

namespace bmapp {

enum class SnapSource { Physical, Recorded, Synthesised };
enum class SnapLibrary { All, Freesound, OpenGameArt };
enum class SnapExample { Plate, Brick, Pin };

struct SnapMix {
  bool enabled = false;
  SnapSource source = SnapSource::Physical;
  SnapLibrary library = SnapLibrary::All;
  double volume = 1, room = 0, stereo = 0.25;
  double click = 1, brightness = 3300, thump = 0.5, thumpPitch = 1, thumpLength = 1;
  double pitch = 1, variation = 0.5;
  bool sizePitch = true, sizeMatch = true;
  int together = 3;
  bool operator==(const SnapMix&) const = default;
};

SnapMix snapMixPreset(const std::string& name);
bool writeSnapPreview(const SnapMix& mix, SnapExample example, const std::string& recordings, const std::string& file);

}  // namespace bmapp
