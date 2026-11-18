// Denoising a path-traced picture with OIDN.
#include <catch2/catch_test_macros.hpp>
#include <cmath>
#include <cstring>
#include "bmr/denoise.h"

using namespace bmr;

namespace {
/// A flat grey picture with noise, as a few samples a pixel give.
PathImage noisy(int size) {
  PathImage p;
  p.width = p.height = size;
  const size_t n = static_cast<size_t>(size) * size * 3;
  p.beauty.resize(n), p.albedo.assign(n, 0.5f), p.normal.resize(n);
  uint32_t s = 12345;
  for (size_t i = 0; i < n; i++) {
    s = s * 1664525u + 1013904223u;
    p.beauty[i] = 0.5f + (static_cast<float>(s >> 8) / 16777216.0f - 0.5f) * 0.4f;
    p.normal[i] = i % 3 == 2 ? 1.0f : 0.0f;
  }
  return p;
}
double mean(const std::vector<float>& v) {
  double sum = 0;
  for (float x : v) sum += x;
  return sum / static_cast<double>(v.size());
}
double spread(const std::vector<float>& v) {
  const double m = mean(v);
  double sum = 0;
  for (float x : v) sum += (x - m) * (x - m);
  return std::sqrt(sum / static_cast<double>(v.size()));
}
}  // namespace

TEST_CASE("denoising keeps the picture's mean and takes out its noise", "[denoise]") {
  if (!denoiserAvailable()) SKIP("built without OIDN");
  PathImage p = noisy(64);
  const double before = mean(p.beauty), noise = spread(p.beauty);
  std::string error;
  REQUIRE(denoise(p, DenoiseDevice::Cpu, &error));
  REQUIRE(error.empty());
  REQUIRE(std::fabs(mean(p.beauty) - before) < 0.02 * before);
  REQUIRE(spread(p.beauty) < noise / 2);
}

TEST_CASE("denoising on the CPU gives the same picture every time", "[denoise]") {
  if (!denoiserAvailable()) SKIP("built without OIDN");
  PathImage a = noisy(48), b = noisy(48);
  REQUIRE(denoise(a, DenoiseDevice::Cpu, nullptr));
  REQUIRE(denoise(b, DenoiseDevice::Cpu, nullptr));
  REQUIRE(std::memcmp(a.beauty.data(), b.beauty.data(), a.beauty.size() * sizeof(float)) == 0);
}

TEST_CASE("an empty picture is not denoised", "[denoise]") {
  PathImage p;
  std::string error;
  REQUIRE_FALSE(denoise(p, DenoiseDevice::Cpu, &error));
  REQUIRE_FALSE(error.empty());
}
