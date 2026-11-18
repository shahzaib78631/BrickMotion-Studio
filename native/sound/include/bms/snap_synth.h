#pragma once
// The snap track, from physics: each seating is an impact (Hertz contact, a hand's press) or a
// Technic ridge letting go, or friction sliding, ringing the modes of the part, the part it lands
// on and the model, heard as the sound those modes radiate. Panned, normalised.
#include <cstddef>
#include <cstdint>
#include <memory>
#include <vector>
#include "bms/snap_events.h"
#include "bms/web_sound.h"

namespace bms {

/// Physics: the parts' own sound (bms/tolerances.h). Web: the web app's snap (bms/web_sound.h).
enum class SoundStyle { Physics, Web };

struct SoundOptions {
  SoundStyle style = SoundStyle::Physics;
  WebSound web;                         ///< Web: its settings (its volume scales `peak`)
  std::filesystem::path recordings;     ///< Web: public/sounds/snaps; empty or none there: its synthesised click
  int sampleRate = 48000;
  double peak = 0.89;    ///< the loudest sample of the track
  double room = 0;       ///< Physics: a reverb's share; 0: dry, a close microphone on a quiet desk
  double stereo = 0.25;  ///< Physics: how far across the pan reaches
};

/// The audible modes of a box's largest face as an ABS plate, Hz, lowest first; empty when it
/// rings above hearing. `thickness` 0: a brick's wall.
std::vector<double> ringHz(const bm::Box& box, double thickness = 0);
/// An ABS shell of the box (top and four walls, kAbsWall thick), kg.
double shellMass(const bm::Box& box);
/// How long a part of `mass` striking at `speed` stays in contact (Hertz), s.
double hertzSeconds(double mass, double speed);

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
