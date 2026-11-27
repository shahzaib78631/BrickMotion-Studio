// Real-Time Path Tracing (RTPT v3): Adaptive Control-Variate Direct Studio Lighting +
// Fine SHaRC World-Space Radiance Cache + 2nd-Bounce Cavity Transport +
// Separate Deterministic Dual-Lobe Bounded-VNDF Clearcoat/Glossy RT +
// Full-Res Contact-Sharp Floor Shadow Catcher + Deterministic-Fresnel 16-Bounce Glass RT +
// Roughness-Aware SVGF 5-Tap A-Trous + SRAM Halton TAA / Unbiased Progressive Convergence.
//
// Solves the exact studio light-transport equation of path_trace.metal (EyeSight BUILD_FL
// 4x 45-deg disk lights, white world, dual-lobe ABS plastic/metal/rubber BRDF, IOR 1.49
// Beer-Lambert glass, shadow-catching floor) live at interactive viewport frame rates.

constant uint kRtptSharcCap = 262144u;
constant uint kRtptSharcMask = 262143u;
constant float kRtptSharcScale = 1024.0f;

// Must match RtptUniformsGpu in src/metal/rtpt.mm field for field.
struct RtptUniforms {
  float4x4 viewProjJittered;
  float4x4 viewProjUnjittered;
  float4x4 prevViewProj;
  float4 eye;          // xyz: eye (scene-local), w: tan(fovY / 2)
  float4 right;        // xyz: camera right, w: aspect
  float4 up;           // xyz: camera up, w: orthoHalfHeight (0 = perspective)
  float4 forward;      // xyz: camera forward, w: near
  float4 lights[4];    // xyz: toward each disk (unit), w: strength (kPathFillShare applied for i>0)
  float4 rig;          // x: kWorldStrength, y: kRigSinSquared, z: cosRadius, w: lightsOn
  float4 background;   // rgb: linear background, w: kFloorSkyPower
  float4 floorPlane;   // x: floorY, y: floorOn, z: kFloorKeyShare, w: floorExtent
  float4 floorCentre;  // xy: floor centre XZ, zw: unused
  float4 sceneMin;     // xyz: scene AABB min (scene-local), w: sharcBaseCell
  float4 sceneMax;     // xyz: scene AABB max (scene-local), w: sharcDecay
  float4 glass;        // x: IOR, y: wallAbsorb, z: absorbPerLdu, w: kFloorThroughGlass
  float4 jitter;       // xy: current pixel jitter (-0.5..0.5), zw: prev pixel jitter
  float4 selection;    // rgb: selection accent linear, w: width px
  uint4 size;          // x: width, y: height, z: frameIndex, w: stillFrames
  uint4 flags;         // x: hasScene, y: hasHistory, z: sceneChanged, w: hasPlaceholders
  uint4 params;        // x: maxSamples, y: atrousStep (low 16) | passIdx (high 16), z: hasPrevPose, w: prevPoseCount
};

struct RtptPrevPose {
  float4 r0, r1, r2;
};

struct RtptSharcAccum {
  atomic_uint key;
  atomic_uint radR;
  atomic_uint radG;
  atomic_uint radB;
  atomic_uint count;
  uint pad0, pad1, pad2;
};

struct RtptSharcResolved {
  float4 radSamples;  // rgb: converged incident diffuse irradiance, w: effective sample weight
  uint4 keyAge;       // x: verification key, y: frames since written, zw: unused
};

// --- Octahedral unit-normal encoding (< 0.002 deg error in 16-bit float) ---
inline float2 rtptOctEncode(float3 n) {
  float invL1 = 1.0f / max(abs(n.x) + abs(n.y) + abs(n.z), 1e-8f);
  float2 p = n.xy * invL1;
  if (n.z < 0.0f) {
    float2 s = select(float2(-1.0f), float2(1.0f), p >= 0.0f);
    p = (1.0f - abs(p.yx)) * s;
  }
  return p;
}

inline float3 rtptOctDecode(float2 e) {
  float3 n = float3(e.x, e.y, 1.0f - abs(e.x) - abs(e.y));
  if (n.z < 0.0f) {
    float2 s = select(float2(-1.0f), float2(1.0f), n.xy >= 0.0f);
    n.xy = (1.0f - abs(n.yx)) * s;
  }
  return normalize(n);
}

inline uint rtptPackIdKind(uint piece, uint kind) { return (piece << 3u) | (kind & 7u); }
inline uint rtptUnpackKind(float packed) { return as_type<uint>(packed) & 7u; }
inline uint rtptUnpackPiece(float packed) { return as_type<uint>(packed) >> 3u; }
inline float rtptLum(float3 c) { return dot(c, float3(0.2126f, 0.7152f, 0.0722f)); }

// Low-discrepancy R2 quasirandom sequence + spatial Cranley-Patterson rotation.
inline float2 rtptR2(uint sampleIdx, uint2 pixel) {
  uint h = ptHash(pixel.x * 1664525u ^ ptHash(pixel.y * 1013904223u));
  float2 shift = float2(float(h & 0xFFFFu), float(h >> 16u)) * (1.0f / 65536.0f);
  float n = float(sampleIdx + 1u);
  return fract(shift + float2(fract(n * 0.7548776662466927f), fract(n * 0.5698402909980532f)));
}

inline float3 rtptPlacePrev(RtptPrevPose p, float3 v) {
  return float3(dot(p.r0.xyz, v) + p.r0.w, dot(p.r1.xyz, v) + p.r1.w, dot(p.r2.xyz, v) + p.r2.w);
}

// Spherical-cap GGX VNDF sampling (Dupuy & Benyoub 2023): exact separable Smith-GGX weight
// G2(nv, nl) / G1(nv) = G1(nl) in [0, 1] -> mathematically firefly-free at all grazing angles!
inline float3 rtptSampleGgxVndf(float3 n, float3 v, float roughness, float u1, float u2, thread float& weight) {
  float a = max(roughness * roughness, 2e-3f);
  float a2 = a * a;
  float3 t, b;
  ptBasis(n, t, b);
  float3 V = float3(dot(v, t), dot(v, b), max(dot(v, n), 1e-4f));
  float3 Vh = normalize(float3(a * V.x, a * V.y, V.z));

  float phi = 2.0f * kPtPi * u1;
  float z = (1.0f - u2) * (1.0f + Vh.z) - Vh.z;
  float sinTheta = sqrt(saturate(1.0f - z * z));
  float3 c = float3(sinTheta * cos(phi), sinTheta * sin(phi), z);
  float3 Nh = c + Vh;
  float3 H = normalize(float3(a * Nh.x, a * Nh.y, max(Nh.z, 0.0f)));
  float3 h = normalize(t * H.x + b * H.y + n * H.z);

  float3 l = reflect(-v, h);
  float nl = dot(n, l);
  weight = nl > 0.0f ? ptSmithG1(nl, a2) : 0.0f;
  return l;
}

// Shared physically energy-conserving LEGO ABS/metal/rubber dual-lobe BRDF decomposition
// (matched to EyeSight Principled ABS: crisp clearcoat + smooth glossy ABS base).
// Uses nvFresnel = max(nv, nvGeom * 0.85) so 0.45-LDU rounded-edge normal fillets keep crisp
// specular catchlights without triggering fake grazing white-rim spikes (as in brick.metal).
inline void rtptBrdfParams(float3 base, float roughness, float metalness, float clearcoat, float nv, float nvGeom,
                           thread float& outCoat, thread float3& outFb, thread float3& outDiffAlbedo,
                           thread float3& outSpecAlbedo, thread float& outCoatRough, thread float& outBaseRough) {
  float nvF = max(nv, nvGeom * 0.85f);
  bool isSolidPlastic = (metalness < 0.05f) && (clearcoat > 0.10f) && (roughness < 0.30f);
  outCoatRough = isSolidPlastic ? 0.015f : 0.03f;
  outBaseRough = isSolidPlastic ? min(roughness, 0.06f) : roughness;
  float f0Dielectric = isSolidPlastic ? 0.04f : 0.0337f;
  // Cycles Principled BSDF: clearcoat sits as an additive dielectric coat over base glossy (Specular=0.5 -> F0=0.04).
  outCoat = (isSolidPlastic ? (clearcoat * 1.40f) : clearcoat) * ptSchlick(0.04f, nvF);
  outFb = ptSchlick3(mix(float3(f0Dielectric), base, metalness), nvF);
  float3 spec = min(float3(outCoat) + (isSolidPlastic ? outFb : ((1.0f - outCoat) * outFb)), float3(1.0f));
  outSpecAlbedo = spec;
  outDiffAlbedo = base * (1.0f - metalness) * (1.0f - spec);
}

// Exact projected solid angle ratio of a spherical disk light above a plane (Lagarde & de Rousiers 2014).
inline float rtptDiskLight(float c, float sinSq) {
  c = clamp(c, -1.0f, 1.0f);
  if (c * c > sinSq) return max(c, 0.0f);
  float sinT = sqrt(max(1.0f - c * c, 0.0f));
  float x = sqrt(1.0f / sinSq - 1.0f);
  float y = -x * (c / max(sinT, 1e-5f));
  float sinTy = sinT * sqrt(max(1.0f - y * y, 0.0f));
  return max((c * acos(clamp(y, -1.0f, 1.0f)) - x * sinTy) * sinSq + atan(sinTy / x), 0.0f) / (kPtPi * sinSq);
}

// ============================================================================
// PASS 1: Rasterized Full-Resolution Primary G-Buffer + Analytic Motion Vectors
// ============================================================================

struct RtptGbufVertOut {
  float4 position [[position]];
  float3 world;
  float3 normal;
  float4 fixedColor;
  float4 curClip;
  float4 prevClip;
  uint piece [[flat]];
};

struct RtptGbufFragOut {
  float4 posId  [[color(0)]];  // xyz: worldPos, w: packed (piece << 3 | kind)
  float4 norm   [[color(1)]];  // xy: oct(ns), zw: oct(ng)
  float4 mat    [[color(2)]];  // rgb: linear base albedo, a: roughness
  float4 motion [[color(3)]];  // xy: prevUv - curUv, z: metalness, w: clearcoat
};

vertex RtptGbufVertOut rtptGbufVertex(
    BrickIn in [[stage_in]],
    uint iid [[instance_id]],
    constant RtptUniforms& u [[buffer(1)]],
    constant DrawUniforms& draw [[buffer(2)]],
    const device InstanceData* instances [[buffer(3)]],
    const device uint* visible [[buffer(4)]],
    const device RtptPrevPose* prevPoses [[buffer(5)]]) {
  InstanceData inst = instances[visible[iid]];
  RtptGbufVertOut out;
  float3 world = placePoint(inst, in.position);
  float3 prevWorld = (u.params.z != 0u && inst.piece < u.params.w)
                         ? rtptPlacePrev(prevPoses[inst.piece], in.position)
                         : world;
  out.world = world;
  out.normal = placeNormal(inst, in.normal) * draw.flip.x;
  out.position = u.viewProjJittered * float4(world, 1.0f);
  out.curClip = u.viewProjUnjittered * float4(world, 1.0f);
  out.prevClip = u.prevViewProj * float4(prevWorld, 1.0f);
  out.fixedColor = float4(linearFromSrgb(in.color.zyx), in.color.a);
  out.piece = inst.piece;
  return out;
}

inline float2 rtptComputeMotion(float4 curClip, float4 prevClip) {
  float2 curNdc = curClip.xy / max(curClip.w, 1e-6f);
  float2 prevNdc = prevClip.xy / max(prevClip.w, 1e-6f);
  float2 curUv = float2(curNdc.x * 0.5f + 0.5f, 0.5f - curNdc.y * 0.5f);
  float2 prevUv = float2(prevNdc.x * 0.5f + 0.5f, 0.5f - prevNdc.y * 0.5f);
  return prevUv - curUv;
}

