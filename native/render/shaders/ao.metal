// Ambient occlusion: how much of the surroundings a point sees, from the depth buffer alone,
// at half size. For each pixel, 8 directions across the screen, 4 steps each out to kAoRadius
// (LDU, as far as it reaches on screen): in each direction the highest point above the
// surface's plane (the horizon) occludes in proportion to its angle, fading with distance.
// The key light's soft shadow is worked out here too, at the same points, so that the same
// blur smooths its sampling. Then a 4 x 4 blur that does not cross depth edges. The last pass
// dims by them only the light that came from the surroundings, and from the key.

struct AoUniforms {
  float4 lens;   // tan of half the angle of view up and across, near, far
  float4 shape;  // radius (LDU), bias (cosine), strength, full-size width
  float4 size;   // full-size height, half width, half height, unused
  float4 eye, right, up, forward;  // the camera in world space (xyz), to carry view-space points there
};

// View-space depth (positive, LDU) from reversed depth.
float viewDepth(float d, float4 lens) { return lens.z * lens.w / (lens.z + d * (lens.w - lens.z)); }

// The view-space point under a full-size pixel, or w = 0 where there is nothing.
float4 viewPoint(depth2d<float> depth, int2 p, constant AoUniforms& u) {
  int2 size = int2(u.shape.w, u.size.x);
  p = clamp(p, int2(0), size - 1);
  float d = depth.read(uint2(p));
  if (d <= 0.0) return float4(0);
  float z = viewDepth(d, u.lens);
  float2 ndc = float2((float(p.x) + 0.5) / size.x * 2.0 - 1.0, 1.0 - (float(p.y) + 0.5) / size.y * 2.0);
  return float4(ndc.x * z * u.lens.y, ndc.y * z * u.lens.x, -z, 1.0);
}

fragment float2 aoFragment(ScreenOut in [[stage_in]], constant AoUniforms& u [[buffer(0)]], constant FrameUniforms& frame [[buffer(1)]], constant FloorBins& bins [[buffer(2)]],
                           depth2d<float> depth [[texture(0)]], depth2d<float> shadowMap [[texture(1)]], texture2d<float> heights [[texture(2)]], sampler shadowSampler [[sampler(1)]]) {
  int2 cell = int2(in.position.xy);
  int2 at = cell * 2;
  float4 p = viewPoint(depth, at, u);
  if (p.w == 0) return float2(1.0);
  // The surface's normal from its neighbours, each side taking the nearer in depth so a silhouette does not bend it.
  float4 l = viewPoint(depth, at - int2(1, 0), u), r = viewPoint(depth, at + int2(1, 0), u);
  float4 t = viewPoint(depth, at - int2(0, 1), u), b = viewPoint(depth, at + int2(0, 1), u);
  float3 dx = (r.w > 0 && (l.w == 0 || abs(r.z - p.z) < abs(l.z - p.z))) ? r.xyz - p.xyz : p.xyz - l.xyz;
  float3 dy = (b.w > 0 && (t.w == 0 || abs(b.z - p.z) < abs(t.z - p.z))) ? p.xyz - b.xyz : t.xyz - p.xyz;
  float3 n = normalize(cross(dx, dy));
  if (dot(n, -p.xyz) < 0) n = -n;
  float3 world = u.eye.xyz + u.right.xyz * p.x + u.up.xyz * p.y - u.forward.xyz * p.z;
  // The floor: its whole light, from the height map over the model (floor_light.metal), in r.
  if (frame.floorLook.z > 0.5 && abs(world.y - frame.floorPlane.x) < 0.5)
    return float2(floorLight(world, frame, bins, heights, uint2(cell), frame.switches.y > 0.5, frame.switches.x > 0.5), 1.0);
  float lit = 1.0;
  if (frame.switches.x > 0.5) {
    float3 worldNormal = normalize(u.right.xyz * n.x + u.up.xyz * n.y - u.forward.xyz * n.z);
    lit = keyShadow(world, worldNormal, frame, shadowMap, shadowSampler, tileTurn(uint2(cell)));
  }
  if (frame.switches.y < 0.5) return float2(1.0, lit);
  float radius = u.shape.x;
  float reach = min(radius / (-p.z * u.lens.x) * u.size.x * 0.5, 160.0);  // pixels
  if (reach < 1.0) return float2(1.0, lit);
  // A fixed 4 x 4 pattern turns the directions and offsets the steps from pixel to pixel; the blur removes it.
  const float pattern[16] = {0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5};
  float jitter = (pattern[(cell.y & 3) * 4 + (cell.x & 3)] + 0.5) / 16.0;
  float sum = 0;
  for (int i = 0; i < 8; i++) {
    float angle = (float(i) + jitter) * (6.2831853 / 8.0);
    float2 dir = float2(cos(angle), sin(angle));
    float most = 0;
    for (int s = 0; s < 4; s++) {
      float2 step = dir * reach * (float(s) + fract(jitter * 7.0 + 0.5)) / 4.0;
      float4 q = viewPoint(depth, at + int2(round(step)), u);
      if (q.w == 0) continue;
      float3 v = q.xyz - p.xyz;
      float dist = length(v);
      if (dist < 1e-3 || dist > radius) continue;
      float rise = dot(n, v) / dist - u.shape.y;
      float fade = 1.0 - (dist / radius) * (dist / radius);
      most = max(most, rise * fade);
    }
    sum += most;
  }
  return float2(saturate(1.0 - u.shape.z * sum / 8.0), lit);
}

// The floor's r (its light) and a brick's (its occlusion) are not mixed, even where the two
// meet at one depth: the shares target (g > 0 on the floor) says which a pixel is.
fragment float2 aoBlurFragment(ScreenOut in [[stage_in]], constant AoUniforms& u [[buffer(0)]], texture2d<float> ao [[texture(0)]], depth2d<float> depth [[texture(1)]],
                               texture2d<float> shares [[texture(2)]]) {
  int2 cell = int2(in.position.xy);
  int2 halfSize = int2(u.size.y, u.size.z);
  int2 fullSize = int2(u.shape.w, u.size.x);
  float centre = depth.read(uint2(clamp(cell * 2, int2(0), fullSize - 1)));
  if (centre <= 0.0) return float2(1.0);
  float z = viewDepth(centre, u.lens);
  bool onFloor = shares.read(uint2(clamp(cell * 2, int2(0), fullSize - 1))).g > 0.0;
  float2 sum = 0;
  float weight = 0;
  for (int y = -2; y < 2; y++)
    for (int x = -2; x < 2; x++) {
      int2 q = clamp(cell + int2(x, y), int2(0), halfSize - 1);
      float d = depth.read(uint2(clamp(q * 2, int2(0), fullSize - 1)));
      bool same = (shares.read(uint2(clamp(q * 2, int2(0), fullSize - 1))).g > 0.0) == onFloor;
      float w = d > 0.0 && same ? exp(-abs(viewDepth(d, u.lens) - z) / (0.02 * z)) : 0.0;
      sum += ao.read(uint2(q)).rg * w;
      weight += w;
    }
  return weight > 0 ? sum / weight : float2(1.0);
}
