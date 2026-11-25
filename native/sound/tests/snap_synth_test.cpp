// The snap track from physics: when a part lands, what rings, and that blocks do not matter.
#include <catch2/catch_test_macros.hpp>
#include <algorithm>
#include <cmath>
#include <cstring>
#include <vector>
#include "bms/snap_synth.h"
#include "bms/tolerances.h"

using namespace bms;

namespace {
/// A part w x d LDU across, h high (studs 4 more), its top at `top` (y down).
bm::Box box(double w, double h, double d, double top = 0) {
  bm::Box b;
  b.grow({-w / 2, top - 4, -d / 2});
  b.grow({w / 2, top + h, d / 2});
  return b;
}
/// A 2x4 brick pressed onto a 2x4 brick, seated at `frame`.
SnapEvent brick(int frame, uint32_t move = 1) {
  SnapEvent e;
  e.frame = frame, e.move = move, e.mates = 8, e.grip = 32;
  e.unit = box(80, 24, 40, -24), e.touching = box(80, 24, 40);
  e.built = e.touching;
  e.built.merge(e.unit);
  e.builtPieces = 10, e.seatSeconds = 0.1;
  return e;
}
std::vector<float> whole(Mixer& m, std::vector<float>* right = nullptr) {
  std::vector<float> l(m.length()), r(m.length());
  m.render(l.data(), r.data(), l.size());
  if (right) *right = r;
  return l;
}
double magnitude(const std::vector<float>& x, size_t from, size_t to, double hz, double rate) {
  double re = 0, im = 0;
  for (size_t n = from; n < to && n < x.size(); n++) {
    const double a = 2 * M_PI * hz * static_cast<double>(n - from) / rate;
    re += x[n] * std::cos(a), im -= x[n] * std::sin(a);
  }
  return std::sqrt(re * re + im * im);
}
double peakOf(const std::vector<float>& x, size_t from = 0, size_t to = SIZE_MAX) {
  double m = 0;
  for (size_t n = from; n < std::min(to, x.size()); n++) m = std::max(m, std::fabs(static_cast<double>(x[n])));
  return m;
}
/// Impacts: peaks of the high-passed envelope (0.5 ms windows) above 30% of the loudest, 2 ms apart.
int impacts(const std::vector<float>& x) {
  std::vector<double> hp(x.size());
  for (size_t n = 2; n < x.size(); n++) hp[n] = x[n] - 2.0 * x[n - 1] + x[n - 2];
  std::vector<double> env;
  for (size_t at = 0; at < hp.size(); at += 24) {
    double m = 0;
    for (size_t n = at; n < at + 24 && n < hp.size(); n++) m = std::max(m, std::fabs(hp[n]));
    env.push_back(m);
  }
  const double top = *std::max_element(env.begin(), env.end());
  int count = 0, last = -100;
  for (int i = 1; i + 1 < static_cast<int>(env.size()); i++)
    if (env[i] > 0.3 * top && env[i] >= env[i - 1] && env[i] >= env[i + 1] && i - last > 4) count++, last = i;
  return count;
}
}  // namespace

TEST_CASE("a part's own tones are its face's plate modes", "[sound][synth]") {
  const std::vector<double> b24 = ringHz(box(80, 24, 40)), b22 = ringHz(box(40, 24, 40));
  REQUIRE_FALSE(b24.empty());
  REQUIRE(b24.front() > 4000);  // f11 of a 32 x 16 mm, 1.5 mm ABS plate: about 5.2 kHz
  REQUIRE(b24.front() < 6500);
  REQUIRE(std::is_sorted(b24.begin(), b24.end()));
  REQUIRE(b22.front() > b24.front());          // smaller rings higher
  REQUIRE(ringHz(box(20, 8, 20)).empty());     // a 1x1 rings above hearing
}

