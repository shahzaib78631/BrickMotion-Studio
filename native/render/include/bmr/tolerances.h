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
/// Solid and transparent plastic are EyeSight's, as fitted in scripts/neural/blender/render.py
/// (roughness 0.1, IOR 1.45, a clear coat of weight 0.25 with roughness 0); the clearcoat
/// number here is that weight.
inline constexpr Surface kSolid{0.10f, 0.0f, 0.25f};
inline constexpr Surface kTrans{0.02f, 0.0f, 0.25f};
inline constexpr Surface kChrome{0.08f, 1.0f, 0.25f};
inline constexpr Surface kMetal{0.20f, 0.7f, 0.25f};
inline constexpr Surface kPearl{0.10f, 0.5f, 0.25f};
inline constexpr Surface kRubber{0.86f, 0.0f, 0.0f};

/// EyeSight's BUILD_FL light preset, as fitted to its renders (scripts/neural/blender/render.py,
/// RMSE about 6 against EyeSight): four distant lights, each a disk 45 degrees in radius as seen
/// from the model (Studio's light "size" 1.0), toward-light vectors in the camera's heading
/// frame (x to the right of the camera, y away from it along the ground, z up), the first the
/// key; and a uniform white world of strength kWorldStrength. Strengths are irradiance at
/// normal incidence; a white matt face lit by the world alone comes out at kWorldStrength.
inline constexpr double kRigToward[4][3] = {{-0.02431, -0.01808, 0.02612}, {-0.02278, 0.02614, 0.01995}, {0.02438, -0.00616, 0.03111}, {0.02636, 0.02253, 0.01995}};
inline constexpr float kRigStrength[4] = {1.187f, 0.751f, 0.751f, 0.751f};
inline constexpr float kRigSinSquared = 0.5f;  // sin^2 of the disks' 45-degree radius
inline constexpr float kWorldStrength = 0.415f;

/// A missing part: the web app's placeholder (src/render/materials.ts:188).
inline constexpr unsigned kPlaceholderRgb = 0xb8bcc2;
inline constexpr float kPlaceholderAlpha = 0.6f;
inline constexpr float kPlaceholderRoughness = 0.6f;

/// The orbit camera's limits: it never goes over the top (89 degrees), nor inside a stud or
/// out of sight.
inline constexpr double kMaxElevation = 1.5533;
inline constexpr double kMinDistance = 10;
/// A drag in the viewport turns the model this many radians per point (half a turn over 390 points).
inline constexpr double kOrbitRadiansPerPoint = 0.008;
inline constexpr double kMaxDistance = 1e6;
/// How much wider than the model a framing shot is: enough air that nothing touches the edge.
inline constexpr double kFrameMargin = 1.15;
/// The nearest the near plane ever is, LDU: a twentieth of a stud.
inline constexpr double kNearest = 1.0;

/// Shadow: the key light's depth map, its side in texels; how far a receiving point is pushed
/// out along its normal before the map is read, in texels (it keeps flat faces from shadowing
/// themselves); and the slope-scaled depth bias of the map itself.
inline constexpr int kShadowMapSize = 2048;
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

/// Levels of detail. A piece is drawn at full detail where its low-detail mesh would be at
/// least kLowErrorPixels off on screen (bm::ldraw::Mesh::lowError, at the near side of the
/// piece), at low detail otherwise, and as its box once the whole piece (its bounding sphere)
/// is under kLowPixels tall, where a box looks the same. The equivalence tests in frame_test.mm
/// hold these: boxes from 6 pixels put a kBlock square of 42000-1 7.6 levels off (over
/// kDetailBlockTolerance).
inline constexpr double kLowErrorPixels = 0.5;
/// A part's underside (the tubes and pins under it) is left out while the eye is more than
/// this many LDU above its bottom, in the part's own space.
inline constexpr double kUndersideSlack = 0.5;
inline constexpr double kLowPixels = 3;
/// Outline lines fade with how wide a stud (kStudLdu across) looks at the near side of the
/// piece: gone below kEdgeStudPixels, where the lines on a stud would be a dot of noise (and
/// black's light-grey edges turn a far tyre grey), all of kEdgeOpacity from kEdgeStudFullPixels.
inline constexpr double kStudLdu = 12;
inline constexpr double kEdgeStudPixels = 4;
inline constexpr double kEdgeStudFullPixels = 8;
/// The selection's outline: the system accent blue (#007AFF, sRGB 0-255), this many pixels wide.
inline constexpr unsigned kSelectionRgb[3] = {0, 122, 255};
inline constexpr float kSelectionWidth = 2.0f;
/// Ambient occlusion: how far (LDU) a surface looks for what hides its surroundings; how many
/// degrees above a surface something must rise before it counts (as a cosine, 0.1: about 6
/// degrees, so a gently curved surface does not shade itself); and how strongly it darkens.
/// The reach is wide (more than six bricks) because it also stands in for the floor's share of
/// EyeSight's white world, which a whole model hides; fitted on native/corpus/calib.
inline constexpr float kAoRadius = 128.0f;
inline constexpr float kAoBias = 0.1f;
inline constexpr float kAoStrength = 1.0f;
/// The occlusion found is raised to this power before it dims a brick's light from the
/// surroundings: half of that light is from the fills, which reach in past what hides the
/// world. Fitted as above. (The floor's light is worked out apart: floor_light.metal.)
inline constexpr float kAoBrickPower = 1.5f;
/// The floor's light (floor_light.metal): the side of the height map over the model (texels),
/// and how far out (as a share of the floor's radius) a floor point looks for what hides its sky.
inline constexpr int kHeightMapSize = 1024;
inline constexpr float kFloorLookShare = 0.35f;
/// EyeSight's ground, as fitted in scripts/neural/blender/render.py: the shadow of the four
/// lights alone (the key at kFloorKeyShare of its strength), times the share of the white
/// world it sees raised to kFloorSkyPower.
inline constexpr float kFloorKeyShare = 0.807f;
inline constexpr float kFloorSkyPower = 0.587f;
/// How far a culled, level-of-detail frame may be from the same frame drawn in full: mean
/// absolute difference per channel, and over the worst kBlock square (0..255).
inline constexpr double kDetailMeanTolerance = 0.5;
inline constexpr double kDetailBlockTolerance = 6.0;
/// Samples per pixel when drawing (multisampling).
inline constexpr int kSamples = 4;

/// How strongly a part's outline lines are drawn over it: the web app's EDGE_OPACITY
/// (src/render/materials.ts:192).
inline constexpr float kEdgeOpacity = 0.3f;

}  // namespace bmr