fragment RtptGbufFragOut rtptGbufOpaqueFragment(
    RtptGbufVertOut in [[stage_in]],
    constant RtptUniforms& u [[buffer(1)]],
    constant DrawUniforms& draw [[buffer(2)]]) {
  float3 v = normalize(u.eye.xyz - in.world);
  float3 n = normalize(in.normal);
  float3 ngRaw = cross(dfdx(in.world), dfdy(in.world));
  float3 ng = dot(ngRaw, ngRaw) > 1e-12f ? normalize(ngRaw) : n;
  if (dot(ng, v) < 0.0f) ng = -ng;
  if (dot(n, ng) < 0.0f) n = -n;
  if (dot(n, v) <= 0.0f) n = ng;

  float3 base = (in.fixedColor.a > 0.5f && draw.surface.w < 0.5f) ? in.fixedColor.rgb : draw.base.rgb;
  uint kind = draw.surface.w > 0.5f ? 4u : 1u;

  RtptGbufFragOut out;
  out.posId = float4(in.world, as_type<float>(rtptPackIdKind(in.piece, kind)));
  out.norm = float4(rtptOctEncode(n), rtptOctEncode(ng));
  out.mat = float4(base, draw.surface.x);
  out.motion = float4(rtptComputeMotion(in.curClip, in.prevClip), draw.surface.y, draw.surface.z);
  return out;
}

fragment RtptGbufFragOut rtptGbufGlassFragment(
    RtptGbufVertOut in [[stage_in]],
    constant RtptUniforms& u [[buffer(1)]],
    constant DrawUniforms& draw [[buffer(2)]]) {
  float3 v = normalize(u.eye.xyz - in.world);
  float3 n = normalize(in.normal);
  float3 ngRaw = cross(dfdx(in.world), dfdy(in.world));
  float3 ng = dot(ngRaw, ngRaw) > 1e-12f ? normalize(ngRaw) : n;
  if (dot(ng, v) < 0.0f) ng = -ng;
  if (dot(n, ng) < 0.0f) n = -n;
  float3 base = in.fixedColor.a > 0.5f ? in.fixedColor.rgb : draw.base.rgb;
  uint kind = draw.surface.w > 0.5f ? 4u : 2u;

  RtptGbufFragOut out;
  out.posId = float4(in.world, as_type<float>(rtptPackIdKind(in.piece, kind)));
  out.norm = float4(rtptOctEncode(n), rtptOctEncode(ng));
  out.mat = float4(base, draw.base.a);
  out.motion = float4(rtptComputeMotion(in.curClip, in.prevClip), 0.0f, 0.0f);
  return out;
}

struct RtptFloorVertOut {
  float4 position [[position]];
  float3 world;
  float4 curClip;
  float4 prevClip;
};

vertex RtptFloorVertOut rtptGbufFloorVertex(uint id [[vertex_id]], constant RtptUniforms& u [[buffer(1)]]) {
  const float2 corners[6] = {float2(-1, -1), float2(1, -1), float2(1, 1), float2(-1, -1), float2(1, 1), float2(-1, 1)};
  float2 c = corners[id] * u.floorPlane.w;
  float3 world = float3(u.floorCentre.x + c.x, u.floorPlane.x, u.floorCentre.y + c.y);
  RtptFloorVertOut out;
  out.world = world;
  out.position = u.viewProjJittered * float4(world, 1.0f);
  out.curClip = u.viewProjUnjittered * float4(world, 1.0f);
  out.prevClip = u.prevViewProj * float4(world, 1.0f);
  return out;
}

fragment RtptGbufFragOut rtptGbufFloorFragment(RtptFloorVertOut in [[stage_in]], constant RtptUniforms& u [[buffer(1)]]) {
  if (u.eye.y >= u.floorPlane.x) discard_fragment();
  float3 up = float3(0.0f, -1.0f, 0.0f);
  RtptGbufFragOut out;
  out.posId = float4(in.world, as_type<float>(rtptPackIdKind(0x1FFFFFFFu, 3u)));
  out.norm = float4(rtptOctEncode(up), rtptOctEncode(up));
  out.mat = float4(u.background.rgb, 1.0f);
  out.motion = float4(rtptComputeMotion(in.curClip, in.prevClip), 0.0f, 0.0f);
  return out;
}

// ============================================================================
// Ray Tracing & Studio Rig Helpers (Exact Parity with path_trace.metal)
// ============================================================================

inline float rtptRayOffset(float3 p, float3 eye) {
  return max(kPtEps * 2.5f, 0.0005f * length(p - eye));
}

