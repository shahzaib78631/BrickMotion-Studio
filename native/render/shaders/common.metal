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
  float4 background;      // rgb, linear
  float4 viewport;        // width, height, 1/width, 1/height, pixels
  float4 switches;        // x: shadows, y: ambient occlusion, z: debug, w: transparency
  float4 floorPlane;      // x: the floor's y (world), y: how far it reaches from its centre, z: shadow texel size (LDU), w: shadow bias in texels
  float4 floorCentre;     // x, y: the floor's centre (world x and z), z: how much full shadow darkens it, w: kOitDepthScale
  float4 lens;            // x: tan of half the vertical angle of view; y, z: pixels per LDU where outlines are gone and fully shown
  float4 selection;       // rgb: the outline's colour, linear; w: its width in pixels, 0 when nothing selected is in view
  float4 lights[4];       // xyz: toward each of the four lights, world; w: its strength (lights[0] is the key, which casts the shadow)
  float4 rig;             // x: the white world's strength; y: sin^2 of each light's angular radius; z: the power occlusion is raised to on bricks
  float4x4 heightProj;    // world to the height map (floor_light.metal)
  float4 floorLook;       // x, y: nearest and furthest a floor point looks (LDU); z: 1 when the floor's light is worked out; w: the power the sky's share is raised to
  float4 glass;           // x: glass's absorption, y: the floor's level seen through glass, z: glass's IOR (tolerances.h kGlass*)
  float4 grid;            // x: spacing, y/z: model origin modulo spacing
  float4 floorCasters;    // min x/z, max x/z of the geometry in the height map
  float4 neuralGlass0;    // neural dielectric glass & floor transport params 0
  float4 neuralGlass1;    // neural dielectric glass & micro-geometry params 1
  float4 plastic;         // x: matched plastic BRDF, y: fill share (0.85), z: mask mode, w: world GI active
};

// Trained weights for the Metal Neural Shader (must match bmr::NeuralWeights in src/metal/neural_weights.h).
struct NeuralWeights {
  float4 w1[24][4];       // Layer 1 encoder: 16 in (4x float4) -> 24 hidden
  float4 b1[6];           // Layer 1 bias (24 floats)
  float4 w2[24][8];       // Layer 2 spatial-graph residual block: 32 in (24 self + 8 threadgroup 3x3 bilateral latent) -> 24 hidden
  float4 b2[6];           // Layer 2 bias (24 floats)
  float4 filmGamma[24];   // FiLM light-view angle scale conditioning: 4 cond -> 24 hidden
  float4 filmBeta[24];    // FiLM light-view angle shift conditioning: 4 cond -> 24 hidden
  float4 w3[16][10];      // Layer 3 decoder with input skip: 40 in (24 h2 + 16 x) -> 16 hidden
  float4 b3[4];           // Layer 3 bias (16 floats)
  float4 w4[8][4];        // Layer 4 radiometric head: 16 in -> 8 physical transport channels (2x float4)
  float4 b4[2];           // Layer 4 bias (8 floats)
  float4 glassParams[4];  // Learned multi-wall dielectric glass, micro-geometry & floor transport coefficients
};

// One per draw. Must match DrawUniforms in src/metal/impl.h.
struct DrawUniforms {
  float4 base;     // rgb linear, a: opacity
  float4 surface;  // roughness, metalness, clearcoat, 1 if the group is a placeholder
  float4 edge;     // rgb linear, a: opacity of outline lines
  float4 flip;     // x: -1 for mirrored instances (their normals come out inverted), else 1; y: the walls a face stands for (glass): 2 for a box, the two a ray through the part crosses, else 1
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

// The key light's soft shadow (shadow.metal): 1 lit, 0 in shadow.
float keyShadow(float3 world, float3 n, constant FrameUniforms& frame, depth2d<float> shadowMap, sampler shadowSampler, float turn);
// What share of each light reaches the floor through each direction and elevation bin.
struct FloorBins {
  ushort weights[4][48][5];
  uint total[4][4];
  float4 lit;
  float4 rays[48];
};
// The share of a white floor's light that reaches the floor at `world` (floor_light.metal).
float floorLight(float3 world, constant FrameUniforms& frame, constant FloorBins& bins, texture2d<float> heights, uint2 cell, bool sky, bool key);
// How much the floor's light counts at `world`: all of it near the model, none toward the rim.
inline float floorFade(float3 world, constant FrameUniforms& frame) {
  float reach = frame.floorPlane.y;
  return 1.0 - smoothstep(0.15 * reach, 0.35 * reach, length(world.xz - frame.floorCentre.xy));
}

// One of 16 turns, a different one at each of the 16 places in a 4 x 4 tile (in Bayer's order,
// so neighbours differ most): a 4 x 4 average sees each once.
inline float tileTurn(uint2 at) {
  const uint bayer[16] = {0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5};
  return float(bayer[(at.y & 3) * 4 + (at.x & 3)]) * (6.2831853 / 16.0);
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
