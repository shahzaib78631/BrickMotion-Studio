#include "bmr/material.h"

#include <cmath>
#include "bmr/tolerances.h"

namespace bmr {

float linearFromSrgb(unsigned channel) {
  const double c = static_cast<double>(channel > 255 ? 255 : channel) / 255.0;
  return static_cast<float>(c <= 0.04045 ? c / 12.92 : std::pow((c + 0.055) / 1.055, 2.4));
}

namespace {
void setRgb(float out[3], uint32_t rgb) {
  out[0] = linearFromSrgb((rgb >> 16) & 0xFF);
  out[1] = linearFromSrgb((rgb >> 8) & 0xFF);
  out[2] = linearFromSrgb(rgb & 0xFF);
}
}  // namespace

Material materialFor(const bm::ldraw::Color& color) {
  Material m;
  setRgb(m.base, color.rgb);
  setRgb(m.edge, color.edge);
  m.alpha = std::isfinite(color.alpha) ? std::min(1.0f, std::max(0.0f, color.alpha)) : 1.0f;
  Surface s = kSolid;
  switch (color.finish) {
    case bm::ldraw::Finish::Solid: s = kSolid; break;
    case bm::ldraw::Finish::Trans: s = kTrans; break;
    case bm::ldraw::Finish::Chrome: s = kChrome; break;
    case bm::ldraw::Finish::Metal: s = kMetal; break;
    case bm::ldraw::Finish::Pearl: s = kPearl; break;
    case bm::ldraw::Finish::Rubber: s = kRubber; break;
  }
  m.roughness = s.roughness, m.metalness = s.metalness, m.clearcoat = s.clearcoat;
  return m;
}

Material placeholderMaterial() {
  Material m;
  setRgb(m.base, kPlaceholderRgb);
  m.alpha = kPlaceholderAlpha;
  m.roughness = kPlaceholderRoughness, m.metalness = 0, m.clearcoat = 0;
  return m;
}

}  // namespace bmr
