#include "bms/snap_synth.h"

#include <algorithm>
#include <cmath>
#include "bms/tolerances.h"

namespace bms {

namespace {

/// splitmix64: the only randomness, seeded by the move, so each snap is its own and repeatable.
struct Rng {
  uint64_t s;
  uint64_t next() {
    uint64_t z = (s += 0x9E3779B97F4A7C15ull);
    z = (z ^ (z >> 30)) * 0xBF58476D1CE4E5B9ull;
    z = (z ^ (z >> 27)) * 0x94D049BB133111EBull;
    return z ^ (z >> 31);
  }
  double uniform() { return static_cast<double>(next() >> 11) * 0x1.0p-53; }
  double noise() { return 2 * uniform() - 1; }
};

/// The two longest sides of a box, LDU: the footprint that rings.
void footprint(const bm::Box& b, double& a, double& c) {
  double e[3] = {b.max.x - b.min.x, b.max.y - b.min.y, b.max.z - b.min.z};
  std::sort(e, e + 3);
  a = std::max(e[2], 1.0), c = std::max(e[1], 1.0);
}

struct Mode {
  double hz, gain;  ///< gain for a click at the plate's middle row, before the row's shape
  int m, n;
};

/// A thin ABS plate's modes below the top (Kirchhoff), lowest first. A plate too small to ring
/// below it keeps its lowest mode, at the top.
std::vector<Mode> plateModes(const bm::Box& box, double top) {
  std::vector<Mode> out;
  if (box.empty()) return out;
  double a = 0, b = 0;
  footprint(box, a, b);
  a *= kMetresPerLdu, b *= kMetresPerLdu;
  const double d = kAbsYoung * kAbsWall * kAbsWall * kAbsWall / (12 * (1 - kAbsPoisson * kAbsPoisson));
  const double k = M_PI / 2 * std::sqrt(d / (kAbsDensity * kAbsWall));
  for (int m = 1; m <= kModes; m++)
    for (int n = 1; n <= kModes; n++) {
      const double hz = k * (std::pow(m / a, 2) + std::pow(n / b, 2));
      if (hz < top) out.push_back({hz, 1.0 / (m * n), m, n});
    }
  if (out.empty()) out.push_back({top * kSmallPartTop, 1.0, 1, 1});
  std::sort(out.begin(), out.end(), [](const Mode& x, const Mode& y) { return x.hz < y.hz; });
  return out;
}

/// The web's snapCharacter size: log2 of the studs in the footprint, 0..6.
double sizeOf(const bm::Box& box) {
  if (box.empty()) return 1;
  double a = 0, b = 0;
  footprint(box, a, b);
  return std::log2(std::clamp(a * b / 400.0, 1.0, 64.0));
}

/// A plate struck at `at` by a half-sine force: each mode a two-pole resonator, added in.
void strike(std::vector<double>& out, size_t at, const std::vector<Mode>& modes, double row, double level, double rate, double detune, double pulseSeconds) {
  const size_t pulse = std::max<size_t>(2, static_cast<size_t>(std::lround(pulseSeconds * rate)));
  for (const Mode& mode : modes) {
    const double hz = mode.hz * detune;
    const double w = 2 * M_PI * hz / rate;
    if (w >= M_PI) continue;
    const double r = std::exp(-M_PI * hz * kLossFactor / rate);
    const double shape = std::sin(mode.m * M_PI * row) * std::sin(mode.n * M_PI * 0.5);
    const double gain = level * mode.gain * shape * std::sin(w) * M_PI / (2.0 * static_cast<double>(pulse));
    if (gain == 0) continue;
    const size_t length = pulse + static_cast<size_t>(std::log(1e-5) / std::log(r)) + 1;
    double y1 = 0, y2 = 0;
    for (size_t j = 0; j < length && at + j < out.size(); j++) {
      const double x = j < pulse ? std::sin(M_PI * (static_cast<double>(j) + 0.5) / static_cast<double>(pulse)) : 0.0;
      const double y = 2 * r * std::cos(w) * y1 - r * r * y2 + x;
      y2 = y1, y1 = y;
      out[at + j] += gain * y;
    }
  }
}

/// RBJ band-pass (constant peak gain).
struct BandPass {
  double b0, b2, a1, a2, x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  BandPass(double hz, double q, double rate) {
    const double w = 2 * M_PI * std::min(hz, 0.45 * rate) / rate, alpha = std::sin(w) / (2 * q), a0 = 1 + alpha;
    b0 = alpha / a0, b2 = -alpha / a0, a1 = -2 * std::cos(w) / a0, a2 = (1 - alpha) / a0;
  }
  double operator()(double x) {
    const double y = b0 * x + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1, x1 = x, y2 = y1, y1 = y;
    return y;
  }
};

/// A Schroeder room for one channel; it keeps its state from sample to sample.
struct Room {
  std::vector<double> comb[4], pass[2];
  size_t combAt[4] = {}, passAt[2] = {};
  Room(double rate, double spread) {
    for (int i = 0; i < 4; i++) comb[i].assign(static_cast<size_t>(std::lround((kCombSeconds[i] + spread) * rate)), 0.0);
    for (int i = 0; i < 2; i++) pass[i].assign(static_cast<size_t>(std::lround((kAllPassSeconds[i] + spread * 0.25) * rate)) + 1, 0.0);
  }
  double operator()(double x) {
    double sum = 0;
    for (int i = 0; i < 4; i++) {
      const double y = comb[i][combAt[i]];
      comb[i][combAt[i]] = x + kCombFeedback * y;
      combAt[i] = (combAt[i] + 1) % comb[i].size();
      sum += y;
    }
    double y = sum / 4;
    for (int i = 0; i < 2; i++) {
      const double held = pass[i][passAt[i]];
      const double o = -kAllPassGain * y + held;
      pass[i][passAt[i]] = y + kAllPassGain * held;
      passAt[i] = (passAt[i] + 1) % pass[i].size();
      y = o;
    }
    return y;
  }
};

/// The most samples a snap starts before its seat (its slide).
size_t maxLead(double rate) { return static_cast<size_t>(std::ceil(kSlideMax * rate)) + 2; }
int64_t seatSample(const SnapEvent& e, double fps, double rate) { return std::llround(static_cast<double>(e.frame) / fps * rate); }

}  // namespace

std::vector<float> synthesise(const SnapEvent& e, double fps, const SoundOptions& o, size_t& lead) {
  (void)fps;
  const double rate = o.sampleRate;
  Rng rng{0xB5C0FFEEull ^ (static_cast<uint64_t>(e.move) * 0x9E3779B97F4A7C15ull)};
  const double slideSeconds = std::clamp(e.seatSeconds, 0.0, kSlideMax);
  const size_t slide = static_cast<size_t>(std::lround(slideSeconds * rate));
  lead = slide + 1;
  std::vector<double> x(lead + static_cast<size_t>(std::ceil(kSnapTailSeconds * rate)), 0.0);
  const bool tall = !e.unit.empty() && e.unit.max.y - e.unit.min.y >= kTallLdu;
  const double size = sizeOf(e.unit);
  const double ringPitch = (1.12 - 0.05 * size) * (tall ? 0.92 : 1.0);
  const bool joined = e.mates > 0;
  const bool clicking = joined && (e.joint == bm::connect::JointKind::Fixed || e.ridge);
  const double detune = 1 + 0.03 * rng.noise();

  // The slide: the unit's faces rubbing on what it goes onto, rising to the seat.
  if (joined && slide > 0) {
    BandPass band(kSlideHz * ringPitch * detune, kSlideQ, rate);
    const double level = !clicking ? kSlideAloneLevel : e.ridge ? kSlideRidgeLevel : kSlideLevel;
    const size_t fade = std::min<size_t>(slide, static_cast<size_t>(rate * 0.001));
    for (size_t j = 0; j < slide; j++) {
      const double t = static_cast<double>(j + 1) / static_cast<double>(slide);
      const double out = j + fade >= slide ? static_cast<double>(slide - j) / static_cast<double>(fade + 1) : 1.0;
      x[lead - slide + j - 1] += level * t * t * out * band(rng.noise());
    }
  }
  // The clicks: each row of studs (or a pin's ridge) seating, ringing the unit and what it joins.
  if (clicking) {
    const int clicks = e.mates <= 2 ? 2 : e.mates <= 6 ? 3 : 4;
    const double gap = kClickGap + kClickGapPerDoubling * std::min(std::log2(static_cast<double>(e.mates)), 4.0);
    const double top = std::min(kTopHz, 0.45 * rate);
    const std::vector<Mode> unit = plateModes(e.unit, top), touching = plateModes(e.touching, top);
    double fa = 0, fb = 0;
    footprint(e.unit, fa, fb);
    const double pulse = kPulseSeconds * std::clamp(std::sqrt(fa * fb / kPulseArea), kPulseScale[0], kPulseScale[1]);
    double level = kClickLevel;
    for (int k = 0; k < clicks; k++) {
      const size_t at = lead + static_cast<size_t>(std::lround(k * gap * (1 + 0.1 * rng.noise()) * rate));
      const double row = (k + 0.5) / clicks;
      const double l = level * (1 + 0.05 * rng.noise());
      strike(x, at, unit, row, l, rate, detune, pulse);
      strike(x, at, touching, row, l * kTouchingLevel, rate, detune, pulse);
      level *= kClickFalloff;
    }
  }
  // The thump: the body of the model taking the unit, deeper as the model grows.
  if (clicking || !joined) {
    const double grown = std::min(std::log2(static_cast<double>(e.builtPieces) + 1) * kThumpSizePerDoubling, kThumpSizeMax);
    const double hz = ((tall ? 105.0 : 135.0) - 6 * grown) * detune;
    const double level = kThumpLevel * ((tall ? 0.75 : 0.5) + 0.05 * grown);
    const double tau = ((tall ? 0.2 : 0.14) + 0.012 * grown) / std::log(1e4);
    const size_t attack = static_cast<size_t>(rate * 0.001);
    double phase = 0, low = 0;
    const double lowK = 1 - std::exp(-2 * M_PI * kThumpNoiseHz / rate);
    for (size_t j = 0; lead + j < x.size(); j++) {
      const double t = static_cast<double>(j) / rate;
      const double f = hz * (1 + (kThumpSweep - 1) * std::max(0.0, 1 - t / kThumpSweepSeconds));
      phase += 2 * M_PI * f / rate;
      const double env = (j < attack ? static_cast<double>(j) / static_cast<double>(attack) : 1.0) * std::exp(-t / tau);
      low += lowK * (rng.noise() - low);
      const double noise = t < kThumpNoiseSeconds ? 0.5 * low * (1 - t / kThumpNoiseSeconds) : 0.0;
      x[lead + j] += level * (env * std::sin(phase) + noise);
    }
  }
  std::vector<float> out(x.size());
  for (size_t j = 0; j < x.size(); j++) out[j] = static_cast<float>(x[j]);
  return out;
}

struct Mixer::Engine {
  struct Playing {
    std::vector<float> samples;
    int64_t begin;   ///< the track sample of samples[0]
    double left, right;
  };
  const std::vector<SnapEvent>* events;
  std::vector<size_t> order;  ///< by seat, then as given
  double fps;
  SoundOptions o;
  size_t next = 0;
  int64_t position = 0;
  std::vector<Playing> playing;
  Room roomLeft, roomRight;

