#pragma once
// The snap track: each seating synthesised (a slide, clicks ringing the unit and what it lands on
// as ABS plates, a thump that deepens as the model grows), panned, in a small room, normalised.
#include <cstddef>
#include <cstdint>
#include <memory>
#include <vector>
#include "bms/snap_events.h"

namespace bms {

struct SoundOptions {
  int sampleRate = 48000;
  double peak = 0.89;    ///< the loudest sample of the track
  double room = 0.2;     ///< the reverb's share
  double stereo = 0.25;  ///< how far across the pan reaches
};

/// One snap, alone and dry, mono, from `lead` samples before its seat: what the mixer pans and
/// mixes. For tuning and tests. Never throws.
std::vector<float> synthesise(const SnapEvent& event, double fps, const SoundOptions& options, size_t& lead);

class Mixer {
 public:
  Mixer(std::vector<SnapEvent> events, int frames, double fps, SoundOptions options = {});
  ~Mixer();
  Mixer(const Mixer&) = delete;
  Mixer& operator=(const Mixer&) = delete;
  /// ceil(frames / fps * sampleRate)
  uint64_t length() const;
  int sampleRate() const { return options_.sampleRate; }
  /// The next `count` samples, normalised, zeros past the end. The samples do not depend on how
  /// the track is cut into blocks. The first call runs through the whole track once for its peak.
  void render(float* left, float* right, size_t count);

  struct Engine;

 private:
  std::vector<SnapEvent> events_;
  int frames_;
  double fps_;
  SoundOptions options_;
  double scale_ = -1;  ///< < 0 until the peak is known
  std::unique_ptr<Engine> engine_;
};

}  // namespace bms
