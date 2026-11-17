#pragma once
// How a colour of the part library looks as a surface.
#include "bm/ldraw/library.h"

namespace bmr {

struct Material {
  float base[3] = {0.5f, 0.5f, 0.5f};  ///< linear, 0..1
  float alpha = 1;                     ///< 1 is opaque
  float roughness = 0.38f, metalness = 0, clearcoat = 0.35f;
  float edge[3] = {0.05f, 0.05f, 0.05f};  ///< linear: the colour of the part's outline lines
  bool transparent() const { return alpha < 1; }
  bool operator==(const Material&) const = default;
};

/// One channel of sRGB (0..255) as linear light (0..1), by the sRGB curve itself.
float linearFromSrgb(unsigned channel);

/// The surface an LDraw colour has. Roughness, metalness and clearcoat come from its finish
/// (tolerances.h has the table and where each value is from).
Material materialFor(const bm::ldraw::Color& color);

/// BrickLink Studio's own linear colour for an LDraw colour (by its name and finish), or null
/// if Studio has none. materialFor uses it in place of LDraw's sRGB value.
const float* studioColor(const bm::ldraw::Color& color);

/// What a part that is missing from the library is drawn with: translucent grey.
Material placeholderMaterial();
/// The colour an LDraw colour code names: from the library's table, or a direct colour
/// (0x2RRGGBB opaque, 0x3RRGGBB transparent, with a darker edge), or the default grey.
bm::ldraw::Color colorFor(const bm::ldraw::Library& library, int code);

}  // namespace bmr
