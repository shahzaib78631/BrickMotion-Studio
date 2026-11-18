// The path tracer (bmr::PathTracer): one thread a pixel, a few samples a dispatch, summed in the
// accumulation buffers. EyeSight's studio: a uniform white world of radiance rig.x, four distant
// disk lights (radius asin(sqrt(rig.y))) of radiance strength / (pi sin^2), plastic as a matt
// base under a GGX layer and a clear coat (as brick.metal shade()), metal as tinted GGX, glass a
// dielectric absorbing by distance, and the floor a shadow catcher. Next-event estimation of the
// disks from matt bounces, joined with the matt bounce's own hits by the power heuristic.
#include <metal_stdlib>
#include <metal_raytracing>

struct PtVertex {
  packed_float3 p;
  packed_float3 n;
  uint color;  // 0: the piece's colour; otherwise 0xFFRRGGBB sRGB
};
struct PtMesh {
  device const PtVertex* vertices;
  device const uint* indices;
};
struct PtInstance {
  float4 row[3];   // part space to world (less the scene's origin), rows of 3x4
  float4 ncol[3];  // normals: the cofactor columns, times the sign of the determinant
  uint structure;
  uint material;
  uint2 pad;
};
struct PtMaterial {
  float4 base;     // linear rgb, alpha
  float4 surface;  // roughness, metalness, clearcoat, kind (0 plastic or metal, 1 glass, 2 placeholder)
};
struct PtUniforms {
  float4 eye;         // xyz; w tan(fovY / 2)
  float4 right;       // xyz; w aspect
  float4 up;
  float4 forward;
  float4 lights[4];   // toward each (unit), strength (irradiance square on)
  float4 rig;         // x world radiance, y sin^2 of the disks' radius, z cos of it, w 1 with the lights on
  float4 background;  // linear rgb
  float4 floorPlane;  // x the floor's y (down is +y), y 1 with the floor on, z the key's share in the floor's shadow
  float4 glass;       // x IOR, y absorption a wall (2 faces), z absorption an LDU, w the floor seen past a bounce
  uint4 size;         // width, height, samples in this dispatch, the first sample's index
  uint4 seed;         // low, high, 1 when there is a scene, the most bounces
};

constant float kPtPi = 3.14159265f;
constant float kPtEps = 0.02f;  // LDU: how far a new ray starts off the surface it leaves

inline uint ptHash(uint v) {
  uint s = v * 747796405u + 2891336453u;
  uint w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u;
  return (w >> 22u) ^ w;
}
struct PtRng {
  uint s;
  float next() {
    s = ptHash(s);
    return float(s >> 8) * (1.0f / 16777216.0f);
  }
};

