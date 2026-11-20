// The last pass: background where nothing was drawn, occlusion, transparency, the selection outline, and out as sRGB.

// A half-size picture at a full-size pixel: its four nearest cells, each weighted as bilinear
// filtering would and by how near its depth is to the pixel's, so that what was worked out on
// one surface does not bleed onto another across a silhouette. Reversed depth is about 1 / the
// distance, so a relative difference in it is one in distance.
float2 upsample(texture2d<float> coarse, depth2d<float> depth, bool onFloor, uint2 at) {
  int2 halfSize = int2(coarse.get_width(), coarse.get_height()), fullSize = int2(depth.get_width(), depth.get_height());
  float centre = depth.read(at);
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
    float4 sample = coarse.read(uint2(cell));
    if (sample.a < 0.5 || (sample.b > 0.5) != onFloor) continue;
    float2 v = sample.rg;
    float w = ((k & 1) ? f.x : 1.0 - f.x) * ((k >> 1) ? f.y : 1.0 - f.y) * exp(-apart / 0.02);
    sum += v * w, weight += w;
    if (apart < best) best = apart, nearest = v;
  }
  return weight > 1e-4 ? sum / weight : nearest;
}

// The floor is sampled independently of the foreground depth. At an antialiased
// silhouette, the resolved MSAA depth is sample 0 (often the *brick*), whereas
// the floor and its coverage can occupy the other three samples. Rejecting
// floor-light samples against that brick depth makes an unshadowed bright rim.
// The floor is a single plane: nearby floor-light samples can be interpolated
// spatially without crossing any depth discontinuity *on the floor itself*.
float upsampleFloor(texture2d<float> coarse, uint2 at) {
  int2 size = int2(coarse.get_width(), coarse.get_height());
  float2 h = (float2(at) + 0.5) * 0.5 - 0.5;
  int2 base = int2(floor(h));
  float2 f = fract(h);
  float sum = 0.0, weight = 0.0;
  for (int k = 0; k < 4; ++k) {
    int2 q = clamp(base + int2(k & 1, k >> 1), int2(0), size - 1);
    float4 sample = coarse.read(uint2(q));
    // .b identifies the floor; .a identifies valid depth. Do not mix brick AO
    // (also in .r) into the floor light, even where they share an MSAA pixel.
    if (sample.b < 0.5 || sample.a < 0.5) continue;
    float w = ((k & 1) ? f.x : 1.0 - f.x) * ((k >> 1) ? f.y : 1.0 - f.y);
    sum += sample.r * w;
    weight += w;
  }
  if (weight > 1e-4) return sum / weight;

  // Only the few pixels right against a silhouette need this fallback: the
  // nearest half-resolution cell may contain the object at sample 0, leaving
  // no floor sample in the bilinear footprint. A short local search recovers
  // the floor light from just outside the silhouette. The common path above
  // costs only four reads and needs no extra render target or pass.
  float closest = 1e9, light = 1.0;
  for (int y = -2; y <= 2; ++y)
    for (int x = -2; x <= 2; ++x) {
      int2 q = clamp(base + int2(x, y), int2(0), size - 1);
      float4 sample = coarse.read(uint2(q));
      if (sample.b < 0.5 || sample.a < 0.5) continue;
      float d = dot(float2(q) - h, float2(q) - h);
      if (d < closest) { closest = d; light = sample.r; }
    }
  return light;
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
  float4 share = worked || frame.switches.w < 0.5 || frame.switches.w > 1.5 ? ambient.read(at) : float4(0.0);
  float floorAo = 1.0;
  if (worked) {
    float2 seen = upsample(occlusion, depth, false, at);
    floorAo = share.g > 1e-4 ? upsampleFloor(occlusion, at) : 1.0;
    c.rgb *= saturate(1.0 - share.r * (1.0 - pow(seen.r, frame.rig.z)) - share.b * (1.0 - seen.g));
  }
  // MSAA resolves coverage, surface light, and floor coverage separately.
  // Reconstruct the covered surface and uncovered floor independently; applying
  // the floor shadow to the whole pixel instead brightens the uncovered part at
  // silhouettes *and* darkens brick samples that should not receive it.
  // Clamp only the per-sample light to white, preserving subpixel coverage.
  float coverage = saturate(c.a);
  float3 solid = c.a > 1e-4 ? saturate(c.rgb / c.a) * coverage : float3(0.0);
  float floorCoverage = min(saturate(share.g), 1.0 - coverage);
  float freeCoverage = max(1.0 - coverage - floorCoverage, 0.0);
  float3 behind = solid + frame.background.rgb * (freeCoverage + floorCoverage * floorAo);
  // The transparent layers: they let through exp(-depth) of what is behind (rgb what they
  // absorb, a what they cover), and cover it with their weighted mean colour.
  float4 sum = accum.read(at);
  float4 depthOf = reveal.read(at);
  // The floor or the background seen through glass: at the floor's own level there, unshadowed
  // (tolerances.h kFloorThroughGlass). The floor there is floor (share.a) that glass has cleared
  // share.g on; the background, what is neither floor nor opaque where something transparent is
  // in front: at least one glass wall face on (the least a wall covers), roughly, as
  // placeholders count too.
  float f0 = (frame.glass.z - 1.0) / (frame.glass.z + 1.0);
  f0 *= f0;
  float glassIn = saturate(depthOf.a / -log(1.0 - 2.0 * f0 / (1.0 + f0)));
  float through = saturate(share.a - share.g) + saturate(1.0 - c.a - share.a) * glassIn;
  behind -= frame.background.rgb * through * (1.0 - frame.glass.y);
  float3 mean = sum.a > 1e-6 ? sum.rgb / sum.a : float3(0);
  float3 out = behind * exp(-depthOf.rgb - depthOf.a) + mean * (1.0 - exp(-depthOf.a));
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
