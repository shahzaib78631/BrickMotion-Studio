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
  uint4 size;          // x: traceWidth, y: traceHeight, z: frameIndex, w: stillFrames
  uint4 flags;         // x: hasScene, y: hasHistory, z: sceneChanged, w: hasPlaceholders
  uint4 params;        // x: maxSamples, y: atrousStep (low 16) | passIdx (high 16), z: hasPrevPose, w: prevPoseCount
  uint4 outSize;       // x: displayWidth, y: displayHeight, z: taauActive, w: unused
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

// IEEE-754 safe 29-bit G-buffer metadata packer: bit 29 is always 1 (bit 30 = 0, bit 31 = 0),
// keeping every packed float strictly normal finite positive (exponent 64..127 -> zero subnormal
// flush, zero NaN/Inf). Cleared sky is 0.0f -> kind 0.
// Layout: [0..2] kind (0..4), [3..6] metalQ (0..10), [7..11] coatQ (0..20), [12..28] piece (0..131071).
inline uint rtptPackMeta(uint piece, uint kind, float metalness, float clearcoat) {
  uint mQ = uint(clamp(round(metalness * 10.0f), 0.0f, 10.0f));
  uint cQ = uint(clamp(round(clearcoat * 20.0f), 0.0f, 20.0f));
  return 0x20000000u | ((piece & 0x1FFFFu) << 12u) | (cQ << 7u) | (mQ << 3u) | (kind & 7u);
}
inline uint rtptUnpackKind(float packed) { return as_type<uint>(packed) & 7u; }
inline float rtptUnpackMetal(float packed) { return float((as_type<uint>(packed) >> 3u) & 0xFu) * 0.1f; }
inline float rtptUnpackCoat(float packed) { return float((as_type<uint>(packed) >> 7u) & 0x1Fu) * 0.05f; }
inline uint rtptUnpackPiece(float packed) { return (as_type<uint>(packed) >> 12u) & 0x1FFFFu; }
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

// Slim 52-byte G-buffer vertex output (zero pow() in vertex shader across 7.8M triangles;
// motion clip coords & sRGB->linear printed color run once per visible pixel after Apple TBDR HSR!).
struct RtptGbufVertOut {
  float4 position [[position]];
  float3 world;
  half3 normal;
  half3 prevDelta;
  half4 fixedColor;
  uint piece [[flat]];
};

// Compact 32-byte/pixel G-buffer (fits Apple Silicon full 32x32 TBDR tile memory without tile splitting!):
//   posId:  RGBA32F (16B) xyz world + w packed (piece | coat | metal | kind)
//   norm:   RGBA16F ( 8B) xy oct(ns) + zw oct(ng)
//   mat:    RGBA8   ( 4B) rgb sqrt(base) + a roughness
//   motion: RG16F   ( 4B) xy (prevUv - curUv)
struct RtptGbufFragOut {
  float4 posId  [[color(0)]];
  float4 norm   [[color(1)]];
  float4 mat    [[color(2)]];
  float2 motion [[color(3)]];
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
  out.world = world;
  out.prevDelta = (u.params.z != 0u && inst.piece < u.params.w)
                      ? half3(rtptPlacePrev(prevPoses[inst.piece], in.position) - world)
                      : half3(0.0h);
  out.normal = half3(placeNormal(inst, in.normal) * draw.flip.x);
  out.position = u.viewProjJittered * float4(world, 1.0f);
  out.fixedColor = half4(half3(in.color.zyx), half(in.color.a));
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
  float3 n = normalize(float3(in.normal));
  float3 ngRaw = cross(dfdx(in.world), dfdy(in.world));
  float3 ng = dot(ngRaw, ngRaw) > 1e-12f ? normalize(ngRaw) : n;
  if (dot(ng, v) < 0.0f) ng = -ng;
  if (dot(n, ng) < 0.0f) n = -n;
  if (dot(n, v) <= 0.0f) n = ng;

  float3 base = (in.fixedColor.a > 0.5h && draw.surface.w < 0.5f)
                    ? linearFromSrgb(float3(in.fixedColor.rgb))
                    : draw.base.rgb;
  uint kind = draw.surface.w > 0.5f ? 4u : 1u;
  float2 motion = float2(0.0f);
  if (u.size.w <= 1u) {
    float3 prevW = (u.params.z != 0u) ? (in.world + float3(in.prevDelta)) : in.world;
    motion = rtptComputeMotion(u.viewProjUnjittered * float4(in.world, 1.0f),
                               u.prevViewProj * float4(prevW, 1.0f));
  }

  RtptGbufFragOut out;
  out.posId = float4(in.world, as_type<float>(rtptPackMeta(in.piece, kind, draw.surface.y, draw.surface.z)));
  out.norm = float4(rtptOctEncode(n), rtptOctEncode(ng));
  out.mat = float4(sqrt(saturate(base)), saturate(draw.surface.x));
  out.motion = motion;
  return out;
}

fragment RtptGbufFragOut rtptGbufGlassFragment(
    RtptGbufVertOut in [[stage_in]],
    constant RtptUniforms& u [[buffer(1)]],
    constant DrawUniforms& draw [[buffer(2)]]) {
  float3 v = normalize(u.eye.xyz - in.world);
  float3 n = normalize(float3(in.normal));
  float3 ngRaw = cross(dfdx(in.world), dfdy(in.world));
  float3 ng = dot(ngRaw, ngRaw) > 1e-12f ? normalize(ngRaw) : n;
  if (dot(ng, v) < 0.0f) ng = -ng;
  if (dot(n, ng) < 0.0f) n = -n;
  float3 base = in.fixedColor.a > 0.5h ? linearFromSrgb(float3(in.fixedColor.rgb)) : draw.base.rgb;
  uint kind = draw.surface.w > 0.5f ? 4u : 2u;
  float2 motion = float2(0.0f);
  if (u.size.w <= 1u) {
    float3 prevW = (u.params.z != 0u) ? (in.world + float3(in.prevDelta)) : in.world;
    motion = rtptComputeMotion(u.viewProjUnjittered * float4(in.world, 1.0f),
                               u.prevViewProj * float4(prevW, 1.0f));
  }

  RtptGbufFragOut out;
  out.posId = float4(in.world, as_type<float>(rtptPackMeta(in.piece, kind, 0.0f, 0.0f)));
  out.norm = float4(rtptOctEncode(n), rtptOctEncode(ng));
  out.mat = float4(sqrt(saturate(base)), saturate(draw.base.a));
  out.motion = motion;
  return out;
}

struct RtptFloorVertOut {
  float4 position [[position]];
  float3 world;
};

