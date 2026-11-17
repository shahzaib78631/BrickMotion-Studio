// Ambient occlusion: how much of the surroundings a point sees, from the depth buffer alone,
// at half size. For each pixel, 8 directions across the screen, 4 steps each out to kAoRadius
// (LDU, as far as it reaches on screen): in each direction the highest point above the
// surface's plane (the horizon) occludes in proportion to its angle, fading with distance.
// Then a 4 x 4 blur that does not cross depth edges. The last pass dims only the light that
// came from the surroundings by it (and the floor, which has no other light).

struct AoUniforms {
  float4 lens;   // tan of half the angle of view up and across, near, far
  float4 shape;  // radius (LDU), bias (cosine), strength, full-size width
  float4 size;   // full-size height, half width, half height, unused
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

fragment float aoFragment(ScreenOut in [[stage_in]], constant AoUniforms& u [[buffer(0)]], depth2d<float> depth [[texture(0)]]) {
  int2 cell = int2(in.position.xy);
  int2 at = cell * 2;
  float4 p = viewPoint(depth, at, u);
  if (p.w == 0) return 1.0;
  // The surface's normal from its neighbours, each side taking the nearer in depth so a silhouette does not bend it.
  float4 l = viewPoint(depth, at - int2(1, 0), u), r = viewPoint(depth, at + int2(1, 0), u);
  float4 t = viewPoint(depth, at - int2(0, 1), u), b = viewPoint(depth, at + int2(0, 1), u);
  float3 dx = (r.w > 0 && (l.w == 0 || abs(r.z - p.z) < abs(l.z - p.z))) ? r.xyz - p.xyz : p.xyz - l.xyz;
  float3 dy = (b.w > 0 && (t.w == 0 || abs(b.z - p.z) < abs(t.z - p.z))) ? p.xyz - b.xyz : t.xyz - p.xyz;
  float3 n = normalize(cross(dx, dy));
  if (dot(n, -p.xyz) < 0) n = -n;
  float radius = u.shape.x;
  float reach = min(radius / (-p.z * u.lens.x) * u.size.x * 0.5, 64.0);  // pixels
  if (reach < 1.0) return 1.0;
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
  return saturate(1.0 - u.shape.z * sum / 8.0);
}

fragment float aoBlurFragment(ScreenOut in [[stage_in]], constant AoUniforms& u [[buffer(0)]], texture2d<float> ao [[texture(0)]], depth2d<float> depth [[texture(1)]]) {
  int2 cell = int2(in.position.xy);
  int2 halfSize = int2(u.size.y, u.size.z);
  int2 fullSize = int2(u.shape.w, u.size.x);
  float centre = depth.read(uint2(clamp(cell * 2, int2(0), fullSize - 1)));
  if (centre <= 0.0) return 1.0;
  float z = viewDepth(centre, u.lens);
  float sum = 0, weight = 0;
  for (int y = -2; y < 2; y++)
    for (int x = -2; x < 2; x++) {
      int2 q = clamp(cell + int2(x, y), int2(0), halfSize - 1);
      float d = depth.read(uint2(clamp(q * 2, int2(0), fullSize - 1)));
      float w = d > 0.0 ? exp(-abs(viewDepth(d, u.lens) - z) / (0.02 * z)) : 0.0;
      sum += ao.read(uint2(q)).r * w;
      weight += w;
    }
  return weight > 0 ? sum / weight : 1.0;
}
