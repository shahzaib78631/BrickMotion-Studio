// The floor's light, as EyeSight's ground catches it: the white world and four wide lights,
// less what the model hides of them. Seen from a floor point, a column of the model at
// distance r, from its underside at height b to its top at height t, hides the elevations
// from atan(b / r) to atan(t / r) in that direction; so a floating piece leaves a gap under it.
//
// A height map over the model (drawn from above: the highest top and lowest underside in each
// column) is walked outward in 12 directions. What each hides goes in a mask of 16 bins, even
// in sin^2 of the elevation, which is even in light a level floor takes from a uniform sky.
// The sky's share is then its clear bins; a light's, the clear bins weighted by how much of its
// disk each holds (FloorBins, worked out each frame from the lights). As EyeSight's ground (in
// the fit of scripts/neural/blender/render.py), the floor's light is the lights' share times
// the sky's share raised to a power (FrameUniforms::floorLook.w).

struct HeightIn {
  float3 position [[attribute(0)]];
};
struct HeightOut {
  float4 position [[position]];
  float height;  // above the floor
};

// Drawn with the map's own matrix (`map`), as shadowVertex is.
vertex HeightOut heightVertex(HeightIn in [[stage_in]], uint iid [[instance_id]], constant FrameUniforms& frame [[buffer(1)]], constant float4x4& map [[buffer(2)]],
                              const device InstanceData* instances [[buffer(3)]], const device uint* visible [[buffer(4)]]) {
  InstanceData inst = instances[visible[iid]];
  float3 p = placePoint(inst, in.position);
  HeightOut out;
  out.position = map * float4(p, 1.0);
  out.position.z = 0.5;  // no depth: the target keeps the least of each channel
  out.height = frame.floorPlane.x - p.y;
  return out;
}

fragment float2 heightFragment(HeightOut in [[stage_in]]) { return float2(-in.height, in.height); }

float floorLight(float3 world, constant FrameUniforms& frame, constant FloorBins& bins, texture2d<float> heights, uint2 cell, bool sky, bool key) {
  constexpr sampler nearest(filter::nearest, address::clamp_to_zero);
  const uint bayer[16] = {0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5};
  uint tile = bayer[(cell.y & 3) * 4 + (cell.x & 3)];
  uint turn = tile & 3;                                // a quarter of a sector, 0..3
  float jitter = (float(tile >> 2) + 0.5) / 4.0;       // a share of a step
  float near = frame.floorLook.x, far = frame.floorLook.y;
  const int steps = 16;
  // Each step stands for the stretch out to halfway to its neighbours: what stands there
  // hides from the underside seen at the stretch's far end to the top seen at its near end.
  float ratio = pow(far / near, 1.0 / float(steps)), spread = sqrt(ratio);
  float first = near * pow(ratio, jitter);
  float2 origin = (frame.heightProj * float4(world, 1.0)).xy;
  float2 minimum = frame.floorCasters.xy - world.xz;
  float2 maximum = frame.floorCasters.zw - world.xz;
  // The nearest point in the caster footprint is farther than any ray step.
  float2 offset = max(max(minimum, -maximum), 0.0);
  float reach = max(near, far);
  if (dot(offset, offset) > reach * reach * 1.0001) return 1.0;
  uint masks[12];
  uint blockedBins = 0;
  for (int d = 0; d < 12; d++) {
    float4 ray = bins.rays[d * 4 + int(turn)];
    float2 p0 = minimum * ray.zw, p1 = maximum * ray.zw;
    float2 enters = min(p0, p1), leaves = max(p0, p1);
    float enter = max(enters.x, enters.y), leave = min(leaves.x, leaves.y);
    uint mask = 0;
    if (leave < enter || (ratio >= 1.0 && (leave < first || enter > far))) {
      masks[d] = mask;
      continue;
    }
    float2 direction = (frame.heightProj * float4(ray.x, 0.0, ray.y, 0.0)).xy;
    float r = first;
    for (int k = 0; k < steps; k++, r *= ratio) {
      if (r > leave) {
        if (ratio >= 1.0) break;
        continue;
      }
      if (r < enter) continue;
      float2 c = origin + direction * r;
      float2 uv = float2(c.x * 0.5 + 0.5, 0.5 - c.y * 0.5);
      if (any(uv < 0.0) || any(uv > 1.0)) continue;
      float2 h = heights.sample(nearest, uv).rg;
      float top = -h.r, low = max(h.g, 0.0);
      if (top < 0.5) continue;  // nothing stands here
      float inner = r / spread, outer = r * spread;
      float s0 = low * low / (low * low + outer * outer), s1 = top * top / (top * top + inner * inner);
      // The bins whose middles lie between.
      int b0 = int(ceil(s0 * 16.0 - 0.5)), b1 = min(int(floor(s1 * 16.0 - 0.5)), 15);
      if (b1 >= b0) mask |= ((1u << uint(b1 - b0 + 1)) - 1u) << uint(b0);
      if (mask == 0xffffu) break;
    }
    masks[d] = mask;
    blockedBins += popcount(mask);
  }
  if (blockedBins == 0) return 1.0;
  // The four lights' shadow, as a share of their light on a bare floor; then the sky's share.
  float light = 0, whole = 0;
  for (int i = 0; i < 4; i++) {
    float lit = bins.lit[i];
    if (lit <= 0) continue;
    whole += lit;
    if ((i == 0 && !key) || (i > 0 && !sky)) {
      light += lit;
      continue;
    }
    uint blocked = 0;
    uint all = bins.total[i][turn];
    for (int d = 0; d < 12; d++) {
      uint mask = masks[d];
      if (mask == 0) continue;
      int row = d * 4 + int(turn);
      // A bin's weight is an exact count of covered light samples (0 to 16).
      // Sum each weight bit across all blocked bins in five parallel counts.
      #pragma unroll
      for (int bit = 0; bit < 5; ++bit)
        blocked += popcount(mask & uint(bins.weights[i][row][bit])) << bit;
    }
    light += all > 0 ? lit * float(all - blocked) / float(all) : lit;
  }
  float out = whole > 0 ? light / whole : 1.0;
  if (sky) out *= pow(float(192u - blockedBins) / 192.0, frame.floorLook.w);
  return out;
}
