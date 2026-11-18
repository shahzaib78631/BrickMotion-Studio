#if BM_GLASS_RAY_QUERY
#include <metal_raytracing>
using namespace metal::raytracing;
#define GLASS_ACCEL_PARAMETER , primitive_acceleration_structure acceleration
#define GLASS_ACCEL_ARGUMENT , acceleration
#else
#define GLASS_ACCEL_PARAMETER
#define GLASS_ACCEL_ARGUMENT
#endif
// Deterministic dielectric transport through the actual walls, cavities and neighbouring
// pieces. The BVH is rebuilt only when the scene moves, never when the camera or lights move.
struct GlassTriangle { float4 p[3], n[3], base, surface; };
struct GlassNode { float4 lo, hi; uint4 range; };
struct GlassHit { float distance; float2 uv; uint triangle; };

GlassHit glassHit(float3 origin, float3 direction, const device GlassNode* nodes, const device GlassTriangle* triangles, uint count GLASS_ACCEL_PARAMETER) {
  GlassHit hit{1e20, float2(0), 0xffffffffu};
  float minimum = 0.002;
#if BM_GLASS_RAY_QUERY
  ray r;
  r.origin = origin; r.direction = direction; r.min_distance = 0.002; r.max_distance = 1e20;
  intersector<triangle_data> query;
  query.assume_geometry_type(geometry_type::triangle);
  query.force_opacity(forced_opacity::opaque);
  auto found = query.intersect(r, acceleration);
  if (found.type == intersection_type::none) return hit;
  hit = GlassHit{found.distance, found.triangle_barycentric_coord, found.primitive_id};
  float2 uv = hit.uv;
  if (triangles[hit.triangle].surface.w < 0.5 && min(min(uv.x, uv.y), 1.0 - uv.x - uv.y) > 0.001) return hit;
  minimum = max(0.002, hit.distance - 0.001);
  hit.distance += 0.001;
#endif
  float3 safe = select(direction, select(float3(-1e-12), float3(1e-12), direction >= 0), abs(direction) < 1e-12);
  float3 inv = 1.0 / safe;
  uint node = 0;
  while (node < count) {
    GlassNode b = nodes[node];
    float3 a = (b.lo.xyz - origin) * inv, z = (b.hi.xyz - origin) * inv;
    float3 near = min(a, z), far = max(a, z);
    if (max(max(near.x, near.y), max(near.z, minimum)) > min(min(far.x, far.y), min(far.z, hit.distance))) { node = b.range.z; continue; }
    if (b.range.y == 0) { ++node; continue; }
    for (uint i = b.range.x; i < b.range.x + b.range.y; ++i) {
      GlassTriangle t = triangles[i];
      float3 e1 = t.p[1].xyz - t.p[0].xyz, e2 = t.p[2].xyz - t.p[0].xyz;
      float3 p = cross(direction, e2);
      float determinant = dot(e1, p);
      if (abs(determinant) < 1e-9) continue;
      float3 delta = origin - t.p[0].xyz;
      float u = dot(delta, p) / determinant;
      float3 q = cross(delta, e1);
      float v = dot(direction, q) / determinant, distance = dot(e2, q) / determinant;
      if (u >= -1e-6 && v >= -1e-6 && u + v <= 1.000001 && distance >= minimum && (distance < hit.distance - 1e-5 || (abs(distance - hit.distance) <= 1e-5 && i < hit.triangle)))
        hit = GlassHit{distance, float2(u, v), i};
    }
    node = b.range.z;
  }
  return hit;
}

float3 glassEnvironment(float3 direction, constant FrameUniforms& frame) {
  float3 result = float3(frame.rig.x);
  float radius = sqrt(1.0 - frame.rig.y);
  for (int i = 0; i < 4; ++i)
    result += frame.lights[i].w / (3.14159265 * frame.rig.y) * smoothstep(radius - 0.02, radius + 0.02, dot(direction, frame.lights[i].xyz));
  return result;
}
struct GlassRay {
  float3 origin, direction, weight, absorption;
  uint depth;
  bool reflected;
};

struct GlassInterface {
  float fresnel;
  float3 transmitted;
  bool transmits;
};

// Exact unpolarized Fresnel and Snell refraction at an air/plastic boundary.
// The eta argument is the ratio of the incident IOR to the transmitted IOR.
GlassInterface glassInterface(float3 incident, float3 facing, float eta) {
  float cosine = saturate(dot(facing, -incident));
  float sine2 = eta * eta * (1.0 - cosine * cosine);
  if (sine2 >= 1.0) return GlassInterface{1.0, float3(0.0), false};  // total internal reflection
  float ct = sqrt(max(1.0 - sine2, 0.0));
  float rs = (eta * cosine - ct) / max(eta * cosine + ct, 1e-6);
  float rp = (cosine - eta * ct) / max(cosine + eta * ct, 1e-6);
  float3 transmitted = normalize(eta * incident + (eta * cosine - ct) * facing);
  return GlassInterface{0.5 * (rs * rs + rp * rp), transmitted, true};
}

