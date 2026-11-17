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

/// The studio. The key light comes from the front, above and a little to the right (the
/// front of an LDraw model faces -z, and -y is up): this is the direction toward it.
inline constexpr double kKeyDirection[3] = {0.35, -0.8, -0.5};
/// The key light's strength, and the luminance of the room and of the soft box that stands
/// where the key light is, in units where a white matt surface in the room alone comes out
/// at about 0.6. Chosen by eye on white, red and black bricks; the look is calibrated later.
inline constexpr float kKeyIntensity = 1.6f;
inline constexpr float kRoomLuminance = 0.62f;
inline constexpr float kBoxLuminance = 6.0f;
/// The soft box seen from the model: full within 18 degrees of the key direction, gone by 32.
inline constexpr float kBoxInnerCos = 0.951f;
inline constexpr float kBoxOuterCos = 0.848f;
/// Two tall strip lights, left and right of the model, and a floor darker than the walls: the
/// contrast chrome and gloss need to read as shiny. A strip is full within 8 degrees of the
/// side (cos 0.990) and gone by 20 (cos 0.940) across it; it reaches from just below the
/// horizon to about 35 degrees up.
inline constexpr float kStripLuminance = 2.5f;
inline constexpr float kStripInnerCos = 0.990f;
inline constexpr float kStripOuterCos = 0.940f;
inline constexpr float kFloorShare = 0.3f;

/// Shadow: the key light's depth map, its side in texels; how far a receiving point is pushed
/// out along its normal before the map is read, in texels (it keeps flat faces from shadowing
/// themselves); and the slope-scaled depth bias of the map itself.
inline constexpr int kShadowMapSize = 4096;
inline constexpr float kShadowBias = 1.5f;
inline constexpr float kShadowSlopeBias = 2.0f;
/// Floor: a plane just under the model (kFloorLift LDU below its lowest point, +y being down),
/// kFloorExtent times the model's diagonal across, the background's colour. It shows only
/// what falls on it: full shadow darkens it by kFloorShadow, fading out toward its rim.
inline constexpr double kFloorExtent = 4.0;
inline constexpr double kFloorLift = 0.05;
inline constexpr float kFloorShadow = 0.45f;
/// Outline lines are drawn this fraction of their distance nearer the eye, so they win over
/// the faces they lie on.
inline constexpr float kEdgeNearer = 0.002f;
/// Weighted blended transparency (McGuire and Bavoil 2013): the depth, in LDU, over which a
/// layer's weight falls by its fourth power.
inline constexpr float kOitDepthScale = 2000.0f;
/// The two cube maps of the studio's light: side in pixels and number of mips of the
/// reflection map (roughness 0 at mip 0 to 1 at the last), side of the map of received
/// light, and directions gathered per pixel.
inline constexpr int kReflectionSize = 128;
inline constexpr int kReflectionMips = 6;
inline constexpr int kReceivedSize = 16;
inline constexpr int kGatherSamples = 256;
/// Samples per pixel when drawing (multisampling).
inline constexpr int kSamples = 4;

/// How strongly a part's outline lines are drawn over it: the web app's EDGE_OPACITY
/// (src/render/materials.ts:192).
inline constexpr float kEdgeOpacity = 0.3f;

}  // namespace bmr
