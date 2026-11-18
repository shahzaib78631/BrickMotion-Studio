import base from './CORTAOBase.glsl?raw';
import main from './CORTAOMainPass.glsl?raw';
import prepass from './CORTAOPrepass.glsl?raw';
import filter from './CORTAOFilterPass.glsl?raw';

// WebGL2 GLSL ES 3.00 has integer textures and bit operations, but lacks
// desktop GLSL's fma and bitCount. Keep the reference algorithm unchanged.
const compatibility = /* glsl */ `
uint bm_bitCount(uint x) {
  x -= (x >> 1u) & 0x55555555u;
  x = (x & 0x33333333u) + ((x >> 2u) & 0x33333333u);
  x = (x + (x >> 4u)) & 0x0f0f0f0fu;
  return (x * 0x01010101u) >> 24u;
}
`;
const shared = '#define CORTAO_GLSL 1\n' + compatibility + base
  .replace('#define cortao_fma(a, b, c) fma(a, b, c)', '#define cortao_fma(a, b, c) ((a) * (b) + (c))')
  .replace('#define cortao_bitCount(x) bitCount(x)', '#define cortao_bitCount(x) bm_bitCount(x)')
  .replaceAll('bitsPerComponent*2', 'bitsPerComponent*2u');

export const vertexShader = /* glsl */ `
void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

// Reconstruct the reference prepass's selected source pixel independently for
// each mip. This avoids compute/imageStore and sampling a render attachment.
// Averaging integer-packed depth/normals with generateMipmaps would be invalid.
export const prepassShader = shared + prepass.replace('#include "CORTAOBase.h"', '').replace('(1 << CORTAO_PACKED_NORMAL_BITS) - 1', '(1u << uint(CORTAO_PACKED_NORMAL_BITS)) - 1u').replace('mipLevel >= params.mipCount', 'uint(mipLevel) >= params.mipCount') + /* glsl */ `
uniform sampler2D tDepth;
uniform sampler2D tNormal;
uniform int mipLevel;
uniform CORTAOPrepassParameters parameters;
layout(location = 0) out uint packedOutput;
float cortao_loadDepth(ivec2 pixel) { return texelFetch(tDepth, pixel, 0).r; }
vec3 cortao_loadNormal(ivec2 pixel) { return normalize(texelFetch(tNormal, pixel, 0).rgb * 2.0 - 1.0); }
void cortao_writePackedData(ivec2 pixel, int level, uint data) {
  if (level == mipLevel && all(equal(pixel, ivec2(gl_FragCoord.xy)))) packedOutput = data;
}
void main() {
  packedOutput = 0u;
  uvec2 pixel = uvec2(gl_FragCoord.xy);
  for (int level = 7; level >= 1; level--) {
    if (level > mipLevel) continue;
    uvec2 dither = uvec2(parameters.randomSeed) >> uvec2(level * 2, level * 2 + 1);
    pixel = (pixel << 1u) | ((pixel.yx ^ dither) & 1u);
  }
  cortao_prepass(pixel, parameters);
}
`;

export const mainShader = shared + main.replace('#include "CORTAOBase.h"', '').replaceAll('cortao_uint i = 0;', 'cortao_uint i = 0u;') + /* glsl */ `
uniform highp usampler2D packedDataBuffer;
uniform highp usampler3D occluderLookupTable;
uniform sampler2D tNormal;
uniform CORTAOMainPassParameters parameters;
uniform float maxMip;
out vec4 aoOutput;
uint cortao_samplePackedData(vec2 coords, float mip) {
  if (any(lessThan(coords, vec2(0.0))) || any(greaterThanEqual(coords, vec2(1.0)))) return 0u;
  return textureLod(packedDataBuffer, coords, clamp(floor(mip + 0.5), 0.0, maxMip)).r;
}
vec3 cortao_loadNormal(ivec2 pixel) {
  return normalize(texelFetch(tNormal, pixel, 0).rgb * 2.0 - 1.0);
}
uint cortao_sampleOccluderLookupTable(vec3 coords) {
  return textureLod(occluderLookupTable, coords, 0.0).r;
}
void cortao_writeResult(ivec2 pixel, float occlusion, vec3 bentNormal, mat3 tangentSpaceTransform, uint rayBits) {
  aoOutput = vec4(vec3(occlusion), 1.0);
}
void main() {
  aoOutput = vec4(1.0); // The reference skips sky pixels; fragment targets must write them.
  cortao_mainPass(uvec2(gl_FragCoord.xy), parameters);
}
`;

// The reference compute filter emits four pixels per invocation. Fragment
// shaders evaluate that same invocation for each destination pixel, retaining
// only the matching store. Gather order matches GLSL textureGather: TL,TR,BR,BL.
export const filterShader = shared + filter.replace('#include "CORTAOBase.h"', '')
  .replaceAll('bits - normalBits', 'int(bits) - normalBits')
  .replaceAll('params.depthOffset.xxxx', 'vec4(params.depthOffset)')
  .replaceAll('params.normalErrorMul.xxxx', 'vec4(params.normalErrorMul)')
  .replace('cortao_uint sampleCount = 6;', 'cortao_uint sampleCount = 6u;')
  .replace('cortao_uint sampleCount = 2;', 'cortao_uint sampleCount = 2u;') + /* glsl */ `
uniform highp usampler2D packedDataBuffer;
uniform sampler2D tAO;
uniform CORTAOFilterPassParameters parameters;
out vec4 filteredOutput;
ivec2 clampPixel(ivec2 pixel) { return clamp(pixel, ivec2(0), textureSize(packedDataBuffer, 0) - 1); }
uvec4 cortao_gatherPackedData(vec2 uv, ivec2 offset) {
  ivec2 p = ivec2(floor(uv * vec2(textureSize(packedDataBuffer, 0)) - 0.5)) + offset;
  return uvec4(texelFetch(packedDataBuffer, clampPixel(p + ivec2(0,1)), 0).r,
    texelFetch(packedDataBuffer, clampPixel(p + ivec2(1,1)), 0).r,
    texelFetch(packedDataBuffer, clampPixel(p + ivec2(1,0)), 0).r,
    texelFetch(packedDataBuffer, clampPixel(p), 0).r);
}
vec4 cortao_gatherSSAO(vec2 uv, ivec2 offset) {
  ivec2 p = ivec2(floor(uv * vec2(textureSize(tAO, 0)) - 0.5)) + offset;
  return vec4(texelFetch(tAO, clampPixel(p + ivec2(0,1)), 0).r,
    texelFetch(tAO, clampPixel(p + ivec2(1,1)), 0).r,
    texelFetch(tAO, clampPixel(p + ivec2(1,0)), 0).r,
    texelFetch(tAO, clampPixel(p), 0).r);
}
void cortao_writeFilterOutput(ivec2 pixel, float ao) {
  if (all(equal(pixel, ivec2(gl_FragCoord.xy)))) filteredOutput = vec4(vec3(ao), 1.0);
}
void main() {
  filteredOutput = vec4(1.0);
  cortao_filterPass(uvec2(gl_FragCoord.xy) >> 1u, parameters);
}
`;
