// The studio's light, gathered once at start-up into two small cube maps: what a rough or
// smooth surface reflects (one roughness per mip), and what a matt surface receives.

struct EnvironmentUniforms {
  float4 keyDirection;
  float4 room;
  float4 strips;
  float4 what;  // x: face 0..5, y: roughness, z: 1 for the matt (cosine) gathering, w: samples
};

// The direction a point of a cube face looks along. u, v in -1..1, v downward.
float3 cubeDirection(uint face, float2 uv) {
  float u = uv.x * 2.0 - 1.0, v = uv.y * 2.0 - 1.0;
  switch (face) {
    case 0: return normalize(float3(1, -v, -u));
    case 1: return normalize(float3(-1, -v, u));
    case 2: return normalize(float3(u, 1, v));
    case 3: return normalize(float3(u, -1, -v));
    case 4: return normalize(float3(u, -v, 1));
    default: return normalize(float3(-u, -v, -1));
  }
}

float radicalInverse(uint bits) {
  bits = (bits << 16) | (bits >> 16);
  bits = ((bits & 0x55555555u) << 1) | ((bits & 0xAAAAAAAAu) >> 1);
  bits = ((bits & 0x33333333u) << 2) | ((bits & 0xCCCCCCCCu) >> 2);
  bits = ((bits & 0x0F0F0F0Fu) << 4) | ((bits & 0xF0F0F0F0u) >> 4);
  bits = ((bits & 0x00FF00FFu) << 8) | ((bits & 0xFF00FF00u) >> 8);
  return float(bits) * 2.3283064365386963e-10;
}

// A direction about `n`: `local` is given with z along n.
float3 about(float3 n, float3 local) {
  float3 up = abs(n.y) < 0.99 ? float3(0, 1, 0) : float3(1, 0, 0);
  float3 t = normalize(cross(up, n)), b = cross(n, t);
  return normalize(t * local.x + b * local.y + n * local.z);
}

fragment float4 environmentFragment(ScreenOut in [[stage_in]], constant EnvironmentUniforms& u [[buffer(0)]]) {
  float3 n = cubeDirection(uint(u.what.x), in.uv);
  uint count = uint(u.what.w);
  float3 sum = float3(0);
  float weight = 0;
  for (uint i = 0; i < count; i++) {
    float2 xi = float2((float(i) + 0.5) / float(count), radicalInverse(i));
    float phi = 6.2831853 * xi.x;
    if (u.what.z > 0.5) {
      // Matt: directions weighted by the cosine, so the mean is what the surface receives over pi.
      float cosT = sqrt(1.0 - xi.y), sinT = sqrt(xi.y);
      sum += studioRadiance(about(n, float3(cos(phi) * sinT, sin(phi) * sinT, cosT)), u.keyDirection.xyz, u.room, u.strips);
      weight += 1.0;
    } else {
      // Shiny: the GGX lobe of this roughness about the mirror direction, seen along it.
      float a = max(u.what.y * u.what.y, 1e-3);
      float cosT = sqrt((1.0 - xi.y) / (1.0 + (a * a - 1.0) * xi.y)), sinT = sqrt(max(0.0, 1.0 - cosT * cosT));
      float3 h = about(n, float3(cos(phi) * sinT, sin(phi) * sinT, cosT));
      float3 l = 2.0 * dot(n, h) * h - n;
      float nl = dot(n, l);
      if (nl > 0) {
        sum += studioRadiance(l, u.keyDirection.xyz, u.room, u.strips) * nl;
        weight += nl;
      }
    }
  }
  return float4(sum / max(weight, 1e-4), 1.0);
}
