#include <algorithm>
#include <cmath>
#include "bmr/path_tracer.h"

namespace bmr {

Image toImage(const PathImage& p) {
  Image out;
  const size_t pixels = static_cast<size_t>(std::max(p.width, 0)) * static_cast<size_t>(std::max(p.height, 0));
  if (pixels == 0 || p.beauty.size() < pixels * 3) return out;
  out.width = p.width, out.height = p.height;
  out.rgba.resize(pixels * 4);
  for (size_t i = 0; i < pixels; i++) {
    for (int c = 0; c < 3; c++) {
      float v = p.beauty[i * 3 + c];
      v = std::isfinite(v) ? std::clamp(v, 0.0f, 1.0f) : 0.0f;
      const float s = v <= 0.0031308f ? v * 12.92f : 1.055f * std::pow(v, 1.0f / 2.4f) - 0.055f;
      out.rgba[i * 4 + c] = static_cast<uint8_t>(std::lround(s * 255.0f));
    }
    out.rgba[i * 4 + 3] = 255;
  }
  return out;
}

}  // namespace bmr
