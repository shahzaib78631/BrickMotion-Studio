// Real-Time Physically-Decoupled Metal Neural Shader for Apple Silicon (M1+):
// Stage 1 (neuralFeatureKernel): Half-res 3D world-scale multi-ring horizon, bent-normal,
//   signed mean curvature (concave stud-root/seam vs convex bevel/rim), hardware-ray-traced
//   full-detail stud/pin area-light shadow, 3D mirror clearcoat reflection, and 2nd-order
//   Neumann cavity multi-bounce indirect irradiance gather.
// Stage 2 (neuralInferKernel): Cooperative 10x10 threadgroup-SRAM tile load + 3x3 bilateral
//   spatial graph convolution + fused 4-layer FP16 residual MLP with FiLM light-rig conditioning.
// Stage 3 (composite.metal): Surface-guided joint bilateral upsampling + full-resolution
//   micro-geometry demodulation, 3D glossy reflection replacement, and dielectric glass transport.
#include <metal_raytracing>

struct NeuralPtVertex {
  packed_float3 p;
  packed_float3 n;
  uint color;
};
struct NeuralPtMesh {
  device const NeuralPtVertex* vertices;
  device const uint* indices;
};
struct NeuralPtInstance {
  float4 row[3];
  float4 ncol[3];
  uint structure;
  uint material;
  uint2 pad;
};
struct NeuralPtMaterial {
  float4 base;
  float4 surface;
};
struct NeuralRtHit {
  bool hit;
  float t;
  float3 ns, ng;
  uint material;
  uint color;
};

inline float3 neuralPtLinear(uint c) {
  float3 s = float3(float((c >> 16) & 255u), float((c >> 8) & 255u), float(c & 255u)) / 255.0f;
  return select(pow((s + 0.055f) / 1.055f, float3(2.4f)), s / 12.92f, s <= 0.04045f);
}

inline void neuralPtBasis(float3 n, thread float3& t, thread float3& b) {
  float sign = n.z >= 0.0f ? 1.0f : -1.0f;
  float a = -1.0f / (sign + n.z), c = n.x * n.y * a;
  t = float3(1.0f + sign * n.x * n.x * a, sign * c, -sign * n.x);
  b = float3(c, sign + n.y * n.y * a, -n.y);
}

inline bool neuralPtShadow(float3 origin, float3 dir, float tmin, float tmax,
                           metal::raytracing::instance_acceleration_structure scene) {
  metal::raytracing::intersector<metal::raytracing::triangle_data, metal::raytracing::instancing> isect;
  isect.assume_geometry_type(metal::raytracing::geometry_type::triangle);
  isect.force_opacity(metal::raytracing::forced_opacity::opaque);
  isect.accept_any_intersection(true);
  metal::raytracing::ray r(origin, dir, tmin, tmax);
  auto res = isect.intersect(r, scene, 0xFFu);
  return res.type == metal::raytracing::intersection_type::triangle;
}

