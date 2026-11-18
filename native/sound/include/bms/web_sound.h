#pragma once
// The web app's snap sound, ported so a track can be made either way (SoundOptions::style): its
// CC0 recordings (public/sounds/snaps) through its click filter over its synthesised body, or its
// synthesised click alone, with its settings and presets. Sources: src/audio/snapSound.ts,
// snapSamples.ts, soundSettings.ts and src/anim/snaps.ts; Web Audio's own formulas where those
// lean on it (biquads, gain ramps, the stereo panner, the convolver's normalisation).
#include <cstdint>
#include <filesystem>
#include <map>
#include <memory>
#include <span>
#include <string>
#include <string_view>
#include <vector>
#include "bms/snap_events.h"

namespace bms {

/// soundSettings.ts SoundSettings, with its defaults (the "Balanced" preset).
struct WebSound {
  double volume = 1;
  bool recorded = true;  ///< source: 'recorded' (false: 'synth')
  enum class Library { All, Freesound, OpenGameArt } library = Library::All;
  double click = 1, brightness = 3300, thump = 0.5, thumpPitch = 1, thumpLength = 1, room = 0.2, pitch = 1;
  bool sizePitch = true, sizeMatch = true;
  double variation = 0.5;
  int together = 3;
  double stereo = 0.25;
};
/// The web's presets: balanced, product, click, soft, synth. False for another name.
bool webPreset(std::string_view name, WebSound& out);

/// anim/snaps.ts Snap: when pieces seat (s), how many together, their footprint studs and height.
struct WebSnap {
  double t = 0;
  int count = 1;
  bool sized = false;
  int studs = 0;
  double height = 0;
};
/// The web's snaps of a build: one a seating, at its seat, landings closer than 30 ms merged.
std::vector<WebSnap> webSnaps(std::span<const SnapEvent> events, double fps);

/// snapSound.ts rng: the web's small repeatable random numbers.
class WebRng {
 public:
  explicit WebRng(int seed);
  double operator()();

 private:
  uint32_t s_;
};

/// snapSound.ts snapCharacter.
struct WebCharacter {
  int clicks;
  double gap, slide, pitch, ring, thumpHz, thump, thumpDecay;
};
WebCharacter webCharacter(bool sized, int studs, double height);

/// One recording as snapSamples.ts keeps it: cut to its landing click, levelled.
struct Recording {
  std::string file;
  int size = 0;  ///< 0 small, 1 medium, 2 large (snapSizeOf)
  bool freesound = true;
  int rate = 44100;
  std::vector<float> samples;
  double peak = 0;  ///< seconds from the start to the loudest filtered click
  double gain = 1;  ///< brings that click to full scale
};
/// The web's recordings in `dir` (SNAP_FILES), as it loads them. Missing or unreadable files are
/// left out; an empty list means the web's synthesised click. Never throws.
std::vector<Recording> loadRecordings(const std::filesystem::path& dir);

/// One web snap rendered: dry and its room, panned, from `begin` (a track sample).
struct StereoVoice {
  int64_t begin = 0;
  std::vector<float> left, right;
};
/// The web's addSnap, sample-accurate, one snap after another (the recording chooser remembers
/// the last one, as the web's does).
class WebVoices {
 public:
  WebVoices(std::shared_ptr<const std::vector<Recording>> recordings, const WebSound& sound, int sampleRate);
  ~WebVoices();
  /// `variant` as renderSnapTrack gives it: index * 7919 + round(t * 1000).
  StereoVoice make(const WebSnap& snap, int variant);
  /// The most a snap sounds before its time, s.
  static constexpr double kLeadSeconds = 0.6;

  struct Impl;

 private:
  std::unique_ptr<Impl> impl_;
};

}  // namespace bms
