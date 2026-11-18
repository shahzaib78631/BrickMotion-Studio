// The snap track: where each snap lands, what shapes its sound, and that blocks do not matter.
#include <catch2/catch_test_macros.hpp>
#include <algorithm>
#include <cmath>
#include <cstring>
#include <vector>
#include "bms/snap_synth.h"

using namespace bms;

namespace {
bm::Box box(double w, double h, double d) {
  bm::Box b;
  b.grow({-w / 2, -4, -d / 2});
  b.grow({w / 2, h - 4, d / 2});
  return b;
}
/// A 2x4 brick onto a 2x4 brick, seated at `frame`.
SnapEvent brick(int frame, uint32_t move = 1) {
  SnapEvent e;
  e.frame = frame, e.move = move, e.mates = 8, e.grip = 32;
  e.unit = box(80, 28, 40), e.touching = box(80, 28, 40), e.built = e.touching;
  e.unit.min.y -= 24, e.unit.max.y -= 24;
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
/// Clicks: peaks of the high-passed envelope (1 ms windows) above 30% of the loudest, 8 ms apart.
int clicks(const std::vector<float>& x) {
  std::vector<double> hp(x.size());
  for (size_t n = 2; n < x.size(); n++) hp[n] = x[n] - 2.0 * x[n - 1] + x[n - 2];
  std::vector<double> env;
  for (size_t at = 0; at < hp.size(); at += 48) {
    double m = 0;
    for (size_t n = at; n < at + 48 && n < hp.size(); n++) m = std::max(m, std::fabs(hp[n]));
    env.push_back(m);
  }
  const double top = *std::max_element(env.begin(), env.end());
  int count = 0, last = -100;
  for (int i = 1; i + 1 < static_cast<int>(env.size()); i++)
    if (env[i] > 0.3 * top && env[i] >= env[i - 1] && env[i] >= env[i + 1] && i - last > 8) count++, last = i;
  return count;
}
}  // namespace

TEST_CASE("the same events give the same samples, in any block size", "[sound][synth]") {
  const std::vector<SnapEvent> events = {brick(10, 1), brick(12, 2), brick(40, 3)};
  auto blocks = [&](size_t size) {
    Mixer m(events, 60, 30);
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

TEST_CASE("each click lands on its frame", "[sound][synth]") {
  Mixer m({brick(30)}, 60, 30);
  std::vector<float> r;
  const std::vector<float> l = whole(m, &r);
  size_t loudest = 0;
  for (size_t i = 0; i < l.size(); i++)
    if (std::max(std::fabs(l[i]), std::fabs(r[i])) > std::max(std::fabs(l[loudest]), std::fabs(r[loudest]))) loudest = i;
  REQUIRE(loudest >= 48000);
  REQUIRE(loudest <= 48000 + 144);
}

TEST_CASE("more mates give more clicks", "[sound][synth]") {
  SoundOptions dry;
  dry.room = 0;
  SnapEvent few = brick(30), many = brick(30);
  few.mates = 1, many.mates = 8;
  size_t lead = 0;
  REQUIRE(clicks(synthesise(few, 30, dry, lead)) == 2);
  REQUIRE(clicks(synthesise(many, 30, dry, lead)) == 4);
}

TEST_CASE("a bigger part rings lower", "[sound][synth]") {
  SnapEvent big = brick(30), small = brick(30);
  small.unit = box(20, 8, 20);
  small.unit.min.y -= 8, small.unit.max.y -= 8;
  auto centroid = [](const SnapEvent& e) {
    size_t lead = 0;
    const std::vector<float> x = synthesise(e, 30, SoundOptions{}, lead);
    double sum = 0, weighted = 0;
    for (double hz = 1000; hz <= 20000; hz += 100) {
      const double p = std::pow(magnitude(x, lead, lead + 2400, hz, 48000), 2);
      sum += p, weighted += p * hz;
    }
    return weighted / sum;
  };
  const double b = centroid(big), s = centroid(small);
  INFO("2x4 brick " << b << " Hz, 1x1 tile " << s << " Hz");
  REQUIRE(b < s);
}

TEST_CASE("a bigger model thumps lower", "[sound][synth]") {
  auto lowPeak = [](uint32_t built) {
    SnapEvent e = brick(30);
    e.builtPieces = built;
    size_t lead = 0;
    const std::vector<float> x = synthesise(e, 30, SoundOptions{}, lead);
    double best = 0, at = 0;
    for (double hz = 20; hz <= 300; hz += 1) {
      const double m = magnitude(x, lead, x.size(), hz, 48000);
      if (m > best) best = m, at = hz;
    }
    return at;
  };
  const double small = lowPeak(10), big = lowPeak(2000);
  INFO("10 pieces " << small << " Hz, 2000 pieces " << big << " Hz");
  REQUIRE(big < small);
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
