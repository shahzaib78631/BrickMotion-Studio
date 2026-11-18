#include "bms/web_sound.h"

#include <algorithm>
#include <cmath>
#include <complex>
#include <cstring>
#include <fstream>
#include <iterator>

namespace bms {
namespace {

using Complex = std::complex<double>;

// snapSound.ts, snapSamples.ts and anim/snaps.ts constants.
constexpr double kMerge = 0.03;            ///< landings closer than this sound as one (snaps.ts MERGE)
constexpr double kNoiseSeconds = 0.5;      ///< NOISE_SECONDS
constexpr double kRoomSeconds = 0.6;       ///< roomResponse's length
constexpr double kDefaultCutoff = 3300;    ///< DEFAULT_CUTOFF
constexpr double kRecordedThump = 1.0;     ///< RECORDED_THUMP
constexpr double kPieceGap = 0.009;        ///< pieces landing together, each this much later
constexpr double kLaterLevel = 0.6;        ///< and this much softer
constexpr double kWindowLonger = 0.25, kWindowBefore = 0.01, kWindowAfter = 0.03, kWindowFade = 0.008;  ///< CLICK_WINDOW
constexpr double kFilterTail = 0.02;       ///< a filter's ringing kept after its source stops (here, not the web's)
constexpr double kClickLevels[4] = {1, 0.55, 0.4, 0.3};
constexpr double kModes[4][3] = {{3900, 1, 1}, {5350, 0.7, 0.75}, {6900, 0.55, 0.55}, {8300, 0.35, 0.4}};

/// The files in public/sounds/snaps and the size each suits (SNAP_FILES).
struct File {
  const char* name;
  int size;
};
constexpr File kFiles[] = {
    {"fs-click-6.wav", 0}, {"fs-click-7.wav", 0}, {"fs-click-8.wav", 0}, {"fs-click-9.wav", 0}, {"fs-click-2.wav", 0}, {"fs-click-4.wav", 0},
    {"fs-click-3.wav", 1}, {"fs-click-5.wav", 1}, {"fs-double-click-1.wav", 1}, {"fs-double-click-2.wav", 1},
    {"fs-double-click-3.wav", 2}, {"fs-double-click-4.wav", 2}, {"oga-brick-01.wav", 2}, {"oga-brick-10.wav", 2}, {"oga-brick-02.wav", 2},
};

double jsRound(double x) { return std::floor(x + 0.5); }
int sizeOf(int studs) { return studs <= 2 ? 0 : studs <= 6 ? 1 : 2; }  // snapSizeOf

/// Web Audio's BiquadFilterNode (its formulas: lowpass and highpass take Q in dB).
struct Biquad {
  enum Type { Lowpass, Highpass, Bandpass, Peaking, Highshelf };
  double b0 = 1, b1 = 0, b2 = 0, a1 = 0, a2 = 0, x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  Biquad(Type type, double hz, double q, double gainDb, double rate) {
    hz = std::clamp(hz, 1.0, rate / 2 - 1);
    const double w = 2 * M_PI * hz / rate, c = std::cos(w), s = std::sin(w), a = std::pow(10.0, gainDb / 40);
    double B0 = 1, B1 = 0, B2 = 0, A0 = 1, A1 = 0, A2 = 0;
    switch (type) {
      case Lowpass:
      case Highpass: {
        const double al = s / (2 * std::pow(10.0, q / 20));
        const double k = type == Lowpass ? 1 - c : 1 + c;
        B0 = k / 2, B1 = type == Lowpass ? k : -k, B2 = k / 2, A0 = 1 + al, A1 = -2 * c, A2 = 1 - al;
        break;
      }
      case Bandpass: {
        const double al = s / (2 * q);
        B0 = al, B1 = 0, B2 = -al, A0 = 1 + al, A1 = -2 * c, A2 = 1 - al;
        break;
      }
      case Peaking: {
        const double al = s / (2 * q);
        B0 = 1 + al * a, B1 = -2 * c, B2 = 1 - al * a, A0 = 1 + al / a, A1 = -2 * c, A2 = 1 - al / a;
        break;
      }
      case Highshelf: {  // S = 1
        const double sq = 2 * std::sqrt(a) * s / 2 * std::sqrt(2.0);
        B0 = a * ((a + 1) + (a - 1) * c + sq), B1 = -2 * a * ((a - 1) + (a + 1) * c), B2 = a * ((a + 1) + (a - 1) * c - sq);
        A0 = (a + 1) - (a - 1) * c + sq, A1 = 2 * ((a - 1) - (a + 1) * c), A2 = (a + 1) - (a - 1) * c - sq;
        break;
      }
    }
    b0 = B0 / A0, b1 = B1 / A0, b2 = B2 / A0, a1 = A1 / A0, a2 = A2 / A0;
  }
  double operator()(double x) {
    const double y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1, x1 = x, y2 = y1, y1 = y;
    return y;
  }
};

/// snapSamples.ts clickFilter.
struct ClickFilter {
  Biquad stage[4];
  ClickFilter(double cutoff, double rate)
      : stage{{Biquad::Highpass, cutoff, 0.7, 0, rate},
              {Biquad::Highpass, cutoff, 0.7, 0, rate},
              {Biquad::Peaking, std::max(cutoff * 1.45, 1500.0), 1, 3, rate},
              {Biquad::Highshelf, 9000, 0.7, -6, rate}} {}
  double operator()(double x) {
    for (Biquad& b : stage) x = b(x);
    return x;
  }
};

/// snapSound.ts envelope: 0 at `at`, a line up to `peak`, an exponential ramp to 1e-4.
struct Envelope {
  double at, peak, decay, attack = 0.0008;
  double operator()(double t) const {
    if (t < at) return 0;
    if (t < at + attack) return peak * (t - at) / attack;
    if (t < at + attack + decay) return peak > 0 ? peak * std::pow(1e-4 / peak, (t - at - attack) / decay) : 0;
    return 1e-4;
  }
};

/// One snap's mono signal, in track samples from `begin`.
struct Buffer {
  int64_t begin;
  double rate;
  std::vector<double> x;
  int64_t first(double t) const { return static_cast<int64_t>(std::ceil(t * rate)); }
  void add(int64_t n, double v) {
    if (n < begin) return;
    const size_t at = static_cast<size_t>(n - begin);
    if (at >= x.size()) x.resize(at + 1, 0.0);
    x[at] += v;
  }
};

void sine(Buffer& out, double hz, double start, double stop, const Envelope& env) {
  for (int64_t n = out.first(start); n < out.first(stop); n++) {
    const double t = static_cast<double>(n) / out.rate;
    out.add(n, std::sin(2 * M_PI * hz * (t - start)) * env(t));
  }
}

void fft(std::vector<Complex>& a, bool inverse) {
  const size_t n = a.size();
  for (size_t i = 1, j = 0; i < n; i++) {
    size_t bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) std::swap(a[i], a[j]);
  }
  std::vector<Complex> turn(n / 2);
  for (size_t k = 0; k < n / 2; k++) turn[k] = std::polar(1.0, (inverse ? 2 : -2) * M_PI * static_cast<double>(k) / static_cast<double>(n));
  for (size_t len = 2; len <= n; len <<= 1) {
    const size_t step = n / len;
    for (size_t i = 0; i < n; i += len)
      for (size_t j = 0; j < len / 2; j++) {
        const Complex u = a[i + j], v = a[i + j + len / 2] * turn[j * step];
        a[i + j] = u + v, a[i + j + len / 2] = u - v;
      }
  }
  if (inverse)
    for (Complex& v : a) v /= static_cast<double>(n);
}

std::vector<uint8_t> bytesOf(const std::filesystem::path& p) {
  std::ifstream f(p, std::ios::binary);
  return f ? std::vector<uint8_t>(std::istreambuf_iterator<char>(f), {}) : std::vector<uint8_t>{};
}
uint32_t le(const std::vector<uint8_t>& b, size_t at, int n) {
  uint32_t v = 0;
  for (int i = n - 1; i >= 0; i--) v = (v << 8) | b[at + static_cast<size_t>(i)];
  return v;
}

/// A WAV file, mono (channels averaged, as a one-channel context mixes them); false if unreadable.
bool readWav(const std::filesystem::path& path, std::vector<float>& out, int& rate) {
  const std::vector<uint8_t> b = bytesOf(path);
  if (b.size() < 12 || le(b, 0, 4) != 0x46464952u || le(b, 8, 4) != 0x45564157u) return false;  // RIFF, WAVE
  int format = 0, channels = 0, bits = 0;
  for (size_t at = 12; at + 8 <= b.size();) {
    const uint32_t id = le(b, at, 4), size = le(b, at + 4, 4);
    const size_t body = at + 8;
    if (body + size > b.size()) return false;
    if (id == 0x20746d66u && size >= 16) {  // "fmt "
      format = static_cast<int>(le(b, body, 2)), channels = static_cast<int>(le(b, body + 2, 2));
      rate = static_cast<int>(le(b, body + 4, 4)), bits = static_cast<int>(le(b, body + 14, 2));
      if (format == 0xFFFE && size >= 26) format = static_cast<int>(le(b, body + 24, 2));
    } else if (id == 0x61746164u) {  // "data"
      if (channels <= 0 || rate <= 0 || !((format == 1 && (bits == 8 || bits == 16 || bits == 24 || bits == 32)) || (format == 3 && bits == 32))) return false;
      const size_t width = static_cast<size_t>(bits / 8), frames = size / (width * static_cast<size_t>(channels));
      out.assign(frames, 0.0f);
      for (size_t i = 0; i < frames; i++) {
        double sum = 0;
        for (int c = 0; c < channels; c++) {
          const size_t p = body + (i * static_cast<size_t>(channels) + static_cast<size_t>(c)) * width;
          const uint32_t raw = le(b, p, static_cast<int>(width));
          double v = 0;
          if (format == 3) {
            float f;
            std::memcpy(&f, &raw, 4);
            v = f;
          } else if (bits == 8) {
            v = (static_cast<double>(raw) - 128) / 128;
          } else {
            const int shift = 32 - bits;
            v = static_cast<double>(static_cast<int32_t>(raw << shift) >> shift) / std::pow(2.0, bits - 1);
          }
          sum += v;
        }
        out[i] = static_cast<float>(sum / channels);
      }
      return !out.empty();
    }
    at = body + size + (size & 1);
  }
  return false;
}

/// snapSamples.ts measure: where the filtered recording is loudest, and how loud.
void measure(const std::vector<float>& x, int rate, double& at, double& level) {
  ClickFilter f(kDefaultCutoff, rate);
  level = 0, at = 0;
  for (size_t i = 0; i < x.size(); i++) {
    const double y = std::fabs(f(x[i]));
    if (y > level) level = y, at = static_cast<double>(i) / rate;
  }
}

/// snapSamples.ts trimToClick.
std::vector<float> trimToClick(const std::vector<float>& x, int rate, double at) {
  if (static_cast<double>(x.size()) / rate <= kWindowLonger) return x;
  const size_t start = static_cast<size_t>(std::max(0.0, std::floor((at - kWindowBefore) * rate)));
  const size_t end = std::min(x.size(), static_cast<size_t>(std::ceil((at + kWindowAfter) * rate)));
  if (start == 0 && end == x.size()) return x;
  const size_t length = std::max<size_t>(1, end - start);
  std::vector<float> out(x.begin() + static_cast<std::ptrdiff_t>(start), x.begin() + static_cast<std::ptrdiff_t>(start + length));
  const size_t fadeIn = start > 0 ? static_cast<size_t>(jsRound(kWindowFade * rate * 0.5)) : 0;
  const size_t fadeOut = end < x.size() ? static_cast<size_t>(jsRound(kWindowFade * rate)) : 0;
  for (size_t i = 0; i < fadeIn && i < length; i++) out[i] = static_cast<float>(out[i] * (static_cast<double>(i) / static_cast<double>(fadeIn)));
  for (size_t i = 0; i < fadeOut && i < length; i++) out[length - 1 - i] = static_cast<float>(out[length - 1 - i] * (static_cast<double>(i) / static_cast<double>(fadeOut)));
  return out;
}

}  // namespace

