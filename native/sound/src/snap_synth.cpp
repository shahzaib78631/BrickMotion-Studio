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
};

/// A box's sides, LDU, longest first.
void sides(const bm::Box& b, double& a, double& c, double& h) {
  double e[3] = {b.max.x - b.min.x, b.max.y - b.min.y, b.max.z - b.min.z};
  std::sort(e, e + 3);
  a = std::max(e[2], 1.0), c = std::max(e[1], 1.0), h = std::max(e[0], 1.0);
}

/// A face as a simply supported plate: sides a, b (m), thickness h (m), density rho (kg/m^3).
struct Plate {
  double a = 0, b = 0, h = 0, rho = 0;
  double tune = 1, loss = kLossFactor;  ///< a held part: kHeldFrequency, kHeldLossFactor
  bool empty() const { return a <= 0 || b <= 0; }
};
Plate faceOf(const bm::Box& box, bool held = false) {
  if (box.empty()) return {};
  double a = 0, b = 0, h = 0;
  sides(box, a, b, h);
  Plate p{a * kMetresPerLdu, b * kMetresPerLdu, kAbsWall, kAbsDensity};
  if (held) p.tune = kHeldFrequency, p.loss = kHeldLossFactor;
  return p;
}
/// The model the unit is clutched into: one plate as large as its footprint, as thick as it is
/// at most kAssemblyThickness, of hollow ABS.
Plate assemblyOf(const bm::Box& box) {
  if (box.empty()) return {};
  double a = 0, b = 0, h = 0;
  sides(box, a, b, h);
  return {a * kMetresPerLdu, b * kMetresPerLdu, std::min(std::max(h - 4, 1.0) * kMetresPerLdu, kAssemblyThickness), kAbsDensity * kAssemblyFill, kHeldFrequency, kHeldLossFactor};
}

struct Mode {
  int kind = 0;  ///< 0 a plate's (m, n); 1 a free beam's k-th bending; 2 a held beam's
  int m, n;
  double hz;
  double mass;    ///< modal mass, kg
  double volume;  ///< air the mode moves per metre of its amplitude, m^3/m (net: odd-odd; else a dipole's share)
  double loss;
};
std::vector<Mode> modesOf(const Plate& p, double top) {
  std::vector<Mode> out;
  if (p.empty()) return out;
  const double d = kAbsYoung * p.h * p.h * p.h / (12 * (1 - kAbsPoisson * kAbsPoisson));
  const double k = M_PI / 2 * std::sqrt(d / (p.rho * p.h));
  for (int m = 1; m <= kModes; m++)
    for (int n = 1; n <= kModes; n++) {
      const double hz = p.tune * k * (std::pow(m / p.a, 2) + std::pow(n / p.b, 2));
      if (hz >= top) continue;
      const double base = p.a * p.b / (m * n * M_PI * M_PI);
      const bool monopole = m % 2 == 1 && n % 2 == 1;
      const double volume = monopole ? 4 * base : base * std::min(1.0, 2 * M_PI * hz * p.a / kSoundSpeed);
      out.push_back({0, m, n, hz, p.rho * p.h * p.a * p.b / 4, volume, p.loss});
    }
  std::sort(out.begin(), out.end(), [](const Mode& x, const Mode& y) { return x.hz < y.hz; });
  return out;
}

/// The part bending as a beam along its longest side (Euler-Bernoulli), its section hollow with
/// kAbsWall walls (solid when too thin for that): free at both ends, or held there (a part in the
/// model). k-th mode: (beta_k L)^2 / (2 pi L^2) sqrt(E I / (rho A)).
std::vector<Mode> beamModesOf(const bm::Box& box, bool held, double top) {
  std::vector<Mode> out;
  if (box.empty()) return out;
  double a = 0, b = 0, h = 0;
  sides(box, a, b, h);
  if (h >= 12) h -= 4;  // a part with studs: the section is below them
  const double length = a * kMetresPerLdu, width = b * kMetresPerLdu, height = h * kMetresPerLdu, t = kAbsWall;
  const bool hollow = width > 3 * t && height > 3 * t;
  const double inW = hollow ? width - 2 * t : 0, inH = hollow ? height - 2 * t : 0;
  const double inertia = (width * std::pow(height, 3) - inW * std::pow(inH, 3)) / 12, area = width * height - inW * inH;
  const double rho = held ? kAbsDensity : kAbsDensity;
  const double c = std::sqrt(kAbsYoung * inertia / (rho * area));
  constexpr double kBeta[4] = {4.730, 7.853, 10.996, 14.137};
  for (int k = 1; k <= 4; k++) {
    const double hz = kBeta[k - 1] * kBeta[k - 1] / (2 * M_PI * length * length) * c;
    if (hz >= top) break;
    // Its shape: held, sqrt2 sin(k pi u) (odd k move air net); free, sqrt2 cos((k+1) pi u), none net.
    const double net = held && k % 2 == 1 ? std::sqrt(2.0) * 2 / (k * M_PI) : 0.0;
    const double volume = width * length * (net > 0 ? net : std::sqrt(2.0) / ((k + 1) * M_PI) * std::min(1.0, 2 * M_PI * hz * length / kSoundSpeed));
    out.push_back({held ? 2 : 1, k, 0, hz, rho * area * length, volume, held ? kHeldLossFactor : kLossFactor});
  }
  return out;
}

