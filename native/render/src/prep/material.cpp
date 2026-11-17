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

bm::ldraw::Color colorFor(const bm::ldraw::Library& library, int code) {
  const auto found = library.colors().find(code);
  if (found != library.colors().end()) return found->second;
  bm::ldraw::Color c;
  c.code = code;
  const uint32_t kind = static_cast<uint32_t>(code) >> 24;
  if (code >= 0 && (kind == 2 || kind == 3)) {
    c.rgb = static_cast<uint32_t>(code) & 0xFFFFFF;
    // Half the colour, as LDraw editors draw a direct colour's edges.
    c.edge = ((c.rgb >> 1) & 0x7F7F7F);
    if (kind == 3) c.alpha = 0.5f, c.finish = bm::ldraw::Finish::Trans;
  }
  return c;
}

Material placeholderMaterial() {
  Material m;
  setRgb(m.base, kPlaceholderRgb);
  m.alpha = kPlaceholderAlpha;
  m.roughness = kPlaceholderRoughness, m.metalness = 0, m.clearcoat = 0;
  return m;
}

}  // namespace bmr