bool webPreset(std::string_view name, WebSound& out) {
  WebSound s;
  if (name == "balanced" || name == "default") {
  } else if (name == "product") {
    s.thump = 1, s.room = 0.25;
  } else if (name == "click") {
    s.thump = 0, s.room = 0.08, s.brightness = 2500;
  } else if (name == "soft") {
    s.volume = 0.7, s.click = 0.7, s.brightness = 1800, s.thump = 0.3, s.room = 0.3;
  } else if (name == "synth") {
    s.recorded = false;
  } else {
    return false;
  }
  out = s;
  return true;
}

std::vector<WebSnap> webSnaps(std::span<const SnapEvent> events, double fps) {
  std::vector<WebSnap> ends;
  for (const SnapEvent& e : events) {
    WebSnap s;
    s.t = static_cast<double>(e.frame) / fps;
    if (!std::isfinite(s.t) || s.t < 0) continue;
    const bm::Box& b = e.unit;
    const double w = b.max.x - b.min.x, h = b.max.y - b.min.y, d = b.max.z - b.min.z;
    if (!b.empty() && std::isfinite(w) && std::isfinite(h) && std::isfinite(d)) {
      s.sized = true;
      s.studs = static_cast<int>(std::min(64.0, std::max(1.0, jsRound(w / 20)) * std::max(1.0, jsRound(d / 20))));
      s.height = h;
    }
    ends.push_back(s);
  }
  std::stable_sort(ends.begin(), ends.end(), [](const WebSnap& a, const WebSnap& b) { return a.t < b.t; });
  std::vector<WebSnap> out;
  for (const WebSnap& e : ends) {
    if (!out.empty() && e.t - out.back().t < kMerge) {
      WebSnap& last = out.back();
      last.count++;
      if (e.sized) {
        last.height = last.sized ? std::max(last.height, e.height) : e.height;
        last.studs += e.studs, last.sized = true;
      }
    } else {
      out.push_back(e);
    }
  }
  return out;
}

