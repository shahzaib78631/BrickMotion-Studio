// Shared by every shader. All of native/render/shaders is compiled as one text, this file first.
//
// Conventions:
// - World space is the model's (LDU, -y up) less the scene's origin, so numbers stay small.
// - Depth is reversed: the near plane is depth 1 and the far plane 0, cleared to 0, tested
//   greater-or-equal. That keeps depth precision far from the eye, which large models need.
// - Colour is linear until the last pass, which applies the tone curve and writes sRGB.
// - The colour target holds colour multiplied by coverage, with coverage in alpha: where
//   nothing is drawn it is (0, 0, 0, 0), and the last pass puts the background there.
#include <metal_stdlib>
using namespace metal;

// One per frame. Must match FrameUniforms in src/metal/impl.h field for field.
struct FrameUniforms {
  float4x4 viewProj;      // world to clip
  float4x4 shadowProj;    // world to the key light's shadow map (xy 0..1, z depth)
  float4 eye;             // xyz: the eye, world
  float4 keyDirection;    // xyz: toward the key light, world; w: its intensity
  float4 background;      // rgb, linear
  float4 viewport;        // width, height, 1/width, 1/height, pixels
  float4 room;            // x: room luminance, y: soft box luminance, z: cos of the soft box's inner edge, w: of its outer edge
  float4 switches;        // x: shadows on, y: ambient occlusion on, z: highest mip of the reflection cube, w: clearcoat roughness
  float4 floorPlane;      // x: the floor's y (world), y: how far it reaches from its centre, z: shadow texel size (LDU), w: shadow bias in texels
  float4 floorCentre;     // x, y: the floor's centre (world x and z), z: how much full shadow darkens it, w: kOitDepthScale
  float4 lens;            // x: tan of half the vertical angle of view, y, z: the on-screen heights (pixels) where edges are gone and fully shown
};

// One per draw. Must match DrawUniforms in src/metal/impl.h.
struct DrawUniforms {
  float4 base;     // rgb linear, a: opacity
  float4 surface;  // roughness, metalness, clearcoat, 1 if the group is a placeholder
  float4 edge;     // rgb linear, a: opacity of outline lines
  float4 flip;     // x: -1 for mirrored instances (their normals come out inverted), else 1
  float4 sphere;   // the part's bounding sphere: centre (part space), radius
};

// One per piece. Must match bmr::Instance (include/bmr/scene.h): 56 bytes.
struct InstanceData {
  packed_float4 r0, r1, r2;  // rows of the 3x4 matrix, part space to world
  uint piece;
  uint flags;                // bit 0 mirrored, bit 1 selected, bit 2 hidden
};

float3 placePoint(InstanceData i, float3 p) { return float3(dot(float4(i.r0).xyz, p) + i.r0[3], dot(float4(i.r1).xyz, p) + i.r1[3], dot(float4(i.r2).xyz, p) + i.r2[3]); }

// A normal carried by the same matrix: by its cofactors, which is right for any matrix that
// does not squash the part flat. A mirroring matrix turns it inward; DrawUniforms::flip undoes that.
float3 placeNormal(InstanceData i, float3 n) {
  float3 c0 = float3(i.r0[0], i.r1[0], i.r2[0]), c1 = float3(i.r0[1], i.r1[1], i.r2[1]), c2 = float3(i.r0[2], i.r1[2], i.r2[2]);
  return normalize(cross(c1, c2) * n.x + cross(c2, c0) * n.y + cross(c0, c1) * n.z);
}

float3 linearFromSrgb(float3 c) { return mix(c / 12.92, pow((c + 0.055) / 1.055, float3(2.4)), step(float3(0.04045), c)); }

// The studio the model stands in, as light arriving from direction `d` (world; -y is up):
// a white room, darker toward the floor, with one large soft box where the key light is and a
// tall strip light on each side (left and right, -x and +x). The strips and the dark floor are
// what a shiny piece shows: in an even room chrome is one flat grey.
// strips: x luminance, y and z cos of a strip's inner and outer edge (across it), w the floor's
// share of the room's luminance.
float3 studioRadiance(float3 d, float3 keyDirection, float4 room, float4 strips) {
  float up = -d.y;
  float wall = room.x * mix(strips.w, 1.0, smoothstep(-0.35, 0.35, up));
  float box = room.y * smoothstep(room.w, room.z, dot(d, keyDirection));
  float2 across = normalize(float2(d.x, d.z) + float2(1e-6, 0));
  float side = smoothstep(strips.z, strips.y, abs(across.x));
  float tall = smoothstep(-0.15, 0.05, up) * (1.0 - smoothstep(0.55, 0.75, up));
  return float3(wall + box + strips.x * side * tall);
}

// A triangle that covers the screen, from the vertex number alone.
struct ScreenOut {
  float4 position [[position]];
  float2 uv;  // 0..1, (0, 0) at the top left
};
vertex ScreenOut screenVertex(uint id [[vertex_id]]) {
  float2 p = float2((id << 1) & 2, id & 2);
  ScreenOut out;
  out.position = float4(p * 2.0 - 1.0, 0.0, 1.0);
  out.uv = float2(p.x, 1.0 - p.y);
  return out;
}
