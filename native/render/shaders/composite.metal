// The last pass: background where nothing was drawn, the tone curve, and out as sRGB.

// The Khronos PBR Neutral tone curve. It leaves colours below its shoulder as they are, so a
// brick's colour on screen is the brick's colour; only highlights are eased toward white.
float3 toneCurve(float3 color) {
  const float startCompression = 0.8 - 0.04, desaturation = 0.15;
  float x = min(color.r, min(color.g, color.b));
  float offset = x < 0.08 ? x - 6.25 * x * x : 0.04;
  color -= offset;
  float peak = max(color.r, max(color.g, color.b));
  if (peak < startCompression) return color;
  const float d = 1.0 - startCompression;
  float newPeak = 1.0 - d * d / (peak + d - startCompression);
  color *= newPeak / peak;
  float g = 1.0 - 1.0 / (desaturation * (peak - newPeak) + 1.0);
  return mix(color, float3(newPeak), g);
}

fragment float4 compositeFragment(ScreenOut in [[stage_in]], constant FrameUniforms& frame [[buffer(1)]], texture2d<float> scene [[texture(0)]], texture2d<float> accum [[texture(1)]],
                                  texture2d<float> reveal [[texture(2)]]) {
  uint2 at = uint2(in.position.xy);
  float4 c = scene.read(at);
  // The transparent layers, over what is behind them: their weighted mean colour, covering
  // as much as they do not let through.
  float4 sum = accum.read(at);
  float covered = sum.a > 1e-6 ? saturate(1.0 - exp(-reveal.read(at).r)) : 0.0;
  float3 mean = sum.a > 1e-6 ? sum.rgb / sum.a : float3(0);
  c = float4(mean * covered + c.rgb * (1.0 - covered), covered + c.a * (1.0 - covered));
  float3 lit = c.a > 1e-4 ? toneCurve(max(c.rgb / c.a, float3(0))) : float3(0);
  return float4(mix(frame.background.rgb, lit, saturate(c.a)), 1.0);
}
