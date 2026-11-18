// The web app's snap sound, ported: the same numbers, the same snaps, and a switch to it.
#include <catch2/catch_test_macros.hpp>
#include <algorithm>
#include <cmath>
#include <cstring>
#include <filesystem>
#include <vector>
#include "bms/snap_synth.h"
#include "bms/web_sound.h"

using namespace bms;
namespace fs = std::filesystem;

namespace {
bm::Box box(double w, double h, double d, double top = 0) {
  bm::Box b;
  b.grow({-w / 2, top - 4, -d / 2});
  b.grow({w / 2, top + h, d / 2});
  return b;
}
SnapEvent brick(int frame, uint32_t move = 1) {
  SnapEvent e;
  e.frame = frame, e.move = move, e.mates = 8, e.grip = 32;
  e.unit = box(80, 24, 40, -24), e.touching = box(80, 24, 40);
  e.built = e.touching;
  e.built.merge(e.unit);
  e.builtPieces = 10, e.seatSeconds = 0.1;
  return e;
}
SoundOptions web(bool recorded = true) {
  SoundOptions o;
  o.style = SoundStyle::Web;
  if (recorded) o.recordings = BM_RECORDINGS;
  o.web.recorded = recorded;
  return o;
}
bool haveRecordings() { return fs::exists(fs::path(BM_RECORDINGS) / "fs-click-2.wav"); }
std::vector<float> track(Mixer& m, std::vector<float>* right = nullptr) {
  std::vector<float> l(m.length()), r(m.length());
  m.render(l.data(), r.data(), l.size());
  if (right) *right = r;
  return l;
}
}  // namespace

TEST_CASE("the web's random numbers are the web's", "[sound][web]") {
  const std::vector<std::pair<int, std::vector<double>>> expected = {
      {0, {0.35888998024165630, 0.10590326134115458, 0.67529047932475805, 0.91793455881997943, 0.10157715040259063}},
      {7919, {0.78194438596256077, 0.0078999986872076988, 0.89259925787337124, 0.21979727339930832, 0.051090262597426772}},
      {12345, {0.12116127344779670, 0.15737345814704895, 0.82874466385692358, 0.075325717683881521, 0.77041146159172058}},
      {778, {0.43085729517042637, 0.082275433698669076, 0.45533385267481208, 0.94192701042629778, 0.55450252513401210}},
  };
  for (const auto& [seed, values] : expected) {
    WebRng r(seed);
    for (double v : values) REQUIRE(r() == v);
  }
}

TEST_CASE("a part's character is the web's", "[sound][web]") {
  const WebCharacter big = webCharacter(true, 8, 28), small = webCharacter(true, 1, 8);
  REQUIRE(big.clicks == 4);
  REQUIRE(std::fabs(big.gap - 0.023) < 1e-15);
  REQUIRE(std::fabs(big.pitch - 0.8924) < 1e-15);
  REQUIRE(big.thumpHz == 87);
  REQUIRE(std::fabs(big.thumpDecay - 0.236) < 1e-15);
  REQUIRE(small.clicks == 2);
  REQUIRE(small.thumpHz == 135);
  REQUIRE(webCharacter(false, 0, 0).clicks == 2);  // no size: two studs, a plate
}

TEST_CASE("the web's presets", "[sound][web]") {
  WebSound s;
  REQUIRE(webPreset("product", s));
  REQUIRE(s.thump == 1);
  REQUIRE(s.room == 0.25);
  REQUIRE(webPreset("click", s));
  REQUIRE(s.thump == 0);
  REQUIRE(s.room == 0.08);
  REQUIRE(s.brightness == 2500);
  REQUIRE(webPreset("soft", s));
  REQUIRE(s.volume == 0.7);
  REQUIRE(s.brightness == 1800);
  REQUIRE(webPreset("synth", s));
  REQUIRE_FALSE(s.recorded);
  REQUIRE(webPreset("balanced", s));
  REQUIRE(s.recorded);
  REQUIRE_FALSE(webPreset("sunset", s));
}

TEST_CASE("landings within 30 ms sound as one, as the web merges them", "[sound][web]") {
  const std::vector<SnapEvent> events = {brick(30, 1), brick(30, 2), brick(60, 3)};
  const std::vector<WebSnap> snaps = webSnaps(events, 30);
  REQUIRE(snaps.size() == 2);
  REQUIRE(snaps[0].count == 2);
  REQUIRE(snaps[0].studs == 16);  // two 2x4 footprints
  REQUIRE(snaps[0].height == 28);  // one 2x4 brick: 24 LDU and its studs
  REQUIRE(snaps[0].t == 1.0);
  REQUIRE(snaps[1].count == 1);
}