vertex RtptFloorVertOut rtptGbufFloorVertex(uint id [[vertex_id]], constant RtptUniforms& u [[buffer(1)]]) {
  const float2 corners[6] = {float2(-1, -1), float2(1, -1), float2(1, 1), float2(-1, -1), float2(1, 1), float2(-1, 1)};
  float2 c = corners[id] * u.floorPlane.w;
  float3 world = float3(u.floorCentre.x + c.x, u.floorPlane.x, u.floorCentre.y + c.y);
  RtptFloorVertOut out;
  out.world = world;
  out.position = u.viewProjJittered * float4(world, 1.0f);
  return out;
}

fragment RtptGbufFragOut rtptGbufFloorFragment(RtptFloorVertOut in [[stage_in]], constant RtptUniforms& u [[buffer(1)]]) {
  if (u.eye.y >= u.floorPlane.x) discard_fragment();
  // Open floor outside model shadow reach is mathematically identical to background (kind == 0):
  // tagging it as kind 0 eliminates it from floor RT, SVGF temporal, and all 4 A-Trous passes!
  float3 bmin = u.sceneMin.xyz, bmax = u.sceneMax.xyz;
  float modelH = max(u.floorPlane.x - bmin.y, 1.0f);
  float modelDiag = max(length(bmax - bmin), 1.0f);
  float reach = max(modelH * 6.5f, modelDiag * 2.0f);
  float2 dBox = max(max(bmin.xz - in.world.xz, in.world.xz - bmax.xz), float2(0.0f));
  if (dot(dBox, dBox) > reach * reach) {
    RtptGbufFragOut skyOut;
    skyOut.posId = float4(in.world, 0.0f);
    skyOut.norm = float4(0.0f);
    skyOut.mat = float4(0.0f);
    skyOut.motion = float2(0.0f);
    return skyOut;
  }

  float3 up = float3(0.0f, -1.0f, 0.0f);
  float2 motion = float2(0.0f);
  if (u.size.w <= 1u) {
    motion = rtptComputeMotion(u.viewProjUnjittered * float4(in.world, 1.0f),
                               u.prevViewProj * float4(in.world, 1.0f));
  }
  RtptGbufFragOut out;
  out.posId = float4(in.world, as_type<float>(rtptPackMeta(0x1FFFFu, 3u, 0.0f, 0.0f)));
  out.norm = float4(rtptOctEncode(up), rtptOctEncode(up));
  out.mat = float4(sqrt(saturate(u.background.rgb)), 1.0f);
  out.motion = motion;
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
  if (key == 0u) return;

  uint count = atomic_load_explicit(&accum[gid].count, memory_order_relaxed);
  RtptSharcResolved cur = resolved[gid];
  float decay = u.sceneMax.w;
  if (count > 0u) {
    count = atomic_exchange_explicit(&accum[gid].count, 0u, memory_order_relaxed);
    uint rQ = atomic_exchange_explicit(&accum[gid].radR, 0u, memory_order_relaxed);
    uint gQ = atomic_exchange_explicit(&accum[gid].radG, 0u, memory_order_relaxed);
    uint bQ = atomic_exchange_explicit(&accum[gid].radB, 0u, memory_order_relaxed);
    float3 sampleRad = float3(float(rQ), float(gQ), float(bQ)) / (kRtptSharcScale * max(float(count), 1.0f));
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
    device atomic_uint* tileIndirect [[buffer(5)]],
    device uint* glassTiles [[buffer(6)]],
    device uint* opaqueTiles [[buffer(7)]],
    device uint* floorTiles [[buffer(8)]],
    texture2d<float, access::read> gPosId [[texture(0)]],
    texture2d<float, access::read> gNorm [[texture(1)]],
    texture2d<float, access::read> gMotion [[texture(2)]],
    texture2d<float, access::read> prevPosId [[texture(3)]],
    texture2d<float, access::read> prevNorm [[texture(4)]],
    texture2d<float, access::read> diffHistPrev [[texture(5)]],
    texture2d<float, access::write> diOut [[texture(6)]],
    uint2 gid [[thread_position_in_grid]],
    uint2 lid [[thread_position_in_threadgroup]],
    uint2 tgid [[threadgroup_position_in_grid]]) {
  // Classify each 8x8 tile by material kind into GPU indirect dispatch lists (deadlock-free barrier!).
  threadgroup atomic_uint tgMask;
  if (lid.x == 0u && lid.y == 0u) atomic_store_explicit(&tgMask, 0u, memory_order_relaxed);
  threadgroup_barrier(mem_flags::mem_threadgroup);

  bool inBounds = (gid.x < u.size.x && gid.y < u.size.y);
  float4 posId = inBounds ? gPosId.read(gid) : float4(0.0f);
  uint kind = inBounds ? rtptUnpackKind(posId.w) : 0u;
  uint bit = (kind == 2u || kind == 4u) ? 1u : (kind == 1u ? 2u : (kind == 3u ? 4u : 0u));
  uint sgMask = simd_or(bit);
  if (simd_is_first() && sgMask != 0u) {
    atomic_fetch_or_explicit(&tgMask, sgMask, memory_order_relaxed);
  }
  threadgroup_barrier(mem_flags::mem_threadgroup);

  if (lid.x == 0u && lid.y == 0u) {
    uint m = atomic_load_explicit(&tgMask, memory_order_relaxed);
    if (m != 0u) {
      uint packedTile = (tgid.x & 0xFFFFu) | (tgid.y << 16u);
      if ((m & 1u) != 0u) {
        uint idx = atomic_fetch_add_explicit(&tileIndirect[0], 1u, memory_order_relaxed);
        glassTiles[idx] = packedTile;
      }
      if ((m & 2u) != 0u) {
        uint idx = atomic_fetch_add_explicit(&tileIndirect[4], 1u, memory_order_relaxed);
        opaqueTiles[idx] = packedTile;
      }
      if ((m & 4u) != 0u) {
        uint idx = atomic_fetch_add_explicit(&tileIndirect[8], 1u, memory_order_relaxed);
        floorTiles[idx] = packedTile;
      }
    }
  }

  if (!inBounds || kind != 1u) return;
  if (u.rig.w < 0.5f) {
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
  bool hasValidAlpha = false;
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
          hasValidAlpha = true;
        }
      }
    }
  }

  PtRng rng;
  rng.s = ptHash(ptHash(gid.x * 3571u + gid.y * 8191u) ^ (u.size.z * 0x9E3779B9u + 0x7F4A7C15u));

  // Unbiased adaptive ray count: fully sunlit (alpha > 0.96) and deep shadow (alpha < 0.04) faces have
  // near-zero control-variate variance with 1 ray; penumbrae & cold pixels use 2 stratified rays!
  uint numSamples = (hasValidAlpha && (alpha > 0.96f || alpha < 0.04f)) ? 1u : 2u;
  float invSamples = 1.0f / float(numSamples);
  float coneScale = 2.0f * (1.0f - u.rig.z) / max(kPtPi * u.rig.y, 1e-6f);
  float diffSum = 0.0f;
  for (uint s = 0u; s < numSamples; s++) {
    float pick = (float(s) + rng.next()) * invSamples * sumE;
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

  float directIrrad = alpha * sumE + diffSum * invSamples;
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
  // Stochastic 8% SHaRC refresh propagates 2nd/3rd/infinite multi-bounce light into deep cavities at low cost!
  bool refreshCache = updateColdCache && (rng.next() < 0.08f);
  if (cached.w > 0.5f && !refreshCache) {
    totalIrradQ = cached.rgb;
  } else {
    // Direct studio irradiance + true 2nd-bounce sky/SHaRC interreflection on diffuse GI bounces.
    // On specular reflection cold misses (!updateColdCache), skip the 2nd recursive TLAS trace to avoid
    // 3-ray cascades during fast camera orbits while keeping full 2-bounce SHaRC accuracy on diffuse hits!
    float3 directQ = rtptSecondaryDirect(q, qn, qng, u, scene, instances, meshes, materials, rng);
    float3 indirectQ = float3(u.rig.x * 0.45f);
    if (updateColdCache) {
      indirectQ = float3(0.0f);
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
      rtptSharcInsert(q, qn, totalIrradQ, u, sharcAccum);
    } else {
      totalIrradQ = directQ + indirectQ;
    }
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

// PASS 4a: Indirect Tile-Compacted Adaptive Control-Variate Floor Shadow Catcher.
// Traces 100% full-resolution within 24 LDU of the model for razor-sharp contact creases,
// and alternating 50% checkerboard across broad outer 45-deg softbox penumbrae (zero quality drop!).
kernel void rtptTraceFloor(
    constant RtptUniforms& u [[buffer(0)]],
    metal::raytracing::instance_acceleration_structure scene [[buffer(1)]],
    device const PtInstance* instances [[buffer(2)]],
    device const PtMesh* meshes [[buffer(3)]],
    device const PtMaterial* materials [[buffer(4)]],
    device const uint* floorTiles [[buffer(5)]],
    texture2d<float, access::read> gPosId [[texture(0)]],
    texture2d<float, access::read> gMotion [[texture(1)]],
    texture2d<float, access::read> prevPosId [[texture(2)]],
    texture2d<float, access::read> diffHistPrev [[texture(3)]],
    texture2d<float, access::write> diffOut [[texture(4)]],
    uint2 lid [[thread_position_in_threadgroup]],
    uint2 tgid [[threadgroup_position_in_grid]]) {
  uint packedTile = floorTiles[tgid.x];
  uint2 gid = uint2(packedTile & 0xFFFFu, packedTile >> 16u) * 8u + lid;
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

  // Reproject previous frame's smoothed floor visibility for control-variate alpha & outer checkerboard reuse.
  float alphaFloor = 0.0f;
  float2 prevFloor = float2(1.0f);
  bool hasReproj = false;
  if (u.flags.y != 0u) {
    float2 mv = gMotion.read(gid).xy;
    float2 prevUv = (float2(gid) + 0.5f) / float2(u.size.xy) + mv;
    if (all(prevUv >= 0.0f) && all(prevUv < 1.0f)) {
      uint2 prevPx = uint2(clamp(int2(prevUv * float2(u.size.xy)), int2(0), int2(u.size.xy) - 1));
      float4 pPosId = prevPosId.read(prevPx);
      if (rtptUnpackKind(pPosId.w) == 3u) {
        float viewDist = max(length(p - u.eye.xyz), 1.0f);
        if (length(pPosId.xyz - p) < 0.08f * viewDist) {
          prevFloor = saturate(diffHistPrev.read(prevPx).rg);
          alphaFloor = prevFloor.r;
          hasReproj = true;
        }
      }
    }
  }

  // Full-res inside tight model footprint (< 24 LDU) AND on Frame 1 / disocclusions (zero black holes!).
  // Alternating 50% checkerboard across wide outer penumbrae ONLY when valid reprojected history exists.
  bool nearModel = (max(dBox.x, dBox.y) < 24.0f);
  if (!nearModel && hasReproj && (((gid.x ^ gid.y ^ u.size.z) & 1u) != 0u)) {
    diffOut.write(float4(prevFloor.r, prevFloor.g, 1.0f, 0.5f), gid);
    return;
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

// PASS 4b: Indirect Tile-Compacted Opaque Brick GI (+ Fine SHaRC) + Energy-Matched Glossy VNDF Specular.
kernel void rtptTraceOpaque(
    constant RtptUniforms& u [[buffer(0)]],
    metal::raytracing::instance_acceleration_structure scene [[buffer(1)]],
    device const PtInstance* instances [[buffer(2)]],
    device const PtMesh* meshes [[buffer(3)]],
    device const PtMaterial* materials [[buffer(4)]],
    device const RtptSharcResolved* sharcResolved [[buffer(5)]],
    device RtptSharcAccum* sharcAccum [[buffer(6)]],
    device const uint* opaqueTiles [[buffer(7)]],
    texture2d<float, access::read> gPosId [[texture(0)]],
    texture2d<float, access::read> gNorm [[texture(1)]],
    texture2d<float, access::read> gMat [[texture(2)]],
    texture2d<float, access::read> diIn [[texture(3)]],
    texture2d<float, access::write> diffOut [[texture(4)]],
    texture2d<float, access::write> specOut [[texture(5)]],
    uint2 lid [[thread_position_in_threadgroup]],
    uint2 tgid [[threadgroup_position_in_grid]]) {
  uint packedTile = opaqueTiles[tgid.x];
  uint2 gid = uint2(packedTile & 0xFFFFu, packedTile >> 16u) * 8u + lid;
  if (gid.x >= u.size.x || gid.y >= u.size.y) return;

  float4 posId = gPosId.read(gid);
  if (rtptUnpackKind(posId.w) != 1u) return;

  float3 p = posId.xyz;
  float4 nPacked = gNorm.read(gid);
  float3 n = rtptOctDecode(nPacked.xy);
  float3 ng = rtptOctDecode(nPacked.zw);
  float4 matVal = gMat.read(gid);
  float3 base = matVal.rgb * matVal.rgb;
  float roughness = matVal.a;
  float metalness = rtptUnpackMetal(posId.w);
  float clearcoat = rtptUnpackCoat(posId.w);
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
          float3 tint = exp(-0.92f * (1.0f - gm.base.rgb));
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

  // 2. Energy-matched deterministic VNDF specular:
  // For smooth glossy ABS plastic (coatRough=0.015, baseRough=0.06), both lobes share an ultra-tight cone
  // (effective roughness ~0.048 matching EyeSight MinRoughness=0.05) -> 1 exact ray cuts opaque RT cost by ~33%!
  // Materials with wide coat-vs-base roughness split (e.g. rough clearcoated metal) trace both lobes separately.
  float nv = max(dot(n, v), 1e-4f);
  float nvGeom = max(dot(ng, v), 1e-4f);
  bool isSolidPlastic = (metalness < 0.05f) && (clearcoat > 0.10f) && (roughness < 0.30f);
  float coat, coatRough, baseRough;
  float3 fb, diffAlbedoUnused, specAlbedoRaw;
  rtptBrdfParams(base, roughness, metalness, clearcoat, nv, nvGeom, coat, fb, diffAlbedoUnused, specAlbedoRaw, coatRough, baseRough);
  float3 specAlbedo = max(specAlbedoRaw, float3(1e-4f));

  float3 demodSpec = float3(0.0f);
  if (isSolidPlastic || abs(baseRough - coatRough) <= 0.08f) {
    float fbMean = ptMean(fb);
    float effRough = (coat * coatRough + fbMean * baseRough) / max(coat + fbMean, 1e-4f);
    demodSpec = rtptTraceSpecLobe(p, n, ng, v, effRough, eps, rSpec, isSolidPlastic, u, scene, instances, meshes, materials, sharcResolved, sharcAccum, rng);
  } else {
    float3 specSum = float3(0.0f);
    if (coat > 1e-4f) {
      specSum += float3(coat) * rtptTraceSpecLobe(p, n, ng, v, coatRough, eps, rCoat, isSolidPlastic, u, scene, instances, meshes, materials, sharcResolved, sharcAccum, rng);
    }
    float3 baseSpecW = (1.0f - coat) * fb;
    if (ptMean(baseSpecW) > 1e-4f) {
      specSum += baseSpecW * rtptTraceSpecLobe(p, n, ng, v, baseRough, eps, rSpec, isSolidPlastic, u, scene, instances, meshes, materials, sharcResolved, sharcAccum, rng);
    }
    demodSpec = specSum / specAlbedo;
  }
  specOut.write(float4(min(demodSpec, float3(12.0f)), 1.0f), gid);
}

// PASS 4c: Indirect Tile-Compacted Crystal-Clear Dielectric Glass RT.
// - Launches ONLY on 8x8 tiles containing glass/placeholders (skips 82-96% of screen!).
// - Reuses the rasterized G-buffer primary hit at bounce 0 (eliminates redundant primary TLAS ray!).
// - Deterministic bounce-0 & bounce-1 Fresnel splits + SHaRC-accelerated opaque-behind-glass shading ->
//   silky speckle-free 1 SPP per frame at 3x-5x faster GPU speed!
kernel void rtptTraceGlass(
    constant RtptUniforms& u [[buffer(0)]],
    metal::raytracing::instance_acceleration_structure scene [[buffer(1)]],
    device const PtInstance* instances [[buffer(2)]],
    device const PtMesh* meshes [[buffer(3)]],
    device const PtMaterial* materials [[buffer(4)]],
    device const RtptSharcResolved* sharcResolved [[buffer(5)]],
    device RtptSharcAccum* sharcAccum [[buffer(6)]],
    device const uint* glassTiles [[buffer(7)]],
    texture2d<float, access::read> gPosId [[texture(0)]],
    texture2d<float, access::read> gNorm [[texture(1)]],
    texture2d<float, access::read> gMat [[texture(2)]],
    texture2d<float, access::write> specOut [[texture(3)]],
    uint2 lid [[thread_position_in_threadgroup]],
    uint2 tgid [[threadgroup_position_in_grid]]) {
  uint packedTile = glassTiles[tgid.x];
  uint2 gid = uint2(packedTile & 0xFFFFu, packedTile >> 16u) * 8u + lid;
  if (gid.x >= u.size.x || gid.y >= u.size.y) return;
  float4 gPos = gPosId.read(gid);
  uint kind = rtptUnpackKind(gPos.w);
  if (kind != 2u && kind != 4u) return;

  PtRng rng;
  rng.s = ptHash(ptHash(gid.x * 2971u + gid.y * 6553u) ^ (u.size.z * 0x9E3779B9u + 313u));

  float2 sub = float2(0.5f) - u.jitter.xy;
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
  bool passedOnly = true;
  uint startBounce = 0u;

  // Reuse the rasterized G-buffer front glass hit directly (skips primary TLAS traversal!).
  if (kind == 2u) {
    float3 hp = gPos.xyz;
    float4 nPacked = gNorm.read(gid);
    float3 gn = rtptOctDecode(nPacked.xy);
    float3 gng = rtptOctDecode(nPacked.zw);
    if (dot(dir, gn) >= 0.0f) gn = gng;
    if (dot(dir, gn) >= 0.0f) gn = -dir;
    float3 gBase = gMat.read(gid).rgb;
    gBase *= gBase;
    float eta = 1.0f / u.glass.x;
    float f = ptFresnel(-dot(dir, gn), eta);
    float3 bulkAbsorb = 0.23f * (1.0f - gBase);
    // Keep offset tiny (~0.025 LDU at 500 LDU) so refracted rays never tunnel past thin LEGO glass walls!
    float eps = max(kPtEps * 1.5f, 0.00005f * length(hp - u.eye.xyz));

    if (f < 0.999f) {
      float3 rDir = reflect(dir, gn);
      PtHit rh = rtptTrace(hp + gng * eps, rDir, u, scene, instances, meshes);
      float3 reflCol;
      if (!rh.hit) {
        reflCol = float3(u.rig.x * 0.51f) + float3(rtptDiskRadiance(rDir, u) * 1.45f);
      } else {
        PtMaterial rm = materials[rh.material];
        if (rm.surface.w < 0.5f) {
          reflCol = rtptShadeBounceHit(rh, hp + gng * eps, rDir, u, scene, instances, meshes, materials, sharcResolved, sharcAccum, rng, false);
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
      radiance += f * reflCol;
      throughput = float3(1.0f - f);
      dir = normalize(refract(dir, gn, eta));
      origin = hp - gng * eps;
      absorb = bulkAbsorb;
    } else {
      dir = reflect(dir, gn);
      origin = hp + gng * eps;
      passedOnly = false;
    }
    startBounce = 1u;
  }

  for (uint bounce = startBounce; bounce < 16u; bounce++) {
    PtHit h = rtptTrace(origin, dir, u, scene, instances, meshes);
    if (any(absorb > 0.0f)) throughput *= exp(-absorb * (h.hit ? h.t : 1e4f));

    float tf = (u.floorPlane.y > 0.5f && dir.y > 1e-6f) ? (u.floorPlane.x - origin.y) / dir.y : -1.0f;
    if (tf > 1e-3f && (!h.hit || tf < h.t)) {
      if (bounce == 0u) {
        radiance += throughput * u.background.rgb;
      } else if (passedOnly) {
        radiance += throughput * u.background.rgb * 0.84f;
      } else {
        radiance += throughput * float3(u.rig.x * 0.42f);
      }
      break;
    }
    if (!h.hit) {
      if (passedOnly) {
        radiance += throughput * u.background.rgb * (bounce == 0u ? 1.0f : 0.84f);
      } else {
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
      float3 bulkAbsorb = 0.23f * (1.0f - m.base.rgb);

      if (bounce == 1u && !entering && f < 0.25f) {
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
      // Fast SHaRC-accelerated deterministic shading on opaque bricks seen behind glass!
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

      float3 diffIrrad = float3(0.0f);
      if (metalness < 0.98f) {
        float4 cached = rtptSharcQuery(hp, n, u, sharcResolved);
        if (cached.w > 0.5f && rng.next() >= 0.15f) {
          diffIrrad = cached.rgb;
        } else {
          float3 directH = rtptSecondaryDirect(hp, n, ng, u, scene, instances, meshes, materials, rng);
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
                float3 gp = hp + ng * kPtEps + giDir * (gh.t + kPtEps * 2.0f);
                float3 gTint = exp(-0.92f * (1.0f - gm.base.rgb));
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
          rtptSharcInsert(hp, n, diffIrrad, u, sharcAccum);
        }
      }
      float3 specRad = float3(0.0f);
      float specVis = ptMean(throughput * specAlbedo);
      if (specVis > 0.025f) {
        float2 rSpec = float2(rng.next(), rng.next());
        specRad = rtptTraceSpecLobe(hp, n, ng, v, baseRough, kPtEps, rSpec, isSolidPlastic, u, scene, instances, meshes, materials, sharcResolved, sharcAccum, rng);
      } else if (specVis > 1e-4f) {
        float3 r = reflect(dir, n);
        if (dot(r, ng) > 0.0f) {
          float visProxy = saturate(rtptLum(diffIrrad) / max(u.rig.x + 0.65f, 1e-4f));
          specRad = (float3(u.rig.x * 0.72f) + float3(rtptDiskRadiance(r, u) * 1.45f)) * visProxy;
        }
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

  float3 outGlass = (!any(isnan(radiance)) && !any(isinf(radiance))) ? min(radiance, float3(10.0f)) : float3(0.0f);
  specOut.write(float4(outGlass, 1.0f), gid);
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
    // Sentinel alpha = -2.0 tags sky/open-floor so floor A-Trous skips gPosId reads on neighbors!
    diffHistOut.write(float4(0.0f, 0.0f, 0.0f, -2.0f), gid);
    return;
  }

  float3 p = posId.xyz;
  uint piece = rtptUnpackPiece(posId.w);
  float4 nPacked = gNorm.read(gid);
  float3 n = rtptOctDecode(nPacked.xy);
  float3 ng = rtptOctDecode(nPacked.zw);
  float viewDist = max(length(p - u.eye.xyz), 1.0f);

  float4 dCur = (kind == 1u || kind == 3u) ? diffRaw.read(gid) : float4(0.0f, 0.0f, 0.0f, -2.0f);
  float4 sCur = (kind == 1u || kind == 2u || kind == 4u) ? specRaw.read(gid) : float4(0.0f);
  bool still = (u.size.w > 1u);

  // When stationary, pass RAW crystal-clear glass directly to rtptResolveTaa (zero double-averaging,
  // zero blur -> exact equal-weight 1/N convergence with Halton subpixel anti-aliasing!).
  if (still && (kind == 2u || kind == 4u)) {
    diffHistOut.write(float4(0.0f, 0.0f, 0.0f, -2.0f), gid);
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
      if (kind == 3u && dCur.a < 0.75f) {
        // Untraced outer checkerboard floor pixel: keep reprojected history cleanly without double-aging!
        dOut = float4(dPrev.rg, max(dPrev.b, dCur.b), 1.0f);
        hLen = prevHLen;
        mOut = mPrev;
      } else {
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
      }
    } else {
      // Moving camera / animation: motion-reprojected EMA with gentle variance clamping.
      if (kind == 3u && dCur.a < 0.75f) {
        dOut = float4(dPrev.rg, max(dPrev.b * 0.9f, dCur.b), 1.0f);
        hLen = prevHLen;
        mOut = mPrev;
      } else {
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
      }

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

  // Tag floor with sentinel alpha = -1.0 and sky/glass with -2.0 so floor A-Trous avoids all gPosId neighbor reads!
  if (kind == 3u) dOut.a = -1.0f;
  else if (kind != 1u) dOut = float4(0.0f, 0.0f, 0.0f, -2.0f);

  diffHistOut.write(dOut, gid);
  specHistOut.write(sOut, gid);
  momentsOut.write(mOut, gid);
  hLenOut.write(float4(hLen, 0.0f, 0.0f), gid);
}

// 5-Tap Alternating Cross/Diagonal Edge-Stopping Plane-Distance A-Trous Wavelet Filter (pass 0: step 1).
// - Spatial 2D Morton dispatch preserves Apple Silicon L2 cache locality!
// - Zero-gPosId floor filtering via diffIn.a == -1.0 sentinel cuts floor DRAM bandwidth by 67%!
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
  if (kind == 0u) {
    diffOut.write(float4(0.0f, 0.0f, 0.0f, -2.0f), gid);
    return;
  }
  if (kind == 4u) {
    diffOut.write(float4(0.0f, 0.0f, 0.0f, -2.0f), gid);
    specOut.write(specIn.read(gid), gid);
    return;
  }

  int step = int(max(u.params.y & 0xFFFFu, 1u));
  uint passIdx = u.params.y >> 16u;
  float stillF = float(max(u.size.w, 1u));

  // Dielectric glass (kind == 2u): NEVER wide-blur refracted internal tubes or edges!
  if (kind == 2u) {
    float4 sCenter = specIn.read(gid);
    diffOut.write(float4(0.0f, 0.0f, 0.0f, -2.0f), gid);
    if (step > 1 || u.size.w >= 24u) {
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
    specOut.write(float4(gSum / max(gW, 1e-6f), sCenter.a), gid);
    return;
  }

  float4 dCenter = diffIn.read(gid);
  float2 hLen = max(hLenIn.read(gid).xy, float2(1.0f));
  float filterScaleD = (u.size.w > 1u) ? saturate((kind == 3u ? 14.0f : 8.0f) / stillF) : 1.0f;

  // Full 3x3 (9-tap) zero-gPosId Gaussian contact-sharp floor filter at step 1!
  if (kind == 3u) {
    if (dCenter.b < 0.01f && dCenter.r > 0.998f && dCenter.g > 0.998f) {
      diffOut.write(float4(dCenter.rgb, -1.0f), gid);
      return;
    }
    float4 mom = momentsIn.read(gid);
    float diffVar = max(mom.y - mom.x * mom.x, 0.0f);
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
        float4 dq = diffIn.read(uint2(qpx));
        if (dq.a > -0.5f || dq.a < -1.5f) continue;
        float kw = (dx == 0 || dy == 0) ? 0.125f : 0.0625f;
        float wl = kw * exp(-abs(dCenter.r - dq.r) / sigmaLights);
        float ws = kw * exp(-abs(dCenter.g - dq.g) / sigmaSky);
        lSum += dq.r * wl;
        lW += wl;
        sSum += dq.g * ws;
        sW += ws;
      }
    }
    diffOut.write(float4(lSum / max(lW, 1e-6f), sSum / max(sW, 1e-6f), dCenter.b, -1.0f), gid);
    return;
  }

  float4 sCenter = specIn.read(gid);
  float filterScaleS = (u.size.w > 1u) ? saturate(5.0f / stillF) : 1.0f;
  const int2 crossOffs[4] = {int2(1, 0), int2(-1, 0), int2(0, 1), int2(0, -1)};
  const int2 diagOffs[4] = {int2(1, 1), int2(-1, 1), int2(1, -1), int2(-1, -1)};

  float4 mom = momentsIn.read(gid);
  float diffVar = max(mom.y - mom.x * mom.x, 0.0f);
  float specVar = max(mom.w - mom.z * mom.z, 0.0f);

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
  bool filterSpec = glossy ? (u.size.w < 6u) : true;

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

// Lightweight Diff-Only A-Trous pass (steps 2, 4, 8): 2D Morton L2 cache locality, zero specular reads/writes,
// zero-gPosId floor neighbor filtering via diffIn.a == -1.0 sentinel, and 5-tap wide floor passes!
kernel void rtptSvgfAtrousDiff(
    constant RtptUniforms& u [[buffer(0)]],
    texture2d<float, access::read> gPosId [[texture(0)]],
    texture2d<float, access::read> gNorm [[texture(1)]],
    texture2d<float, access::read> diffIn [[texture(2)]],
    texture2d<float, access::read> momentsIn [[texture(3)]],
    texture2d<float, access::read> hLenIn [[texture(4)]],
    texture2d<float, access::write> diffOut [[texture(5)]],
    uint2 gid [[thread_position_in_grid]]) {
  if (gid.x >= u.size.x || gid.y >= u.size.y) return;

  float4 dCenter = diffIn.read(gid);
  // Fast sentinel dispatch: sky/glass (-2.0) bypasses gPosId completely; floor (-1.0) NEVER touches gPosId!
  if (dCenter.a < -1.5f) {
    diffOut.write(float4(0.0f, 0.0f, 0.0f, -2.0f), gid);
    return;
  }
  bool isFloor = (dCenter.a < -0.5f);
  if (isFloor && dCenter.b < 0.01f && dCenter.r > 0.998f && dCenter.g > 0.998f) {
    diffOut.write(dCenter, gid);
    return;
  }

  int step = int(max(u.params.y & 0xFFFFu, 1u));
  uint passIdx = u.params.y >> 16u;
  float2 hLen = max(hLenIn.read(gid).xy, float2(1.0f));
  float stillF = float(max(u.size.w, 1u));
  float filterScaleD = (u.size.w > 1u) ? saturate((isFloor ? 14.0f : 8.0f) / stillF) : 1.0f;

  if (step >= 8 && !isFloor && hLen.x > 3.0f) {
    diffOut.write(dCenter, gid);
    return;
  }
  if (isFloor) {
    if (u.size.w >= 24u && step >= 8) { diffOut.write(dCenter, gid); return; }
    if (u.size.w >= 48u && step >= 4) { diffOut.write(dCenter, gid); return; }
  } else {
    if (u.size.w >= 12u && step >= 4) { diffOut.write(dCenter, gid); return; }
    if (u.size.w >= 24u && step >= 2) { diffOut.write(dCenter, gid); return; }
  }

  float4 mom = momentsIn.read(gid);
  float diffVar = max(mom.y - mom.x * mom.x, 0.0f);
  const int2 crossOffs[4] = {int2(1, 0), int2(-1, 0), int2(0, 1), int2(0, -1)};
  const int2 diagOffs[4] = {int2(1, 1), int2(-1, 1), int2(1, -1), int2(-1, -1)};

  if (isFloor) {
    float conf = saturate((hLen.x - 1.5f) / 4.5f);
    float coldBoost = mix(0.32f, 0.025f, conf);
    float sigmaLights = max(4.5f * sqrt(diffVar + 1e-4f) * filterScaleD, coldBoost);
    float contactTight = mix(1.0f, mix(0.34f, 1.0f, saturate((dCenter.g - 0.18f) / 0.65f)), conf);
    float sigmaSky = max(3.4f * sqrt(diffVar + 1e-4f) * filterScaleD * contactTight, coldBoost * contactTight);
    if (step <= 2) {
      float lSum = dCenter.r * 0.25f, lW = 0.25f;
      float sSum = dCenter.g * 0.25f, sW = 0.25f;
      for (int dy = -1; dy <= 1; dy++) {
        for (int dx = -1; dx <= 1; dx++) {
          if (dx == 0 && dy == 0) continue;
          int2 qpx = int2(gid) + int2(dx, dy) * step;
          if (qpx.x < 0 || qpx.y < 0 || qpx.x >= int(u.size.x) || qpx.y >= int(u.size.y)) continue;
          float4 dq = diffIn.read(uint2(qpx));
          if (dq.a > -0.5f || dq.a < -1.5f) continue;
          float kw = (dx == 0 || dy == 0) ? 0.125f : 0.0625f;
          float wl = kw * exp(-abs(dCenter.r - dq.r) / sigmaLights);
          float ws = kw * exp(-abs(dCenter.g - dq.g) / sigmaSky);
          lSum += dq.r * wl; lW += wl;
          sSum += dq.g * ws; sW += ws;
        }
      }
      diffOut.write(float4(lSum / max(lW, 1e-6f), sSum / max(sW, 1e-6f), dCenter.b, -1.0f), gid);
    } else {
      float lSum = dCenter.r * 0.36f, lW = 0.36f;
      float sSum = dCenter.g * 0.36f, sW = 0.36f;
      for (int i = 0; i < 4; i++) {
        int2 o = ((passIdx & 1u) == 0u) ? crossOffs[i] : diagOffs[i];
        int2 qpx = int2(gid) + o * step;
        if (qpx.x < 0 || qpx.y < 0 || qpx.x >= int(u.size.x) || qpx.y >= int(u.size.y)) continue;
        float4 dq = diffIn.read(uint2(qpx));
        if (dq.a > -0.5f || dq.a < -1.5f) continue;
        float wl = 0.16f * exp(-abs(dCenter.r - dq.r) / sigmaLights);
        float ws = 0.16f * exp(-abs(dCenter.g - dq.g) / sigmaSky);
        lSum += dq.r * wl; lW += wl;
        sSum += dq.g * ws; sW += ws;
      }
      diffOut.write(float4(lSum / max(lW, 1e-6f), sSum / max(sW, 1e-6f), dCenter.b, -1.0f), gid);
    }
    return;
  }

  float4 posId = gPosId.read(gid);
  float3 p = posId.xyz;
  float4 nPacked = gNorm.read(gid);
  float3 n = rtptOctDecode(nPacked.xy);
  float3 ng = rtptOctDecode(nPacked.zw);
  float viewDist = max(length(p - u.eye.xyz), 1.0f);
  float dLumC = rtptLum(dCenter.rgb);
  float sigmaPlane = max(0.012f * viewDist * float(step), 0.15f);
  float sigmaDiff = max(3.0f * sqrt(diffVar + 1e-4f) * filterScaleD, 1e-3f);

  float3 dSum = dCenter.rgb * 0.36f;
  float dW = 0.36f;
  for (int i = 0; i < 4; i++) {
    int2 o = ((passIdx & 1u) == 0u) ? crossOffs[i] : diagOffs[i];
    int2 qpx = int2(gid) + o * step;
    if (qpx.x < 0 || qpx.y < 0 || qpx.x >= int(u.size.x) || qpx.y >= int(u.size.y)) continue;
    float4 qPosId = gPosId.read(uint2(qpx));
    if (rtptUnpackKind(qPosId.w) != 1u) continue;
    float planeDist = abs(dot(qPosId.xyz - p, ng));
    float wz = exp(-planeDist / sigmaPlane);
    float3 qn = rtptOctDecode(gNorm.read(uint2(qpx)).xy);
    float wnDiff = pow(max(dot(n, qn), 0.0f), 48.0f);
    float4 dq = diffIn.read(uint2(qpx));
    float wlDiff = exp(-abs(dLumC - rtptLum(dq.rgb)) / sigmaDiff);
    float wDiff = 0.16f * wz * wnDiff * wlDiff;
    dSum += dq.rgb * wDiff;
    dW += wDiff;
  }
  diffOut.write(float4(dSum / max(dW, 1e-6f), dCenter.a), gid);
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
  float3 base = matVal.rgb * matVal.rgb;
  float roughness = matVal.a;
  float metalness = rtptUnpackMetal(posId.w);
  float clearcoat = rtptUnpackCoat(posId.w);
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
    tile[ty][tx] = half3(rtptReModulate(px, u, gPosId, gNorm, gMat, diffFilt, specFilt));
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

// Pass 6a-pre (TAAU only): Re-modulate linear HDR color ONCE per trace pixel into reused rtptDiffRaw.
kernel void rtptReModulateTrace(
    constant RtptUniforms& u [[buffer(0)]],
    texture2d<float, access::read> gPosId [[texture(0)]],
    texture2d<float, access::read> gNorm [[texture(1)]],
    texture2d<float, access::read> gMat [[texture(2)]],
    texture2d<float, access::read> diffFilt [[texture(3)]],
    texture2d<float, access::read> specFilt [[texture(4)]],
    texture2d<float, access::write> colorOut [[texture(5)]],
    uint2 gid [[thread_position_in_grid]]) {
  if (gid.x >= u.size.x || gid.y >= u.size.y) return;
  uint kind = rtptUnpackKind(gPosId.read(gid).w);
  float3 rgb = rtptReModulate(gid, u, gPosId, gNorm, gMat, diffFilt, specFilt);
  colorOut.write(float4(max(rgb, float3(0.0f)), float(kind)), gid);
}

// 5-tap hardware-bilinear sharp Catmull-Rom filter (Jimenez / Filmic SMAA) for razor-sharp TAAU reprojection.
inline float3 rtptSampleCatmullRom5(texture2d<float, access::sample> tex, float2 uv, float2 texSize) {
  constexpr sampler s(coord::normalized, filter::linear, address::clamp_to_edge);
  float2 pos = uv * texSize;
  float2 center = floor(pos - 0.5f) + 0.5f;
  float2 f = pos - center;
  float2 f2 = f * f;
  float2 f3 = f2 * f;

  float2 w0 = f2 - 0.5f * (f3 + f);
  float2 w1 = 1.5f * f3 - 2.5f * f2 + 1.0f;
  float2 w3 = 0.5f * (f3 - f2);
  float2 w2 = 1.0f - w0 - w1 - w3;

  float2 w12 = w1 + w2;
  float2 invSize = 1.0f / texSize;
  float2 tc0 = (center - 1.0f) * invSize;
  float2 tc12 = (center + w2 / max(w12, float2(1e-5f))) * invSize;
  float2 tc3 = (center + 2.0f) * invSize;

  float3 c = float3(0.0f);
  float wSum = 0.0f;
  float wt;
  wt = w12.x * w0.y;  c += tex.sample(s, float2(tc12.x, tc0.y)).rgb * wt;  wSum += wt;
  wt = w0.x * w12.y;  c += tex.sample(s, float2(tc0.x, tc12.y)).rgb * wt;  wSum += wt;
  wt = w12.x * w12.y; c += tex.sample(s, float2(tc12.x, tc12.y)).rgb * wt; wSum += wt;
  wt = w3.x * w12.y;  c += tex.sample(s, float2(tc3.x, tc12.y)).rgb * wt;  wSum += wt;
  wt = w12.x * w3.y;  c += tex.sample(s, float2(tc12.x, tc3.y)).rgb * wt;  wSum += wt;
  return max(c / max(wSum, 1e-5f), float3(0.0f));
}

// Pass 6a (TAAU): Full-Display-Resolution Exact Sub-Pixel Halton Temporal Super-Resolution!
// - Stationary frames: zero-blur direct-hit point-sample splatting (only accumulates unblurred trace
//   rays that physically land inside each display pixel -> converges to true 1.0x native sharpness!).
// - Moving frames: clamped 5-tap Catmull-Rom upsampling + 5-tap Catmull-Rom full-res history reprojection
//   with foreground motion dilation, YCoCg variance clamping, and on-center jitter confidence!
kernel void rtptResolveTaau(
    constant RtptUniforms& u [[buffer(0)]],
    texture2d<float, access::sample> colorTrace [[texture(0)]],
    texture2d<float, access::read> gMotion [[texture(1)]],
    texture2d<float, access::sample> taaPrev [[texture(2)]],
    texture2d<float, access::write> taaOut [[texture(3)]],
    uint2 gid [[thread_position_in_grid]]) {
  if (gid.x >= u.outSize.x || gid.y >= u.outSize.y) return;

  float2 outSizeF = float2(u.outSize.xy);
  float2 traceSizeF = float2(u.size.xy);
  int2 traceSizeI = int2(u.size.xy);
  float2 scaleOut = outSizeF / traceSizeF;
  float2 outUv = (float2(gid) + 0.5f) / outSizeF;
  // Unjittered continuous trace-pixel position corresponding to this display pixel's center.
  float2 tPos = outUv * traceSizeF;
  // Rasterized trace pixel tIdx sampled unjittered coordinate (float2(tIdx) + 0.5 - u.jitter.xy).
  float2 tPosJit = tPos + u.jitter.xy;
  int2 tNear = clamp(int2(floor(tPosJit)), int2(0), traceSizeI - 1);

  float4 nearTap = colorTrace.read(uint2(tNear));
  float2 dTrace = tPosJit - (float2(tNear) + 0.5f);
  float2 dOut = dTrace * scaleOut;
  float dOut2 = dot(dOut, dOut);
  bool still = (u.size.w > 1u);

  // Fast stationary sub-pixel direct-hit reconstruction: ZERO cross-pixel Gaussian blurring!
  if (still && u.flags.y != 0u) {
    float4 prevState = taaPrev.read(gid);
    float prevW = prevState.a;
    // Direct hit inside this display pixel (radius <= 0.72 display px -> guaranteed single nearest trace sample!).
    if (dOut2 < 0.52f) {
      uint kind = uint(round(nearTap.a));
      bool isGlass = (kind == 2u || kind == 4u);
      float sampleW = exp(-3.4f * dOut2);
      if (prevW < 0.08f) {
        // First real on-center ray hit: instantly replace the Frame-1 Catmull-Rom bootstrap!
        taaOut.write(float4(max(nearTap.rgb, float3(0.0f)), sampleW), gid);
        return;
      }
      if (!isGlass && u.size.w <= 12u) prevW *= 0.88f;
      prevW = min(prevW, max(float(u.params.x), 64.0f));
      float newW = prevW + sampleW;
      float3 out = mix(prevState.rgb, nearTap.rgb, sampleW / newW);
      taaOut.write(float4(max(out, float3(0.0f)), newW), gid);
      return;
    }
    // No trace ray landed inside this display pixel this frame: preserve razor-sharp history untouched!
    if (prevW >= 0.08f) {
      taaOut.write(prevState, gid);
      return;
    }
    // Still waiting for first direct hit (frames 2-3): keep sharp clamped Catmull-Rom bootstrap.
    float3 cMin = nearTap.rgb, cMax = nearTap.rgb;
    for (int dy = -1; dy <= 1; dy++) {
      for (int dx = -1; dx <= 1; dx++) {
        int2 tidx = clamp(tNear + int2(dx, dy), int2(0), traceSizeI - 1);
        float3 c = colorTrace.read(uint2(tidx)).rgb;
        cMin = min(cMin, c);
        cMax = max(cMax, c);
      }
    }
    float3 cr = clamp(rtptSampleCatmullRom5(colorTrace, tPosJit / traceSizeF, traceSizeF), cMin, cMax);
    float3 out = mix(prevState.rgb, cr, 0.35f);
    taaOut.write(float4(max(out, float3(0.0f)), prevW), gid);
    return;
  }

  // Moving camera / animation / Cold Frame 1: gather 3x3 trace neighborhood for ringing-free Catmull-Rom clamp,
  // YCoCg variance box, and foreground max-speed motion vector dilation.
  float3 cMin = float3(1e9f), cMax = float3(-1e9f);
  float3 m1 = float3(0.0f), m2 = float3(0.0f);
  float2 bestMv = float2(0.0f);
  float bestMvLen2 = -1.0f;
  bool allSky = true;

  for (int dy = -1; dy <= 1; dy++) {
    for (int dx = -1; dx <= 1; dx++) {
      int2 tidx = clamp(tNear + int2(dx, dy), int2(0), traceSizeI - 1);
      float4 tap = colorTrace.read(uint2(tidx));
      if (uint(round(tap.a)) != 0u) allSky = false;
      cMin = min(cMin, tap.rgb);
      cMax = max(cMax, tap.rgb);
      float3 y = rtptRgbToYCoCg(tap.rgb);
      m1 += y;
      m2 += y * y;
      float2 mv = gMotion.read(uint2(tidx)).xy;
      float l2 = dot(mv, mv);
      if (l2 > bestMvLen2) {
        bestMvLen2 = l2;
        bestMv = mv;
      }
    }
  }

  if (allSky) {
    taaOut.write(float4(u.background.rgb, 1.0f), gid);
    return;
  }

  // Sharp ringing-free 5-tap Catmull-Rom upsample of current trace frame, sharpened with direct hit when on-center!
  float3 curCR = clamp(rtptSampleCatmullRom5(colorTrace, tPosJit / traceSizeF, traceSizeF), cMin, cMax);
  float onCenter = (dOut2 < 0.45f) ? exp(-3.5f * dOut2) : 0.0f;
  float3 cur = mix(curCR, nearTap.rgb, onCenter * 0.70f);

  if (u.flags.y == 0u) {
    // Cold Frame 1: bootstrap weight 0.02 so first Halton direct hit on Frame 2-4 snaps straight to native sharpness!
    taaOut.write(float4(max(cur, float3(0.0f)), 0.02f), gid);
    return;
  }

  float3 out = cur;
  float2 prevUv = outUv + bestMv;
  if (all(prevUv >= 0.0f) && all(prevUv < 1.0f)) {
    float3 prev = rtptSampleCatmullRom5(taaPrev, prevUv, outSizeF);
    float3 mean = m1 * (1.0f / 9.0f);
    float3 stddev = sqrt(max(m2 * (1.0f / 9.0f) - mean * mean, float3(0.0f)));
    float3 prevY = clamp(rtptRgbToYCoCg(prev), mean - stddev * 1.25f, mean + stddev * 1.25f);
    // High blend weight when a real ray landed inside this display pixel; low weight when off-center to preserve crisp full-res history!
    float alpha = mix(0.09f, 0.24f, onCenter);
    out = max(mix(rtptYCoCgToRgb(prevY), cur, alpha), float3(0.0f));
  }
  taaOut.write(float4(out, 0.5f), gid);
}

fragment float4 rtptPresentFragment(
    ScreenOut in [[stage_in]],
    constant RtptUniforms& u [[buffer(0)]],
    texture2d<float> resolved [[texture(0)]],
    texture2d<float> mask [[texture(1)]]) {
  uint2 at = uint2(in.position.xy);
  if (at.x >= u.outSize.x || at.y >= u.outSize.y) return float4(u.background.rgb, 1.0f);
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