/// Where a force acts on a face: spread over it (a flat landing) or at a point (u, v in 0..1).
struct Where {
  bool spread = true;
  double u = 0.5, v = 0.5;
  double weight(const Mode& mode) const {
    if (mode.kind == 1) return spread ? 0.0 : std::sqrt(2.0) * std::cos((mode.m + 1) * M_PI * u);
    if (mode.kind == 2) return spread ? (mode.m % 2 == 1 ? std::sqrt(2.0) * 2 / (mode.m * M_PI) : 0.0) : std::sqrt(2.0) * std::sin(mode.m * M_PI * u);
    if (spread) return mode.m % 2 == 1 && mode.n % 2 == 1 ? 16.0 / (mode.m * mode.n * M_PI * M_PI) : 0.0;
    return std::sin(mode.m * M_PI * u) * std::sin(mode.n * M_PI * v);
  }
};

/// The sound pressure at the microphone of a plate driven by `force` (N, one value a sample from
/// `at`): each mode a damped oscillator, heard by the air its acceleration moves.
void ring(std::vector<double>& out, size_t at, const std::vector<double>& force, const std::vector<Mode>& modes, const Where& where, double scale, double rate) {
  const double dt = 1 / rate, toPressure = kAirDensity / (4 * M_PI * kMicDistance);
  for (const Mode& mode : modes) {
    const double drive = where.weight(mode) * scale / mode.mass;
    if (drive == 0) continue;
    const double w0 = 2 * M_PI * mode.hz, zeta = mode.loss / 2, wd = w0 * std::sqrt(1 - zeta * zeta);
    const double r = std::exp(-zeta * w0 * dt), theta = wd * dt, b1 = r * std::sin(theta) / wd;
    const double gain = toPressure * mode.volume * w0 * w0;
    const size_t ringing = force.size() + static_cast<size_t>(std::log(1e-6) / std::log(r)) + 1;
    double x1 = 0, x2 = 0, u1 = 0;
    for (size_t j = 0; j < ringing && at + j < out.size(); j++) {
      const double x = 2 * r * std::cos(theta) * x1 - r * r * x2 + b1 * u1;
      u1 = j < force.size() ? force[j] * drive * dt : 0.0;
      x2 = x1, x1 = x;
      out[at + j] += gain * x;
    }
  }
}

/// A Hertz impact's force, one value a sample: a half sine of the contact time, its integral the
/// impulse.
std::vector<double> impact(double impulse, double seconds, double rate) {
  const size_t n = std::max<size_t>(1, static_cast<size_t>(std::ceil(seconds * rate)));
  std::vector<double> f(n);
  double sum = 0;
  for (size_t j = 0; j < n; j++) sum += f[j] = std::sin(M_PI * (static_cast<double>(j) + 0.5) / static_cast<double>(n));
  for (double& x : f) x *= impulse * rate / sum;
  return f;
}

/// What one force does: it rings the unit, the part it acts on (the reaction) and, through the
/// clutch, the model.
/// A body's modes: its face as a plate and the whole as a beam.
std::vector<Mode> bodyModes(const Plate& face, const bm::Box& box, bool held, double rate) {
  const double top = std::min(kTopHz, 0.45 * rate);
  std::vector<Mode> modes = face.empty() ? std::vector<Mode>{} : modesOf(face, top);
  const std::vector<Mode> beam = beamModesOf(box, held, top);
  modes.insert(modes.end(), beam.begin(), beam.end());
  return modes;
}
void strike(std::vector<double>& out, size_t at, const std::vector<double>& force, const SnapEvent& e, const Where& where, double rate) {
  ring(out, at, force, bodyModes(faceOf(e.unit), e.unit, false, rate), where, 1.0, rate);
  ring(out, at, force, bodyModes(faceOf(e.touching, true), e.touching, true, rate), where, -1.0, rate);
  if (e.builtPieces > 0) ring(out, at, force, bodyModes(assemblyOf(e.built), bm::Box{}, true, rate), Where{false, 0.5, 0.5}, -kJointTransmission, rate);
}

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

size_t leadSamples(double rate) { return static_cast<size_t>(std::ceil(kSnapLeadSeconds * rate)); }
size_t maxLead(double rate) { return leadSamples(rate); }
int64_t seatSample(const SnapEvent& e, double fps, double rate) { return std::llround(static_cast<double>(e.frame) / fps * rate); }

}  // namespace