WebRng::WebRng(int seed) : s_((static_cast<uint32_t>(seed) * 2654435761u) ^ 0x9e3779b9u) {}
double WebRng::operator()() {
  s_ += 0x6d2b79f5u;
  uint32_t t = s_;
  t = (t ^ (t >> 15)) * (t | 1u);
  t ^= t + (t ^ (t >> 7)) * (t | 61u);
  return static_cast<double>(t ^ (t >> 14)) / 4294967296.0;
}

WebCharacter webCharacter(bool sized, int studs, double height) {
  const int n = sized ? std::clamp(studs, 1, 64) : 2;
  const bool tall = (sized ? height : 8) >= 20;  // a brick (24 LDU), not a plate or tile (8)
  const double size = std::log2(static_cast<double>(n));
  return {n <= 2 ? 2 : n <= 6 ? 3 : 4,
          0.014 + 0.003 * std::min(size, 4.0),
          0.03 + 0.01 * std::min(size, 4.0),
          (1.12 - 0.05 * size) * (tall ? 0.92 : 1),
          0.035 + 0.008 * size,
          (tall ? 105 : 135) - 6 * size,
          (tall ? 0.75 : 0.5) + 0.05 * size,
          (tall ? 0.2 : 0.14) + 0.012 * size};
}

std::vector<Recording> loadRecordings(const std::filesystem::path& dir) {
  std::vector<Recording> out;
  try {
    for (const File& f : kFiles) {
      Recording r;
      r.file = f.name, r.size = f.size, r.freesound = r.file.rfind("fs-", 0) == 0;
      std::vector<float> decoded;
      if (!readWav(dir / f.name, decoded, r.rate)) continue;
      double at = 0, level = 0;
      measure(decoded, r.rate, at, level);
      r.samples = trimToClick(decoded, r.rate, at);
      measure(r.samples, r.rate, at, level);
      r.peak = at, r.gain = level > 1e-4 ? 1 / level : 1;
      out.push_back(std::move(r));
    }
  } catch (...) {
    out.clear();
  }
  return out;
}