TEST_CASE("the recordings load as the web loads them", "[sound][web]") {
  if (!haveRecordings()) SKIP("no public/sounds/snaps");
  const std::vector<Recording> recs = loadRecordings(BM_RECORDINGS);
  REQUIRE(recs.size() == 15);
  int sizes[3] = {};
  for (const Recording& r : recs) {
    sizes[r.size]++;
    REQUIRE(r.rate == 44100);
    REQUIRE(r.gain > 0);
    REQUIRE(r.peak >= 0);
    REQUIRE(r.peak * r.rate < r.samples.size());
    if (r.file.rfind("oga-", 0) == 0) REQUIRE(r.samples.size() <= static_cast<size_t>((0.01 + 0.03) * 44100) + 2);  // a rattle cut to its click
  }
  REQUIRE(sizes[0] == 6);
  REQUIRE(sizes[1] == 4);
  REQUIRE(sizes[2] == 5);
  REQUIRE(loadRecordings("/nonexistent").empty());
}

TEST_CASE("the style is a switch: physics, the web's recordings, the web's synth", "[sound][web]") {
  const std::vector<SnapEvent> events = {brick(15)};
  Mixer physics(events, 45, 30), synth(events, 45, 30, web(false));
  const std::vector<float> p = track(physics), s = track(synth);
  REQUIRE(p.size() == s.size());
  REQUIRE(std::memcmp(p.data(), s.data(), p.size() * sizeof(float)) != 0);
  if (haveRecordings()) {
    Mixer recorded(events, 45, 30, web(true));
    const std::vector<float> r = track(recorded);
    REQUIRE(std::memcmp(r.data(), s.data(), r.size() * sizeof(float)) != 0);
  }
  SoundOptions none = web(true);
  none.recordings = "/nonexistent";  // the web falls back to its synthesised click
  Mixer fallback(events, 45, 30, none);
  const std::vector<float> f = track(fallback);
  REQUIRE(std::memcmp(f.data(), s.data(), f.size() * sizeof(float)) == 0);
}

TEST_CASE("the web style is the same in any block size", "[sound][web]") {
  const std::vector<SnapEvent> events = {brick(10, 1), brick(11, 2), brick(40, 3)};
  for (bool recorded : {false, true}) {
    if (recorded && !haveRecordings()) continue;
    auto blocks = [&](size_t size) {
      Mixer m(events, 60, 30, web(recorded));
      std::vector<float> l(m.length()), r(m.length());
      for (size_t at = 0; at < l.size(); at += size) m.render(l.data() + at, r.data() + at, std::min(size, l.size() - at));
      l.insert(l.end(), r.begin(), r.end());
      return l;
    };
    const std::vector<float> one = blocks(1), odd = blocks(997), all = blocks(1u << 30);
    REQUIRE(std::memcmp(one.data(), odd.data(), one.size() * sizeof(float)) == 0);
    REQUIRE(std::memcmp(one.data(), all.data(), one.size() * sizeof(float)) == 0);
  }
}

TEST_CASE("a recorded snap's click lands on its time", "[sound][web]") {
  if (!haveRecordings()) SKIP("no public/sounds/snaps");
  SoundOptions o = web(true);
  o.web.thump = 0, o.web.room = 0;  // the click alone
  Mixer m({brick(30)}, 60, 30, o);
  std::vector<float> r;
  const std::vector<float> l = track(m, &r);
  size_t loudest = 0;
  for (size_t i = 0; i < l.size(); i++)
    if (std::fabs(l[i]) + std::fabs(r[i]) > std::fabs(l[loudest]) + std::fabs(r[loudest])) loudest = i;
  REQUIRE(loudest >= 48000 - 96);
  REQUIRE(loudest <= 48000 + 96);
}

TEST_CASE("the web track peaks at 0.89 times its volume", "[sound][web]") {
  SoundOptions o = web(false);
  o.web.volume = 0.5;
  Mixer m({brick(10), brick(25, 2)}, 45, 30, o);
  std::vector<float> r;
  const std::vector<float> l = track(m, &r);
  double top = 0;
  for (size_t i = 0; i < l.size(); i++) top = std::max({top, std::fabs(static_cast<double>(l[i])), std::fabs(static_cast<double>(r[i]))});
  REQUIRE(std::fabs(top - 0.445) < 1e-6);
}