std::vector<double> ringHz(const bm::Box& box, double thickness) {
  Plate p = faceOf(box);
  if (thickness > 0) p.h = thickness;
  std::vector<double> out;
  for (const Mode& m : modesOf(p, kTopHz)) out.push_back(m.hz);
  return out;
}

double shellMass(const bm::Box& box) {
  if (box.empty()) return 0;
  double a = 0, b = 0, h = 0;
  sides(box, a, b, h);
  a *= kMetresPerLdu, b *= kMetresPerLdu, h = std::max(h - 4, 1.0) * kMetresPerLdu;  // less its studs
  return kAbsDensity * kAbsWall * (a * b + 2 * (a + b) * h);
}

double hertzSeconds(double mass, double speed) {
  const double e = kAbsYoung / (2 * (1 - kAbsPoisson * kAbsPoisson));
  return 2.868 * std::pow(mass * mass / (kContactRadius * e * e * speed), 0.2);
}

std::vector<float> synthesise(const SnapEvent& e, double fps, const SoundOptions& o, size_t& lead) {
  (void)fps;
  const double rate = o.sampleRate, v = kPressSpeed;
  Rng rng{0xB5C0FFEEull ^ (static_cast<uint64_t>(e.move) * 0x9E3779B97F4A7C15ull)};
  lead = leadSamples(rate);
  std::vector<double> x(lead + static_cast<size_t>(std::ceil(kSnapTailSeconds * rate)), 0.0);
  const bool joined = e.mates > 0;
  const bool lands = !joined || e.joint == bm::connect::JointKind::Fixed || e.ridge;  // else it slides on (an axle)
  const double mass = shellMass(e.unit);

  if (e.ridge) {
    // A Technic pin's ridge: squeezed as it goes through the hole, then letting go.
    const size_t ramp = static_cast<size_t>(kRidgeRamp * rate), release = std::max<size_t>(1, static_cast<size_t>(kRidgeRelease * rate));
    std::vector<double> f(ramp + release);
    for (size_t j = 0; j < ramp; j++) f[j] = kRidgeForce * static_cast<double>(j) / static_cast<double>(ramp);
    for (size_t j = 0; j < release; j++) f[ramp + j] = kRidgeForce * (1 - static_cast<double>(j + 1) / static_cast<double>(release));
    const size_t letGo = lead - static_cast<size_t>(std::lround(kRidgeDepth / v * rate));
    strike(x, letGo - ramp, f, e, Where{false, 0.5, 0.5}, rate);
  }
  if (lands && mass > 0) {
    // The faces meet: a Hertz impact, or two when a long part is pressed a little tilted.
    double a = 0, b = 0, h = 0;
    sides(e.unit, a, b, h);
    const double impulse = mass * v * (1 + kRestitution);
    if (a > kTiltLdu) {
      const double tilt = (kTiltDegrees[0] + (kTiltDegrees[1] - kTiltDegrees[0]) * rng.uniform()) * M_PI / 180;
      const double later = a * kMetresPerLdu * std::sin(tilt) / v;
      const double t = hertzSeconds(mass / 2, v);
      strike(x, lead, impact(kFirstShare * impulse, t, rate), e, Where{false, 0.1, 0.5}, rate);
      strike(x, lead + static_cast<size_t>(std::lround(later * rate)), impact((1 - kFirstShare) * impulse, t, rate), e, Where{false, 0.9, 0.5}, rate);
    } else {
      strike(x, lead, impact(impulse, hertzSeconds(mass, v), rate), e, Where{}, rate);
    }
  } else if (joined) {
    // Sliding on: friction, sticking and slipping, over the length engaged.
    const double seconds = std::min(e.grip * kMetresPerLdu / v, kSlideMaxSeconds);
    const size_t n = static_cast<size_t>(seconds * rate), ease = std::max<size_t>(1, static_cast<size_t>(0.005 * rate));
    std::vector<double> f(n + 2 * ease);
    double held = kFrictionForce;
    for (size_t j = 0; j < f.size(); j++) {
      if (rng.uniform() < kSlipRate / rate) held = kFrictionForce * (1 - kSlipShare * rng.uniform());
      else held += (kFrictionForce - held) * 0.05;
      const double in = std::min(1.0, static_cast<double>(j) / static_cast<double>(ease)), out = std::min(1.0, static_cast<double>(f.size() - j) / static_cast<double>(ease));
      f[j] = held * 0.5 * (1 - std::cos(M_PI * in)) * 0.5 * (1 - std::cos(M_PI * out));
    }
    strike(x, lead - std::min(lead, f.size()), f, e, Where{false, 0.5, 0.5}, rate);
  }
  std::vector<float> out(x.size());
  for (size_t j = 0; j < x.size(); j++) out[j] = static_cast<float>(x[j]);
  return out;
}