inline float3 ptLinear(uint c) {
  float3 s = float3(float((c >> 16) & 255u), float((c >> 8) & 255u), float(c & 255u)) / 255.0f;
  return select(pow((s + 0.055f) / 1.055f, float3(2.4f)), s / 12.92f, s <= 0.04045f);
}
inline void ptBasis(float3 n, thread float3& t, thread float3& b) {
  float sign = n.z >= 0.0f ? 1.0f : -1.0f;
  float a = -1.0f / (sign + n.z), c = n.x * n.y * a;
  t = float3(1.0f + sign * n.x * n.x * a, sign * c, -sign * n.x);
  b = float3(c, sign + n.y * n.y * a, -n.y);
}
inline float3 ptAround(float3 axis, float cosT, float phi) {
  float3 t, b;
  ptBasis(axis, t, b);
  float sinT = sqrt(max(0.0f, 1.0f - cosT * cosT));
  return normalize(t * (sinT * cos(phi)) + b * (sinT * sin(phi)) + axis * cosT);
}
inline float3 ptCosine(float3 n, float u1, float u2) { return ptAround(n, sqrt(max(0.0f, 1.0f - u1)), 2.0f * kPtPi * u2); }
inline float ptSchlick(float f0, float c) { return f0 + (1.0f - f0) * pow(1.0f - saturate(c), 5.0f); }
inline float3 ptSchlick3(float3 f0, float c) { return f0 + (1.0f - f0) * pow(1.0f - saturate(c), 5.0f); }
inline float ptMean(float3 c) { return (c.x + c.y + c.z) / 3.0f; }
/// Unpolarised Fresnel reflectance of a dielectric; eta = n incident / n transmitted.
inline float ptFresnel(float cosi, float eta) {
  float sint2 = eta * eta * (1.0f - cosi * cosi);
  if (sint2 >= 1.0f) return 1.0f;
  float cost = sqrt(1.0f - sint2);
  float rs = (eta * cosi - cost) / (eta * cosi + cost), rp = (cosi - eta * cost) / (cosi + eta * cost);
  return 0.5f * (rs * rs + rp * rp);
}
inline float ptSmithG1(float c, float a2) { return 2.0f * c / (c + sqrt(a2 + (1.0f - a2) * c * c)); }
/// A GGX reflection, its half vector drawn by D(h) cos; `weight` is G2 (v.h) / ((n.v)(n.h)), 0 below the surface.
inline float3 ptGgx(float3 n, float3 v, float roughness, float u1, float u2, thread float& weight) {
  float a = max(roughness * roughness, 2e-3f), a2 = a * a;
  float3 h = ptAround(n, sqrt((1.0f - u1) / (1.0f + (a2 - 1.0f) * u1)), 2.0f * kPtPi * u2);
  float3 l = reflect(-v, h);
  float nl = dot(n, l), nv = max(dot(n, v), 1e-4f), nh = max(dot(n, h), 1e-4f), vh = max(dot(v, h), 0.0f);
  weight = nl > 0.0f ? ptSmithG1(nv, a2) * ptSmithG1(nl, a2) * vh / (nv * nh) : 0.0f;
  return l;
}

struct PtHit {
  bool hit;
  float t;
  float3 ns, ng;  // outward, unit
  uint material;
  uint color;
};

inline PtHit ptTrace(float3 origin, float3 dir, constant PtUniforms& u, metal::raytracing::instance_acceleration_structure scene,
                     device const PtInstance* instances, device const PtMesh* meshes) {
  PtHit out;
  out.hit = false;
  if (u.seed.z == 0u) return out;
  metal::raytracing::intersector<metal::raytracing::triangle_data, metal::raytracing::instancing> isect;
  isect.assume_geometry_type(metal::raytracing::geometry_type::triangle);
  isect.force_opacity(metal::raytracing::forced_opacity::opaque);
  metal::raytracing::ray r(origin, dir, 1e-3f, INFINITY);
  auto res = isect.intersect(r, scene, 0xFFu);
  if (res.type != metal::raytracing::intersection_type::triangle) return out;
  const device PtInstance& in = instances[res.instance_id];
  const device PtMesh& mesh = meshes[in.structure];
  const uint i0 = mesh.indices[res.primitive_id * 3], i1 = mesh.indices[res.primitive_id * 3 + 1], i2 = mesh.indices[res.primitive_id * 3 + 2];
  const device PtVertex& a = mesh.vertices[i0];
  const device PtVertex& b = mesh.vertices[i1];
  const device PtVertex& c = mesh.vertices[i2];
  const float2 uv = res.triangle_barycentric_coord;
  float3 n = float3(a.n) * (1.0f - uv.x - uv.y) + float3(b.n) * uv.x + float3(c.n) * uv.y;
  float3 g = cross(float3(b.p) - float3(a.p), float3(c.p) - float3(a.p));
  float3 ns = in.ncol[0].xyz * n.x + in.ncol[1].xyz * n.y + in.ncol[2].xyz * n.z;
  float3 ng = in.ncol[0].xyz * g.x + in.ncol[1].xyz * g.y + in.ncol[2].xyz * g.z;
  out.hit = true;
  out.t = res.distance;
  out.ng = length(ng) > 0.0f ? normalize(ng) : -dir;
  out.ns = length(ns) > 0.0f ? normalize(ns) : out.ng;
  out.material = in.material;
  out.color = a.color;
  return out;
}