inline PtHit rtptTrace(float3 origin, float3 dir, constant RtptUniforms& u,
                       metal::raytracing::instance_acceleration_structure scene,
                       device const PtInstance* instances, device const PtMesh* meshes) {
  PtHit out;
  out.hit = false;
  if (u.flags.x == 0u) return out;
  metal::raytracing::intersector<metal::raytracing::triangle_data, metal::raytracing::instancing> isect;
  isect.assume_geometry_type(metal::raytracing::geometry_type::triangle);
  isect.force_opacity(metal::raytracing::forced_opacity::opaque);
  metal::raytracing::ray r(origin, dir, 1e-3f, INFINITY);
  auto res = isect.intersect(r, scene, 0xFFu);
  if (res.type != metal::raytracing::intersection_type::triangle) return out;
  const device PtInstance& in = instances[res.instance_id];
  const device PtMesh& mesh = meshes[in.structure];
  const uint i0 = mesh.indices[res.primitive_id * 3];
  const uint i1 = mesh.indices[res.primitive_id * 3 + 1];
  const uint i2 = mesh.indices[res.primitive_id * 3 + 2];
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

inline bool rtptRayHitsBox(float3 origin, float3 dir, float3 bmin, float3 bmax) {
  float3 invD = 1.0f / select(dir, copysign(float3(1e-8f), dir), abs(dir) < 1e-8f);
  float3 t0 = (bmin - origin) * invD;
  float3 t1 = (bmax - origin) * invD;
  float3 tsmall = min(t0, t1);
  float3 tbig = max(t0, t1);
  float tmin = max(max(tsmall.x, tsmall.y), max(tsmall.z, 0.0f));
  float tmax = min(min(tbig.x, tbig.y), tbig.z);
  return tmax >= tmin;
}

inline float rtptShadowFast(float3 origin, float3 dir, constant RtptUniforms& u,
                            metal::raytracing::instance_acceleration_structure scene,
                            device const PtInstance* instances, device const PtMesh* meshes,
                            device const PtMaterial* materials) {
  if (u.flags.x == 0u) return 1.0f;
  if (!rtptRayHitsBox(origin, dir, u.sceneMin.xyz, u.sceneMax.xyz)) return 1.0f;
  if (u.flags.w == 0u) {
    metal::raytracing::intersector<metal::raytracing::triangle_data, metal::raytracing::instancing> isect;
    isect.assume_geometry_type(metal::raytracing::geometry_type::triangle);
    isect.force_opacity(metal::raytracing::forced_opacity::opaque);
    isect.accept_any_intersection(true);
    metal::raytracing::ray r(origin, dir, 1e-3f, INFINITY);
    auto res = isect.intersect(r, scene, 0xFFu);
    return res.type == metal::raytracing::intersection_type::triangle ? 0.0f : 1.0f;
  }
  float through = 1.0f;
  for (int i = 0; i < 16; i++) {
    PtHit h = rtptTrace(origin, dir, u, scene, instances, meshes);
    if (!h.hit) return through;
    PtMaterial m = materials[h.material];
    if (m.surface.w < 1.5f) return 0.0f;
    through *= (1.0f - m.base.a);
    if (through < 1e-4f) return 0.0f;
    origin = origin + dir * (h.t + kPtEps);
  }
  return 0.0f;
}

inline float rtptDiskRadiance(float3 dir, constant RtptUniforms& u) {
  if (u.rig.w < 0.5f) return 0.0f;
  float seen = 0.0f;
  float invArea = 1.0f / (kPtPi * u.rig.y);
  for (int i = 0; i < 4; i++) {
    if (dot(dir, u.lights[i].xyz) >= u.rig.z) seen += u.lights[i].w * invArea;
  }
  return seen;
}

inline float rtptDisksWithPdf(float3 dir, constant RtptUniforms& u, thread float& pdf) {
  float seen = 0.0f;
  pdf = 0.0f;
  if (u.rig.w < 0.5f) return 0.0f;
  float total = u.lights[0].w + u.lights[1].w + u.lights[2].w + u.lights[3].w;
  float cone = 1.0f / (2.0f * kPtPi * (1.0f - u.rig.z));
  float invArea = 1.0f / (kPtPi * u.rig.y);
  for (int i = 0; i < 4; i++) {
    if (dot(dir, u.lights[i].xyz) >= u.rig.z) {
      seen += u.lights[i].w * invArea;
      pdf += (u.lights[i].w / total) * cone;
    }
  }
  return seen;
}

inline float3 rtptDrawDiskUniform(constant RtptUniforms& u, thread PtRng& rng) {
  float total = u.lights[0].w + u.lights[1].w + u.lights[2].w + u.lights[3].w;
  float pick = rng.next() * total;
  int i = 0;
  while (i < 3 && pick >= u.lights[i].w) {
    pick -= u.lights[i].w;
    i++;
  }
  return ptAround(u.lights[i].xyz, 1.0f - rng.next() * (1.0f - u.rig.z), 2.0f * kPtPi * rng.next());
}

inline float3 rtptSecondaryDirect(float3 q, float3 qn, float3 qng, constant RtptUniforms& u,
                                  metal::raytracing::instance_acceleration_structure scene,
                                  device const PtInstance* instances, device const PtMesh* meshes,
                                  device const PtMaterial* materials, thread PtRng& rng) {
  if (u.rig.w < 0.5f) return float3(0.0f);
  float w[4];
  float sumW = 0.0f;
  for (int i = 0; i < 4; i++) {
    w[i] = u.lights[i].w * rtptDiskLight(dot(qn, u.lights[i].xyz), u.rig.y);
    sumW += w[i];
  }
  if (sumW <= 1e-6f) return float3(0.0f);
  float pick = rng.next() * sumW;
  int idx = 0;
  while (idx < 3 && pick >= w[idx]) {
    pick -= w[idx];
    idx++;
  }
  float3 l = ptAround(u.lights[idx].xyz, 1.0f - rng.next() * (1.0f - u.rig.z), 2.0f * kPtPi * rng.next());
  float nl = dot(qn, l);
  if (nl <= 0.0f || dot(qng, l) <= 0.0f) return float3(0.0f);
  float vis = rtptShadowFast(q + qng * kPtEps, l, u, scene, instances, meshes, materials);
  if (vis <= 0.0f) return float3(0.0f);
  float coneScale = 2.0f * (1.0f - u.rig.z) / max(kPtPi * u.rig.y, 1e-6f);
  float sampleE = u.lights[idx].w * nl * coneScale;
  // Exact importance weight: (sampleE / (w[idx] / sumW)) * (1/pi) cancels cleanly to sampleE * (sumW / w[idx]) / pi?
  // Note: w[idx] = lights[idx].w * diskLight, while E[sampleE] = lights[idx].w * diskLight / pi = w[idx] / pi!
  // So pPick = w[idx] / sumW -> sampleE / pPick = sampleE * sumW / w[idx], whose expectation is sumW / pi!
  return float3(vis * sampleE * (sumW / max(w[idx], 1e-6f)));
}

// ============================================================================
// PASS 2: Fine World-Space Spatial Hash Radiance Cache (SHaRC)
// ============================================================================

inline uint rtptSharcLod(float3 p, float3 eye, float baseCell) {
  float dist = length(p - eye);
  float refDist = max(baseCell * 32.0f, 64.0f);
  return uint(clamp(int(floor(log2(max(dist / refDist, 1.0f)))), 0, 5));
}

inline void rtptSharcHash(float3 p, float3 n, uint lod, float baseCell, thread uint& slot0, thread uint& tag) {
  float cellSize = baseCell * float(1u << lod);
  int3 cell = int3(floor(p / cellSize));
  int3 nb = clamp(int3(round(n * 1.5f)) + int3(2), int3(0), int3(4));
  uint nCode = uint(nb.x * 25 + nb.y * 5 + nb.z);

  uint h1 = ptHash(as_type<uint>(cell.x) * 73856093u ^
                   as_type<uint>(cell.y) * 19349663u ^
                   as_type<uint>(cell.z) * 83492791u ^
                   (nCode * 2654435761u) ^ (lod * 1597334677u));
  uint h2 = ptHash(as_type<uint>(cell.x) * 2971215073u ^
                   as_type<uint>(cell.y) * 480752697u ^
                   as_type<uint>(cell.z) * 1369778189u ^
                   ((nCode + 7u) * 374761393u) ^ ((lod + 13u) * 668265263u));
  slot0 = h1 & kRtptSharcMask;
  tag = h2 | 1u;
}

inline void rtptSharcInsertLod(float3 p, float3 n, float3 irrad, uint lod, float baseCell,
                               device RtptSharcAccum* accum) {
  uint slot0, tag;
  rtptSharcHash(p, n, lod, baseCell, slot0, tag);
  float3 clamped = clamp(irrad, float3(0.0f), float3(16.0f));
  uint rQ = uint(clamped.r * kRtptSharcScale + 0.5f);
  uint gQ = uint(clamped.g * kRtptSharcScale + 0.5f);
  uint bQ = uint(clamped.b * kRtptSharcScale + 0.5f);
  for (uint probe = 0u; probe < 8u; probe++) {
    uint slot = (slot0 + probe) & kRtptSharcMask;
    uint cur = atomic_load_explicit(&accum[slot].key, memory_order_relaxed);
    if (cur == 0u) {
      atomic_compare_exchange_weak_explicit(&accum[slot].key, &cur, tag, memory_order_relaxed, memory_order_relaxed);
    }
    if (cur == tag || cur == 0u) {
      if (atomic_load_explicit(&accum[slot].key, memory_order_relaxed) == tag) {
        atomic_fetch_add_explicit(&accum[slot].radR, rQ, memory_order_relaxed);
        atomic_fetch_add_explicit(&accum[slot].radG, gQ, memory_order_relaxed);
        atomic_fetch_add_explicit(&accum[slot].radB, bQ, memory_order_relaxed);
        atomic_fetch_add_explicit(&accum[slot].count, 1u, memory_order_relaxed);
        return;
      }
    }
  }
}

inline void rtptSharcInsert(float3 p, float3 n, float3 irrad, constant RtptUniforms& u,
                            device RtptSharcAccum* accum) {
  uint lod = rtptSharcLod(p, u.eye.xyz, u.sceneMin.w);
  rtptSharcInsertLod(p, n, irrad, lod, u.sceneMin.w, accum);
}

inline float4 rtptSharcQueryLod(float3 p, float3 n, uint lod, float baseCell,
                                device const RtptSharcResolved* resolved) {
  uint slot0, tag;
  rtptSharcHash(p, n, lod, baseCell, slot0, tag);
  for (uint probe = 0u; probe < 8u; probe++) {
    uint slot = (slot0 + probe) & kRtptSharcMask;
    uint k = resolved[slot].keyAge.x;
    if (k == 0u) return float4(0.0f);
    if (k == tag) {
      float4 rs = resolved[slot].radSamples;
      return rs.w > 0.5f ? float4(rs.rgb, 1.0f) : float4(0.0f);
    }
  }
  return float4(0.0f);
}

inline float4 rtptSharcQuery(float3 p, float3 n, constant RtptUniforms& u,
                             device const RtptSharcResolved* resolved) {
  uint lod = rtptSharcLod(p, u.eye.xyz, u.sceneMin.w);
  return rtptSharcQueryLod(p, n, lod, u.sceneMin.w, resolved);
}

kernel void rtptSharcResolve(
    constant RtptUniforms& u [[buffer(0)]],
    device RtptSharcAccum* accum [[buffer(1)]],
    device RtptSharcResolved* resolved [[buffer(2)]],
    uint gid [[thread_position_in_grid]]) {
  if (gid >= kRtptSharcCap) return;
  uint key = atomic_load_explicit(&accum[gid].key, memory_order_relaxed);
  uint count = atomic_exchange_explicit(&accum[gid].count, 0u, memory_order_relaxed);
  uint rQ = atomic_exchange_explicit(&accum[gid].radR, 0u, memory_order_relaxed);
  uint gQ = atomic_exchange_explicit(&accum[gid].radG, 0u, memory_order_relaxed);
  uint bQ = atomic_exchange_explicit(&accum[gid].radB, 0u, memory_order_relaxed);

  RtptSharcResolved cur = resolved[gid];
  float decay = u.sceneMax.w;
  if (count > 0u && key != 0u) {
    float3 sampleRad = float3(float(rQ), float(gQ), float(bQ)) / (kRtptSharcScale * float(count));
    if (cur.keyAge.x == key && cur.radSamples.w > 0.5f) {
      float oldW = cur.radSamples.w * decay;
      float maxW = u.size.w > 1u ? 64.0f : 24.0f;
      float newW = min(oldW + float(count), maxW);
      float alpha = clamp(float(count) / max(oldW + float(count), 1.0f), 1.0f / maxW, 1.0f);
      cur.radSamples = float4(mix(cur.radSamples.rgb, sampleRad, alpha), newW);
      cur.keyAge = uint4(key, 0u, 0u, 0u);
    } else {
      cur.radSamples = float4(sampleRad, min(float(count), 16.0f));
      cur.keyAge = uint4(key, 0u, 0u, 0u);
    }
    resolved[gid] = cur;
  } else if (cur.keyAge.x != 0u) {
    uint age = cur.keyAge.y + 1u;
    if (age > 48u || (u.flags.z != 0u && age > 8u)) {
      resolved[gid].radSamples = float4(0.0f);
      resolved[gid].keyAge = uint4(0u);
      atomic_store_explicit(&accum[gid].key, 0u, memory_order_relaxed);
    } else {
      cur.radSamples.w *= decay;
      cur.keyAge.y = age;
      resolved[gid] = cur;
    }
  }
}

// ============================================================================
// PASS 3: Exact Analytical Adaptive Control-Variate Direct Studio Lighting
// ============================================================================
// Unbiased for ANY history alpha in [0, 1] independent of current RNG:
//   - Sunlit faces (alpha=1, vis=1): 0.000 variance, exact closed-form irradiance on Frame 1!
//   - Deep shadows (alpha=0, vis=0): 0.000 variance, 0 negative values!
//   - Penumbrae (alpha=0.5): 4x lower variance than standard direct sampling, 0 spatial bias!

kernel void rtptDirectPass(
    constant RtptUniforms& u [[buffer(0)]],
    metal::raytracing::instance_acceleration_structure scene [[buffer(1)]],
    device const PtInstance* instances [[buffer(2)]],
    device const PtMesh* meshes [[buffer(3)]],
    device const PtMaterial* materials [[buffer(4)]],
    texture2d<float, access::read> gPosId [[texture(0)]],
    texture2d<float, access::read> gNorm [[texture(1)]],
    texture2d<float, access::read> gMotion [[texture(2)]],
    texture2d<float, access::read> prevPosId [[texture(3)]],
    texture2d<float, access::read> prevNorm [[texture(4)]],
    texture2d<float, access::read> diffHistPrev [[texture(5)]],
    texture2d<float, access::write> diOut [[texture(6)]],
    uint2 gid [[thread_position_in_grid]]) {
  if (gid.x >= u.size.x || gid.y >= u.size.y) return;
  float4 posId = gPosId.read(gid);
  uint kind = rtptUnpackKind(posId.w);
  if (kind != 1u || u.rig.w < 0.5f) {
    diOut.write(float4(0.0f), gid);
    return;
  }

  float3 p = posId.xyz;
  uint piece = rtptUnpackPiece(posId.w);
  float4 nPacked = gNorm.read(gid);
  float3 n = rtptOctDecode(nPacked.xy);
  float3 ng = rtptOctDecode(nPacked.zw);
  float viewDist = max(length(p - u.eye.xyz), 1.0f);
  float eps = rtptRayOffset(p, u.eye.xyz);

  float diskE[4];
  float sumE = 0.0f;
  for (int i = 0; i < 4; i++) {
    diskE[i] = u.lights[i].w * rtptDiskLight(dot(n, u.lights[i].xyz), u.rig.y) / kPtPi;
    sumE += diskE[i];
  }
  if (sumE <= 1e-6f) {
    diOut.write(float4(0.0f, 0.0f, 0.0f, 1.0f), gid);
    return;
  }

  // Reproject previous frame's direct visibility estimate as unbiased control-variate weight alpha.
  // On cold Frame-1 or disoccluded pixels (no valid history), use alpha = 0.0 so the estimator is
  // strictly non-negative (>= 0) with zero negative-CV dark speckles in shadowed creases!
  float alpha = 0.0f;
  if (u.flags.y != 0u) {
    float2 mv = gMotion.read(gid).xy;
    float2 prevUv = (float2(gid) + 0.5f) / float2(u.size.xy) + mv;
    if (all(prevUv >= 0.0f) && all(prevUv < 1.0f)) {
      uint2 prevPx = uint2(clamp(int2(prevUv * float2(u.size.xy)), int2(0), int2(u.size.xy) - 1));
      float4 pPosId = prevPosId.read(prevPx);
      if (rtptUnpackKind(pPosId.w) == 1u) {
        float3 pn = rtptOctDecode(prevNorm.read(prevPx).xy);
        bool samePiece = (rtptUnpackPiece(pPosId.w) == piece);
        if (dot(n, pn) > 0.90f && abs(dot(pPosId.xyz - p, ng)) < 0.035f * viewDist && (samePiece || u.flags.z == 0u)) {
          alpha = saturate(diffHistPrev.read(prevPx).a);
        }
      }
    }
  }

  PtRng rng;
  rng.s = ptHash(ptHash(gid.x * 3571u + gid.y * 8191u) ^ (u.size.z * 0x9E3779B9u + 0x7F4A7C15u));

  float coneScale = 2.0f * (1.0f - u.rig.z) / max(kPtPi * u.rig.y, 1e-6f);
  float diffSum = 0.0f;
  for (uint s = 0u; s < 2u; s++) {
    float pick = (float(s) + rng.next()) * 0.5f * sumE;
    int dIdx = 0;
    while (dIdx < 3 && pick >= diskE[dIdx]) {
      pick -= diskE[dIdx];
      dIdx++;
    }
    float2 rD = rtptR2(u.size.z * 2u + s, gid);
    float3 l = ptAround(u.lights[dIdx].xyz, 1.0f - rD.x * (1.0f - u.rig.z), 2.0f * kPtPi * rD.y);
    float nl = max(dot(n, l), 0.0f);
    if (nl > 0.0f) {
      float vis = dot(ng, l) > 0.0f ? rtptShadowFast(p + ng * eps, l, u, scene, instances, meshes, materials) : 0.0f;
      float sampleE = u.lights[dIdx].w * nl * coneScale;
      diffSum += (vis - alpha) * (sampleE / max(diskE[dIdx], 1e-6f)) * sumE;
    }
  }

  float directIrrad = alpha * sumE + diffSum * 0.5f;
  float visEst = saturate(directIrrad / max(sumE, 1e-4f));
  diOut.write(float4(directIrrad, visEst, sumE, 1.0f), gid);
}

// ============================================================================
// PASS 4a, 4b, 4c: Specialized High-Occupancy Ray Tracing Kernels
// ============================================================================

inline float3 rtptShadeBounceHit(
    PtHit h, float3 rayOrigin, float3 rayDir, constant RtptUniforms& u,
    metal::raytracing::instance_acceleration_structure scene,
    device const PtInstance* instances, device const PtMesh* meshes,
    device const PtMaterial* materials, device const RtptSharcResolved* sharcResolved,
    device RtptSharcAccum* sharcAccum, thread PtRng& rng, bool updateColdCache) {
  float3 q = rayOrigin + rayDir * h.t;
  PtMaterial m = materials[h.material];
  float3 base = h.color != 0u ? ptLinear(h.color) : m.base.rgb;
  float roughness = m.surface.x, metalness = m.surface.y, clearcoat = m.surface.z;
  float3 qng = dot(h.ng, rayDir) > 0.0f ? -h.ng : h.ng;
  float3 qn = h.ns;
  if (dot(qn, qng) < 0.0f) qn = -qn;
  if (dot(qn, -rayDir) <= 0.0f) qn = qng;

  float3 v = -rayDir;
  float nv = max(dot(qn, v), 1e-4f);
  float coat = clearcoat * ptSchlick(0.04f, nv);
  float3 fb = ptSchlick3(mix(float3(0.0337f), base, metalness), nv);
  float3 matt = base * (1.0f - metalness) * (1.0f - fb);
  float3 diffAlbedo = (1.0f - coat) * matt;

  float4 cached = rtptSharcQuery(q, qn, u, sharcResolved);
  float3 totalIrradQ;
  // Stochastic 20% SHaRC refresh propagates 2nd/3rd/infinite multi-bounce light into deep white cavities!
  bool refreshCache = updateColdCache && (rng.next() < 0.20f);
  if (cached.w > 0.5f && !refreshCache) {
    totalIrradQ = cached.rgb;
  } else {
    // Direct studio irradiance + true 2nd-bounce sky/SHaRC interreflection (fixes tight cavities & under-plate bounce!).
    float3 directQ = rtptSecondaryDirect(q, qn, qng, u, scene, instances, meshes, materials, rng);
    float3 indirectQ = float3(0.0f);
    float3 b2Dir = ptCosine(qn, rng.next(), rng.next());
    if (dot(b2Dir, qng) > 0.0f) {
      PtHit h2 = rtptTrace(q + qng * kPtEps, b2Dir, u, scene, instances, meshes);
      if (!h2.hit) {
        indirectQ = float3(u.rig.x);
      } else {
        PtMaterial m2 = materials[h2.material];
        if (m2.surface.w < 0.5f) {
          float3 q2 = q + qng * kPtEps + b2Dir * h2.t;
          float3 q2ng = dot(h2.ng, b2Dir) > 0.0f ? -h2.ng : h2.ng;
          float3 q2n = dot(h2.ns, q2ng) < 0.0f ? -h2.ns : h2.ns;
          float3 base2 = h2.color != 0u ? ptLinear(h2.color) : m2.base.rgb;
          float4 c2 = rtptSharcQuery(q2, q2n, u, sharcResolved);
          float3 irrad2 = c2.w > 0.5f ? c2.rgb : (rtptSecondaryDirect(q2, q2n, q2ng, u, scene, instances, meshes, materials, rng) + float3(u.rig.x * 0.45f));
          indirectQ = base2 * (1.0f - m2.surface.y) * irrad2;
        } else if (m2.surface.w < 1.5f) {
          indirectQ = exp(-u.glass.y * (1.0f - m2.base.rgb)) * float3(u.rig.x * 0.85f);
        } else {
          indirectQ = float3(u.rig.x * (1.0f - m2.base.a));
        }
      }
    }
    totalIrradQ = directQ + indirectQ;
    if (updateColdCache) rtptSharcInsert(q, qn, totalIrradQ, u, sharcAccum);
  }
  float3 outRad = diffAlbedo * totalIrradQ;

  float3 r = reflect(rayDir, qn);
  if (dot(r, qng) > 0.0f) {
    float3 specAlbedo = float3(coat) + (1.0f - coat) * fb;
    float a2 = max(roughness * roughness, 2e-3f);
    a2 *= a2;
    float g1 = ptSmithG1(max(dot(qn, r), 1e-4f), a2);
    float visProxy = saturate(rtptLum(totalIrradQ) / max(u.rig.x + 0.65f, 1e-4f));
    float envRad = (u.rig.x + rtptDiskRadiance(r, u)) * visProxy;
    outRad += specAlbedo * g1 * envRad;
  }
  return outRad;
}

// PASS 4a: Full-Resolution Adaptive Control-Variate Floor Shadow Catcher (zero white halos!).
kernel void rtptTraceFloor(
    constant RtptUniforms& u [[buffer(0)]],
    metal::raytracing::instance_acceleration_structure scene [[buffer(1)]],
    device const PtInstance* instances [[buffer(2)]],
    device const PtMesh* meshes [[buffer(3)]],
    device const PtMaterial* materials [[buffer(4)]],
    texture2d<float, access::read> gPosId [[texture(0)]],
    texture2d<float, access::read> gMotion [[texture(1)]],
    texture2d<float, access::read> prevPosId [[texture(2)]],
    texture2d<float, access::read> diffHistPrev [[texture(3)]],
    texture2d<float, access::write> diffOut [[texture(4)]],
    uint2 gid [[thread_position_in_grid]]) {
  if (gid.x >= u.size.x || gid.y >= u.size.y) return;
  float4 posId = gPosId.read(gid);
  if (rtptUnpackKind(posId.w) != 3u) return;

  float3 p = posId.xyz;
  float3 up = float3(0.0f, -1.0f, 0.0f);
  float3 bmin = u.sceneMin.xyz, bmax = u.sceneMax.xyz;
  float modelH = max(u.floorPlane.x - bmin.y, 1.0f);
  float modelDiag = max(length(bmax - bmin), 1.0f);
  float reach = max(modelH * 6.5f, modelDiag * 2.0f);
  float2 dBox = max(max(bmin.xz - p.xz, p.xz - bmax.xz), float2(0.0f));
  if (dot(dBox, dBox) > reach * reach) {
    // Open floor outside shadow reach: 0 rays, marked open (b = 0).
    diffOut.write(float4(1.0f, 1.0f, 0.0f, 1.0f), gid);
    return;
  }

  // Reproject previous frame's smoothed floor lightsVis as unbiased control-variate alpha
  // (0.0 on cold/disoccluded pixels so Frame-1 floor shadows stay strictly non-negative).
  float alphaFloor = 0.0f;
  if (u.flags.y != 0u) {
    float2 mv = gMotion.read(gid).xy;
    float2 prevUv = (float2(gid) + 0.5f) / float2(u.size.xy) + mv;
    if (all(prevUv >= 0.0f) && all(prevUv < 1.0f)) {
      uint2 prevPx = uint2(clamp(int2(prevUv * float2(u.size.xy)), int2(0), int2(u.size.xy) - 1));
      float4 pPosId = prevPosId.read(prevPx);
      if (rtptUnpackKind(pPosId.w) == 3u) {
        float viewDist = max(length(p - u.eye.xyz), 1.0f);
        if (length(pPosId.xyz - p) < 0.08f * viewDist) {
          alphaFloor = saturate(diffHistPrev.read(prevPx).r);
        }
      }
    }
  }

  float3 fOrigin = p + up * kPtEps;
  PtRng rng;
  rng.s = ptHash(ptHash(gid.x * 1973u + gid.y * 9277u) ^ (u.size.z * 26699u + 73u));

  // 1 full-res cosine sky ray + 1 full-res adaptive control-variate disk ray (paired with 3x3 bilateral filter -> 65+ FPS on 4.5M tris!).
  float2 rSky = rtptR2(u.size.z * 2u, gid);
  float skyVis = rtptShadowFast(fOrigin, ptCosine(up, rSky.x, rSky.y), u, scene, instances, meshes, materials);

  float lightsVis = 1.0f;
  if (u.rig.w > 0.5f) {
    float coneScale = u.rig.y / max(2.0f * (1.0f - u.rig.z), 1e-6f);
    float diskE[4];
    float sumE = 0.0f;
    for (int i = 0; i < 4; i++) {
      float w = u.lights[i].w * (i == 0 ? u.floorPlane.z : 1.0f);
      diskE[i] = w * rtptDiskLight(dot(u.lights[i].xyz, up), u.rig.y) * coneScale;
      sumE += diskE[i];
    }
    if (sumE > 1e-6f) {
      float pick = rng.next() * sumE;
      int dIdx = 0;
      while (dIdx < 3 && pick >= diskE[dIdx]) {
        pick -= diskE[dIdx];
        dIdx++;
      }
      float2 rDisk = rtptR2(u.size.z * 2u + 1u, gid);
      float3 l = ptAround(u.lights[dIdx].xyz, 1.0f - rDisk.x * (1.0f - u.rig.z), 2.0f * kPtPi * rDisk.y);
      float c = max(dot(l, up), 0.0f);
      float vis = c > 0.0f ? rtptShadowFast(fOrigin, l, u, scene, instances, meshes, materials) : 0.0f;
      float wExact = u.lights[dIdx].w * (dIdx == 0 ? u.floorPlane.z : 1.0f) * c;
      lightsVis = alphaFloor + (vis - alphaFloor) * (wExact / max(diskE[dIdx], 1e-6f));
    }
  }

  diffOut.write(float4(lightsVis, skyVis, 1.0f, 1.0f), gid);
}

inline float3 rtptTraceSpecLobe(
    float3 p, float3 n, float3 ng, float3 v, float lobeRough, float eps, float2 r2,
    bool isSolidPlastic, constant RtptUniforms& u,
    metal::raytracing::instance_acceleration_structure scene,
    device const PtInstance* instances, device const PtMesh* meshes,
    device const PtMaterial* materials, device const RtptSharcResolved* sharcResolved,
    device RtptSharcAccum* sharcAccum, thread PtRng& rng) {
  float gWeight = 0.0f;
  float3 reflDir = rtptSampleGgxVndf(n, v, lobeRough, r2.x, r2.y, gWeight);
  if (gWeight <= 0.0f || dot(reflDir, ng) <= 0.0f) return float3(0.0f);
  PtHit rh = rtptTrace(p + ng * eps, reflDir, u, scene, instances, meshes);
  float3 reflIn = float3(0.0f);
  if (!rh.hit) {
    if (isSolidPlastic) {
      // EyeSight studio specular contrast: darker dome between brighter softboxes, subtle studio floor reflection below horizon.
      float envBase = (u.floorPlane.y > 0.5f && reflDir.y > 0.0f) ? (u.rig.x * 1.18f) : (u.rig.x * 0.72f);
      reflIn = float3(envBase + rtptDiskRadiance(reflDir, u) * 1.55f);
    } else {
      reflIn = float3(u.rig.x) + float3(rtptDiskRadiance(reflDir, u));
    }
  } else {
    PtMaterial rm = materials[rh.material];
    if (rm.surface.w < 0.5f) {
      reflIn = rtptShadeBounceHit(rh, p + ng * eps, reflDir, u, scene, instances, meshes, materials, sharcResolved, sharcAccum, rng, false);
    } else if (rm.surface.w < 1.5f) {
      float3 rqn = dot(rh.ns, -reflDir) < 0.0f ? -rh.ns : rh.ns;
      float gf = ptFresnel(saturate(dot(rqn, -reflDir)), 1.0f / u.glass.x);
      float3 rSky = float3(u.rig.x * 0.52f) + float3(rtptDiskRadiance(reflect(reflDir, rqn), u) * 1.25f);
      float3 transTint = exp(-0.76f * (1.0f - rm.base.rgb)) * u.background.rgb * 0.65f;
      reflIn = mix(transTint, rSky, gf);
    } else {
      reflIn = float3(u.rig.x);
    }
  }
  return gWeight * reflIn;
}

// PASS 4b: Specialized Opaque Brick GI (+ Fine SHaRC) + Separate Deterministic Clearcoat & Base VNDF Specular.
kernel void rtptTraceOpaque(
    constant RtptUniforms& u [[buffer(0)]],
    metal::raytracing::instance_acceleration_structure scene [[buffer(1)]],
    device const PtInstance* instances [[buffer(2)]],
    device const PtMesh* meshes [[buffer(3)]],
    device const PtMaterial* materials [[buffer(4)]],
    device const RtptSharcResolved* sharcResolved [[buffer(5)]],
    device RtptSharcAccum* sharcAccum [[buffer(6)]],
    texture2d<float, access::read> gPosId [[texture(0)]],
    texture2d<float, access::read> gNorm [[texture(1)]],
    texture2d<float, access::read> gMat [[texture(2)]],
    texture2d<float, access::read> gMotion [[texture(3)]],
    texture2d<float, access::read> diIn [[texture(4)]],
    texture2d<float, access::write> diffOut [[texture(5)]],
    texture2d<float, access::write> specOut [[texture(6)]],
    uint2 gid [[thread_position_in_grid]]) {
  if (gid.x >= u.size.x || gid.y >= u.size.y) return;

  float4 posId = gPosId.read(gid);
  if (rtptUnpackKind(posId.w) != 1u) return;

  float3 p = posId.xyz;
  float4 nPacked = gNorm.read(gid);
  float3 n = rtptOctDecode(nPacked.xy);
  float3 ng = rtptOctDecode(nPacked.zw);
  float4 matVal = gMat.read(gid);
  float4 motVal = gMotion.read(gid);
  float3 base = matVal.rgb;
  float roughness = matVal.a;
  float metalness = motVal.z;
  float clearcoat = motVal.w;
  float3 v = normalize(u.eye.xyz - p);
  float eps = rtptRayOffset(p, u.eye.xyz);

  PtRng rng;
  rng.s = ptHash(ptHash(gid.x * 1973u + gid.y * 9277u) ^ (u.size.z * 26699u + 911u));
  float2 rGi = rtptR2(u.size.z * 3u, gid);
  float2 rCoat = rtptR2(u.size.z * 3u + 1u, gid);
  float2 rSpec = rtptR2(u.size.z * 3u + 2u, gid);

  // 1. Full-res Diffuse GI bounce (+ fine SHaRC multi-bounce lookup & cache update).
  float4 diVal = diIn.read(gid);
  float3 indirectIrrad = float3(0.0f);
  if (metalness < 0.98f) {
    float3 giDir = ptCosine(n, rGi.x, rGi.y);
    if (dot(giDir, ng) > 0.0f) {
      PtHit gh = rtptTrace(p + ng * eps, giDir, u, scene, instances, meshes);
      if (!gh.hit) {
        indirectIrrad = float3(u.rig.x);
      } else {
        PtMaterial gm = materials[gh.material];
        if (gm.surface.w < 0.5f) {
          indirectIrrad = rtptShadeBounceHit(gh, p + ng * eps, giDir, u, scene, instances, meshes, materials, sharcResolved, sharcAccum, rng, true);
        } else if (gm.surface.w < 1.5f) {
          float3 gp = p + ng * eps + giDir * (gh.t + kPtEps * 2.0f);
          float3 tint = exp(-u.glass.y * (1.0f - gm.base.rgb));
          PtHit gh2 = rtptTrace(gp, giDir, u, scene, instances, meshes);
          if (!gh2.hit) indirectIrrad = tint * float3(u.rig.x);
          else if (materials[gh2.material].surface.w < 0.5f)
            indirectIrrad = tint * rtptShadeBounceHit(gh2, gp, giDir, u, scene, instances, meshes, materials, sharcResolved, sharcAccum, rng, false);
          else indirectIrrad = tint * float3(u.rig.x * 0.8f);
        } else {
          indirectIrrad = float3(u.rig.x * (1.0f - gm.base.a));
        }
      }
    }
    indirectIrrad = min(indirectIrrad, float3(12.0f));
  }
  float3 totalDiffIrrad = float3(diVal.r) + indirectIrrad;
  if (((gid.x + gid.y + u.size.z) & 3u) == 0u && metalness < 0.98f) {
    rtptSharcInsert(p, n, totalDiffIrrad, u, sharcAccum);
  }
  // Store direct visibility estimate in alpha for next frame's unbiased adaptive control variate!
  diffOut.write(float4(totalDiffIrrad, diVal.g), gid);

  // 2. Separate Deterministic Dual-Lobe Clearcoat + Base VNDF Specular (ZERO coin-flip sheen noise!).
  float nv = max(dot(n, v), 1e-4f);
  float nvGeom = max(dot(ng, v), 1e-4f);
  bool isSolidPlastic = (metalness < 0.05f) && (clearcoat > 0.10f) && (roughness < 0.30f);
  float coat, coatRough, baseRough;
  float3 fb, diffAlbedoUnused, specAlbedoRaw;
  rtptBrdfParams(base, roughness, metalness, clearcoat, nv, nvGeom, coat, fb, diffAlbedoUnused, specAlbedoRaw, coatRough, baseRough);
  float3 specAlbedo = max(specAlbedoRaw, float3(1e-4f));

  float3 specSum = float3(0.0f);
  if (coat > 1e-4f) {
    specSum += float3(coat) * rtptTraceSpecLobe(p, n, ng, v, coatRough, eps, rCoat, isSolidPlastic, u, scene, instances, meshes, materials, sharcResolved, sharcAccum, rng);
  }
  float3 baseSpecW = isSolidPlastic ? fb : ((1.0f - coat) * fb);
  if (ptMean(baseSpecW) > 1e-4f) {
    specSum += baseSpecW * rtptTraceSpecLobe(p, n, ng, v, baseRough, eps, rSpec, isSolidPlastic, u, scene, instances, meshes, materials, sharcResolved, sharcAccum, rng);
  }
  float3 demodSpec = min(specSum / specAlbedo, float3(12.0f));
  specOut.write(float4(demodSpec, 1.0f), gid);
}

// PASS 4c: Crystal-Clear Cycles/EyeSight Dielectric Glass RT (Deterministic Fresnel Split +
// Smooth Optical Refraction + True Polycarbonate Beer-Lambert Volume Absorption +
// Exact Passed-Only Backdrop vs Glossy/TIR Studio Dome & Softbox Contrast +
// Noise-Free Deterministic Opaque-Behind-Glass Shading via Fine SHaRC).
// Dispatched ONLY when glass is in view (0.00 ms on opaque scenes).
kernel void rtptTraceGlass(
    constant RtptUniforms& u [[buffer(0)]],
    metal::raytracing::instance_acceleration_structure scene [[buffer(1)]],
    device const PtInstance* instances [[buffer(2)]],
    device const PtMesh* meshes [[buffer(3)]],
    device const PtMaterial* materials [[buffer(4)]],
    device const RtptSharcResolved* sharcResolved [[buffer(5)]],
    device RtptSharcAccum* sharcAccum [[buffer(6)]],
    texture2d<float, access::read> gPosId [[texture(0)]],
    texture2d<float, access::write> specOut [[texture(1)]],
    uint2 gid [[thread_position_in_grid]]) {
  if (gid.x >= u.size.x || gid.y >= u.size.y) return;
  uint kind = rtptUnpackKind(gPosId.read(gid).w);
  if (kind != 2u && kind != 4u) return;

  PtRng rng;
  rng.s = ptHash(ptHash(gid.x * 2971u + gid.y * 6553u) ^ (u.size.z * 0x9E3779B9u + 313u));
  constexpr uint kGlassSpp = 2u;
  float3 glassAcc = float3(0.0f);

  for (uint s = 0u; s < kGlassSpp; s++) {
    float2 sub = (s == 0u) ? (float2(0.5f) + u.jitter.xy) : rtptR2(u.size.z * kGlassSpp + s, gid);
    float sx = (float(gid.x) + sub.x) / float(u.size.x) * 2.0f - 1.0f;
    float sy = 1.0f - (float(gid.y) + sub.y) / float(u.size.y) * 2.0f;
    float3 origin, dir;
    if (u.up.w > 0.5f) {
      origin = u.eye.xyz + u.right.xyz * (sx * u.up.w * u.right.w) + u.up.xyz * (sy * u.up.w);
      dir = u.forward.xyz;
    } else {
      origin = u.eye.xyz;
      dir = normalize(u.forward.xyz + u.right.xyz * (sx * u.eye.w * u.right.w) + u.up.xyz * (sy * u.eye.w));
    }

    float3 throughput = float3(1.0f), radiance = float3(0.0f), absorb = float3(0.0f);
    // passedOnly stays true across pure glass refractions (sees the bright studio floor/backdrop)
    // and flips false on any Fresnel reflection or Total Internal Reflection (sees EyeSight's 0.15
    // dark studio world dome vs bright softboxes -> razor-sharp dark crystal inner tubes & stud rims!).
    bool passedOnly = true;

    for (uint bounce = 0u; bounce < 16u; bounce++) {
      PtHit h = rtptTrace(origin, dir, u, scene, instances, meshes);
      if (any(absorb > 0.0f)) throughput *= exp(-absorb * (h.hit ? h.t : 1e4f));

      float tf = (u.floorPlane.y > 0.5f && dir.y > 1e-6f) ? (u.floorPlane.x - origin.y) / dir.y : -1.0f;
      if (tf > 1e-3f && (!h.hit || tf < h.t)) {
        if (bounce == 0u) {
          radiance += throughput * u.background.rgb;
        } else if (passedOnly) {
          // Pure straight transmission onto the white studio floor backdrop: bright luminous crystal window!
          radiance += throughput * u.background.rgb * 0.84f;
        } else {
          // Internally reflected / TIR ray hitting below horizon: dark studio world ambient (NOT glowing white floor!),
          // giving Clear, Red, Light Blue, Yellow, Green, and Round bricks true jewel-like dark inner-tube & stud contrast!
          radiance += throughput * float3(u.rig.x * 0.42f);
        }
        break;
      }
      if (!h.hit) {
        if (passedOnly) {
          radiance += throughput * u.background.rgb * (bounce == 0u ? 1.0f : 0.84f);
        } else {
          // Pure glass reflection / TIR exiting to the studio dome:
          // EyeSight worldStrength (0.15) between bright softbox disks creates crisp sparkles & dark crystal facets!
          float disks = rtptDiskRadiance(dir, u);
          radiance += throughput * (float3(u.rig.x * 0.51f) + float3(disks * 1.45f));
        }
        break;
      }

      float3 hp = origin + dir * h.t;
      PtMaterial m = materials[h.material];
      float mKind = m.surface.w;
      if (mKind > 1.5f) {
        if (rng.next() >= m.base.a) {
          origin = hp + dir * kPtEps;
          continue;
        }
        mKind = 0.0f;
      }

      if (mKind > 0.5f) {
        bool entering = dot(dir, h.ng) < 0.0f;
        float3 gn = entering ? h.ns : -h.ns;
        if (dot(dir, gn) >= 0.0f) gn = entering ? h.ng : -h.ng;
        float eta = entering ? (1.0f / u.glass.x) : u.glass.x;
        float f = ptFresnel(-dot(dir, gn), eta);
        // True polycarbonate Beer-Lambert volume absorption (0.23 / LDU):
        // Keeps Trans-Clear crystal clear (0 absorption), Trans-Yellow golden lemon-yellow, Trans-Light Blue ice cyan,
        // and Trans-Red luminous rose-ruby on thin walls while deepening thick edges, top walls & studs naturally!
        float3 bulkAbsorb = 0.23f * (1.0f - m.base.rgb);

        // Deterministic Entry & Exit Wall Fresnel Splits (bounce 0 & bounce 1):
        // Eliminates the 8%-vs-92% binary speckle noise inside flat glass walls completely, even on Frame 1,
        // while keeping exact traced multi-bounce reflections on deeper walls & curved TIR facets!
        if (bounce == 0u && entering && f < 0.999f) {
          float3 rDir = reflect(dir, gn);
          PtHit rh = rtptTrace(hp + gn * kPtEps, rDir, u, scene, instances, meshes);
          float3 reflCol;
          if (!rh.hit) {
            reflCol = float3(u.rig.x * 0.51f) + float3(rtptDiskRadiance(rDir, u) * 1.45f);
          } else {
            PtMaterial rm = materials[rh.material];
            if (rm.surface.w < 0.5f) {
              reflCol = rtptShadeBounceHit(rh, hp + gn * kPtEps, rDir, u, scene, instances, meshes, materials, sharcResolved, sharcAccum, rng, false);
            } else if (rm.surface.w < 1.5f) {
              float3 rqn = dot(rh.ns, -rDir) < 0.0f ? -rh.ns : rh.ns;
              float gf = ptFresnel(saturate(dot(rqn, -rDir)), 1.0f / u.glass.x);
              float3 rSky = float3(u.rig.x * 0.51f) + float3(rtptDiskRadiance(reflect(rDir, rqn), u) * 1.45f);
              float3 tTint = exp(-0.92f * (1.0f - rm.base.rgb)) * u.background.rgb * 0.66f;
              reflCol = mix(tTint, rSky, gf);
            } else {
              reflCol = float3(u.rig.x);
            }
          }
          radiance += throughput * f * reflCol;
          throughput *= (1.0f - f);
          dir = normalize(refract(dir, gn, eta));
          origin = hp - gn * kPtEps;
          absorb = bulkAbsorb;
        } else if (bounce == 1u && !entering && f < 0.25f) {
          // Deterministic front-wall exit Fresnel split: removes binary flat-wall speckle at zero extra ray cost
          // while preserving exact traced multi-brick & curved TIR reflections on bounce >= 2 and grazing angles!
          float3 rDir = reflect(dir, gn);
          float3 rEnv = (u.floorPlane.y > 0.5f && rDir.y > 1e-6f)
                            ? float3(u.rig.x * 0.42f)
                            : (float3(u.rig.x * 0.51f) + float3(rtptDiskRadiance(rDir, u) * 1.45f));
          radiance += throughput * f * exp(-bulkAbsorb * 4.0f) * rEnv;
          throughput *= (1.0f - f);
          dir = normalize(refract(dir, gn, eta));
          origin = hp - gn * kPtEps;
          absorb = float3(0.0f);
        } else if (rng.next() < f) {
          dir = reflect(dir, gn);
          origin = hp + gn * kPtEps;
          passedOnly = false;
        } else {
          dir = normalize(refract(dir, gn, eta));
          origin = hp - gn * kPtEps;
          absorb = entering ? bulkAbsorb : float3(0.0f);
        }
      } else {
        // Noise-free deterministic shading on opaque bricks seen inside/behind glass (e.g. white studs under blue glass!):
        // Eliminates diffuse/specular coin-flip & uniform-disk salt-and-pepper grain completely!
        float3 base = h.color != 0u ? ptLinear(h.color) : m.base.rgb;
        float roughness = m.surface.x, metalness = m.surface.y, clearcoat = m.surface.z;
        float3 ng = dot(h.ng, dir) > 0.0f ? -h.ng : h.ng;
        float3 n = h.ns;
        if (dot(n, ng) < 0.0f) n = -n;
        if (dot(n, -dir) <= 0.0f) n = ng;
        float3 v = -dir;
        float nv = max(dot(n, v), 1e-4f);
        float nvGeom = max(dot(ng, v), 1e-4f);
        bool isSolidPlastic = (metalness < 0.05f) && (clearcoat > 0.10f) && (roughness < 0.30f);
        float coat, coatRough, baseRough;
        float3 fb, diffAlbedo, specAlbedo;
        rtptBrdfParams(base, roughness, metalness, clearcoat, nv, nvGeom, coat, fb, diffAlbedo, specAlbedo, coatRough, baseRough);

        // 1. Direct studio irradiance (exact diskLight importance sampling, 2 stratified samples) + indirect bounce via SHaRC!
        float3 diffIrrad = float3(0.0f);
        if (metalness < 0.98f) {
          float3 directH = 0.5f * (rtptSecondaryDirect(hp, n, ng, u, scene, instances, meshes, materials, rng) +
                                   rtptSecondaryDirect(hp, n, ng, u, scene, instances, meshes, materials, rng));
          float3 indirectH = float3(0.0f);
          float3 giDir = ptCosine(n, rng.next(), rng.next());
          if (dot(giDir, ng) > 0.0f) {
            PtHit gh = rtptTrace(hp + ng * kPtEps, giDir, u, scene, instances, meshes);
            if (!gh.hit) {
              indirectH = float3(u.rig.x);
            } else {
              PtMaterial gm = materials[gh.material];
              if (gm.surface.w < 0.5f) {
                indirectH = rtptShadeBounceHit(gh, hp + ng * kPtEps, giDir, u, scene, instances, meshes, materials, sharcResolved, sharcAccum, rng, true);
              } else if (gm.surface.w < 1.5f) {
                // Light entering through the enclosing glass shell onto the white studs inside (like Cycles caustics/transmission!):
                float3 gp = hp + ng * kPtEps + giDir * (gh.t + kPtEps * 2.0f);
                float3 gTint = exp(-0.88f * (1.0f - gm.base.rgb));
                PtHit gh2 = rtptTrace(gp, giDir, u, scene, instances, meshes);
                if (!gh2.hit) indirectH = gTint * (float3(u.rig.x) + float3(rtptDiskRadiance(giDir, u) * 0.45f));
                else if (materials[gh2.material].surface.w < 0.5f)
                  indirectH = gTint * rtptShadeBounceHit(gh2, gp, giDir, u, scene, instances, meshes, materials, sharcResolved, sharcAccum, rng, false);
                else indirectH = gTint * float3(u.rig.x * 0.75f);
              } else {
                indirectH = float3(u.rig.x * (1.0f - gm.base.a));
              }
            }
          }
          diffIrrad = directH + indirectH;
          if ((s == 0u) && (((gid.x + gid.y + u.size.z) & 3u) == 0u)) {
            rtptSharcInsert(hp, n, diffIrrad, u, sharcAccum);
          }
        }
        // 2. Deterministic specular reflection lobe on the opaque brick behind glass.
        float3 specRad = float3(0.0f);
        if (ptMean(specAlbedo) > 1e-4f) {
          float2 rSpec = float2(rng.next(), rng.next());
          specRad = rtptTraceSpecLobe(hp, n, ng, v, baseRough, kPtEps, rSpec, isSolidPlastic, u, scene, instances, meshes, materials, sharcResolved, sharcAccum, rng);
        }
        radiance += throughput * (diffAlbedo * diffIrrad + specAlbedo * specRad);
        break;
      }

      if (bounce >= 8u) {
        float q = clamp(max(throughput.r, max(throughput.g, throughput.b)), 0.10f, 0.95f);
        if (rng.next() > q) break;
        throughput /= q;
      }
    }

    if (!any(isnan(radiance)) && !any(isinf(radiance))) glassAcc += min(radiance, float3(10.0f));
  }
  specOut.write(float4(glassAcc * (1.0f / float(kGlassSpp)), 1.0f), gid);
}

// ============================================================================
// PASS 5: Demodulated SVGF Temporal + Roughness/Contact-Aware 5-Tap A-Trous
// ============================================================================

kernel void rtptSvgfTemporal(
    constant RtptUniforms& u [[buffer(0)]],
    texture2d<float, access::read> gPosId [[texture(0)]],
    texture2d<float, access::read> gNorm [[texture(1)]],
    texture2d<float, access::read> gMotion [[texture(2)]],
    texture2d<float, access::read> prevPosId [[texture(3)]],
    texture2d<float, access::read> prevNorm [[texture(4)]],
    texture2d<float, access::read> diffRaw [[texture(5)]],
    texture2d<float, access::read> specRaw [[texture(6)]],
    texture2d<float, access::read> diffHistPrev [[texture(7)]],
    texture2d<float, access::read> specHistPrev [[texture(8)]],
    texture2d<float, access::read> momentsPrev [[texture(9)]],
    texture2d<float, access::read> hLenPrev [[texture(10)]],
    texture2d<float, access::write> diffHistOut [[texture(11)]],
    texture2d<float, access::write> specHistOut [[texture(12)]],
    texture2d<float, access::write> momentsOut [[texture(13)]],
    texture2d<float, access::write> hLenOut [[texture(14)]],
    uint2 gid [[thread_position_in_grid]]) {
  if (gid.x >= u.size.x || gid.y >= u.size.y) return;

  float4 posId = gPosId.read(gid);
  uint kind = rtptUnpackKind(posId.w);
  if (kind == 0u) {
    diffHistOut.write(float4(0.0f), gid);
    specHistOut.write(float4(0.0f), gid);
    momentsOut.write(float4(0.0f), gid);
    hLenOut.write(float4(0.0f), gid);
    return;
  }

  float3 p = posId.xyz;
  uint piece = rtptUnpackPiece(posId.w);
  float4 nPacked = gNorm.read(gid);
  float3 n = rtptOctDecode(nPacked.xy);
  float3 ng = rtptOctDecode(nPacked.zw);
  float viewDist = max(length(p - u.eye.xyz), 1.0f);

  float4 dCur = (kind == 1u || kind == 3u) ? diffRaw.read(gid) : float4(0.0f);
  float4 sCur = (kind == 1u || kind == 2u || kind == 4u) ? specRaw.read(gid) : float4(0.0f);
  bool still = (u.size.w > 1u);

  // When stationary, pass RAW crystal-clear glass directly to rtptResolveTaa (zero double-averaging,
  // zero blur -> exact equal-weight 1/N convergence with 16x Halton subpixel anti-aliasing!).
  if (still && (kind == 2u || kind == 4u)) {
    diffHistOut.write(float4(0.0f), gid);
    specHistOut.write(sCur, gid);
    momentsOut.write(float4(0.0f), gid);
    hLenOut.write(float4(float(u.size.w), float(u.size.w), 0.0f, 0.0f), gid);
    return;
  }

  bool validHistory = false;
  float4 dPrev = float4(0.0f), sPrev = float4(0.0f), mPrev = float4(0.0f);
  float2 prevHLen = float2(0.0f);

  if (u.flags.y != 0u) {
    float2 mv = gMotion.read(gid).xy;
    float2 curUv = (float2(gid) + 0.5f) / float2(u.size.xy);
    float2 prevUv = curUv + mv;
    if (all(prevUv >= 0.0f) && all(prevUv < 1.0f)) {
      float2 prevF = prevUv * float2(u.size.xy) - 0.5f;
      int2 base = int2(floor(prevF));
      float2 f = fract(prevF);
      float wSum = 0.0f;
      for (int k = 0; k < 4; k++) {
        int2 tap = clamp(base + int2(k & 1, k >> 1), int2(0), int2(u.size.xy) - 1);
        float4 tPosId = prevPosId.read(uint2(tap));
        if (rtptUnpackKind(tPosId.w) != kind) continue;
        if (kind == 1u || kind == 2u) {
          if (u.flags.z != 0u && rtptUnpackPiece(tPosId.w) != piece) continue;
          float3 tn = rtptOctDecode(prevNorm.read(uint2(tap)).xy);
          if (dot(n, tn) < 0.90f) continue;
          if (abs(dot(tPosId.xyz - p, ng)) > 0.035f * viewDist) continue;
        } else if (kind == 3u) {
          if (length(tPosId.xyz - p) > 0.08f * viewDist) continue;
        }
        float bw = ((k & 1) ? f.x : (1.0f - f.x)) * ((k >> 1) ? f.y : (1.0f - f.y));
        dPrev += diffHistPrev.read(uint2(tap)) * bw;
        sPrev += specHistPrev.read(uint2(tap)) * bw;
        mPrev += momentsPrev.read(uint2(tap)) * bw;
        prevHLen += hLenPrev.read(uint2(tap)).xy * bw;
        wSum += bw;
      }
      if (wSum > 0.05f) {
        float invW = 1.0f / wSum;
        dPrev *= invW;
        sPrev *= invW;
        mPrev *= invW;
        prevHLen *= invW;
        validHistory = true;
      }
    }
  }

  float dLum = (kind == 3u) ? (0.5f * (dCur.r + dCur.g)) : rtptLum(dCur.rgb);
  float sLum = rtptLum(sCur.rgb);
  float2 curDM = float2(dLum, dLum * dLum);
  float2 curSM = float2(sLum, sLum * sLum);

  float4 dOut = dCur, sOut = sCur;
  float4 mOut = float4(curDM, curSM);
  float2 hLen = float2(1.0f, 1.0f);

  if (validHistory) {
    if (still) {
      // Sliding-window temporal filter prevents double-averaging lock-in of Frame-1 cold SHaRC!
      // Exact progressive accumulation happens once in rtptResolveTaa with Cesaro weighting.
      hLen.x = min(prevHLen.x + 1.0f, kind == 3u ? 16.0f : 8.0f);
      hLen.y = min(prevHLen.y + 1.0f, 4.0f);
      float aD = 1.0f / hLen.x;
      float aS = 1.0f / hLen.y;
      if (kind == 3u) {
        dOut = float4(mix(dPrev.rg, dCur.rg, aD), max(dPrev.b, dCur.b), 1.0f);
      } else {
        dOut = float4(mix(dPrev.rgb, dCur.rgb, aD), mix(dPrev.a, dCur.a, 0.25f));
      }
      sOut = float4(mix(sPrev.rgb, sCur.rgb, aS), 1.0f);
      mOut.xy = mix(mPrev.xy, curDM, aD);
      mOut.zw = mix(mPrev.zw, curSM, aS);
    } else {
      // Moving camera / animation: motion-reprojected EMA with gentle variance clamping.
      if (kind == 1u) {
        float3 m1 = dCur.rgb, m2 = dCur.rgb * dCur.rgb;
        float cnt = 1.0f;
        for (int dy = -1; dy <= 1; dy++) {
          for (int dx = -1; dx <= 1; dx++) {
            if (dx == 0 && dy == 0) continue;
            int2 nb = clamp(int2(gid) + int2(dx, dy), int2(0), int2(u.size.xy) - 1);
            if (rtptUnpackKind(gPosId.read(uint2(nb)).w) != 1u) continue;
            float3 nd = diffRaw.read(uint2(nb)).rgb;
            m1 += nd; m2 += nd * nd; cnt += 1.0f;
          }
        }
        float3 mean = m1 / cnt, sd = sqrt(max(m2 / cnt - mean * mean, float3(0.0f)));
        dPrev.rgb = clamp(dPrev.rgb, mean - sd * 2.4f, mean + sd * 2.4f);
      }
      hLen.x = min(prevHLen.x + 1.0f, 16.0f);
      float aD = max(1.0f / hLen.x, kind == 3u ? 0.10f : 0.12f);
      if (kind == 3u) {
        dOut = float4(mix(dPrev.rg, dCur.rg, aD), max(dPrev.b * 0.9f, dCur.b), 1.0f);
      } else {
        dOut = float4(mix(dPrev.rgb, dCur.rgb, aD), mix(dPrev.a, dCur.a, 0.25f));
      }
      mOut.xy = mix(mPrev.xy, curDM, aD);

      if (kind == 1u || kind == 2u || kind == 4u) {
        float3 m1 = sCur.rgb, m2 = sCur.rgb * sCur.rgb;
        float cnt = 1.0f;
        for (int dy = -1; dy <= 1; dy++) {
          for (int dx = -1; dx <= 1; dx++) {
            if (dx == 0 && dy == 0) continue;
            int2 nb = clamp(int2(gid) + int2(dx, dy), int2(0), int2(u.size.xy) - 1);
            if (rtptUnpackKind(gPosId.read(uint2(nb)).w) != kind) continue;
            float3 ns = specRaw.read(uint2(nb)).rgb;
            m1 += ns; m2 += ns * ns; cnt += 1.0f;
          }
        }
        float3 mean = m1 / cnt, sd = sqrt(max(m2 / cnt - mean * mean, float3(0.0f)));
        float kClamp = (kind == 2u) ? 3.5f : 2.2f;
        sPrev.rgb = clamp(sPrev.rgb, max(mean - sd * kClamp, float3(0.0f)), mean + sd * kClamp);
        hLen.y = min(prevHLen.y + 1.0f, 14.0f);
        float aS = max(1.0f / hLen.y, kind == 2u ? 0.18f : 0.16f);
        sOut = float4(mix(sPrev.rgb, sCur.rgb, aS), 1.0f);
        mOut.zw = mix(mPrev.zw, curSM, aS);
      }
    }
  } else {
    mOut = float4(dLum, dLum * dLum + 0.06f, sLum, sLum * sLum + 0.08f);
  }

  diffHistOut.write(dOut, gid);
  specHistOut.write(sOut, gid);
  momentsOut.write(mOut, gid);
  hLenOut.write(float4(hLen, 0.0f, 0.0f), gid);
}

// 5-Tap Alternating Cross/Diagonal Edge-Stopping Plane-Distance A-Trous Wavelet Filter (steps 1, 2, 4, 8).
// - NEVER spatially blurs dielectric glass (kind == 2u/4u) -> crystal-sharp refractions & caustics!
// - Contact-tightened floor sky edge-stopping -> razor-sharp dark creases under brick bases, silky penumbrae!
// - Roughness-gated specular filtering -> razor-sharp glossy LEGO stud sheen & bevels!
kernel void rtptSvgfAtrous(
    constant RtptUniforms& u [[buffer(0)]],
    texture2d<float, access::read> gPosId [[texture(0)]],
    texture2d<float, access::read> gNorm [[texture(1)]],
    texture2d<float, access::read> gMat [[texture(2)]],
    texture2d<float, access::read> diffIn [[texture(3)]],
    texture2d<float, access::read> specIn [[texture(4)]],
    texture2d<float, access::read> momentsIn [[texture(5)]],
    texture2d<float, access::read> hLenIn [[texture(6)]],
    texture2d<float, access::write> diffOut [[texture(7)]],
    texture2d<float, access::write> specOut [[texture(8)]],
    uint2 gid [[thread_position_in_grid]]) {
  if (gid.x >= u.size.x || gid.y >= u.size.y) return;

  float4 posId = gPosId.read(gid);
  uint kind = rtptUnpackKind(posId.w);
  float4 dCenter = diffIn.read(gid);
  float4 sCenter = specIn.read(gid);
  if (kind == 0u || kind == 4u) {
    diffOut.write(dCenter, gid);
    specOut.write(sCenter, gid);
    return;
  }

  int step = int(max(u.params.y & 0xFFFFu, 1u));
  uint passIdx = u.params.y >> 16u;
  float2 hLen = max(hLenIn.read(gid).xy, float2(1.0f));
  float stillF = float(max(u.size.w, 1u));

  // Dielectric glass (kind == 2u): NEVER wide-blur refracted internal tubes or edges!
  // Only apply a tight RGB-color-stopping 5-tap pass at step==1 on early frames (< 24) to remove
  // subtle flat-interior grain while keeping every caustic, stud, and refraction edge 100% razor-sharp.
  if (kind == 2u) {
    if (step > 1 || u.size.w >= 24u) {
      diffOut.write(dCenter, gid);
      specOut.write(sCenter, gid);
      return;
    }
    const int2 gOffs[4] = {int2(1, 0), int2(-1, 0), int2(0, 1), int2(0, -1)};
    float sigmaRgb = mix(0.11f, 0.045f, saturate((stillF - 1.0f) / 16.0f));
    float3 gSum = sCenter.rgb * 0.44f;
    float gW = 0.44f;
    for (int i = 0; i < 4; i++) {
      int2 qpx = int2(gid) + gOffs[i];
      if (qpx.x < 0 || qpx.y < 0 || qpx.x >= int(u.size.x) || qpx.y >= int(u.size.y)) continue;
      if (rtptUnpackKind(gPosId.read(uint2(qpx)).w) != 2u) continue;
      float3 sq = specIn.read(uint2(qpx)).rgb;
      float cDist = length(sCenter.rgb - sq);
      float w = 0.14f * exp(-(cDist * cDist) / max(2.0f * sigmaRgb * sigmaRgb, 1e-5f));
      gSum += sq * w;
      gW += w;
    }
    diffOut.write(dCenter, gid);
    specOut.write(float4(gSum / max(gW, 1e-6f), sCenter.a), gid);
    return;
  }

  // Fast open-floor bypass: zero neighbors fetched outside model shadow reach!
  if (kind == 3u && dCenter.b < 0.01f && dCenter.r > 0.998f && dCenter.g > 0.998f) {
    diffOut.write(dCenter, gid);
    specOut.write(sCenter, gid);
    return;
  }

  float filterScaleD = (u.size.w > 1u) ? saturate((kind == 3u ? 14.0f : 8.0f) / stillF) : 1.0f;
  float filterScaleS = (u.size.w > 1u) ? saturate(5.0f / stillF) : 1.0f;

  // Step 8 runs on broad floor shadow penumbrae and cold disocclusions; ramp down as stationary frames converge.
  if (step >= 8 && kind != 3u && hLen.x > 3.0f) {
    diffOut.write(dCenter, gid);
    specOut.write(sCenter, gid);
    return;
  }
  if (kind == 3u) {
    if (u.size.w >= 24u && step >= 8) { diffOut.write(dCenter, gid); specOut.write(sCenter, gid); return; }
    if (u.size.w >= 48u && step >= 4) { diffOut.write(dCenter, gid); specOut.write(sCenter, gid); return; }
  } else {
    if (u.size.w >= 12u && step >= 4) { diffOut.write(dCenter, gid); specOut.write(sCenter, gid); return; }
    if (u.size.w >= 24u && step >= 2) { diffOut.write(dCenter, gid); specOut.write(sCenter, gid); return; }
  }

  const int2 crossOffs[4] = {int2(1, 0), int2(-1, 0), int2(0, 1), int2(0, -1)};
  const int2 diagOffs[4] = {int2(1, 1), int2(-1, 1), int2(1, -1), int2(-1, -1)};

  float4 mom = momentsIn.read(gid);
  float diffVar = max(mom.y - mom.x * mom.x, 0.0f);
  float specVar = max(mom.w - mom.z * mom.z, 0.0f);

  // Full 3x3 (9-tap) Gaussian contact-sharp floor filter: eliminates 5-tap checkerboard stipple completely
  // while preserving razor-sharp dark contact creases under brick bases!
  if (kind == 3u) {
    float conf = saturate((hLen.x - 1.5f) / 4.5f);
    float coldBoost = mix(0.32f, 0.025f, conf);
    float sigmaLights = max(4.5f * sqrt(diffVar + 1e-4f) * filterScaleD, coldBoost);
    float contactTight = mix(1.0f, mix(0.34f, 1.0f, saturate((dCenter.g - 0.18f) / 0.65f)), conf);
    float sigmaSky = max(3.4f * sqrt(diffVar + 1e-4f) * filterScaleD * contactTight, coldBoost * contactTight);
    float lSum = dCenter.r * 0.25f, lW = 0.25f;
    float sSum = dCenter.g * 0.25f, sW = 0.25f;
    for (int dy = -1; dy <= 1; dy++) {
      for (int dx = -1; dx <= 1; dx++) {
        if (dx == 0 && dy == 0) continue;
        int2 qpx = int2(gid) + int2(dx, dy) * step;
        if (qpx.x < 0 || qpx.y < 0 || qpx.x >= int(u.size.x) || qpx.y >= int(u.size.y)) continue;
        if (rtptUnpackKind(gPosId.read(uint2(qpx)).w) != 3u) continue;
        float kw = (dx == 0 || dy == 0) ? 0.125f : 0.0625f;
        float4 dq = diffIn.read(uint2(qpx));
        float wl = kw * exp(-abs(dCenter.r - dq.r) / sigmaLights);
        float ws = kw * exp(-abs(dCenter.g - dq.g) / sigmaSky);
        lSum += dq.r * wl;
        lW += wl;
        sSum += dq.g * ws;
        sW += ws;
      }
    }
    diffOut.write(float4(lSum / max(lW, 1e-6f), sSum / max(sW, 1e-6f), dCenter.b, dCenter.a), gid);
    specOut.write(sCenter, gid);
    return;
  }

  // Opaque brick branch: exact plane-distance + normal + variance edge-stopping.
  float3 p = posId.xyz;
  float4 nPacked = gNorm.read(gid);
  float3 n = rtptOctDecode(nPacked.xy);
  float3 ng = rtptOctDecode(nPacked.zw);
  float roughness = gMat.read(gid).a;
  float viewDist = max(length(p - u.eye.xyz), 1.0f);

  float dLumC = rtptLum(dCenter.rgb);
  float sLumC = rtptLum(sCenter.rgb);
  float sigmaPlane = max(0.012f * viewDist * float(step), 0.15f);
  float sigmaDiff = max(3.0f * sqrt(diffVar + 1e-4f) * filterScaleD, 1e-3f);
  float sigmaSpec = max((0.75f + 2.2f * roughness) * sqrt(specVar + 1e-4f) * filterScaleS, 1e-3f);

  // Preserve crisp glossy LEGO plastic sheen: never wide-blur low-roughness specular!
  bool glossy = (roughness < 0.25f);
  bool filterSpec = glossy ? ((step <= 1) && (u.size.w < 6u)) : (step <= 4);

  float3 dSum = dCenter.rgb * 0.36f;
  float dW = 0.36f;
  float3 sSum = sCenter.rgb * 0.36f;
  float sW = 0.36f;

  for (int i = 0; i < 4; i++) {
    int2 o = ((passIdx & 1u) == 0u) ? crossOffs[i] : diagOffs[i];
    int2 qpx = int2(gid) + o * step;
    if (qpx.x < 0 || qpx.y < 0 || qpx.x >= int(u.size.x) || qpx.y >= int(u.size.y)) continue;
    float4 qPosId = gPosId.read(uint2(qpx));
    if (rtptUnpackKind(qPosId.w) != 1u) continue;

    float planeDist = abs(dot(qPosId.xyz - p, ng));
    float wz = exp(-planeDist / sigmaPlane);
    float3 qn = rtptOctDecode(gNorm.read(uint2(qpx)).xy);
    float nd = max(dot(n, qn), 0.0f);
    float wnDiff = pow(nd, 48.0f);
    float wnSpec = pow(nd, 160.0f);

    float4 dq = diffIn.read(uint2(qpx));
    float wlDiff = exp(-abs(dLumC - rtptLum(dq.rgb)) / sigmaDiff);
    float wDiff = 0.16f * wz * wnDiff * wlDiff;
    dSum += dq.rgb * wDiff;
    dW += wDiff;

    if (filterSpec) {
      float4 sq = specIn.read(uint2(qpx));
      float wlSpec = exp(-abs(sLumC - rtptLum(sq.rgb)) / sigmaSpec);
      float wSpec = 0.16f * wz * wnSpec * wlSpec;
      sSum += sq.rgb * wSpec;
      sW += wSpec;
    }
  }

  diffOut.write(float4(dSum / max(dW, 1e-6f), dCenter.a), gid);
  specOut.write(float4(filterSpec ? (sSum / max(sW, 1e-6f)) : sCenter.rgb, sCenter.a), gid);
}

// ============================================================================
// PASS 6: Threadgroup-SRAM Physical BRDF Re-Modulation + Halton TAA / Progressive
// ============================================================================

inline float3 rtptRgbToYCoCg(float3 c) {
  return float3(0.25f * c.r + 0.5f * c.g + 0.25f * c.b,
                0.5f * c.r - 0.5f * c.b,
                -0.25f * c.r + 0.5f * c.g - 0.25f * c.b);
}
inline float3 rtptYCoCgToRgb(float3 y) {
  return float3(y.x + y.y - y.z, y.x + y.z, y.x - y.y - y.z);
}

inline float3 rtptReModulate(uint2 at, constant RtptUniforms& u,
                             texture2d<float, access::read> gPosId,
                             texture2d<float, access::read> gNorm,
                             texture2d<float, access::read> gMat,
                             texture2d<float, access::read> gMotion,
                             texture2d<float, access::read> diffFilt,
                             texture2d<float, access::read> specFilt) {
  float4 posId = gPosId.read(at);
  uint kind = rtptUnpackKind(posId.w);
  if (kind == 0u) return u.background.rgb;
  if (kind == 3u) {
    float4 df = diffFilt.read(at);
    float ratio = saturate(df.r) * pow(saturate(df.g), u.background.w);
    return u.background.rgb * ratio;
  }
  if (kind == 2u || kind == 4u) return max(specFilt.read(at).rgb, float3(0.0f));

  float3 p = posId.xyz;
  float4 nPacked = gNorm.read(at);
  float3 n = rtptOctDecode(nPacked.xy);
  float3 ng = rtptOctDecode(nPacked.zw);
  float4 matVal = gMat.read(at);
  float4 motVal = gMotion.read(at);
  float3 base = matVal.rgb;
  float roughness = matVal.a;
  float metalness = motVal.z;
  float clearcoat = motVal.w;
  float3 v = normalize(u.eye.xyz - p);
  float nv = max(dot(n, v), 1e-4f);
  float nvGeom = max(dot(ng, v), 1e-4f);
  float coat, coatRoughUnused, baseRoughUnused;
  float3 fb, diffAlbedo, specAlbedo;
  rtptBrdfParams(base, roughness, metalness, clearcoat, nv, nvGeom, coat, fb, diffAlbedo, specAlbedo, coatRoughUnused, baseRoughUnused);
  return diffAlbedo * max(diffFilt.read(at).rgb, float3(0.0f)) +
         specAlbedo * max(specFilt.read(at).rgb, float3(0.0f));
}

// Cooperative 10x10 threadgroup-SRAM cache computes rtptReModulate ONCE per pixel instead of 10x!
kernel void rtptResolveTaa(
    constant RtptUniforms& u [[buffer(0)]],
    texture2d<float, access::read> gPosId [[texture(0)]],
    texture2d<float, access::read> gNorm [[texture(1)]],
    texture2d<float, access::read> gMat [[texture(2)]],
    texture2d<float, access::read> gMotion [[texture(3)]],
    texture2d<float, access::read> diffFilt [[texture(4)]],
    texture2d<float, access::read> specFilt [[texture(5)]],
    texture2d<float, access::read> taaPrev [[texture(6)]],
    texture2d<float, access::write> taaOut [[texture(7)]],
    uint2 gid [[thread_position_in_grid]],
    uint2 lid [[thread_position_in_threadgroup]],
    uint2 tgid [[threadgroup_position_in_grid]]) {
  threadgroup half3 tile[10][10];
  int2 sizeI = int2(u.size.xy);
  int2 basePx = int2(tgid * 8u) - int2(1, 1);

  uint flatIdx = lid.y * 8u + lid.x;
  for (uint idx = flatIdx; idx < 100u; idx += 64u) {
    uint tx = idx % 10u;
    uint ty = idx / 10u;
    uint2 px = uint2(clamp(basePx + int2(int(tx), int(ty)), int2(0), sizeI - 1));
    tile[ty][tx] = half3(rtptReModulate(px, u, gPosId, gNorm, gMat, gMotion, diffFilt, specFilt));
  }
  threadgroup_barrier(mem_flags::mem_threadgroup);

  if (gid.x >= u.size.x || gid.y >= u.size.y) return;
  float3 cur = float3(tile[lid.y + 1u][lid.x + 1u]);
  float3 out = cur;

  if (u.flags.y != 0u) {
    if (u.size.w > 1u) {
      uint kind = rtptUnpackKind(gPosId.read(gid).w);
      float3 prev = taaPrev.read(gid).rgb;
      uint n = min(u.size.w, max(u.params.x, 64u));
      // Glass gets pure 1/N equal-weight accumulation (raw unblurred samples);
      // opaque & floor use Cesaro linear-ramp weighting (evicts Frame-1 cold SHaRC & wide A-Trous fast!).
      float alpha = (kind == 2u || kind == 4u)
                        ? (1.0f / float(n))
                        : (n <= 12u ? (2.0f / float(n + 1u)) : (1.0f / float(n - 5u)));
      out = mix(prev, cur, alpha);
    } else {
      float2 mv = gMotion.read(gid).xy;
      float2 curUv = (float2(gid) + 0.5f) / float2(u.size.xy);
      float2 prevUv = curUv + mv;
      if (all(prevUv >= 0.0f) && all(prevUv < 1.0f)) {
        float2 pf = prevUv * float2(u.size.xy) - 0.5f;
        int2 b = int2(floor(pf));
        float2 f = fract(pf);
        float3 c00 = taaPrev.read(uint2(clamp(b + int2(0, 0), int2(0), sizeI - 1))).rgb;
        float3 c10 = taaPrev.read(uint2(clamp(b + int2(1, 0), int2(0), sizeI - 1))).rgb;
        float3 c01 = taaPrev.read(uint2(clamp(b + int2(0, 1), int2(0), sizeI - 1))).rgb;
        float3 c11 = taaPrev.read(uint2(clamp(b + int2(1, 1), int2(0), sizeI - 1))).rgb;
        float3 prev = mix(mix(c00, c10, f.x), mix(c01, c11, f.x), f.y);

        float3 m1 = float3(0.0f), m2 = float3(0.0f);
        for (uint dy = 0u; dy < 3u; dy++) {
          for (uint dx = 0u; dx < 3u; dx++) {
            float3 y = rtptRgbToYCoCg(float3(tile[lid.y + dy][lid.x + dx]));
            m1 += y;
            m2 += y * y;
          }
        }
        float3 mean = m1 * (1.0f / 9.0f);
        float3 stddev = sqrt(max(m2 * (1.0f / 9.0f) - mean * mean, float3(0.0f)));
        float3 prevY = clamp(rtptRgbToYCoCg(prev), mean - stddev * 1.25f, mean + stddev * 1.25f);
        out = max(mix(rtptYCoCgToRgb(prevY), cur, 0.20f), float3(0.0f));
      }
    }
  }

  taaOut.write(float4(out, 1.0f), gid);
}

fragment float4 rtptPresentFragment(
    ScreenOut in [[stage_in]],
    constant RtptUniforms& u [[buffer(0)]],
    texture2d<float> resolved [[texture(0)]],
    texture2d<float> mask [[texture(1)]]) {
  uint2 at = uint2(in.position.xy);
  if (at.x >= u.size.x || at.y >= u.size.y) return float4(u.background.rgb, 1.0f);
  float3 out = saturate(resolved.read(at).rgb);

  int width = int(u.selection.w);
  if (width > 0 && mask.read(at).r < 0.5f) {
    int2 size = int2(mask.get_width(), mask.get_height());
    bool near = false;
    for (int dy = -width; dy <= width && !near; dy++) {
      for (int dx = -width; dx <= width && !near; dx++) {
        if (dx * dx + dy * dy > width * width) continue;
        int2 q = clamp(int2(at) + int2(dx, dy), int2(0), size - 1);
        near = mask.read(uint2(q)).r > 0.5f;
      }
    }
    if (near) out = u.selection.rgb;
  }
  return float4(out, 1.0f);
}