struct WebVoices::Impl {
  std::vector<const Recording*> usable;  ///< the chosen library's, or empty: the synthesised click
  std::shared_ptr<const std::vector<Recording>> recordings;
  WebSound sound;
  double rate;
  std::vector<float> noise;
  std::vector<float> room[2];
  double roomScale = 0;
  std::vector<Complex> roomSpectrum;  ///< FFT of room[0] + i room[1], scaled, at its size
  std::map<int, const Recording*> last;  ///< chooseSample's memory: 0-2 a size, 3 any

  Impl(std::shared_ptr<const std::vector<Recording>> r, const WebSound& s, int sampleRate) : recordings(std::move(r)), sound(s), rate(sampleRate) {
    if (sound.recorded && recordings) {
      for (const Recording& rec : *recordings)
        if (sound.library == WebSound::Library::All || (sound.library == WebSound::Library::Freesound) == rec.freesound) usable.push_back(&rec);
      if (usable.empty())
        for (const Recording& rec : *recordings) usable.push_back(&rec);
    }
    noise.resize(static_cast<size_t>(std::ceil(rate * kNoiseSeconds)));
    WebRng nr(12345);
    for (float& v : noise) v = static_cast<float>(nr() * 2 - 1);
    // roomResponse: decaying stereo noise that darkens as it fades; the convolver normalises it.
    const size_t len = static_cast<size_t>(std::ceil(rate * kRoomSeconds));
    double power = 0;
    for (int c = 0; c < 2; c++) {
      room[c].resize(len);
      WebRng rr(777 + c);
      double lp = 0;
      for (size_t i = 0; i < len; i++) {
        const double t = static_cast<double>(i) / rate, k = std::max(0.06, 0.9 - t * 3);
        lp += k * ((rr() * 2 - 1) - lp);
        room[c][i] = static_cast<float>(lp * std::exp(-t / 0.1) * (t < 0.004 ? t / 0.004 : 1));
        power += static_cast<double>(room[c][i]) * room[c][i];
      }
    }
    power = std::sqrt(power / (2.0 * static_cast<double>(len)));
    if (!std::isfinite(power) || power < 0.000125) power = 0.000125;
    roomScale = 0.00125 / power * 44100 / rate;
  }

