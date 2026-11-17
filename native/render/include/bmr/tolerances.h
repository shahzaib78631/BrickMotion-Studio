#pragma once
// Every number the renderer uses. Lengths are LDU unless a line says pixels.

namespace bmr {

/// Side, in pixels, of the blocks compare() looks at: about the size of a stud in a test frame,
/// so that one wrong stud is a whole block and is not averaged away over the image.
inline constexpr int kBlock = 16;

/// Faces that meet at less than this angle are shaded as one curved surface; a sharper turn
/// is an edge. LDraw's curved primitives turn 22.5 degrees a facet at 16 sides and real edges
/// 90: 35 smooths a 16-sided cylinder and keeps every true edge. An 8-sided low-detail
/// cylinder (45 a facet) is therefore faceted, which is right at the size it is shown.
inline constexpr double kCreaseDegrees = 35.0;

/// The colour of a triangle whose colour code is not in the table: mid grey, as bm::ldraw::Color's default.
inline constexpr unsigned kUnknownColor = 0xFF888888u;

/// Surfaces by finish: roughness, metalness, clearcoat.
/// Solid is the web app's default look, "BrickLink plastic" (src/render/looks.ts:412). Chrome,
/// metal, pearl and rubber are its per-finish overrides (src/render/materials.ts:135-138), which
/// leave the look's clearcoat except on rubber. Transparent plastic's roughness is this
/// renderer's own: the web app's glass is a separate optics model that is not ported here.
struct Surface {
  float roughness, metalness, clearcoat;
};
inline constexpr Surface kSolid{0.38f, 0.0f, 0.35f};
inline constexpr Surface kTrans{0.05f, 0.0f, 0.35f};
inline constexpr Surface kChrome{0.08f, 1.0f, 0.35f};
inline constexpr Surface kMetal{0.20f, 0.7f, 0.35f};
inline constexpr Surface kPearl{0.10f, 0.5f, 0.35f};
inline constexpr Surface kRubber{0.86f, 0.0f, 0.0f};
/// The roughness of the clearcoat layer itself (the same look).
inline constexpr float kClearcoatRoughness = 0.2f;

/// A missing part: the web app's placeholder (src/render/materials.ts:188).
inline constexpr unsigned kPlaceholderRgb = 0xb8bcc2;
inline constexpr float kPlaceholderAlpha = 0.6f;
inline constexpr float kPlaceholderRoughness = 0.6f;

/// The orbit camera's limits: it never goes over the top (89 degrees), nor inside a stud or
/// out of sight.
inline constexpr double kMaxElevation = 1.5533;
inline constexpr double kMinDistance = 10;
inline constexpr double kMaxDistance = 1e6;
/// How much wider than the model a framing shot is: enough air that nothing touches the edge.
inline constexpr double kFrameMargin = 1.15;
/// The nearest the near plane ever is, LDU: a twentieth of a stud.
inline constexpr double kNearest = 1.0;

}  // namespace bmr