TEST_CASE("a heavier part strikes longer, as Hertz says", "[sound][synth]") {
  const double m = shellMass(box(80, 24, 40));
  REQUIRE(m > 2.0e-3);  // a real 3001 weighs 2.32 g
  REQUIRE(m < 2.6e-3);
  const double t = hertzSeconds(m, kPressSpeed);
  REQUIRE(t > 1e-4);
  REQUIRE(t < 1e-3);
  REQUIRE(std::fabs(hertzSeconds(8 * m, kPressSpeed) / t - std::pow(8.0, 0.4)) < 1e-9);
}

TEST_CASE("the sound starts when the part lands", "[sound][synth]") {
  Mixer m({brick(30)}, 60, 30);
  std::vector<float> r;
  const std::vector<float> l = whole(m, &r);
  const double top = std::max(peakOf(l), peakOf(r));
  size_t onset = 0;
  while (onset < l.size() && std::max(std::fabs(l[onset]), std::fabs(r[onset])) < 0.1 * top) onset++;
  REQUIRE(onset >= 48000 - 24);
  REQUIRE(onset <= 48000 + 48);
}

TEST_CASE("a long part pressed a little tilted lands in two impacts; a 1x1 in one", "[sound][synth]") {
  size_t lead = 0;
  REQUIRE(impacts(synthesise(brick(30), 30, SoundOptions{}, lead)) == 2);
  SnapEvent tile = brick(30);
  tile.unit = box(20, 8, 20, -8), tile.mates = 1;
  REQUIRE(impacts(synthesise(tile, 30, SoundOptions{}, lead)) == 1);
}

TEST_CASE("the model it lands on rings lower as it grows", "[sound][synth]") {
  auto lowCentre = [](double width) {
    SnapEvent e = brick(30);
    e.built = box(width, 48, width);
    size_t lead = 0;
    const std::vector<float> x = synthesise(e, 30, SoundOptions{}, lead);
    double sum = 0, weighted = 0;  // the spectral centroid below 5 kHz
    for (double hz = 50; hz <= 5000; hz += 10) {
      const double p = std::pow(magnitude(x, lead, x.size(), hz, 48000), 2);
      sum += p, weighted += p * hz;
    }
    return weighted / sum;
  };
  const double small = lowCentre(400), big = lowCentre(800);
  INFO("20x20 studs " << small << " Hz, 40x40 studs " << big << " Hz");
  REQUIRE(big < small);
}

TEST_CASE("a Technic pin's ridge lets go before its collar lands", "[sound][synth]") {
  SnapEvent pin = brick(30);
  pin.unit = box(40, 16, 16, -16), pin.touching = box(120, 20, 20), pin.mates = 2, pin.ridge = true;
  pin.joint = bm::connect::JointKind::Revolute;
  size_t lead = 0;
  const std::vector<float> p = synthesise(pin, 30, SoundOptions{}, lead);
  const size_t ms = 48;
  REQUIRE(lead > 25 * ms);
  REQUIRE(peakOf(p, lead - 25 * ms, lead - 5 * ms) > 0.1 * peakOf(p));
  const std::vector<float> b = synthesise(brick(30), 30, SoundOptions{}, lead);
  REQUIRE(peakOf(b, lead - 25 * ms, lead - 5 * ms) < 0.01 * peakOf(b));
}

TEST_CASE("an axle only rubs: at least 10 dB quieter than a brick landing", "[sound][synth]") {
  SnapEvent axle = brick(30);
  axle.unit = box(80, 8, 8, -8), axle.touching = box(120, 20, 20), axle.mates = 2, axle.grip = 40;
  axle.joint = bm::connect::JointKind::Cylindrical;
  size_t lead = 0;
  const std::vector<float> a = synthesise(axle, 30, SoundOptions{}, lead);
  REQUIRE(peakOf(a) > 0);
  REQUIRE(peakOf(a) < 0.316 * peakOf(synthesise(brick(30), 30, SoundOptions{}, lead)));
}