fragment OpaqueOut glassTransportFragment(BrickOut in [[stage_in]], constant FrameUniforms& frame [[buffer(1)]],
  const device GlassNode* nodes [[buffer(3)]], const device GlassTriangle* triangles [[buffer(4)]], constant uint& nodeCount [[buffer(5)]],
  depth2d<float> shadowMap [[texture(0)]], sampler shadowSampler [[sampler(1)]]
#if BM_GLASS_RAY_QUERY
  , primitive_acceleration_structure acceleration [[buffer(6)]]
#endif
) {
  float3 direction = normalize(in.world - frame.eye.xyz);
  GlassRay pending[16];
  int size = 1;
  pending[0] = GlassRay{in.world - direction * 0.02, direction, float3(1), float3(0), 0, false};
  float3 result = 0;
  for (int work = 0; work < 40 && size > 0; ++work) {
    GlassRay ray = pending[--size];
    if (max(max(ray.weight.r, ray.weight.g), ray.weight.b) < 0.01) continue;
    GlassHit hit = glassHit(ray.origin, ray.direction, nodes, triangles, nodeCount GLASS_ACCEL_ARGUMENT);
    float floorDistance = frame.glass.w > 0.5 && ray.direction.y > 1e-5 ? (frame.floorPlane.x - ray.origin.y) / ray.direction.y : -1;
    if (floorDistance > 0 && floorDistance < hit.distance) {
      // The ground seen through a pane is a shadow catcher, not the camera's
      // contact shadow. EyeSight darkens its white level behind glass; reflections
      // still see the studio's illumination rather than a painted background.
      result += ray.weight * (ray.reflected ? float3(frame.rig.x) : frame.background.rgb * frame.glass.y);
      continue;
    }
    if (hit.triangle == 0xffffffffu) {
      result += ray.weight * (ray.reflected ? glassEnvironment(ray.direction, frame) : frame.background.rgb * frame.glass.y);
      continue;
    }
    ray.weight *= exp(-ray.absorption * hit.distance);
    GlassTriangle t = triangles[hit.triangle];
    float3 point = ray.origin + ray.direction * hit.distance;
    float3 geometric = normalize(cross(t.p[1].xyz - t.p[0].xyz, t.p[2].xyz - t.p[0].xyz));
    float3 normal = normalize(t.n[0].xyz * (1.0 - hit.uv.x - hit.uv.y) + t.n[1].xyz * hit.uv.x + t.n[2].xyz * hit.uv.y);
    bool entering = dot(ray.direction, geometric) < 0;
    float3 geometricFacing = entering ? geometric : -geometric;
    float3 facing = entering ? normal : -normal;
    if (dot(facing, -ray.direction) < 0.01 || dot(facing, geometricFacing) < 0.25)
      facing = geometricFacing;
    if (t.base.a < 0.5) {
      Lit light = shade(t.base.rgb, t.surface.x, t.surface.y, t.surface.z, facing, -ray.direction, point, frame, true, uint2(in.position.xy), shadowMap, shadowSampler);
      result += ray.weight * light.color;
      continue;
    }
    if (ray.depth >= 12) continue; // trapped paths contribute no unearned white light
    float eta = entering ? 1.0 / frame.glass.z : frame.glass.z;
    GlassInterface boundary = glassInterface(ray.direction, facing, eta);
    float3 reflected = normalize(reflect(ray.direction, facing));
    // A smoothed shading normal on a rounded edge can bend the refracted ray
    // back across the *geometric* face. The next query then hits that same face
    // again, causing bright/dark sparkling seams. Keep the smooth normal where
    // it is valid, but use the geometric interface for pathological directions.
    if ((boundary.transmits && dot(boundary.transmitted, geometricFacing) >= -1e-4) ||
        dot(reflected, geometricFacing) <= 1e-4) {
      facing = geometricFacing;
      boundary = glassInterface(ray.direction, facing, eta);
      reflected = normalize(reflect(ray.direction, facing));
    }
    float3 reflectionWeight = ray.weight * boundary.fresnel;
    if (size < 15 && max(max(reflectionWeight.r, reflectionWeight.g), reflectionWeight.b) >= 0.01)
      pending[size++] = GlassRay{point + reflected * 0.01, reflected, reflectionWeight, ray.absorption, ray.depth + 1, true};
    if (boundary.transmits && size < 16) {
      // Beer-Lambert extinction per LDU, measured over each actual wall segment.
      float3 absorption = entering ? frame.glass.x * saturate(1.0 - t.base.rgb) / 6.0 : float3(0);
      pending[size++] = GlassRay{point + boundary.transmitted * 0.01, boundary.transmitted, ray.weight * (1.0 - boundary.fresnel), absorption, ray.depth + 1, ray.reflected};
    }
  }
  OpaqueOut out;
  out.color = float4(result, 1);
  out.shares = float4(0); // already lit at the transported points, not at the front glass wall
  return out;
}
