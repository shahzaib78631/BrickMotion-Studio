// Live progressive path-tracer display resolve: combines persistent GPU accumulation buffers
// (accum, catcher, sky) into linear RGB for the BGRA8Unorm_sRGB viewport drawable, or blits
// the Metal-OIDN denoised texture once a denoised milestone is ready.

struct PathResolveUniforms {
  uint width;
  uint height;
  uint samples;
  uint useDenoised;
  float4 background;  // rgb: linear background, w: kFloorSkyPower
};

fragment float4 pathResolveFragment(ScreenOut in [[stage_in]], constant PathResolveUniforms& u [[buffer(0)]],
                                    const device float4* accum [[buffer(1)]], const device float4* catcher [[buffer(2)]],
                                    const device float4* sky [[buffer(3)]], texture2d<float> denoised [[texture(0)]]) {
  uint2 at = uint2(in.position.xy);
  if (at.x >= u.width || at.y >= u.height) return float4(u.background.rgb, 1.0);
  if (u.useDenoised != 0u) {
    return float4(saturate(denoised.read(at).rgb), 1.0);
  }
  uint idx = at.y * u.width + at.x;
  float4 a = accum[idx];
  float4 c = catcher[idx];
  float4 w = sky[idx];
  float inv = 1.0 / float(max(u.samples, 1u));
  float3 lights = c.w > 0.0 ? c.rgb / c.w : float3(1.0);
  float3 world = w.w > 0.0 ? w.rgb / w.w : float3(1.0);
  float3 ratio = lights * pow(max(world, float3(0.0)), float3(u.background.w));
  float3 col = (a.rgb + a.w * u.background.rgb * ratio) * inv;
  return float4(saturate(col), 1.0);
}