TEST_CASE("the same events give the same samples, in any block size", "[sound][synth]") {
  const std::vector<SnapEvent> events = {brick(10, 1), brick(12, 2), brick(40, 3)};
  SoundOptions room;
  room.room = 0.2;  // the reverb keeps its state across blocks
  auto blocks = [&](size_t size) {
    Mixer m(events, 60, 30, room);
    std::vector<float> l(m.length()), r(m.length());
    for (size_t at = 0; at < l.size(); at += size) m.render(l.data() + at, r.data() + at, std::min(size, l.size() - at));
    l.insert(l.end(), r.begin(), r.end());
    return l;
  };
  const std::vector<float> one = blocks(1), odd = blocks(997), all = blocks(1u << 30);
  REQUIRE(one.size() == 2 * 96000);
  REQUIRE(std::memcmp(one.data(), odd.data(), one.size() * sizeof(float)) == 0);
  REQUIRE(std::memcmp(one.data(), all.data(), one.size() * sizeof(float)) == 0);
}

TEST_CASE("the track is exactly as long as the film", "[sound][synth]") {
  REQUIRE(Mixer({}, 45000, 30).length() == static_cast<uint64_t>(std::ceil(45000 / 30.0 * 48000)));
  REQUIRE(Mixer({}, 7, 30).length() == static_cast<uint64_t>(std::ceil(7 / 30.0 * 48000)));
}

TEST_CASE("no seatings is silence", "[sound][synth]") {
  Mixer m({}, 90, 30);
  std::vector<float> r;
  const std::vector<float> l = whole(m, &r);
  REQUIRE(l.size() == 144000);
  for (size_t i = 0; i < l.size(); i++) {
    REQUIRE(l[i] == 0.0f);
    REQUIRE(r[i] == 0.0f);
  }
}

TEST_CASE("the loudest sample is the peak asked for", "[sound][synth]") {
  Mixer m({brick(10), brick(25, 2)}, 60, 30);
  std::vector<float> r;
  const std::vector<float> l = whole(m, &r);
  double top = 0;
  for (size_t i = 0; i < l.size(); i++) {
    REQUIRE_FALSE(std::isnan(l[i]));
    top = std::max({top, std::fabs(static_cast<double>(l[i])), std::fabs(static_cast<double>(r[i]))});
  }
  REQUIRE(std::fabs(top - 0.89) < 1e-6);
}

TEST_CASE("a 1x1 is heard: the click of being stopped short, when nothing it meets rings in hearing", "[sound][synth]") {
  // A 1x1 brick onto a lone 1x1 brick: every plate and beam mode of both is above 20 kHz.
  SnapEvent small = brick(30);
  small.unit = box(20, 24, 20, -24), small.touching = box(20, 24, 20), small.mates = 1;
  small.built = small.touching;
  small.builtPieces = 0;
  REQUIRE(ringHz(small.unit).empty());
  size_t lead = 0;
  const std::vector<float> x = synthesise(small, 30, SoundOptions{}, lead);
  // A click as long as the Hertz contact, broadband: energy across the kHz, nothing after it.
  const double contact = hertzSeconds(shellMass(small.unit), kPressSpeed);
  INFO("contact " << contact * 1e6 << " us, peak " << peakOf(x));
  REQUIRE(contact > 50e-6);
  REQUIRE(contact < 1e-3);
  REQUIRE(peakOf(x, lead, lead + static_cast<size_t>(std::ceil(contact * 48000)) + 2) > 0);
  CHECK(peakOf(x, lead + static_cast<size_t>(std::ceil(contact * 48000)) + 2) == 0);
  CHECK(peakOf(x, 0, lead) == 0);
  const double low = magnitude(x, lead, x.size(), 1000, 48000), high = magnitude(x, lead, x.size(), 4000, 48000);
  CHECK(low > 0);
  CHECK(high > low);  // da/dt: rising with frequency below 1 / contact
  // Smaller and lighter, it is quieter than a 2x4 landing, yet clearly there (within 40 dB).
  const std::vector<float> b = synthesise(brick(30), 30, SoundOptions{}, lead);
  INFO("2x4 peak " << peakOf(b));
  CHECK(peakOf(x) < peakOf(b));
  CHECK(peakOf(x) > 0.01 * peakOf(b));
}
