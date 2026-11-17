#include "bmr/material.h"

#include <algorithm>
#include <cctype>
#include <cmath>
#include <string>
#include <string_view>
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
struct Named {
  std::string_view name;
  float rgb[3];
};
// BrickLink Studio's own colour for each of its materials, sorted by name.
constexpr Named kEyesight[] = {
#include "eyesight_colors.inc"
};

/// Studio's name for an LDraw colour (SOLID-RED, TRANS-CLEAR, …): the finish, then the name in
/// capitals with GREY spelt GRAY, without a leading TRANS_.
std::string studioName(const bm::ldraw::Color& c) {
  const char* prefix = "SOLID";
  switch (c.finish) {
    case bm::ldraw::Finish::Trans: prefix = "TRANS"; break;
    case bm::ldraw::Finish::Chrome: prefix = "CHROME"; break;
    case bm::ldraw::Finish::Metal: prefix = "METAL"; break;
    case bm::ldraw::Finish::Pearl: prefix = "PEARL"; break;
    case bm::ldraw::Finish::Rubber: prefix = "RUBBER"; break;
    case bm::ldraw::Finish::Solid: break;
  }
  std::string base;
  for (char ch : c.name) base += static_cast<char>(std::toupper(static_cast<unsigned char>(ch)));
  for (size_t at; (at = base.find("GREY")) != std::string::npos;) base.replace(at, 4, "GRAY");
  if (base.rfind("TRANS_", 0) == 0) base.erase(0, 6);
  return std::string(prefix) + "-" + base;
}
}  // namespace

const float* studioColor(const bm::ldraw::Color& color) {
  const std::string name = studioName(color);
  const auto* end = std::end(kEyesight);
  const auto* at = std::lower_bound(std::begin(kEyesight), end, name, [](const Named& n, const std::string& key) { return n.name < key; });
  return at != end && at->name == name ? at->rgb : nullptr;
}

Material materialFor(const bm::ldraw::Color& color) {
  Material m;
  setRgb(m.base, color.rgb);
  if (const float* studio = studioColor(color)) std::copy(studio, studio + 3, m.base);  // the colour EyeSight draws
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