  Engine(const std::vector<SnapEvent>& e, double f, const SoundOptions& options)
      : events(&e), fps(f), o(options), roomLeft(options.sampleRate, 0.0), roomRight(options.sampleRate, kStereoSpreadSeconds) {
    order.resize(e.size());
    for (size_t i = 0; i < e.size(); i++) order[i] = i;
    std::stable_sort(order.begin(), order.end(), [&](size_t a, size_t b) { return e[a].frame < e[b].frame; });
  }
  void raw(double* left, double* right, size_t count) {
    const double rate = o.sampleRate;
    const int64_t early = static_cast<int64_t>(maxLead(rate));
    for (size_t i = 0; i < count; i++, position++) {
      while (next < order.size() && seatSample((*events)[order[next]], fps, rate) - early <= position) {
        const SnapEvent& e = (*events)[order[next++]];
        Playing p;
        size_t lead = 0;
        p.samples = synthesise(e, fps, o, lead);
        p.begin = seatSample(e, fps, rate) - static_cast<int64_t>(lead);
        const double theta = (std::clamp(e.pan, -1.0, 1.0) * o.stereo + 1) * M_PI / 4;
        p.left = std::cos(theta), p.right = std::sin(theta);
        playing.push_back(std::move(p));
      }
      double l = 0, r = 0;
      bool over = false;
      for (const Playing& p : playing) {
        const int64_t at = position - p.begin;
        if (at >= static_cast<int64_t>(p.samples.size())) {
          over = true;
          continue;
        }
        if (at < 0) continue;
        l += p.samples[static_cast<size_t>(at)] * p.left, r += p.samples[static_cast<size_t>(at)] * p.right;
      }
      if (over) std::erase_if(playing, [&](const Playing& p) { return position - p.begin >= static_cast<int64_t>(p.samples.size()); });
      left[i] = l + o.room * roomLeft(l);
      right[i] = r + o.room * roomRight(r);
    }
  }
};

Mixer::Mixer(std::vector<SnapEvent> events, int frames, double fps, SoundOptions options) : events_(std::move(events)), frames_(frames), fps_(fps), options_(options) {}
Mixer::~Mixer() = default;

uint64_t Mixer::length() const {
  if (frames_ <= 0 || !(fps_ > 0)) return 0;
  return static_cast<uint64_t>(std::ceil(static_cast<double>(frames_) / fps_ * options_.sampleRate));
}

void Mixer::render(float* left, float* right, size_t count) {
  constexpr size_t kBlock = 8192;
  std::vector<double> l(kBlock), r(kBlock);
  if (scale_ < 0) {
    // The peak, from one pass over the whole track.
    Engine probe(events_, fps_, options_);
    double found = 0;
    for (uint64_t at = 0; at < length(); at += kBlock) {
      const size_t n = static_cast<size_t>(std::min<uint64_t>(kBlock, length() - at));
      probe.raw(l.data(), r.data(), n);
      for (size_t i = 0; i < n; i++) found = std::max({found, std::fabs(l[i]), std::fabs(r[i])});
    }
    scale_ = options_.peak / std::max(found, 1e-9);
    engine_ = std::make_unique<Engine>(events_, fps_, options_);
  }
  for (size_t done = 0; done < count;) {
    const uint64_t at = static_cast<uint64_t>(engine_->position);
    const size_t left_ = at < length() ? static_cast<size_t>(std::min<uint64_t>(length() - at, count - done)) : 0;
    const size_t n = std::min(kBlock, left_);
    if (n == 0) {
      std::fill(left + done, left + count, 0.0f);
      std::fill(right + done, right + count, 0.0f);
      return;
    }
    engine_->raw(l.data(), r.data(), n);
    for (size_t i = 0; i < n; i++) {
      left[done + i] = std::isfinite(l[i]) ? static_cast<float>(l[i] * scale_) : 0.0f;
      right[done + i] = std::isfinite(r[i]) ? static_cast<float>(r[i] * scale_) : 0.0f;
    }
    done += n;
  }
}

}  // namespace bms
