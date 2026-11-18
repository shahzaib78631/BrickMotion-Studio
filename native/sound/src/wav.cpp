#include "bms/wav.h"

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <fstream>
#include <vector>

namespace bms {

namespace {
void put16(std::ofstream& out, uint16_t v) {
  const char b[2] = {static_cast<char>(v & 0xFF), static_cast<char>(v >> 8)};
  out.write(b, 2);
}
void put32(std::ofstream& out, uint32_t v) {
  for (int i = 0; i < 4; i++) out.put(static_cast<char>((v >> (8 * i)) & 0xFF));
}
}  // namespace

bool writeWav(Mixer& mixer, const std::filesystem::path& file) {
  const uint32_t rate = static_cast<uint32_t>(mixer.sampleRate());
  const uint64_t frames = mixer.length();
  const uint64_t bytes = frames * 4;
  if (bytes > 0xFFFFFFFFull - 36) return false;
  std::ofstream out(file, std::ios::binary);
  if (!out) return false;
  out.write("RIFF", 4), put32(out, static_cast<uint32_t>(36 + bytes)), out.write("WAVE", 4);
  out.write("fmt ", 4), put32(out, 16), put16(out, 1), put16(out, 2), put32(out, rate), put32(out, rate * 4), put16(out, 4), put16(out, 16);
  out.write("data", 4), put32(out, static_cast<uint32_t>(bytes));
  constexpr size_t kBlock = 8192;
  std::vector<float> l(kBlock), r(kBlock);
  std::vector<char> pcm(kBlock * 4);
  for (uint64_t at = 0; at < frames; at += kBlock) {
    const size_t n = static_cast<size_t>(std::min<uint64_t>(kBlock, frames - at));
    mixer.render(l.data(), r.data(), n);
    for (size_t i = 0; i < n; i++) {
      const float s[2] = {l[i], r[i]};
      for (int c = 0; c < 2; c++) {
        const int16_t v = static_cast<int16_t>(std::lround(std::clamp(s[c], -1.0f, 1.0f) * 32767.0f));
        pcm[i * 4 + c * 2] = static_cast<char>(v & 0xFF), pcm[i * 4 + c * 2 + 1] = static_cast<char>((v >> 8) & 0xFF);
      }
    }
    out.write(pcm.data(), static_cast<std::streamsize>(n * 4));
  }
  return static_cast<bool>(out);
}

}  // namespace bms