struct Mixer::Engine {
  struct Playing {
    std::vector<float> samples;  ///< physics: mono, panned by left and right
    int64_t begin;   ///< the track sample of samples[0]
    double left, right;
    std::vector<float> stereoLeft, stereoRight;  ///< web: already panned
    size_t size() const { return samples.empty() ? stereoLeft.size() : samples.size(); }
  };
  const std::vector<SnapEvent>* events;
  std::vector<size_t> order;  ///< by seat, then as given
  double fps;
  SoundOptions o;
  size_t next = 0;
  int64_t position = 0;
  std::vector<Playing> playing;
  Room roomLeft, roomRight;
  // the web style
  std::vector<WebSnap> snaps;
  std::unique_ptr<WebVoices> voices;
  double duration = 0;

  Engine(const std::vector<SnapEvent>& e, double f, const SoundOptions& options, std::shared_ptr<const std::vector<Recording>> recordings, double seconds)
      : events(&e), fps(f), o(options), roomLeft(options.sampleRate, 0.0), roomRight(options.sampleRate, kStereoSpreadSeconds), duration(seconds) {
    if (o.style == SoundStyle::Web) {
      snaps = webSnaps(e, f);
      voices = std::make_unique<WebVoices>(std::move(recordings), o.web, o.sampleRate);
      return;
    }
    order.resize(e.size());
    for (size_t i = 0; i < e.size(); i++) order[i] = i;
    std::stable_sort(order.begin(), order.end(), [&](size_t a, size_t b) { return e[a].frame < e[b].frame; });
  }
  void raw(double* left, double* right, size_t count) {
    const double rate = o.sampleRate;
    const int64_t early = static_cast<int64_t>(maxLead(rate));
    const bool web = o.style == SoundStyle::Web;
    const int64_t webEarly = static_cast<int64_t>(std::ceil(WebVoices::kLeadSeconds * rate));
    for (size_t i = 0; i < count; i++, position++) {
      // renderSnapTrack: the snaps before the end, the variant from the snap's place in the list
      while (web && next < snaps.size() && static_cast<int64_t>(std::floor(snaps[next].t * rate)) - webEarly <= position) {
        const WebSnap& s = snaps[next];
        const int variant = static_cast<int>(next) * 7919 + static_cast<int>(std::floor(s.t * 1000 + 0.5));
        next++;
        if (!(s.t < duration)) continue;
        StereoVoice v = voices->make(s, variant);
        Playing p;
        p.begin = v.begin, p.left = p.right = 0;
        p.stereoLeft = std::move(v.left), p.stereoRight = std::move(v.right);
        if (!p.stereoLeft.empty()) playing.push_back(std::move(p));
      }
      while (!web && next < order.size() && seatSample((*events)[order[next]], fps, rate) - early <= position) {
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
        if (at >= static_cast<int64_t>(p.size())) {
          over = true;
          continue;
        }
        if (at < 0) continue;
        if (p.samples.empty()) l += p.stereoLeft[static_cast<size_t>(at)], r += p.stereoRight[static_cast<size_t>(at)];
        else l += p.samples[static_cast<size_t>(at)] * p.left, r += p.samples[static_cast<size_t>(at)] * p.right;
      }
      if (over) std::erase_if(playing, [&](const Playing& p) { return position - p.begin >= static_cast<int64_t>(p.size()); });
      left[i] = web ? l : l + o.room * roomLeft(l);
      right[i] = web ? r : r + o.room * roomRight(r);
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
    std::shared_ptr<const std::vector<Recording>> recordings;
    if (options_.style == SoundStyle::Web && options_.web.recorded && !options_.recordings.empty())
      recordings = std::make_shared<const std::vector<Recording>>(loadRecordings(options_.recordings));
    const double seconds = static_cast<double>(frames_) / fps_;
    // The peak, from one pass over the whole track.
    Engine probe(events_, fps_, options_, recordings, seconds);
    double found = 0;
    for (uint64_t at = 0; at < length(); at += kBlock) {
      const size_t n = static_cast<size_t>(std::min<uint64_t>(kBlock, length() - at));
      probe.raw(l.data(), r.data(), n);
      for (size_t i = 0; i < n; i++) found = std::max({found, std::fabs(l[i]), std::fabs(r[i])});
    }
    // the web's renderSnapTrack: its volume scales the peak, never past 0.99
    const double peak = options_.style == SoundStyle::Web ? std::min(0.99, options_.peak * options_.web.volume) : options_.peak;
    scale_ = peak / std::max(found, 1e-15);
    engine_ = std::make_unique<Engine>(events_, fps_, options_, recordings, seconds);
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