/// What reaches `origin` along `dir` past the pieces: 0 behind anything opaque or glass;
/// placeholders let some through.
inline float3 ptShadow(float3 origin, float3 dir, constant PtUniforms& u, metal::raytracing::instance_acceleration_structure scene,
                       device const PtInstance* instances, device const PtMesh* meshes, device const PtMaterial* materials) {
  // Glass stops a shadow ray, as in Cycles: light through glass comes only along refracted
  // paths (which next-event estimation never draws, so they are not counted twice), and
  // EyeSight's ground is shadowed by glass as by any piece.
  float3 through = float3(1.0f);
  for (int i = 0; i < 16; i++) {
    PtHit h = ptTrace(origin, dir, u, scene, instances, meshes);
    if (!h.hit) return through;
    PtMaterial m = materials[h.material];
    if (m.surface.w < 1.5f) return float3(0.0f);
    through *= 1.0f - m.base.a;
    if (ptMean(through) < 1e-4f) return float3(0.0f);
    origin = origin + dir * h.t + dir * kPtEps;
  }
  return float3(0.0f);
}

/// The disks seen along `dir`: their radiance and the density next-event estimation draws it with.
inline float3 ptDisks(float3 dir, constant PtUniforms& u, thread float& pdf) {
  float3 seen = float3(0.0f);
  pdf = 0.0f;
  if (u.rig.w < 0.5f) return seen;
  float total = u.lights[0].w + u.lights[1].w + u.lights[2].w + u.lights[3].w;
  float cone = 1.0f / (2.0f * kPtPi * (1.0f - u.rig.z));
  for (int i = 0; i < 4; i++) {
    if (dot(dir, u.lights[i].xyz) < u.rig.z) continue;
    seen += float3(u.lights[i].w / (kPtPi * u.rig.y));
    pdf += u.lights[i].w / total * cone;
  }
  return seen;
}
/// Draws a direction from one of the disks, chosen by strength.
inline float3 ptDrawDisk(constant PtUniforms& u, thread PtRng& rng) {
  float total = u.lights[0].w + u.lights[1].w + u.lights[2].w + u.lights[3].w;
  float pick = rng.next() * total;
  int i = 0;
  while (i < 3 && pick >= u.lights[i].w) pick -= u.lights[i].w, i++;
  float u1 = rng.next(), u2 = rng.next();
  return ptAround(u.lights[i].xyz, 1.0f - u1 * (1.0f - u.rig.z), 2.0f * kPtPi * u2);
}