  const Recording& choose(int size, double pick) {
    std::vector<const Recording*> pool;
    for (const Recording* r : usable)
      if (size == 3 || r->size == size) pool.push_back(r);
    if (pool.empty()) pool = usable;
    const auto prev = last.find(size);
    if (pool.size() > 1 && prev != last.end()) std::erase(pool, prev->second);
    const Recording* chosen = pool[std::min(pool.size() - 1, static_cast<size_t>(std::floor(pick * static_cast<double>(pool.size()))))];
    last[size] = chosen;
    return *chosen;
  }

  /// noiseSource through `filter`, times `gain(t)`.
  template <class Gain>
  void noiseBurst(Buffer& out, double at, double length, WebRng& r, Biquad filter, Gain gain) {
    const double offset = r() * (kNoiseSeconds - length - 0.01);
    const int64_t stop = out.first(at + length + 0.01), end = out.first(at + length + 0.01 + kFilterTail);
    for (int64_t n = out.first(at); n < end; n++) {
      const double t = static_cast<double>(n) / rate;
      double x = 0;
      if (n < stop) {
        const size_t i = static_cast<size_t>(std::floor((offset + t - at) * rate));
        x = i < noise.size() ? noise[i] : 0.0;
      }
      out.add(n, filter(x) * gain(t));
    }
  }