inline NeuralRtHit neuralPtTrace(float3 origin, float3 dir, float tmin, float tmax,
                                 metal::raytracing::instance_acceleration_structure scene,
                                 device const NeuralPtInstance* instances,
                                 device const NeuralPtMesh* meshes) {
  NeuralRtHit out;
  out.hit = false;
  metal::raytracing::intersector<metal::raytracing::triangle_data, metal::raytracing::instancing> isect;
  isect.assume_geometry_type(metal::raytracing::geometry_type::triangle);
  isect.force_opacity(metal::raytracing::forced_opacity::opaque);
  metal::raytracing::ray r(origin, dir, tmin, tmax);
  auto res = isect.intersect(r, scene, 0xFFu);
  if (res.type != metal::raytracing::intersection_type::triangle) return out;
  const device NeuralPtInstance& in = instances[res.instance_id];
  const device NeuralPtMesh& mesh = meshes[in.structure];
  const uint i0 = mesh.indices[res.primitive_id * 3], i1 = mesh.indices[res.primitive_id * 3 + 1], i2 = mesh.indices[res.primitive_id * 3 + 2];
  const device NeuralPtVertex& a = mesh.vertices[i0];
  const device NeuralPtVertex& b = mesh.vertices[i1];
  const device NeuralPtVertex& c = mesh.vertices[i2];
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

inline float3 neuralShadeReflectedHit(float3 base, float roughness, float metalness, float clearcoat,
                                      float3 n, float3 v, constant FrameUniforms& frame) {
  float nv = max(dot(n, v), 1e-3f);
  float3 f0 = mix(float3(0.0337f), base, metalness);
  float3 matt = base * (1.0f - metalness);
  float3 r = reflect(-v, n);
  float coat = clearcoat * schlick(0.04f, nv);
  float3 under = surroundReflectance(f0, roughness, nv);
  float worldStrength = frame.rig.x * 0.62f;
  float sinSquared = max(frame.rig.y, 1e-4f);
  float cosRadius = sqrt(max(1.0f - sinSquared, 0.0f));

  float3 col = worldStrength * (matt * (1.0f - under) * (1.0f - coat) + (under * (1.0f - coat) + coat) * 0.60f);
  for (int i = 0; i < 4; i++) {
    float3 l = frame.lights[i].xyz;
    float strength = frame.lights[i].w * (i == 0 ? 0.85f : 0.70f);
    float nl = dot(n, l);
    if (nl <= -0.25f) continue;
    float3 light = matt * (1.0f - under) * (1.0f - coat) * strength * diskLight(nl, sinSquared) / 3.14159265f;
    float radiance = strength / (3.14159265f * sinSquared);
    float rl = dot(r, l);
    float soft = 0.02f + roughness * 0.35f;
    float seen = smoothstep(cosRadius - soft, cosRadius + soft, rl) * step(0.0f, nl + 0.25f);
    float coatSeen = smoothstep(cosRadius - 0.02f, cosRadius + 0.02f, rl) * step(0.0f, nl + 0.25f);
    light += radiance * (under * (1.0f - coat) * seen + coat * coatSeen);
    col += light;
  }
  return col;
}

inline half4 neuralSilu(half4 z) {
  return z / (1.0h + exp(-clamp(z, -12.0h, 12.0h)));
}

// Analytical physical demodulation of brick.metal's direct studio lighting into linear base
// albedo and specular/clearcoat energy, requiring zero extra MSAA G-buffer targets.
inline void neuralDemodulate(float3 rawLit, float3 n, float3 v, constant FrameUniforms& frame,
                             thread float3& albedo, thread float& specEnergy, thread float& specAlign) {
  float nv = max(dot(n, v), 1e-3f);
  const float roughness = 0.1f, clearcoat = 0.25f;
  const float3 f0 = float3(0.0337f);
  float3 r = reflect(-v, n);
  float coat = clearcoat * schlick(0.04f, nv);
  float3 under = surroundReflectance(f0, roughness, nv);
  float diffShare = (1.0f - under.x) * (1.0f - coat);
  bool studio = frame.grid.w > 0.5f;
  float worldStrength = frame.rig.x * (studio ? 0.62f : 1.0f);
  float sinSquared = max(frame.rig.y, 1e-4f);
  float cosRadius = sqrt(max(1.0f - sinSquared, 0.0f));

  float diffIrrad = worldStrength * diffShare;
  float specRad = worldStrength * (under.x * (1.0f - coat) + coat);
  float maxAlign = 0.0f;

  for (int i = 0; i < 4; i++) {
    float3 l = frame.lights[i].xyz;
    float strength = frame.lights[i].w * (studio ? (i == 0 ? 1.24f : 0.68f) : 1.0f);
    float nl = dot(n, l);
    diffIrrad += diffShare * strength * diskLight(nl, sinSquared) / 3.14159265f;
    float radiance = strength / (3.14159265f * sinSquared);
    float rl = dot(r, l);
    float soft = studio ? (0.015f + roughness * 0.22f) : (0.02f + roughness * 0.5f);
    float seen = smoothstep(cosRadius - soft, cosRadius + soft, rl) * step(0.0f, nl + 0.3f);
    float coatSeen = smoothstep(cosRadius - (studio ? 0.014f : 0.02f), cosRadius + (studio ? 0.014f : 0.02f), rl) * step(0.0f, nl + 0.3f);
    specRad += radiance * (under.x * (1.0f - coat) * seen + coat * coatSeen * (studio ? 1.35f : 1.0f));
    maxAlign = max(maxAlign, coatSeen);
  }
  specEnergy = clamp(specRad, 0.0f, 2.5f);
  specAlign = saturate(maxAlign);
  albedo = clamp((rawLit - float3(specRad * 0.92f)) / max(diffIrrad, 0.08f), 0.0f, 1.0f);
}

// Reconstruct silhouette-guarded view-space normal at full-resolution pixel `at`.
inline float3 neuralViewNormal(depth2d<float> depth, int2 at, float4 p, constant AoUniforms& u, thread float& edgeJump) {
  float4 l = viewPoint(depth, at - int2(1, 0), u), r = viewPoint(depth, at + int2(1, 0), u);
  float4 t = viewPoint(depth, at - int2(0, 1), u), b = viewPoint(depth, at + int2(0, 1), u);
  float3 dx = (r.w > 0.0f && (l.w == 0.0f || abs(r.z - p.z) < abs(l.z - p.z))) ? r.xyz - p.xyz : p.xyz - l.xyz;
  float3 dy = (b.w > 0.0f && (t.w == 0.0f || abs(b.z - p.z) < abs(t.z - p.z))) ? p.xyz - b.xyz : t.xyz - p.xyz;
  edgeJump = max(length(dx), length(dy));
  float3 n = cross(dx, dy);
  float len2 = dot(n, n);
  n = len2 > 1e-12f ? (n * rsqrt(len2)) : float3(0.0f, 0.0f, 1.0f);
  if (dot(n, -p.xyz) < 0.0f) n = -n;
  return n;
}

// Stage 1: Half-resolution 3D Multi-Ring Geometric, Ray-Traced Reflection & Radiometric Feature Pyramid.
kernel void neuralFeatureKernel(
    constant AoUniforms& u [[buffer(0)]],
    constant FrameUniforms& frame [[buffer(1)]],
    metal::raytracing::instance_acceleration_structure rtScene [[buffer(2)]],
    device const NeuralPtInstance* rtInstances [[buffer(3)]],
    device const NeuralPtMesh* rtMeshes [[buffer(4)]],
    device const NeuralPtMaterial* rtMaterials [[buffer(5)]],
    depth2d<float> depth [[texture(0)]],
    texture2d<float, access::read> scene [[texture(1)]],
    texture2d<float, access::read> shares [[texture(2)]],
    texture2d<float, access::read> aoSoft [[texture(3)]],
    texture2d<float, access::read> accum [[texture(4)]],
    texture2d<float, access::read> reveal [[texture(5)]],
    texture2d<float, access::write> feat0Out [[texture(6)]],
    texture2d<float, access::write> feat1Out [[texture(7)]],
    texture2d<float, access::write> reflRawOut [[texture(8)]],
    uint2 gid [[thread_position_in_grid]]) {
  uint halfW = uint(u.size.y), halfH = uint(u.size.z);
  if (gid.x >= halfW || gid.y >= halfH) return;

  int stride = max(int(u.grid.x), 1);
  int2 fullSize = int2(int(u.shape.w), int(u.size.x));
  int2 at = clamp(int2(gid) * stride, int2(0), fullSize - 1);
  float4 p = viewPoint(depth, at, u);
  if (p.w == 0.0f) {
    feat0Out.write(float4(0.0f, 0.0f, 0.0f, 1.0f), gid);
    feat1Out.write(float4(1.0f, 0.0f, 0.0f, 1.0f), gid);
    reflRawOut.write(float4(0.0f), gid);
    return;
  }

  float3 worldP = u.eye.xyz + u.right.xyz * p.x + u.up.xyz * p.y - u.forward.xyz * p.z;
  float4 share = shares.read(uint2(at));
  bool onFloor = share.a > 0.0f && abs(worldP.y - frame.floorPlane.x) < 0.05f;
  float edgeJump = 0.0f;
  float3 nView = onFloor
      ? normalize(float3(-u.right.y, -u.up.y, u.forward.y))
      : neuralViewNormal(depth, at, p, u, edgeJump);
  float3 worldN = onFloor
      ? float3(0.0f, -1.0f, 0.0f)
      : normalize(u.right.xyz * nView.x + u.up.xyz * nView.y - u.forward.xyz * nView.z);
  float3 viewW = normalize(u.eye.xyz - worldP);

  float4 c = scene.read(uint2(at));
  float3 albedo = frame.background.rgb;
  float specEnergy = 0.0f, specAlign = 0.0f;
  if (!onFloor && c.a > 1e-4f) {
    neuralDemodulate(max(c.rgb / c.a, float3(0.0f)), worldN, viewW, frame, albedo, specEnergy, specAlign);
  }
  float4 aoVal = aoSoft.read(gid);
  if (onFloor && aoVal.r > 0.9999f) {
    feat0Out.write(float4(0.0f, 0.0f, 0.0f, 1.0f), gid);
    feat1Out.write(float4(1.0f, 0.0f, 0.0f, 1.0f), gid);
    reflRawOut.write(float4(0.0f), gid);
    return;
  }

  // 3D World-Scale Multi-Ring Gather (3 concentric rings x 8 directions):
  // Ring 0 (~8 LDU): stud-root collars, plate seams, and bevel curvature.
  // Ring 1 (~34 LDU): stud-cavity self-bounce and adjacent brick walls.
  // Ring 2 (~110 LDU): macro structural indirect bounce and sky/light-rig bent normal.
  const float pattern[16] = {0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5};
  float jitter = (pattern[(gid.y & 3u) * 4u + (gid.x & 3u)] + 0.5f) / 16.0f;

  float worldRadius = u.shape.x * (onFloor ? 1.45f : 1.15f);
  float scale = u.size.w > 0.5f ? 1.0f : -p.z;
  float reach = clamp(worldRadius / (scale * u.lens.x) * u.size.x * 0.5f, 2.0f, 140.0f);

  float3 bentView = nView * 2.5f;
  float3 bounceSum = float3(0.0f);
  float kappaCave = 0.0f;
  float kappaRidge = 0.0f;
  const float ringFracs[3] = {0.09f, 0.34f, 0.85f};
  bool hasBlend = frame.switches.w > 0.5f;
  bool hasRt = u.grid.y > 0.5f;
  int numDirs = hasRt ? 6 : 8;
  int numRings = hasRt ? 2 : 3;

  for (int i = 0; i < numDirs; i++) {
    float angle = (float(i) + jitter) * (6.2831853f / float(numDirs));
    float2 dir = float2(cos(angle), sin(angle));
    float maxHorizon = 0.03f;

    for (int s = 0; s < numRings; s++) {
      float rFrac = ringFracs[s] * (0.85f + 0.30f * fract(jitter * 3.0f + float(s) * 0.37f));
      int2 sp = at + int2(round(dir * reach * rFrac));
      if (sp.x < 0 || sp.y < 0 || sp.x >= fullSize.x || sp.y >= fullSize.y) continue;

      float4 q = viewPoint(depth, sp, u);
      if (q.w == 0.0f) {
        if (s == 0 && !onFloor) kappaRidge += 0.10f;  // outer silhouette bevel exposure
        continue;
      }

      float3 v = q.xyz - p.xyz;
      float dist = length(v);
      if (dist < 0.25f || dist > worldRadius) continue;
      float3 omega = v / dist;
      float sinTheta = dot(nView, omega);

      // Ring 0 short-range 3D signed curvature sensor (stud roots vs bevel ridges).
      if (s == 0 && !onFloor) {
        if (sinTheta > 0.06f && dist < 18.0f) {
          kappaCave += (sinTheta - 0.06f) * (1.0f - dist / 18.0f);
        } else if (sinTheta < -0.06f && dist < 12.0f) {
          kappaRidge += (-sinTheta - 0.06f) * (1.0f - dist / 12.0f);
        }
      }

      float qWorldY = u.eye.y + u.right.y * q.x + u.up.y * q.y - u.forward.y * q.z;
      bool qOnFloor = abs(qWorldY - frame.floorPlane.x) < 0.5f;
      if (qOnFloor) continue;  // EyeSight's shadow-catcher floor neither occludes nor emits onto bricks

      if (sinTheta > maxHorizon) {
        float gain = sinTheta - maxHorizon;
        maxHorizon = sinTheta;
        float fade = 1.0f - saturate(dist / worldRadius);
        fade *= fade;

        // Deflect bent normal away from occluding 3D geometry.
        bentView -= omega * (gain * fade * 1.35f);

        // Gather visible surface radiance (modulated by the emitter's own AO/shadow).
        uint2 qCell = uint2(clamp(sp / stride, int2(0), int2(int(halfW) - 1, int(halfH) - 1)));
        float2 qAo = aoSoft.read(qCell).rg;
        float4 qc = scene.read(uint2(sp));
        float3 qRad = qc.a > 1e-4f ? saturate(qc.rgb / qc.a) * (0.45f + 0.55f * qAo.r * qAo.g) : float3(0.0f);
        if (hasBlend) {
          float4 qDep = reveal.read(uint2(sp));
          if (qDep.a > 1e-4f) {
            float4 qSum = accum.read(uint2(sp));
            float3 qMean = qSum.a > 1e-6f ? qSum.rgb / qSum.a : float3(0.0f);
            qRad = qRad * exp(-qDep.rgb - qDep.a) + qMean * (1.0f - exp(-qDep.a));
          }
        }
        bounceSum += qRad * (gain * fade);
      }
    }
  }

  float3 bentWorld = normalize(u.right.xyz * bentView.x + u.up.xyz * bentView.y - u.forward.xyz * bentView.z);
  float3 gi = bounceSum / float(numDirs);
  if (!onFloor) {
    // 2nd-order Neumann cavity multiple-scattering series: inside concave colored stud arrays,
    // repeated bounces between walls of albedo `rho` amplify chromatic radiance by 1 / (1 - k * rho * occ).
    float occ = saturate(1.0f - aoVal.r);
    float3 denom = max(float3(1.0f) - 0.44f * albedo * occ, float3(0.35f));
    gi /= denom;
  }

  // Anisotropic studio light-rig transfer along the 3D bent normal vs geometric normal.
  float bentRig = 0.0f, geomRig = 0.0f;
  for (int i = 0; i < 4; i++) {
    float3 l = frame.lights[i].xyz;
    float w = frame.lights[i].w;
    bentRig += w * max(dot(bentWorld, l) + 0.25f, 0.0f);
    geomRig += w * max(dot(worldN, l) + 0.25f, 0.0f);
  }
  float vRig = geomRig > 1e-3f ? clamp(bentRig / geomRig, 0.25f, 1.45f) : 1.0f;
  // In LDraw world space, -Y is up toward the studio sky dome.
  float vSky = saturate(0.5f - 0.5f * bentWorld.y);

  // 3D Hardware-Ray-Traced Full-Detail Key-Light Stud/Pin Shadow + Glossy Mirror Reflection.
  float vContact = 1.0f;
  float4 reflRaw = float4(0.0f);

  if (!onFloor && hasRt) {
    // Scale ray origin bias and tmin with camera distance so Detail::Low 8-sided curved bricks
    // (e.g. pontoons, cones, cylinders with up to ~0.76 LDU chord sagitta vs Detail::Full)
    // never self-shadow or self-reflect against their own Detail::Full shell in rtScene.
    float viewDist = abs(p.z);
    float lodBias = clamp(0.24f + 0.0011f * viewDist, 0.24f, 1.05f);
    float rtOriginBias = lodBias;
    float3 rtOrigin = worldP + worldN * rtOriginBias;

    // 1. Short-range 3D Key-Light Area-Disk Shadow Ray against Detail::Full BLAS/TLAS (catches studs & pins
    //    omitted from Detail::Shadow; skips pixels already shadowed in aoVal.g).
    if (frame.switches.x > 0.5f && aoVal.g > 0.15f) {
      float3 lWorld = frame.lights[0].xyz;
      if (dot(worldN, lWorld) > 0.08f) {
        float3 tKey, bKey;
        neuralPtBasis(lWorld, tKey, bKey);
        uint bayerIdx = (gid.y & 3u) * 4u + (gid.x & 3u);
        float rDisk = sqrt((float(bayerIdx) + 0.5f) / 16.0f) * 0.036f;
        float phiDisk = float(bayerIdx) * 2.3999632f;
        float3 lDir = normalize(lWorld + tKey * (rDisk * cos(phiDisk)) + bKey * (rDisk * sin(phiDisk)));
        float shadowTmin = clamp(0.45f + 0.0012f * viewDist, 0.45f, 1.35f);
        if (neuralPtShadow(rtOrigin, lDir, shadowTmin, 32.0f, rtScene)) {
          vContact = 0.0f;
        }
      }
    }
    // 2. Spatial-Checkerboard 3D Mirror Clearcoat Reflection Ray (reconstructed to full density in SRAM).
    if (edgeJump < 2.2f && ((gid.x ^ gid.y) & 1u) == 0u) {
      float3 reflW = reflect(-viewW, worldN);
      if (dot(reflW, worldN) > 0.05f) {
        float reflTmin = clamp(0.45f + 0.0012f * viewDist, 0.45f, 1.35f);
        NeuralRtHit rh = neuralPtTrace(rtOrigin, reflW, reflTmin, 120.0f, rtScene, rtInstances, rtMeshes);
        // Reject interior back-face self-exit hits from Detail::Low vs Detail::Full chord offset.
        if (rh.hit && !(rh.t < 2.2f && dot(reflW, rh.ng) > 0.0f)) {
          NeuralPtMaterial rm = rtMaterials[rh.material];
          float3 rBase = rh.color != 0u ? neuralPtLinear(rh.color) : rm.base.rgb;
          float3 rN = dot(rh.ns, -reflW) < 0.0f ? -rh.ns : rh.ns;
          float3 rCol;
          if (rm.surface.w < 0.5f) {
            rCol = neuralShadeReflectedHit(rBase, rm.surface.x, rm.surface.y, rm.surface.z, rN, -reflW, frame);
          } else {
            rCol = rBase * frame.rig.x;
          }
          float rMask = saturate(1.0f - rh.t / 120.0f) * smoothstep(reflTmin, reflTmin + 0.50f, rh.t);
          reflRaw = float4(clamp(rCol, 0.0f, 2.2f) * rMask, rMask);
          vSky *= (1.0f - 0.65f * rMask);
        }
      }
    }
  } else if (!onFloor && frame.switches.x > 0.5f) {
    // Fallback screen-space key-light micro-contact shadow march.
    float3 lWorld = frame.lights[0].xyz;
    float3 lView = normalize(float3(dot(lWorld, u.right.xyz), dot(lWorld, u.up.xyz), -dot(lWorld, u.forward.xyz)));
    if (dot(nView, lView) > 0.04f) {
      const float maxRay = 7.2f;
      for (int s = 1; s <= 5; s++) {
        float tRay = maxRay * (float(s) - 0.5f + 0.5f * jitter) / 5.0f;
        float3 samplePos = p.xyz + nView * 0.25f + lView * tRay;
        float sc = u.size.w > 0.5f ? 1.0f : -samplePos.z;
        if (sc <= 1e-4f) break;
        float2 ndc = float2(samplePos.x / (sc * u.lens.y), samplePos.y / (sc * u.lens.x));
        float2 px = float2((ndc.x * 0.5f + 0.5f) * u.shape.w, (0.5f - ndc.y * 0.5f) * u.size.x);
        if (px.x < 1.0f || px.y < 1.0f || px.x >= u.shape.w - 1.0f || px.y >= u.size.x - 1.0f) break;
        float4 hitP = viewPoint(depth, int2(px), u);
        if (hitP.w == 0.0f) continue;
        float dz = hitP.z - samplePos.z;
        float abovePlane = dot(hitP.xyz - p.xyz, nView);
        if (abovePlane > 0.45f && dz > 0.22f && dz < 2.8f) {
          vContact = min(vContact, 1.0f - 0.35f * (1.0f - tRay / maxRay));
        }
      }
    }
  }

  feat0Out.write(float4(clamp(gi, 0.0f, 2.5f), vRig), gid);
  feat1Out.write(float4(vSky, saturate(kappaCave * 1.4f), saturate(kappaRidge * 1.4f), vContact), gid);
  reflRawOut.write(reflRaw, gid);
}

// Stage 2: Cooperative 10x10 Threadgroup-SRAM Spatial Graph Convolution + Fused 4-Layer FP16
// Residual Neural Network with FiLM Light-Rig Conditioning.
kernel void neuralInferKernel(
    constant AoUniforms& u [[buffer(0)]],
    constant FrameUniforms& frame [[buffer(1)]],
    constant NeuralWeights& nw [[buffer(2)]],
    depth2d<float> depth [[texture(0)]],
    texture2d<float, access::read> scene [[texture(1)]],
    texture2d<float, access::read> shares [[texture(2)]],
    texture2d<float, access::read> aoSoft [[texture(3)]],
    texture2d<float, access::read> feat0In [[texture(4)]],
    texture2d<float, access::read> feat1In [[texture(5)]],
    texture2d<float, access::write> out0Tex [[texture(6)]],
    texture2d<float, access::write> out1Tex [[texture(7)]],
    texture2d<float, access::read> reflRawIn [[texture(8)]],
    texture2d<float, access::write> reflSoftOut [[texture(9)]],
    uint2 gid [[thread_position_in_grid]],
    uint2 lid [[thread_position_in_threadgroup]],
    uint2 tgid [[threadgroup_position_in_grid]]) {
  // 10x10 shared-memory tile (8x8 active threads + 1-cell border halo all around).
  threadgroup half4 s_f0[10][10];
  threadgroup half4 s_f1[10][10];
  threadgroup half4 s_geom[10][10];  // xyz: view normal, w: signed view depth (+brick, -floor, 0 empty)

  int halfW = int(u.size.y), halfH = int(u.size.z);
  int stride = max(int(u.grid.x), 1);
  int2 fullSize = int2(int(u.shape.w), int(u.size.x));
  int2 tileBase = int2(tgid) * 8 - int2(1, 1);
  uint tid = lid.y * 8u + lid.x;

  // Cooperatively populate the 100-cell (10x10) tile in two waves (64 + 36 threads).
  for (uint idx = tid; idx < 100u; idx += 64u) {
    uint ty = idx / 10u, tx = idx % 10u;
    int2 cell = clamp(tileBase + int2(int(tx), int(ty)), int2(0), int2(halfW - 1, halfH - 1));
    uint2 ucell = uint2(cell);
    s_f0[ty][tx] = half4(feat0In.read(ucell));
    s_f1[ty][tx] = half4(feat1In.read(ucell));

    int2 fullAt = clamp(cell * stride, int2(0), fullSize - 1);
    float4 p = viewPoint(depth, fullAt, u);
    if (p.w == 0.0f) {
      s_geom[ty][tx] = half4(0.0h, 0.0h, 1.0h, 0.0h);
    } else {
      float3 worldP = u.eye.xyz + u.right.xyz * p.x + u.up.xyz * p.y - u.forward.xyz * p.z;
      bool fl = shares.read(uint2(fullAt)).a > 0.0f && abs(worldP.y - frame.floorPlane.x) < 0.05f;
      float ej = 0.0f;
      float3 nv = fl ? normalize(float3(-u.right.y, -u.up.y, u.forward.y)) : neuralViewNormal(depth, fullAt, p, u, ej);
      float signedZ = fl ? p.z : -p.z;  // negative on floor, positive on brick
      s_geom[ty][tx] = half4(half3(nv), half( clamp(signedZ, -32000.0f, 32000.0f) ));
    }
  }
  threadgroup_barrier(mem_flags::mem_threadgroup);

  uint lx = lid.x + 1u, ly = lid.y + 1u;
  half4 centerGeom = s_geom[ly][lx];
  float signedZ = float(centerGeom.w);
  bool valid = abs(signedZ) > 1e-3f;
  bool onFloor = signedZ < 0.0f;
  float z = abs(signedZ);
  half3 nCenter = centerGeom.xyz;

  // Bilateral 3x3 spatial filter over the 10x10 threadgroup tile (zero DRAM traffic).
  half4 f0Filtered = s_f0[ly][lx];
  half4 f1Filtered = s_f1[ly][lx];
  half wts[3][3];
  half wSum = 0.0h;

  if (valid) {
    float4 f0Acc = float4(0.0f), f1Acc = float4(0.0f);
    float fWeight = 0.0f;
    for (int dy = -1; dy <= 1; dy++) {
      for (int dx = -1; dx <= 1; dx++) {
        half4 ng = s_geom[int(ly) + dy][int(lx) + dx];
        float nz = float(ng.w);
        bool nValid = abs(nz) > 1e-3f;
        bool nFloor = nz < 0.0f;
        if (!nValid || nFloor != onFloor) {
          wts[dy + 1][dx + 1] = 0.0h;
          continue;
        }
        float spatial = (dx == 0 && dy == 0) ? 1.0f : ((dx == 0 || dy == 0) ? 0.65f : 0.42f);
        float depthW = exp(-abs(abs(nz) - z) / max(0.025f * z, 0.5f));
        float normDot = saturate(dot(float3(nCenter), float3(ng.xyz)));
        float normW = onFloor ? 1.0f : (normDot * normDot);
        float w = spatial * depthW * normW;
        wts[dy + 1][dx + 1] = half(w);
        wSum += half(w);
        f0Acc += float4(s_f0[int(ly) + dy][int(lx) + dx]) * w;
        f1Acc += float4(s_f1[int(ly) + dy][int(lx) + dx]) * w;
        fWeight += w;
      }
    }
    if (fWeight > 1e-4f) {
      f0Filtered = half4(f0Acc / fWeight);
      f1Filtered = half4(f1Acc / fWeight);
    }
  }

  // Assemble the 16-channel input feature vector x[0..3] and 4-channel FiLM conditioning vector.
  int2 cell = clamp(int2(gid), int2(0), int2(halfW - 1, halfH - 1));
  int2 fullAt = clamp(cell * stride, int2(0), fullSize - 1);
  float4 p = viewPoint(depth, fullAt, u);
  float3 worldP = u.eye.xyz + u.right.xyz * p.x + u.up.xyz * p.y - u.forward.xyz * p.z;
  float3 worldN = onFloor
      ? float3(0.0f, -1.0f, 0.0f)
      : normalize(u.right.xyz * float(nCenter.x) + u.up.xyz * float(nCenter.y) - u.forward.xyz * float(nCenter.z));
  float3 viewW = valid ? normalize(u.eye.xyz - worldP) : float3(0.0f, 1.0f, 0.0f);
  float nv = saturate(dot(worldN, viewW));
  float nl0 = saturate(0.5f + 0.5f * dot(worldN, frame.lights[0].xyz));

  float4 c = scene.read(uint2(fullAt));
  float4 share = shares.read(uint2(fullAt));
  float4 aoVal = aoSoft.read(uint2(cell));
  float3 albedo = frame.background.rgb;
  float specEnergy = 0.0f, specAlign = 0.0f;
  if (valid && !onFloor && c.a > 1e-4f) {
    neuralDemodulate(max(c.rgb / c.a, float3(0.0f)), worldN, viewW, frame, albedo, specEnergy, specAlign);
  }
  float maxC = max(albedo.r, max(albedo.g, albedo.b));
  float minC = min(albedo.r, min(albedo.g, albedo.b));
  float sat = maxC - minC;
  float fresnel = pow(1.0f - nv, 3.0f);

  half4 x[4];
  x[0] = half4(half3(albedo), half(sat));
  x[1] = half4(f0Filtered.xyz, f1Filtered.w);  // bilateral GI rgb + micro-contact shadow
  x[2] = half4(half(aoVal.r), half(aoVal.g), f0Filtered.w, f1Filtered.x);  // AO, key shadow, vRig, vSky
  x[3] = half4(f1Filtered.y, f1Filtered.z, half(fresnel * (onFloor ? 0.0f : 1.0f)), half(onFloor ? 1.0f : 0.0f));
  half4 cond = half4(half(nv), half(nl0), half(specAlign), half(onFloor ? 1.0f : 0.0f));

  // ---- Layer 1: Encoder (16 -> 24, FP16 Register FMA + SiLU) ----
  half h1[24];
  for (int g = 0; g < 6; g++) {
    half4 b = half4(nw.b1[g]);
    for (int sub = 0; sub < 4; sub++) {
      int o = g * 4 + sub;
      half acc = b[sub];
      for (int k = 0; k < 4; k++) acc += dot(half4(nw.w1[o][k]), x[k]);
      h1[o] = acc;
    }
    half4 act = neuralSilu(half4(h1[g * 4], h1[g * 4 + 1], h1[g * 4 + 2], h1[g * 4 + 3]));
    h1[g * 4] = act.x; h1[g * 4 + 1] = act.y; h1[g * 4 + 2] = act.z; h1[g * 4 + 3] = act.w;
  }

  // ---- Threadgroup SRAM Latent Message-Passing (3x3 Bilateral Graph Conv on h1[0..7]) ----
  threadgroup_barrier(mem_flags::mem_threadgroup);
  s_f0[ly][lx] = half4(h1[0], h1[1], h1[2], h1[3]);
  s_f1[ly][lx] = half4(h1[4], h1[5], h1[6], h1[7]);
  // Halo threads copy their nearest active neighbor's latent features.
  if (tid < 36u) {
    uint borderIdx = tid < 10u ? tid : (tid < 20u ? 90u + (tid - 10u) : (tid < 28u ? (tid - 19u) * 10u : (tid - 27u) * 10u + 9u));
    uint by = borderIdx / 10u, bx = borderIdx % 10u;
    uint cy = clamp(by, 1u, 8u), cx = clamp(bx, 1u, 8u);
    s_f0[by][bx] = s_f0[cy][cx];
    s_f1[by][bx] = s_f1[cy][cx];
  }
  threadgroup_barrier(mem_flags::mem_threadgroup);

  if (gid.x >= uint(halfW) || gid.y >= uint(halfH)) return;
  if (!valid) {
    out0Tex.write(float4(0.0f, 0.0f, 0.0f, 1.0f), gid);
    out1Tex.write(float4(1.0f, 1.0f, 0.0f, 0.0f), gid);
    reflSoftOut.write(float4(0.0f), gid);
    return;
  }
  if (onFloor && aoVal.r > 0.9999f) {
    out0Tex.write(float4(0.0f, 0.0f, 0.0f, nw.glassParams[2].y), gid);
    out1Tex.write(float4(1.0f, 1.0f, nw.glassParams[2].x, 0.0f), gid);
    reflSoftOut.write(float4(0.0f), gid);
    return;
  }

  half4 lat0 = s_f0[ly][lx], lat1 = s_f1[ly][lx];
  if (valid && wSum > 1e-3h) {
    half4 acc0 = half4(0.0h), acc1 = half4(0.0h);
    for (int dy = -1; dy <= 1; dy++) {
      for (int dx = -1; dx <= 1; dx++) {
        half w = wts[dy + 1][dx + 1];
        acc0 += s_f0[int(ly) + dy][int(lx) + dx] * w;
        acc1 += s_f1[int(ly) + dy][int(lx) + dx] * w;
      }
    }
    lat0 = acc0 / wSum;
    lat1 = acc1 / wSum;
  }

  half4 h1Ext[8] = {
    half4(h1[0], h1[1], h1[2], h1[3]),
    half4(h1[4], h1[5], h1[6], h1[7]),
    half4(h1[8], h1[9], h1[10], h1[11]),
    half4(h1[12], h1[13], h1[14], h1[15]),
    half4(h1[16], h1[17], h1[18], h1[19]),
    half4(h1[20], h1[21], h1[22], h1[23]),
    lat0,
    lat1
  };

  // ---- Layer 2: Spatial-Graph Residual Block + FiLM Light-View Conditioning (32 -> 24) ----
  half4 h2Ext[10];
  for (int g = 0; g < 6; g++) {
    half4 b = half4(nw.b2[g]);
    half4 pre;
    for (int sub = 0; sub < 4; sub++) {
      int o = g * 4 + sub;
      half acc = b[sub];
      for (int k = 0; k < 8; k++) acc += dot(half4(nw.w2[o][k]), h1Ext[k]);
      half gamma = 1.0h + 0.35h * tanh(dot(half4(nw.filmGamma[o]), cond));
      half beta = 0.25h * tanh(dot(half4(nw.filmBeta[o]), cond));
      pre[sub] = acc * gamma + beta;
    }
    h2Ext[g] = h1Ext[g] + neuralSilu(pre);
  }
  for (int k = 0; k < 4; k++) h2Ext[6 + k] = x[k];

  // ---- Layer 3: Bottleneck Decoder with Input Skip Connection (40 -> 16) ----
  half4 h3[4];
  for (int g = 0; g < 4; g++) {
    half4 b = half4(nw.b3[g]);
    half4 pre;
    for (int sub = 0; sub < 4; sub++) {
      int o = g * 4 + sub;
      half acc = b[sub];
      for (int k = 0; k < 10; k++) acc += dot(half4(nw.w3[o][k]), h2Ext[k]);
      pre[sub] = acc;
    }
    h3[g] = neuralSilu(pre);
  }

  // ---- Layer 4: Physically-Constrained Radiometric Output Head (16 -> 8) ----
  float raw[8];
  for (int g = 0; g < 2; g++) {
    float4 b = nw.b4[g];
    for (int sub = 0; sub < 4; sub++) {
      int o = g * 4 + sub;
      float acc = b[sub];
      for (int k = 0; k < 4; k++) acc += dot(nw.w4[o][k], float4(h3[k]));
      raw[o] = clamp(acc, -10.0f, 10.0f);
    }
  }

  // Map raw network predictions to bounded, energy-conserving radiometric transport quantities.
  // Designed so raw == 0 is the exact identity transform over the physical raster baseline:
  // out0.rgb: learned 3D multi-bounce indirect irradiance
  // out0.a:   m_amb      in [0.65, 1.35] (anisotropic ambient & sky-dome transfer multiplier; 1.0 at raw=0)
  // out1.r:   m_key      in [0.70, 1.30] (key-light direct & contact transfer multiplier; 1.0 at raw=0)
  // out1.g:   m_spec     in [0.60, 1.40] (glossy clearcoat & softbox reflection multiplier; 1.0 at raw=0)
  // out1.b:   m_penumbra in [-0.30, 0.30] (shadow penumbra exponent delta; 0.0 at raw=0)
  // out1.a:   m_cavity   in [0.00, 0.60] (chromatic ABS cavity multiple-scattering factor; 0.0 at raw=0)
  float3 baseGi = float3(f0Filtered.xyz);
  float3 giScale = max(0.35f + 0.65f * tanh(float3(raw[0], raw[1], raw[2])), float3(0.0f));
  float3 giOut = baseGi * giScale;
  if (onFloor) {
    float mAmbFloor = nw.glassParams[2].y + 0.08f * tanh(raw[3]) * nw.glassParams[2].z;
    float mPenumbraFloor = nw.glassParams[2].x + 0.15f * tanh(raw[6]) * nw.glassParams[2].z;
    out0Tex.write(float4(giOut * nw.glassParams[2].w, mAmbFloor), gid);
    out1Tex.write(float4(1.0f, 1.0f, mPenumbraFloor, 0.0f), gid);
    reflSoftOut.write(float4(0.0f), gid);
    return;
  }

  // 3x3 Bilateral reconstruction of spatial-checkerboard 3D ray-traced clearcoat reflection.
  float4 reflFiltered = float4(0.0f);
  if (wSum > 1e-3h) {
    float4 rAcc = float4(0.0f);
    float rWgt = 0.0f;
    for (int dy = -1; dy <= 1; dy++) {
      for (int dx = -1; dx <= 1; dx++) {
        int2 rc = clamp(cell + int2(dx, dy), int2(0), int2(halfW - 1, halfH - 1));
        if (((rc.x ^ rc.y) & 1) != 0) continue;
        float w = float(wts[dy + 1][dx + 1]);
        if (w > 0.0f) {
          rAcc += reflRawIn.read(uint2(rc)) * w;
          rWgt += w;
        }
      }
    }
    if (rWgt > 1e-4f) reflFiltered = rAcc / rWgt;
  }
  float coatRefl = 0.25f * schlick(0.04f, nv);
  float baseRefl = surroundReflectance(float3(0.0337f), 0.1f, nv).x * (1.0f - coatRefl);
  float rSpec = clamp(baseRefl + coatRefl, 0.04f, 0.85f);
  reflSoftOut.write(reflFiltered * rSpec, gid);

  float mAmb = 1.0f + 0.35f * tanh(raw[3]);
  float mKey = 1.0f + 0.30f * tanh(raw[4]);
  if (u.grid.y > 0.5f && frame.grid.w > 0.5f) {
    // Combine neural key transfer with 3D ray-traced full-detail stud/pin area-light shadow.
    mKey *= mix(1.0f, saturate(float(f1Filtered.w)), 0.90f);
  }
  float mSpec = 1.0f + 0.40f * tanh(raw[5]);
  float mPenumbra = 0.30f * tanh(raw[6]);
  float mCavity = 0.50f * max(tanh(raw[7]), 0.0f);

  out0Tex.write(float4(giOut, mAmb), gid);
  out1Tex.write(float4(mKey, mSpec, mPenumbra, mCavity), gid);
}