kernel void pathTrace(constant PtUniforms& u [[buffer(0)]], metal::raytracing::instance_acceleration_structure scene [[buffer(1)]],
                      device const PtInstance* instances [[buffer(2)]], device const PtMesh* meshes [[buffer(3)]],
                      device const PtMaterial* materials [[buffer(4)]], device float4* accum [[buffer(5)]], device float4* catcher [[buffer(6)]],
                      device float4* albedoSum [[buffer(7)]], device float4* normalSum [[buffer(8)]], device float4* skyCatcher [[buffer(9)]],
                      uint2 gid [[thread_position_in_grid]]) {
  if (gid.x >= u.size.x || gid.y >= u.size.y) return;
  const uint pixel = gid.y * u.size.x + gid.x;
  const float3 up = float3(0.0f, -1.0f, 0.0f);
  float4 acc = accum[pixel], catch_ = catcher[pixel], sky = skyCatcher[pixel], alb = albedoSum[pixel], nor = normalSum[pixel];
  for (uint k = 0; k < u.size.z; k++) {
    const uint sample = u.size.w + k;
    PtRng rng;
    rng.s = ptHash(ptHash(ptHash(u.seed.x ^ ptHash(u.seed.y)) ^ pixel) ^ (sample * 0x9E3779B9u + 0x7F4A7C15u));
    const float sx = (float(gid.x) + rng.next()) / float(u.size.x) * 2.0f - 1.0f;
    const float sy = 1.0f - (float(gid.y) + rng.next()) / float(u.size.y) * 2.0f;
    float3 origin = u.eye.xyz;
    float3 dir = normalize(u.forward.xyz + u.right.xyz * (sx * u.eye.w * u.right.w) + u.up.xyz * (sy * u.eye.w));
    float3 throughput = float3(1.0f), radiance = float3(0.0f), absorb = float3(0.0f);
    bool passedOnly = true, aov = false, floorSeen = false, bounced = false;
    float mattPdf = -1.0f;  // the last bounce's density when it was a matt one, for joining with the disks
    for (uint bounce = 0; bounce <= u.seed.w; bounce++) {
      PtHit h = ptTrace(origin, dir, u, scene, instances, meshes);
      if (any(absorb > 0.0f)) throughput *= exp(-absorb * (h.hit ? h.t : 1e4f));
      // The floor, where it is nearer than any piece.
      // After a bounce off plastic or metal it is not there (EyeSight's ground lights nothing and
      // shows in no reflection); seen through glass it is the background at glass.w.
      float tf = (u.floorPlane.y > 0.5f && dir.y > 1e-6f && !bounced) ? (u.floorPlane.x - origin.y) / dir.y : -1.0f;
      if (tf > 1e-3f && (!h.hit || tf < h.t)) {
        if (bounce == 0) {
          // The shadow catcher, as EyeSight's ground: how much of the lights' light the model
          // keeps from the floor (the key at floorPlane.z of its strength), and, apart, how much of
          // the white world it sees; the host makes the floor's colour of the two.
          floorSeen = true;
          float3 p = origin + dir * tf + up * kPtEps;
          float3 kept = float3(0.0f);
          float all = 0.0f;
          float3 d = ptCosine(up, rng.next(), rng.next());
          sky += float4(ptShadow(p, d, u, scene, instances, meshes, materials), 1.0f);
          if (u.rig.w > 0.5f) {
            for (int i = 0; i < 4; i++) {
              float3 l = ptAround(u.lights[i].xyz, 1.0f - rng.next() * (1.0f - u.rig.z), 2.0f * kPtPi * rng.next());
              float c = dot(l, up);
              if (c <= 0.0f) continue;
              float e = u.lights[i].w * (i == 0 ? u.floorPlane.z : 1.0f) / (kPtPi * u.rig.y) * c * 2.0f * kPtPi * (1.0f - u.rig.z);
              all += e;
              kept += e * ptShadow(p, l, u, scene, instances, meshes, materials);
            }
          }
          catch_ += float4(kept, all);
          if (!aov) alb.rgb += u.background.rgb, nor.xyz += up, aov = true;
        } else {
          radiance += throughput * u.background.rgb * u.glass.w;
        }
        break;
      }
      if (!h.hit) {
        if (passedOnly) {
          radiance += throughput * u.background.rgb;
        } else {
          float pdf;
          float3 disks = ptDisks(dir, u, pdf);
          float w = mattPdf > 0.0f ? mattPdf * mattPdf / (mattPdf * mattPdf + pdf * pdf) : 1.0f;
          radiance += throughput * (float3(u.rig.x) + disks * w);
        }
        if (!aov) alb.rgb += u.background.rgb, aov = true;
        break;
      }
      const float3 p = origin + dir * h.t;
      PtMaterial m = materials[h.material];
      float kind = m.surface.w;
      if (kind > 1.5f) {
        // A placeholder: an opaque matt box alpha of the time, otherwise passed straight through.
        if (rng.next() >= m.base.a) {
          origin = p + dir * kPtEps;
          continue;
        }
        kind = 0.0f;
      }
      if (kind > 0.5f) {
        // Glass: reflected or refracted by Fresnel, absorbing inside by 1 - its colour.
        const bool entering = dot(dir, h.ng) < 0.0f;
        float3 n = entering ? h.ns : -h.ns;
        if (dot(dir, n) >= 0.0f) n = entering ? h.ng : -h.ng;
        const float eta = entering ? 1.0f / u.glass.x : u.glass.x;
        const float cosi = -dot(dir, n);
        const float f = ptFresnel(cosi, eta);
        if (rng.next() < f) {
          dir = reflect(dir, n);
          origin = p + n * kPtEps;
          passedOnly = false;
        } else {
          dir = normalize(refract(dir, n, eta));
          origin = p - n * kPtEps;
          absorb = entering ? u.glass.z * (1.0f - m.base.rgb) : float3(0.0f);
        }
        mattPdf = -1.0f;
      } else {
        // Plastic or metal.
        const float3 base = h.color != 0u ? ptLinear(h.color) : m.base.rgb;
        const float roughness = m.surface.x, metalness = m.surface.y, clearcoat = m.surface.z;
        const float3 ng = dot(h.ng, dir) > 0.0f ? -h.ng : h.ng;
        float3 n = h.ns;
        if (dot(n, ng) < 0.0f) n = -n;
        if (dot(n, -dir) <= 0.0f) n = ng;
        if (!aov) alb.rgb += base, nor.xyz += n, aov = true;
        passedOnly = false, bounced = true;
        absorb = float3(0.0f);
        const float3 v = -dir;
        const float nv = max(dot(n, v), 1e-4f);
        const float coat = clearcoat * ptSchlick(0.04f, nv);
        const float3 fb = ptSchlick3(mix(float3(0.0337f), base, metalness), nv);
        const float3 matt = base * (1.0f - metalness) * (1.0f - fb);
        const float specShare = ptMean(fb) + ptMean(matt) > 0.0f ? clamp(ptMean(fb) / (ptMean(fb) + ptMean(matt)), 0.01f, 1.0f) : 1.0f;
        float w;
        if (rng.next() < coat) {
          float u1 = rng.next(), u2 = rng.next();
          dir = ptGgx(n, v, 0.03f, u1, u2, w);
          throughput *= w;
          mattPdf = -1.0f;
        } else if (rng.next() < specShare) {
          float u1 = rng.next(), u2 = rng.next();
          dir = ptGgx(n, v, roughness, u1, u2, w);
          throughput *= fb * (w / specShare);
          mattPdf = -1.0f;
        } else {
          throughput *= matt / (1.0f - specShare);
          if (u.rig.w > 0.5f) {
            // Next-event: a direction toward a disk, joined with the matt bounce by the power heuristic.
            float3 l = ptDrawDisk(u, rng);
            float c = dot(n, l);
            if (c > 0.0f) {
              float pdf;
              float3 disks = ptDisks(l, u, pdf);
              float b = c / kPtPi;
              float3 seen = ptShadow(p + ng * kPtEps, l, u, scene, instances, meshes, materials);
              radiance += throughput * disks * seen * (c / kPtPi) * (pdf / (pdf * pdf + b * b));
            }
          }
          dir = ptCosine(n, rng.next(), rng.next());
          mattPdf = max(dot(n, dir), 0.0f) / kPtPi;
        }
        if (dot(dir, ng) <= 0.0f || all(throughput == 0.0f)) break;
        origin = p + ng * kPtEps;
      }
      if (bounce >= 3) {
        float q = clamp(max(throughput.x, max(throughput.y, throughput.z)), 0.05f, 0.95f);
        if (rng.next() > q) break;
        throughput /= q;
      }
    }
    if (any(isnan(radiance)) || any(isinf(radiance))) radiance = float3(0.0f);
    acc += float4(radiance, floorSeen ? 1.0f : 0.0f);
  }
  accum[pixel] = acc;
  catcher[pixel] = catch_;
  skyCatcher[pixel] = sky;
  albedoSum[pixel] = alb;
  normalSum[pixel] = nor;
}