  void click(Buffer& out, double at, double amp, double pitch, double ring, WebRng& r) {
    const Envelope crack{at, amp * 0.9, 0.004};
    noiseBurst(out, at, 0.01, r, Biquad(Biquad::Highpass, 1800, 1, 0, rate), crack);
    for (const auto& [hz, a, d] : kModes) {
      const double f = hz * pitch * (1 + (r() - 0.5) * 0.04);
      sine(out, f, at, at + ring * d + 0.01, Envelope{at, amp * a * 0.35, ring * d});
    }
  }

  void thump(Buffer& out, double at, double hz, double amp, double decay, WebRng& r) {
    if (!(amp > 0)) return;
    const Envelope env{at, amp, decay, 0.002};
    // its pitch falls from 1.5 hz to hz over 30 ms, exponentially; the phase is that integral
    const double sweep = 0.03, fall = 1 / 1.5, start = hz * 1.5;
    for (int64_t n = out.first(at); n < out.first(at + decay + 0.01); n++) {
      const double t = static_cast<double>(n) / rate, u = t - at;
      const double phase = u < sweep ? start * sweep * (std::pow(fall, u / sweep) - 1) / std::log(fall)
                                     : start * sweep * (fall - 1) / std::log(fall) + hz * (u - sweep);
      out.add(n, std::sin(2 * M_PI * phase) * env(t));
    }
    noiseBurst(out, at, 0.04, r, Biquad(Biquad::Lowpass, 500, 1, 0, rate), Envelope{at, amp * 0.35, 0.03});
  }

  void slide(Buffer& out, double at, double length, double pitch, WebRng& r) {
    const double start = std::max(0.0, at - length);
    if (at - start < 0.005) return;
    const double top = at - 0.003;
    noiseBurst(out, start, at - start, r, Biquad(Biquad::Bandpass, 3200 * pitch, 0.8, 0, rate), [&](double t) {
      if (t < start || t >= at) return 0.0;
      return t < top ? 0.05 * (t - start) / (top - start) : 0.05 * (at - t) / (at - top);
    });
  }

  double vary(WebRng& r, double spread) const { return 1 + (r() - 0.5) * spread * sound.variation * 2; }

  void bodyThump(Buffer& out, double at, const WebCharacter& c, double level, WebRng& r) {
    const double hz = c.thumpHz * sound.thumpPitch * (1 + (r() - 0.5) * 0.1 * sound.variation * 2);
    thump(out, at, hz, c.thump * level * sound.thump, c.thumpDecay * sound.thumpLength, r);
  }

  void seat(Buffer& out, double at, const WebSnap& v, double level, WebRng& r) {
    const WebCharacter c = sound.sizeMatch ? webCharacter(v.sized, v.studs, v.height) : webCharacter(true, 2, v.sized ? v.height : 8);
    const double pitch = (sound.sizePitch ? c.pitch : 1.05) * sound.pitch;
    const double clickLevel = level * sound.click;
    if (clickLevel > 0) {
      const double slideLength = c.slide * vary(r, 0.3);
      slide(out, at, slideLength, pitch, r);
      click(out, at - c.slide * 0.45, 0.1 * clickLevel, pitch * 1.1, 0.01, r);  // the first stud edge meeting its socket
      double t = at;
      for (int i = 0; i < c.clicks; i++) {
        const double amp = clickLevel * kClickLevels[i] * vary(r, 0.2);
        click(out, t, amp, pitch * (1 - i * 0.015), c.ring, r);
        t += c.gap * vary(r, 0.4);
      }
    }
    bodyThump(out, at, c, level, r);
  }

