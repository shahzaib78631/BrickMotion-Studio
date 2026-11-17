// The last pass: background where nothing was drawn, occlusion, transparency, the selection outline, and out as sRGB.

// A half-size picture at a full-size pixel: its four nearest cells, each weighted as bilinear
// filtering would and by how near its depth is to the pixel's, so that what was worked out on
// one surface does not bleed onto another across a silhouette. Reversed depth is about 1 / the
// distance, so a relative difference in it is one in distance.
float2 upsample(texture2d<float> coarse, depth2d<float> depth, texture2d<float> shares, uint2 at) {
  int2 halfSize = int2(coarse.get_width(), coarse.get_height()), fullSize = int2(depth.get_width(), depth.get_height());
  float centre = depth.read(at);
  bool onFloor = shares.read(at).a > 0.5;  // the floor's light and a brick's occlusion are not mixed
  float2 h = (float2(at) + 0.5) * 0.5 - 0.5;
  int2 base = int2(floor(h));
  float2 f = h - float2(base);
  float2 sum = 0;
  float weight = 0, best = 1e9;
  float2 nearest = float2(1.0);
  for (int k = 0; k < 4; k++) {
    int2 cell = clamp(base + int2(k & 1, k >> 1), int2(0), halfSize - 1);
    float d = depth.read(uint2(clamp(cell * 2, int2(0), fullSize - 1)));
    float apart = abs(d - centre) / max(centre, 1e-6);
    if ((shares.read(uint2(clamp(cell * 2, int2(0), fullSize - 1))).a > 0.5) != onFloor) apart = 1e3;
    float2 v = coarse.read(uint2(cell)).rg;
    float w = ((k & 1) ? f.x : 1.0 - f.x) * ((k >> 1) ? f.y : 1.0 - f.y) * exp(-apart / 0.02);
    sum += v * w, weight += w;
    if (apart < best) best = apart, nearest = v;
  }
  return weight > 1e-4 ? sum / weight : nearest;
}

fragment float4 compositeFragment(ScreenOut in [[stage_in]], constant FrameUniforms& frame [[buffer(1)]], texture2d<float> scene [[texture(0)]], texture2d<float> accum [[texture(1)]],
                                  texture2d<float> reveal [[texture(2)]], texture2d<float> mask [[texture(3)]], texture2d<float> ambient [[texture(4)]],
                                  texture2d<float> occlusion [[texture(5)]], depth2d<float> depth [[texture(6)]], sampler smooth [[sampler(0)]]) {
  uint2 at = uint2(in.position.xy);
  float4 c = scene.read(at);
  // Ambient occlusion dims the light an opaque surface had from its surroundings, and the floor.
  // Occlusion (r) and the key light's shadow (g), worked out at half size and smoothed.
  // On the floor, r is instead the share of its light that reaches it.
  bool worked = frame.switches.x > 0.5 || frame.switches.y > 0.5;
  float2 seen = worked ? upsample(occlusion, depth, ambient, at) : float2(1.0);
  float ao = seen.r, keyLit = seen.g;
  float4 share = ambient.read(at);
  c.rgb *= saturate(1.0 - share.r * (1.0 - pow(ao, frame.rig.z)) - share.b * (1.0 - keyLit));
  // The transparent layers, over what is behind them: their weighted mean colour, covering
  // as much as they do not let through.
  float4 sum = accum.read(at);
  float covered = sum.a > 1e-6 ? saturate(1.0 - exp(-reveal.read(at).r)) : 0.0;
  float3 mean = sum.a > 1e-6 ? sum.rgb / sum.a : float3(0);
  c = float4(mean * covered + c.rgb * (1.0 - covered), covered + c.a * (1.0 - covered));
  // Out as EyeSight's renders are (Standard view): linear light, clipped at white.
  float3 lit = c.a > 1e-4 ? saturate(c.rgb / c.a) : float3(0);
  float3 out = mix(frame.background.rgb, lit, saturate(c.a));
  out *= 1.0 - share.g * (1.0 - ao);
  // The selection's outline: just outside where the selected pieces are, within its width.
  int width = int(frame.selection.w);
  if (width > 0 && mask.read(at).r < 0.5) {
    int2 size = int2(mask.get_width(), mask.get_height());
    bool near = false;
    for (int dy = -width; dy <= width && !near; dy++)
      for (int dx = -width; dx <= width && !near; dx++) {
        if (dx * dx + dy * dy > width * width) continue;
        int2 q = clamp(int2(at) + int2(dx, dy), int2(0), size - 1);
        near = mask.read(uint2(q)).r > 0.5;
      }
    if (near) out = frame.selection.rgb;
  }
  return float4(out, 1.0);
}