  void recorded(Buffer& out, double at, const WebSnap& v, double level, WebRng& r) {
    const WebCharacter c = webCharacter(v.sized, v.studs, v.height);
    const Recording& rec = choose(sound.sizeMatch ? sizeOf(v.sized ? v.studs : 2) : 3, r());
    const double speed = std::min(2.0, std::max(0.5, (sound.sizePitch ? c.pitch / 1.05 : 1) * sound.pitch * vary(r, 0.03)));
    const double gain = 1.6 * rec.gain * level * sound.click * vary(r, 0.1);
    if (gain > 0) {
      // its loudest moment on `at`; one whose start has passed plays from part-way in
      const double start = at - rec.peak / speed;
      ClickFilter filter(sound.brightness, rate);
      const double length = static_cast<double>(rec.samples.size());
      const int64_t end = out.first(start + length / (speed * rec.rate) + kFilterTail);
      for (int64_t n = out.first(std::max(start, 0.0)); n < end; n++) {
        const double pos = (static_cast<double>(n) / rate - start) * speed * rec.rate;
        double x = 0;
        if (pos < length) {
          const size_t i = static_cast<size_t>(pos);
          const double frac = pos - static_cast<double>(i);
          x = rec.samples[i] * (1 - frac) + (i + 1 < rec.samples.size() ? rec.samples[i + 1] : 0.0f) * frac;
        }
        out.add(n, filter(x) * gain);
      }
    }
    bodyThump(out, at, c, level * kRecordedThump, r);
  }
};

WebVoices::WebVoices(std::shared_ptr<const std::vector<Recording>> recordings, const WebSound& sound, int sampleRate)
    : impl_(std::make_unique<Impl>(std::move(recordings), sound, sampleRate)) {}
WebVoices::~WebVoices() = default;

StereoVoice WebVoices::make(const WebSnap& snap, int variant) {
  Impl& m = *impl_;
  WebRng r(variant);
  const double pan = (r() - 0.5) * m.sound.stereo;
  Buffer mono{static_cast<int64_t>(std::floor((snap.t - kLeadSeconds) * m.rate)), m.rate, {}};
  const int count = std::max(1, snap.count);
  WebSnap per = snap;
  if (per.sized) per.studs = static_cast<int>(std::max(1.0, jsRound(static_cast<double>(snap.studs) / count)));
  for (int i = 0; i < std::min(count, std::max(1, m.sound.together)); i++) {
    const double at = snap.t + i * kPieceGap, level = i ? kLaterLevel : 1;
    if (!m.usable.empty()) m.recorded(mono, at, per, level, r);
    else m.seat(mono, at, per, level, r);
  }
  // the stereo panner (a mono input), then dry and the room's send
  const double x = (std::clamp(pan, -1.0, 1.0) + 1) / 2, gl = std::cos(x * M_PI / 2), gr = std::sin(x * M_PI / 2);
  const size_t n = mono.x.size(), roomLength = m.room[0].size();
  StereoVoice out;
  out.begin = mono.begin;
  const size_t total = m.sound.room > 0 && n > 0 ? n + roomLength - 1 : n;
  out.left.assign(total, 0.0f), out.right.assign(total, 0.0f);
  std::vector<double> wetL(total, 0.0), wetR(total, 0.0);
  if (m.sound.room > 0 && n > 0) {
    size_t size = 1;
    while (size < total) size <<= 1;
    if (m.roomSpectrum.size() != size) {
      m.roomSpectrum.assign(size, Complex{});
      for (size_t i = 0; i < roomLength; i++) m.roomSpectrum[i] = Complex(m.room[0][i], m.room[1][i]) * m.roomScale;
      fft(m.roomSpectrum, false);
    }
    std::vector<Complex> a(size);
    for (size_t i = 0; i < n; i++) a[i] = mono.x[i];
    fft(a, false);
    for (size_t i = 0; i < size; i++) a[i] *= m.roomSpectrum[i];
    fft(a, true);  // real: through the left response; imaginary: the right
    for (size_t i = 0; i < total; i++) wetL[i] = m.sound.room * gl * a[i].real(), wetR[i] = m.sound.room * gr * a[i].imag();
  }
  for (size_t i = 0; i < total; i++) {
    const double dry = i < n ? mono.x[i] : 0.0;
    out.left[i] = static_cast<float>(dry * gl + wetL[i]);
    out.right[i] = static_cast<float>(dry * gr + wetR[i]);
  }
  return out;
}

}  // namespace bms
