// New-Era Universal Metal 3.1 Bindless Real-Time Path Tracing Pipeline (rtpt_world.metal).
// Supports native glTF 2.0 & Wavefront OBJ scenes: bindless PBR textures (PNG/JPG/TGA/BC1-BC7 DDS),
// tangent-space normal maps, metallic-roughness + clearcoat, true alpha-cutout foliage hardware RT,
// 16-bounce Beer-Lambert volume glass, HDRI / Nishita sky + sun, SHaRC multi-bounce GI,
// 32-byte Apple Silicon TBDR G-buffer, 2D-Morton SVGF, direct-hit Halton TAAU, and ACES filmic tone mapping.

constant uint kWrSharcCap = 262144u;
constant uint kWrSharcMask = 262143u;
constant float kWrSharcScale = 1024.0f;
constant float kWrPi = 3.14159265f;

// Must match WorldVertex in world_renderer.h (48 bytes).
struct WrVertex {
  packed_float3 p;
  packed_float3 n;
  packed_float2 uv;
  packed_float4 t;
};

// Must match WrMeshGpu in world_rtpt.mm.
struct WrMeshGpu {
  const device WrVertex* vertices;
  const device uint* indices;
  uint material;
  uint flags;  // bit 0: alphaMask, bit 1: doubleSided, bit 2: glass
};

// Must match WrInstanceGpu in world_rtpt.mm.
struct WrInstanceGpu {
  float4 model0, model1, model2, model3;
  float4 ncol0, ncol1, ncol2;  // inverse-transpose 3x3 columns for world normals
  uint meshIndex;
  uint material;
  uint flags;  // bit 0: alphaMask, bit 1: doubleSided, bit 2: glass
  uint pad0;
};

// Metal 3.1 Bindless Material Struct (exact 16-byte aligned layout matching WrMaterialGpuHost in world_rtpt.mm).
// Flags in attenuation.w (as uint bits):
//   bit 0: alphaMask    bit 1: alphaBlend   bit 2: doubleSided   bit 3: bc5Normal
//   bit 4: hasAlbedo    bit 5: hasNormal    bit 6: hasMr         bit 7: hasEmissive
//   bit 8: hasAlpha     bit 9: mrIsObjSpec  bit 10: isGlass      bit 11: thinGlass
struct WrMaterialGpu {
  texture2d<float> albedoTex;
  texture2d<float> normalTex;
  texture2d<float> mrTex;
  texture2d<float> emissiveTex;
  texture2d<float> alphaTex;
  texture2d<float> padTex;
  float4 baseColor;    // linear rgb + alpha
  float4 emissive;     // linear HDR rgb + unused
  float4 pbr;          // x: metallic, y: roughness, z: clearcoat, w: clearcoatRoughness
  float4 glass;        // x: transmission, y: ior, z: normalScale, w: alphaCutoff
  float4 attenuation;  // rgb: Beer-Lambert sigma_a per world unit, w: as_type<float>(flags)
  float4 meanAlbedo;   // rgb: precomputed linear mean albedo (zero-stall GI), w: unused
  float4 uvScale;      // xy: normalUvScale, zw: albedoUvScale (KHR_texture_transform)
};

// Must match WrUniformsGpu in world_rtpt.mm field for field.
struct WrUniforms {
  float4x4 viewProjJittered;
  float4x4 viewProjUnjittered;
  float4x4 prevViewProj;
  float4 eye;         // xyz: camera eye (+Y up), w: tan(fovY / 2)
  float4 right;       // xyz: camera right, w: aspect
  float4 up;          // xyz: camera up, w: orthoHalfHeight
  float4 forward;     // xyz: camera forward, w: near
  float4 sun;         // xyz: unit dir toward sun (+Y up), w: sunIntensity
  float4 sky;         // x: skyIntensity, y: sunCosRadius, z: exposure, w: sunSinSq
  float4 studioLights[4];  // xyz: dir, w: strength (when studioRig enabled)
  float4 background;  // rgb: studio background linear, w: floorY
  float4 sceneMin;    // xyz: world AABB min, w: sharcBaseCell
  float4 sceneMax;    // xyz: world AABB max, w: sharcDecay
  float4 jitter;      // xy: current Halton jitter, zw: prev jitter
  uint4 size;         // x: traceW, y: traceH, z: frameIdx, w: stillFrames
  uint4 flags;        // x: hasScene, y: hasHistory, z: hasAlphaMask, w: modeBits (b0:clay, b1:studioRig, b2:floor, b3:hasHdr)
  uint4 params;       // x: maxSamples, y: atrousStep | (passIdx << 16), z: instanceCount, w: unused
  uint4 outSize;      // x: displayW, y: displayH, z: taauActive, w: unused
};

struct WrSharcAccum {
  atomic_uint key;
  atomic_uint radR;
  atomic_uint radG;
  atomic_uint radB;
  atomic_uint count;
  uint pad0, pad1, pad2;
};

struct WrSharcResolved {
  float4 radSamples;
  uint4 keyAge;
};

// ---- Helpers ----

inline uint wrPackMeta(uint matId, uint kind, float metalness, float clearcoat) {
  uint mQ = uint(clamp(round(metalness * 15.0f), 0.0f, 15.0f));
  uint cQ = uint(clamp(round(clearcoat * 15.0f), 0.0f, 15.0f));
  return 0x20000000u | ((matId & 0x3FFFFu) << 11u) | (cQ << 7u) | (mQ << 3u) | (kind & 7u);
}
inline uint wrUnpackKind(float packed) { return as_type<uint>(packed) & 7u; }
inline float wrUnpackMetal(float packed) { return float((as_type<uint>(packed) >> 3u) & 0xFu) / 15.0f; }
inline float wrUnpackCoat(float packed) { return float((as_type<uint>(packed) >> 7u) & 0xFu) / 15.0f; }
inline uint wrUnpackMat(float packed) { return (as_type<uint>(packed) >> 11u) & 0x3FFFFu; }

inline float2 wrOctEncode(float3 n) {
  float invL1 = 1.0f / max(abs(n.x) + abs(n.y) + abs(n.z), 1e-8f);
  float2 p = n.xy * invL1;
  if (n.z < 0.0f) {
    float2 s = select(float2(-1.0f), float2(1.0f), p >= 0.0f);
    p = (1.0f - abs(p.yx)) * s;
  }
  return p;
}
inline float3 wrOctDecode(float2 e) {
  float3 n = float3(e.x, e.y, 1.0f - abs(e.x) - abs(e.y));
  if (n.z < 0.0f) {
    float2 s = select(float2(-1.0f), float2(1.0f), n.xy >= 0.0f);
    n.xy = (1.0f - abs(n.yx)) * s;
  }
  return normalize(n);
}

inline float wrLum(float3 c) { return dot(c, float3(0.2126f, 0.7152f, 0.0722f)); }

inline float2 wrR2(uint sampleIdx, uint2 pixel) {
  uint h = ptHash(pixel.x * 1664525u ^ ptHash(pixel.y * 1013904223u));
  float2 shift = float2(float(h & 0xFFFFu), float(h >> 16u)) * (1.0f / 65536.0f);
  float n = float(sampleIdx + 1u);
  return fract(shift + float2(fract(n * 0.7548776662466927f), fract(n * 0.5698402909980532f)));
}

inline float wrRayOffset(float3 p, constant WrUniforms& u) {
  float diag = max(length(u.sceneMax.xyz - u.sceneMin.xyz), 1.0f);
  return max(diag * 1.2e-5f, 0.0004f * length(p - u.eye.xyz));
}

// Physical daylight Nishita-inspired sky + optional equirectangular HDRI skybox.
inline float3 wrSampleSky(float3 dir, constant WrUniforms& u, texture2d<float, access::sample> envTex, bool includeSunDisk) {
  bool clay = (u.flags.w & 1u) != 0u;
  bool studioRig = (u.flags.w & 2u) != 0u;
  if (clay && !studioRig) {
    // Sculptural high-contrast neutral architectural daylight dome (matches clay AO reference!).
    float y = clamp(dir.y, -1.0f, 1.0f);
    float3 dome = mix(float3(0.30f, 0.31f, 0.33f), float3(0.62f, 0.63f, 0.65f), saturate(y * 0.65f + 0.35f));
    if (includeSunDisk && dot(dir, u.sun.xyz) >= u.sky.y) {
      float solidAngle = max(2.0f * kWrPi * (1.0f - u.sky.y), 1e-5f);
      dome += float3(1.0f, 0.99f, 0.97f) * min(3.1f / solidAngle, 12.0f);
    }
    return dome;
  }
  if (studioRig) {
    float3 col = float3(u.sky.x);
    if (includeSunDisk) {
      float invArea = 1.0f / max(kWrPi * u.sky.w, 1e-5f);
      for (int i = 0; i < 4; i++) {
        if (dot(dir, u.studioLights[i].xyz) >= u.sky.y) col += float3(u.studioLights[i].w * invArea);
      }
    }
    return col;
  }
  float3 skyCol;
  if ((u.flags.w & 8u) != 0u) {
    constexpr sampler envSamp(coord::normalized, filter::linear, address::repeat, t_address::clamp_to_edge);
    float phi = atan2(dir.z, dir.x);
    float theta = acos(clamp(dir.y, -1.0f, 1.0f));
    float2 uv = float2(phi * (0.5f / kWrPi) + 0.5f, theta / kWrPi);
    skyCol = min(envTex.sample(envSamp, uv, level(0.0f)).rgb, float3(24.0f)) * u.sky.x;
  } else {
    float y = clamp(dir.y, -1.0f, 1.0f);
    float3 horizon = float3(0.76f, 0.85f, 0.96f);
    float3 zenith = float3(0.16f, 0.38f, 0.82f);
    float3 ground = float3(0.18f, 0.17f, 0.16f);
    float t = pow(saturate(y), 0.52f);
    skyCol = (y >= 0.0f) ? mix(horizon, zenith, t) : mix(horizon * 0.55f, ground, saturate(-y * 3.0f));
    float sunCos = max(dot(dir, u.sun.xyz), 0.0f);
    skyCol += float3(1.0f, 0.90f, 0.72f) * (pow(sunCos, 12.0f) * 0.25f + pow(sunCos, 180.0f) * 0.85f);
    skyCol *= u.sky.x * 1.25f;
  }
  if (includeSunDisk && dot(dir, u.sun.xyz) >= u.sky.y) {
    float solidAngle = max(2.0f * kWrPi * (1.0f - u.sky.y), 1e-5f);
    skyCol += float3(1.0f, 0.95f, 0.86f) * min(u.sun.w / solidAngle, 28.0f);
  }
  return skyCol;
}

// ACES Filmic Tone Mapping (Narkowicz 2015 fit).
inline float3 wrAcesFilmic(float3 x) {
  float3 a = x * (2.51f * x + 0.03f);
  float3 b = x * (2.43f * x + 0.59f) + 0.14f;
  return saturate(a / max(b, float3(1e-5f)));
}

inline void wrBrdfParams(float3 base, float roughness, float metalness, float clearcoat, float nv,
                         thread float& outCoat, thread float3& outFb,
                         thread float3& outDiffAlbedo, thread float3& outSpecAlbedo) {
  outCoat = clearcoat * ptSchlick(0.04f, nv);
  outFb = ptSchlick3(mix(float3(0.04f), base, metalness), nv);
  float3 spec = min(float3(outCoat) + (1.0f - outCoat) * outFb, float3(1.0f));
  outSpecAlbedo = spec;
  outDiffAlbedo = base * (1.0f - metalness) * (1.0f - spec);
}

inline float3 wrSampleGgxVndf(float3 n, float3 v, float roughness, float u1, float u2, thread float& weight) {
  float a = max(roughness * roughness, 2e-3f);
  float a2 = a * a;
  float3 t, b;
  ptBasis(n, t, b);
  float3 V = float3(dot(v, t), dot(v, b), max(dot(v, n), 1e-4f));
  float3 Vh = normalize(float3(a * V.x, a * V.y, V.z));
  float phi = 2.0f * kWrPi * u1;
  float z = (1.0f - u2) * (1.0f + Vh.z) - Vh.z;
  float sinTheta = sqrt(saturate(1.0f - z * z));
  float3 Nh = float3(sinTheta * cos(phi), sinTheta * sin(phi), z) + Vh;
  float3 H = normalize(float3(a * Nh.x, a * Nh.y, max(Nh.z, 0.0f)));
  float3 h = normalize(t * H.x + b * H.y + n * H.z);
  float3 l = reflect(-v, h);
  float nl = dot(n, l);
  weight = nl > 0.0f ? ptSmithG1(nl, a2) : 0.0f;
  return l;
}

inline float wrSampleAlpha(device const WrMaterialGpu& m, float2 uv, float lod) {
  constexpr sampler s(coord::normalized, filter::linear, mip_filter::linear, address::repeat);
  uint flags = as_type<uint>(m.attenuation.w);
  if ((flags & 256u) != 0u) return m.alphaTex.sample(s, uv, level(lod)).r;
  if ((flags & 16u) != 0u) return m.albedoTex.sample(s, uv, level(lod)).a * m.baseColor.a;
  return m.baseColor.a;
}

inline void wrEvalMaterial(device const WrMaterialGpu& m, float2 uv, float lod, bool clay,
                           thread float3& outBase, thread float& outRough, thread float& outMetal,
                           thread float& outCoat, thread float3& outEmissive) {
  constexpr sampler s(coord::normalized, filter::linear, mip_filter::linear, address::repeat);
  uint flags = as_type<uint>(m.attenuation.w);
  outEmissive = float3(0.0f);
  if (clay) {
    outBase = float3(0.46f, 0.45f, 0.44f);
    outRough = 0.65f;
    outMetal = 0.0f;
    outCoat = 0.0f;
    return;
  }
  outBase = m.baseColor.rgb;
  if ((flags & 16u) != 0u) outBase *= m.albedoTex.sample(s, uv * m.uvScale.zw, level(lod)).rgb;
  outMetal = m.pbr.x;
  outRough = m.pbr.y;
  outCoat = m.pbr.z;
  if ((flags & 64u) != 0u) {
    float4 mr = m.mrTex.sample(s, uv, level(lod));
    if ((flags & 512u) != 0u) {
      // OBJ map_Ks / specular texture heuristic (Bistro & Sponza):
      float specLum = wrLum(mr.rgb);
      outRough = clamp(1.0f - specLum * 0.78f, 0.10f, 0.94f);
    } else {
      // glTF 2.0: G = roughness, B = metallic
      outRough = clamp(outRough * mr.g, 0.04f, 0.98f);
      outMetal = clamp(outMetal * mr.b, 0.0f, 1.0f);
    }
  }
  outEmissive = m.emissive.rgb;
  if ((flags & 128u) != 0u) {
    float3 eTex = m.emissiveTex.sample(s, uv, level(lod)).rgb;
    float3 eMul = (dot(outEmissive, outEmissive) > 1e-6f) ? outEmissive : float3(1.0f);
    outEmissive = eTex * eMul;
  }
}

// ============================================================================
// PASS 1: Rasterized 32-Byte/px Bindless PBR G-Buffer + Alpha-Cutout + Motion
// ============================================================================

struct WrGbufVertOut {
  float4 position [[position]];
  float3 world;
  half3 normal;
  half4 tangent;
  float2 uv;
  uint matId [[flat]];
};

struct WrGbufFragOut {
  float4 posId  [[color(0)]];
  float4 norm   [[color(1)]];
  float4 mat    [[color(2)]];
  float2 motion [[color(3)]];
};

inline float2 wrComputeMotion(float4 curClip, float4 prevClip) {
  float2 curNdc = curClip.xy / max(curClip.w, 1e-6f);
  float2 prevNdc = prevClip.xy / max(prevClip.w, 1e-6f);
  float2 curUv = float2(curNdc.x * 0.5f + 0.5f, 0.5f - curNdc.y * 0.5f);
  float2 prevUv = float2(prevNdc.x * 0.5f + 0.5f, 0.5f - prevNdc.y * 0.5f);
  return prevUv - curUv;
}

vertex WrGbufVertOut wrGbufVertex(
    const device WrVertex* vertices [[buffer(0)]],
    uint vid [[vertex_id]],
    constant WrUniforms& u [[buffer(1)]],
    constant WrInstanceGpu& inst [[buffer(2)]]) {
  WrVertex v = vertices[vid];
  float3 lp = float3(v.p);
  float4 wp4 = inst.model0 * lp.x + inst.model1 * lp.y + inst.model2 * lp.z + inst.model3;
  float3 wp = wp4.xyz;
  float3 wnRaw = inst.ncol0.xyz * v.n[0] + inst.ncol1.xyz * v.n[1] + inst.ncol2.xyz * v.n[2];
  float3 wn = dot(wnRaw, wnRaw) > 1e-12f ? normalize(wnRaw) : float3(0.0f, 1.0f, 0.0f);
  float3 wtRaw = inst.model0.xyz * v.t[0] + inst.model1.xyz * v.t[1] + inst.model2.xyz * v.t[2];
  float3 wt = dot(wtRaw, wtRaw) > 1e-12f ? normalize(wtRaw) : float3(1.0f, 0.0f, 0.0f);
  WrGbufVertOut out;
  out.world = wp;
  out.normal = half3(wn);
  out.tangent = half4(half3(wt), half(v.t[3]));
  out.uv = float2(v.uv);
  out.matId = inst.material;
  out.position = u.viewProjJittered * float4(wp, 1.0f);
  return out;
}

fragment WrGbufFragOut wrGbufOpaqueFragment(
    WrGbufVertOut in [[stage_in]],
    bool frontFacing [[front_facing]],
    constant WrUniforms& u [[buffer(1)]],
    const device WrMaterialGpu* materials [[buffer(2)]]) {
  device const WrMaterialGpu& m = materials[in.matId];
  uint mFlags = as_type<uint>(m.attenuation.w);

  // Hardware alpha-cutout for foliage, ivy, chains, fences!
  if ((mFlags & 1u) != 0u) {
    constexpr sampler s(coord::normalized, filter::linear, mip_filter::linear, address::repeat);
    float a = ((mFlags & 256u) != 0u) ? m.alphaTex.sample(s, in.uv).r
                                      : (((mFlags & 16u) != 0u) ? m.albedoTex.sample(s, in.uv).a * m.baseColor.a : m.baseColor.a);
    if (a < m.glass.w) discard_fragment();
  }

  float3 v = normalize(u.eye.xyz - in.world);
  float3 n = normalize(float3(in.normal));
  float3 ngRaw = cross(dfdx(in.world), dfdy(in.world));
  float3 ng = dot(ngRaw, ngRaw) > 1e-12f ? normalize(ngRaw) : n;
  if (dot(ng, v) < 0.0f) ng = -ng;
  if (!frontFacing && (mFlags & 4u) != 0u) n = -n;
  if (dot(n, ng) < 0.0f) n = -n;

  bool clay = (u.flags.w & 1u) != 0u;
  // Tangent-space normal mapping (supports RGB normal maps, BC5/DDNA 2-channel XY maps & KHR_texture_transform!).
  if (!clay && (mFlags & 32u) != 0u) {
    constexpr sampler s(coord::normalized, filter::linear, mip_filter::linear, address::repeat);
    float3 tRaw = float3(in.tangent.xyz) - n * dot(float3(in.tangent.xyz), n);
    if (dot(tRaw, tRaw) > 1e-8f) {
      float3 t = normalize(tRaw);
      float3 b = cross(n, t) * float(in.tangent.w);
      float4 nsamp = m.normalTex.sample(s, in.uv * m.uvScale.xy);
      float2 xy = nsamp.xy * 2.0f - 1.0f;
      float z = ((mFlags & 8u) != 0u) ? sqrt(saturate(1.0f - dot(xy, xy))) : (nsamp.z * 2.0f - 1.0f);
      // Clearcoat car paint has a smooth lacquer outer coat over micro-flake base normal!
      float nScale = m.glass.z * (1.0f - saturate(m.pbr.z) * 0.85f);
      float3 tn = normalize(float3(xy * nScale, max(z, 0.05f)));
      float3 mapped = normalize(t * tn.x + b * tn.y + n * tn.z);
      if (dot(mapped, v) > 0.02f) n = mapped;
    }
  }
  if (dot(n, v) <= 0.0f) n = ng;

  // Evaluate textured PBR albedo, roughness, metalness, clearcoat, emissive (mip-filtered by hardware gradients!).
  constexpr sampler s(coord::normalized, filter::linear, mip_filter::linear, address::repeat);
  float3 base = float3(0.46f, 0.45f, 0.44f);
  float rough = 0.65f, metal = 0.0f, coat = 0.0f;
  float3 em = float3(0.0f);
  if (!clay) {
    base = m.baseColor.rgb;
    if ((mFlags & 16u) != 0u) base *= m.albedoTex.sample(s, in.uv * m.uvScale.zw).rgb;
    metal = m.pbr.x;
    rough = m.pbr.y;
    coat = m.pbr.z;
    if ((mFlags & 64u) != 0u) {
      float4 mr = m.mrTex.sample(s, in.uv);
      if ((mFlags & 512u) != 0u) {
        rough = clamp(1.0f - wrLum(mr.rgb) * 0.78f, 0.10f, 0.94f);
      } else {
        rough = clamp(rough * mr.g, 0.04f, 0.98f);
        metal = clamp(metal * mr.b, 0.0f, 1.0f);
      }
    }
    em = m.emissive.rgb;
    if ((mFlags & 128u) != 0u) {
      float3 eTex = m.emissiveTex.sample(s, in.uv).rgb;
      float3 eMul = (dot(em, em) > 1e-6f) ? em : float3(1.0f);
      em = eTex * eMul;
    }
  }

  float2 motion = float2(0.0f);
  if (u.size.w <= 1u) {
    motion = wrComputeMotion(u.viewProjUnjittered * float4(in.world, 1.0f),
                             u.prevViewProj * float4(in.world, 1.0f));
  }

  WrGbufFragOut out;
  if (!clay && wrLum(em) > 0.08f) {
    // Emissive surface (lantern bulbs, neon cafe/pharmacy signs): exact full-res HDR glow in G-buffer!
    out.posId = float4(in.world, as_type<float>(wrPackMeta(in.matId, 4u, 0.0f, 0.0f)));
    out.norm = float4(wrOctEncode(n), wrOctEncode(ng));
    out.mat = float4(min(base * 0.18f + em, float3(24.0f)), 1.0f);
    out.motion = motion;
    return out;
  }
  out.posId = float4(in.world, as_type<float>(wrPackMeta(in.matId, 1u, metal, coat)));
  out.norm = float4(wrOctEncode(n), wrOctEncode(ng));
  out.mat = float4(sqrt(saturate(base)), saturate(rough));
  out.motion = motion;
  return out;
}

fragment WrGbufFragOut wrGbufGlassFragment(
    WrGbufVertOut in [[stage_in]],
    constant WrUniforms& u [[buffer(1)]],
    const device WrMaterialGpu* materials [[buffer(2)]]) {
  device const WrMaterialGpu& m = materials[in.matId];
  float3 v = normalize(u.eye.xyz - in.world);
  float3 n = normalize(float3(in.normal));
  float3 ngRaw = cross(dfdx(in.world), dfdy(in.world));
  float3 ng = dot(ngRaw, ngRaw) > 1e-12f ? normalize(ngRaw) : n;
  if (dot(ng, v) < 0.0f) ng = -ng;
  if (dot(n, ng) < 0.0f) n = -n;
  float2 motion = float2(0.0f);
  if (u.size.w <= 1u) {
    motion = wrComputeMotion(u.viewProjUnjittered * float4(in.world, 1.0f),
                             u.prevViewProj * float4(in.world, 1.0f));
  }
  WrGbufFragOut out;
  out.posId = float4(in.world, as_type<float>(wrPackMeta(in.matId, 2u, 0.0f, 0.0f)));
  out.norm = float4(wrOctEncode(n), wrOctEncode(ng));
  out.mat = float4(sqrt(saturate(m.baseColor.rgb)), saturate(m.pbr.y));
  out.motion = motion;
  return out;
}

struct WrFloorVertOut {
  float4 position [[position]];
  float3 world;
};

vertex WrFloorVertOut wrGbufFloorVertex(uint id [[vertex_id]], constant WrUniforms& u [[buffer(1)]]) {
  const float2 corners[6] = {float2(-1, -1), float2(1, -1), float2(1, 1), float2(-1, -1), float2(1, 1), float2(-1, 1)};
  float3 c3 = (u.sceneMin.xyz + u.sceneMax.xyz) * 0.5f;
  float diag = max(length(u.sceneMax.xyz - u.sceneMin.xyz), 1.0f);
  float2 c = corners[id] * (diag * 10.0f);
  float3 world = float3(c3.x + c.x, u.background.w, c3.z + c.y);
  WrFloorVertOut out;
  out.world = world;
  out.position = u.viewProjJittered * float4(world, 1.0f);
  return out;
}

fragment WrGbufFragOut wrGbufFloorFragment(WrFloorVertOut in [[stage_in]], constant WrUniforms& u [[buffer(1)]]) {
  if (u.eye.y <= u.background.w) discard_fragment();
  float3 bmin = u.sceneMin.xyz, bmax = u.sceneMax.xyz;
  float modelH = max(bmax.y - u.background.w, 1.0f);
  float modelDiag = max(length(bmax - bmin), 1.0f);
  float reach = max(modelH * 6.0f, modelDiag * 2.0f);
  float2 dBox = max(max(bmin.xz - in.world.xz, in.world.xz - bmax.xz), float2(0.0f));
  if (dot(dBox, dBox) > reach * reach) {
    WrGbufFragOut skyOut;
    skyOut.posId = float4(in.world, 0.0f);
    skyOut.norm = float4(0.0f);
    skyOut.mat = float4(0.0f);
    skyOut.motion = float2(0.0f);
    return skyOut;
  }
  float3 up = float3(0.0f, 1.0f, 0.0f);
  float2 motion = float2(0.0f);
  if (u.size.w <= 1u) {
    motion = wrComputeMotion(u.viewProjUnjittered * float4(in.world, 1.0f),
                             u.prevViewProj * float4(in.world, 1.0f));
  }
  WrGbufFragOut out;
  out.posId = float4(in.world, as_type<float>(wrPackMeta(0x3FFFFu, 3u, 0.0f, 0.0f)));
  out.norm = float4(wrOctEncode(up), wrOctEncode(up));
  out.mat = float4(sqrt(saturate(u.background.rgb)), 1.0f);
  out.motion = motion;
  return out;
}

// Fast Hardware Ray Tracing with Split Opaque/Alpha Instance Masks!
// Instance masks set on TLAS: bit 0 (0x01) = Opaque, bit 1 (0x02) = Alpha-Mask Foliage, bit 2 (0x04) = Glass.

struct WrHit {
  bool hit;
  float t;
  float3 ns;
  float3 ng;
  float2 uv;
  uint material;
};

inline WrHit wrFetchHit(
    float3 dir, float dist, uint instId, uint geomId, uint primId, float2 bc,
    device const WrInstanceGpu* instances, device const uint* geomMeshes, device const WrMeshGpu* meshes) {
  WrHit out;
  const device WrInstanceGpu& inst = instances[instId];
  const uint meshIdx = geomMeshes[inst.meshIndex + geomId];
  const device WrMeshGpu& mesh = meshes[meshIdx];
  const uint i0 = mesh.indices[primId * 3u + 0u];
  const uint i1 = mesh.indices[primId * 3u + 1u];
  const uint i2 = mesh.indices[primId * 3u + 2u];
  const device WrVertex& a = mesh.vertices[i0];
  const device WrVertex& b = mesh.vertices[i1];
  const device WrVertex& c = mesh.vertices[i2];
  float w0 = 1.0f - bc.x - bc.y;
  float3 n = float3(a.n) * w0 + float3(b.n) * bc.x + float3(c.n) * bc.y;
  float3 g = cross(float3(b.p) - float3(a.p), float3(c.p) - float3(a.p));
  float3 ns = inst.ncol0.xyz * n.x + inst.ncol1.xyz * n.y + inst.ncol2.xyz * n.z;
  float3 ng = inst.ncol0.xyz * g.x + inst.ncol1.xyz * g.y + inst.ncol2.xyz * g.z;
  out.hit = true;
  out.t = dist;
  out.ng = dot(ng, ng) > 1e-12f ? normalize(ng) : -dir;
  out.ns = dot(ns, ns) > 1e-12f ? normalize(ns) : out.ng;
  out.uv = float2(a.uv) * w0 + float2(b.uv) * bc.x + float2(c.uv) * bc.y;
  out.material = mesh.material;
  return out;
}

// Zero-branch single-intersect trace for smooth diffuse GI bounces (eliminates alpha-test register spill!).
inline WrHit wrTraceGi(float3 origin, float3 dir, float tMinInit, constant WrUniforms& u,
                       metal::raytracing::instance_acceleration_structure scene,
                       device const WrInstanceGpu* instances, device const uint* geomMeshes,
                       device const WrMeshGpu* meshes, uint mask = 0x03u) {
  WrHit out;
  out.hit = false;
  if (u.flags.x == 0u) return out;
  metal::raytracing::intersector<metal::raytracing::triangle_data, metal::raytracing::instancing> isect;
  isect.assume_geometry_type(metal::raytracing::geometry_type::triangle);
  isect.force_opacity(metal::raytracing::forced_opacity::opaque);
  metal::raytracing::ray r(origin, dir, tMinInit, INFINITY);
  auto res = isect.intersect(r, scene, mask);
  if (res.type != metal::raytracing::intersection_type::triangle) return out;
  return wrFetchHit(dir, res.distance, res.instance_id, res.geometry_id, res.primitive_id, res.triangle_barycentric_coord, instances, geomMeshes, meshes);
}

// Fast single-pass closest-hit trace over Unified Multi-Geometry BLASes (zero TLAS overlap!).
inline WrHit wrTrace(float3 origin, float3 dir, float tMinInit, constant WrUniforms& u,
                     metal::raytracing::instance_acceleration_structure scene,
                     device const WrInstanceGpu* instances, device const uint* geomMeshes,
                     device const WrMeshGpu* meshes, device const WrMaterialGpu* materials, uint mask = 0xFFu) {
  WrHit out;
  out.hit = false;
  if (u.flags.x == 0u) return out;
  metal::raytracing::intersector<metal::raytracing::triangle_data, metal::raytracing::instancing> isect;
  isect.assume_geometry_type(metal::raytracing::geometry_type::triangle);
  isect.force_opacity(metal::raytracing::forced_opacity::opaque);

  metal::raytracing::ray r(origin, dir, tMinInit, INFINITY);
  auto res = isect.intersect(r, scene, mask);
  if (res.type != metal::raytracing::intersection_type::triangle) return out;

  const device WrInstanceGpu& inst = instances[res.instance_id];
  const uint meshIdx = geomMeshes[inst.meshIndex + res.geometry_id];
  const device WrMeshGpu& mesh = meshes[meshIdx];
  if ((mesh.flags & 1u) != 0u) {
    const uint i0 = mesh.indices[res.primitive_id * 3u + 0u];
    const uint i1 = mesh.indices[res.primitive_id * 3u + 1u];
    const uint i2 = mesh.indices[res.primitive_id * 3u + 2u];
    const float2 bc = res.triangle_barycentric_coord;
    float2 uv = float2(mesh.vertices[i0].uv) * (1.0f - bc.x - bc.y) +
                float2(mesh.vertices[i1].uv) * bc.x + float2(mesh.vertices[i2].uv) * bc.y;
    device const WrMaterialGpu& m = materials[mesh.material];
    if (wrSampleAlpha(m, uv, 2.0f) < m.glass.w) {
      metal::raytracing::ray r2(origin, dir, res.distance + max(tMinInit, res.distance * 1e-4f), INFINITY);
      auto res2 = isect.intersect(r2, scene, mask & ~2u);
      if (res2.type != metal::raytracing::intersection_type::triangle) return out;
      return wrFetchHit(dir, res2.distance, res2.instance_id, res2.geometry_id, res2.primitive_id, res2.triangle_barycentric_coord, instances, geomMeshes, meshes);
    }
  }
  return wrFetchHit(dir, res.distance, res.instance_id, res.geometry_id, res.primitive_id, res.triangle_barycentric_coord, instances, geomMeshes, meshes);
}

// Ultra-fast split-mask hardware any-hit shadow ray over Unified Multi-Geometry BLASes!
inline float wrShadow(float3 origin, float3 dir, float tMinInit, constant WrUniforms& u,
                      metal::raytracing::instance_acceleration_structure scene,
                      device const WrInstanceGpu* instances, device const uint* geomMeshes,
                      device const WrMeshGpu* meshes, device const WrMaterialGpu* materials, bool testAlphaCutout = true) {
  if (u.flags.x == 0u) return 1.0f;
  metal::raytracing::intersector<metal::raytracing::triangle_data, metal::raytracing::instancing> anyIsect;
  anyIsect.assume_geometry_type(metal::raytracing::geometry_type::triangle);
  anyIsect.force_opacity(metal::raytracing::forced_opacity::opaque);
  anyIsect.accept_any_intersection(true);
  metal::raytracing::ray rOpaque(origin, dir, tMinInit, INFINITY);
  auto resO = anyIsect.intersect(rOpaque, scene, 0x01u);
  if (resO.type == metal::raytracing::intersection_type::triangle) return 0.0f;

  if (!testAlphaCutout || u.flags.z == 0u) return 1.0f;

  metal::raytracing::intersector<metal::raytracing::triangle_data, metal::raytracing::instancing> alphaIsect;
  alphaIsect.assume_geometry_type(metal::raytracing::geometry_type::triangle);
  alphaIsect.force_opacity(metal::raytracing::forced_opacity::opaque);
  float tMin = tMinInit;
  for (int iter = 0; iter < 3; iter++) {
    metal::raytracing::ray r(origin, dir, tMin, INFINITY);
    auto res = alphaIsect.intersect(r, scene, 0x02u);
    if (res.type != metal::raytracing::intersection_type::triangle) return 1.0f;
    const device WrInstanceGpu& inst = instances[res.instance_id];
    const uint meshIdx = geomMeshes[inst.meshIndex + res.geometry_id];
    const device WrMeshGpu& mesh = meshes[meshIdx];
    const uint i0 = mesh.indices[res.primitive_id * 3u + 0u];
    const uint i1 = mesh.indices[res.primitive_id * 3u + 1u];
    const uint i2 = mesh.indices[res.primitive_id * 3u + 2u];
    const float2 bc = res.triangle_barycentric_coord;
    float2 uv = float2(mesh.vertices[i0].uv) * (1.0f - bc.x - bc.y) +
                float2(mesh.vertices[i1].uv) * bc.x + float2(mesh.vertices[i2].uv) * bc.y;
    device const WrMaterialGpu& m = materials[mesh.material];
    if (wrSampleAlpha(m, uv, 1.0f) >= m.glass.w) return 0.0f;
    tMin = res.distance + max(tMinInit, res.distance * 2e-4f);
  }
  return 1.0f;
}

// ============================================================================
// Fine World-Space SHaRC Radiance Cache (Auto-Scaled for 10cm Watch to 150m Street!)
// ============================================================================

inline uint wrSharcLod(float3 p, float3 eye, float baseCell) {
  float dist = length(p - eye);
  float refDist = max(baseCell * 32.0f, 1.0f);
  return uint(clamp(int(floor(log2(max(dist / refDist, 1.0f)))), 0, 5));
}

inline void wrSharcHash(float3 p, float3 n, uint lod, float baseCell, thread uint& slot0, thread uint& tag) {
  float cellSize = baseCell * float(1u << lod);
  int3 cell = int3(floor(p / max(cellSize, 1e-4f)));
  int3 nb = clamp(int3(round(n * 1.5f)) + int3(2), int3(0), int3(4));
  uint nCode = uint(nb.x * 25 + nb.y * 5 + nb.z);
  uint h1 = ptHash(as_type<uint>(cell.x) * 73856093u ^ as_type<uint>(cell.y) * 19349663u ^
                   as_type<uint>(cell.z) * 83492791u ^ (nCode * 2654435761u) ^ (lod * 1597334677u));
  uint h2 = ptHash(as_type<uint>(cell.x) * 2971215073u ^ as_type<uint>(cell.y) * 480752697u ^
                   as_type<uint>(cell.z) * 1369778189u ^ ((nCode + 7u) * 374761393u) ^ ((lod + 13u) * 668265263u));
  slot0 = h1 & kWrSharcMask;
  tag = h2 | 1u;
}

inline void wrSharcInsert(float3 p, float3 n, float3 irrad, constant WrUniforms& u, device WrSharcAccum* accum) {
  uint lod = wrSharcLod(p, u.eye.xyz, u.sceneMin.w);
  uint slot0, tag;
  wrSharcHash(p, n, lod, u.sceneMin.w, slot0, tag);
  float3 cl = clamp(irrad, float3(0.0f), float3(32.0f));
  uint rQ = uint(cl.r * kWrSharcScale + 0.5f);
  uint gQ = uint(cl.g * kWrSharcScale + 0.5f);
  uint bQ = uint(cl.b * kWrSharcScale + 0.5f);
  for (uint probe = 0u; probe < 8u; probe++) {
    uint slot = (slot0 + probe) & kWrSharcMask;
    uint cur = atomic_load_explicit(&accum[slot].key, memory_order_relaxed);
    if (cur == 0u) atomic_compare_exchange_weak_explicit(&accum[slot].key, &cur, tag, memory_order_relaxed, memory_order_relaxed);
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

inline float4 wrSharcQuery(float3 p, float3 n, constant WrUniforms& u, device const WrSharcResolved* resolved) {
  uint lod = wrSharcLod(p, u.eye.xyz, u.sceneMin.w);
  uint slot0, tag;
  wrSharcHash(p, n, lod, u.sceneMin.w, slot0, tag);
  for (uint probe = 0u; probe < 8u; probe++) {
    uint slot = (slot0 + probe) & kWrSharcMask;
    uint k = resolved[slot].keyAge.x;
    if (k == 0u) return float4(0.0f);
    if (k == tag) {
      float4 rs = resolved[slot].radSamples;
      return rs.w > 0.5f ? float4(rs.rgb, 1.0f) : float4(0.0f);
    }
  }
  return float4(0.0f);
}

kernel void wrSharcResolve(
    constant WrUniforms& u [[buffer(0)]],
    device WrSharcAccum* accum [[buffer(1)]],
    device WrSharcResolved* resolved [[buffer(2)]],
    uint gid [[thread_position_in_grid]]) {
  if (gid >= kWrSharcCap) return;
  uint key = atomic_load_explicit(&accum[gid].key, memory_order_relaxed);
  if (key == 0u) return;
  uint count = atomic_load_explicit(&accum[gid].count, memory_order_relaxed);
  WrSharcResolved cur = resolved[gid];
  float decay = u.sceneMax.w;
  if (count > 0u) {
    count = atomic_exchange_explicit(&accum[gid].count, 0u, memory_order_relaxed);
    uint rQ = atomic_exchange_explicit(&accum[gid].radR, 0u, memory_order_relaxed);
    uint gQ = atomic_exchange_explicit(&accum[gid].radG, 0u, memory_order_relaxed);
    uint bQ = atomic_exchange_explicit(&accum[gid].radB, 0u, memory_order_relaxed);
    float3 sampleRad = float3(float(rQ), float(gQ), float(bQ)) / (kWrSharcScale * max(float(count), 1.0f));
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
    if (age > 48u) {
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
// PASS 3: Adaptive Control-Variate Direct Sun / Studio Lighting + 8x8 Tile Compaction
// ============================================================================

inline float3 wrSecondaryDirect(float3 q, float3 qn, float3 qng, float eps, constant WrUniforms& u,
                                metal::raytracing::instance_acceleration_structure scene,
                                device const WrInstanceGpu* instances, device const uint* geomMeshes,
                                device const WrMeshGpu* meshes, device const WrMaterialGpu* materials, thread PtRng& rng) {
  bool studioRig = (u.flags.w & 2u) != 0u;
  bool clay = (u.flags.w & 1u) != 0u;
  if (!studioRig) {
    float3 l = ptAround(u.sun.xyz, 1.0f - rng.next() * (1.0f - u.sky.y), 2.0f * kWrPi * rng.next());
    float nl = dot(qn, l);
    if (nl <= 0.0f || dot(qng, l) <= 0.0f) return float3(0.0f);
    // Secondary bounce shadow rays use pure opaque hardware any-hit (zero divergence, 10x faster!).
    float vis = wrShadow(q + qng * eps, l, eps, u, scene, instances, geomMeshes, meshes, materials, false);
    float sunPow = clay ? min(u.sun.w, 3.1f) : u.sun.w;
    float3 sunCol = clay ? float3(1.0f, 0.99f, 0.97f) : float3(1.0f, 0.96f, 0.89f);
    return sunCol * (vis * sunPow * nl / kWrPi);
  }
  float w[4], sumW = 0.0f;
  for (int i = 0; i < 4; i++) {
    w[i] = u.studioLights[i].w * rtptDiskLight(dot(qn, u.studioLights[i].xyz), u.sky.w);
    sumW += w[i];
  }
  if (sumW <= 1e-6f) return float3(0.0f);
  float pick = rng.next() * sumW;
  int idx = 0;
  while (idx < 3 && pick >= w[idx]) { pick -= w[idx]; idx++; }
  float3 l = ptAround(u.studioLights[idx].xyz, 1.0f - rng.next() * (1.0f - u.sky.y), 2.0f * kWrPi * rng.next());
  float nl = dot(qn, l);
  if (nl <= 0.0f || dot(qng, l) <= 0.0f) return float3(0.0f);
  float vis = wrShadow(q + qng * eps, l, eps, u, scene, instances, geomMeshes, meshes, materials, false);
  float coneScale = 2.0f * (1.0f - u.sky.y) / max(kWrPi * u.sky.w, 1e-6f);
  return float3(vis * u.studioLights[idx].w * nl * coneScale * (sumW / max(w[idx], 1e-6f)));
}

kernel void wrDirectPass(
    constant WrUniforms& u [[buffer(0)]],
    metal::raytracing::instance_acceleration_structure scene [[buffer(1)]],
    device const WrInstanceGpu* instances [[buffer(2)]],
    device const WrMeshGpu* meshes [[buffer(3)]],
    device const WrMaterialGpu* materials [[buffer(4)]],
    device atomic_uint* tileIndirect [[buffer(5)]],
    device uint* glassTiles [[buffer(6)]],
    device uint* opaqueTiles [[buffer(7)]],
    device uint* floorTiles [[buffer(8)]],
    device const uint* geomMeshes [[buffer(9)]],
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
  threadgroup atomic_uint tgMask;
  if (lid.x == 0u && lid.y == 0u) atomic_store_explicit(&tgMask, 0u, memory_order_relaxed);
  threadgroup_barrier(mem_flags::mem_threadgroup);

  bool inBounds = (gid.x < u.size.x && gid.y < u.size.y);
  float4 posId = inBounds ? gPosId.read(gid) : float4(0.0f);
  uint kind = inBounds ? wrUnpackKind(posId.w) : 0u;
  uint bit = (kind == 2u) ? 1u : (kind == 1u ? 2u : (kind == 3u ? 4u : 0u));
  uint sgMask = simd_or(bit);
  if (simd_is_first() && sgMask != 0u) atomic_fetch_or_explicit(&tgMask, sgMask, memory_order_relaxed);
  threadgroup_barrier(mem_flags::mem_threadgroup);

  if (lid.x == 0u && lid.y == 0u) {
    uint m = atomic_load_explicit(&tgMask, memory_order_relaxed);
    if (m != 0u) {
      uint packedTile = (tgid.x & 0xFFFFu) | (tgid.y << 16u);
      if ((m & 1u) != 0u) glassTiles[atomic_fetch_add_explicit(&tileIndirect[0], 1u, memory_order_relaxed)] = packedTile;
      if ((m & 2u) != 0u) opaqueTiles[atomic_fetch_add_explicit(&tileIndirect[4], 1u, memory_order_relaxed)] = packedTile;
      if ((m & 4u) != 0u) floorTiles[atomic_fetch_add_explicit(&tileIndirect[8], 1u, memory_order_relaxed)] = packedTile;
    }
  }

  if (!inBounds || kind != 1u) return;

  float3 p = posId.xyz;
  float4 nPacked = gNorm.read(gid);
  float3 n = wrOctDecode(nPacked.xy);
  float3 ng = wrOctDecode(nPacked.zw);
  float viewDist = max(length(p - u.eye.xyz), 1e-3f);
  float eps = wrRayOffset(p, u);
  bool studioRig = (u.flags.w & 2u) != 0u;

  float alpha = 0.0f;
  bool hasValidAlpha = false;
  if (u.flags.y != 0u) {
    float2 mv = gMotion.read(gid).xy;
    float2 prevUv = (float2(gid) + 0.5f) / float2(u.size.xy) + mv;
    if (all(prevUv >= 0.0f) && all(prevUv < 1.0f)) {
      uint2 prevPx = uint2(clamp(int2(prevUv * float2(u.size.xy)), int2(0), int2(u.size.xy) - 1));
      float4 pPosId = prevPosId.read(prevPx);
      if (wrUnpackKind(pPosId.w) == 1u) {
        float3 pn = wrOctDecode(prevNorm.read(prevPx).xy);
        if (dot(n, pn) > 0.88f && abs(dot(pPosId.xyz - p, ng)) < 0.035f * viewDist) {
          alpha = saturate(diffHistPrev.read(prevPx).a);
          hasValidAlpha = true;
        }
      }
    }
  }

  PtRng rng;
  rng.s = ptHash(ptHash(gid.x * 3571u + gid.y * 8191u) ^ (u.size.z * 0x9E3779B9u + 0x7F4A7C15u));

  if (!studioRig) {
    float nlSun = max(dot(n, u.sun.xyz), 0.0f);
    if (nlSun <= 1e-5f) {
      diOut.write(float4(0.0f, 0.0f, 0.0f, 0.0f), gid);
      return;
    }
    float2 rD = wrR2(u.size.z, gid);
    float3 l = ptAround(u.sun.xyz, 1.0f - rD.x * (1.0f - u.sky.y), 2.0f * kWrPi * rD.y);
    float vis = (dot(ng, l) > 0.0f) ? wrShadow(p + ng * eps, l, eps, u, scene, instances, geomMeshes, meshes, materials, true) : 0.0f;
    float visEst = hasValidAlpha ? saturate(mix(alpha, vis, 0.55f)) : vis;
    bool clay = (u.flags.w & 1u) != 0u;
    float sunPow = clay ? min(u.sun.w, 3.1f) : u.sun.w;
    float3 sunColor = clay ? float3(1.0f, 0.99f, 0.97f) : float3(1.0f, 0.96f, 0.89f);
    float3 sunIrrad = sunColor * (sunPow * nlSun * visEst / kWrPi);
    diOut.write(float4(sunIrrad, vis), gid);
    return;
  }

  // White studio 4-softbox analytical CV
  float diskE[4], sumE = 0.0f;
  for (int i = 0; i < 4; i++) {
    diskE[i] = u.studioLights[i].w * rtptDiskLight(dot(n, u.studioLights[i].xyz), u.sky.w) / kWrPi;
    sumE += diskE[i];
  }
  if (sumE <= 1e-6f) {
    diOut.write(float4(0.0f), gid);
    return;
  }
  uint numSamples = (hasValidAlpha && (alpha > 0.96f || alpha < 0.04f)) ? 1u : 2u;
  float invS = 1.0f / float(numSamples);
  float coneScale = 2.0f * (1.0f - u.sky.y) / max(kWrPi * u.sky.w, 1e-6f);
  float diffSum = 0.0f;
  for (uint s = 0u; s < numSamples; s++) {
    float pick = (float(s) + rng.next()) * invS * sumE;
    int dIdx = 0;
    while (dIdx < 3 && pick >= diskE[dIdx]) { pick -= diskE[dIdx]; dIdx++; }
    float2 rD = wrR2(u.size.z * 2u + s, gid);
    float3 l = ptAround(u.studioLights[dIdx].xyz, 1.0f - rD.x * (1.0f - u.sky.y), 2.0f * kWrPi * rD.y);
    float nl = max(dot(n, l), 0.0f);
    if (nl > 0.0f) {
      float vis = (dot(ng, l) > 0.0f) ? wrShadow(p + ng * eps, l, eps, u, scene, instances, geomMeshes, meshes, materials, true) : 0.0f;
      diffSum += (vis - alpha) * ((u.studioLights[dIdx].w * nl * coneScale) / max(diskE[dIdx], 1e-6f)) * sumE;
    }
  }
  float directIrrad = max(alpha * sumE + diffSum * invS, 0.0f);
  float visEst = saturate(directIrrad / max(sumE, 1e-4f));
  diOut.write(float4(float3(directIrrad), visEst), gid);
}

// ============================================================================
// PASS 4a/4b/4c: Bounce Shading + Floor + Opaque GI/Spec + 16-Bounce Volume Glass
// ============================================================================

// Zero-stall diffuse GI bounce shading: uses precomputed linear meanAlbedo (no divergent 32-way texture fetch!)
// + SHaRC multi-bounce radiance cache (with 1/4-pixel cold cache updates)!
inline float3 wrShadeBounceHit(
    WrHit h, float3 rayOrigin, float3 rayDir, constant WrUniforms& u,
    metal::raytracing::instance_acceleration_structure scene,
    device const WrInstanceGpu* instances, device const uint* geomMeshes, device const WrMeshGpu* meshes,
    device const WrMaterialGpu* materials, device const WrSharcResolved* sharcResolved,
    device WrSharcAccum* sharcAccum, texture2d<float, access::sample> envTex,
    thread PtRng& rng, bool updateColdCache, bool sampleTextures) {
  float3 q = rayOrigin + rayDir * h.t;
  device const WrMaterialGpu& m = materials[h.material];
  bool clay = (u.flags.w & 1u) != 0u;
  float3 qng = dot(h.ng, rayDir) > 0.0f ? -h.ng : h.ng;
  float3 qn = dot(h.ns, qng) < 0.0f ? -h.ns : h.ns;
  if (dot(qn, -rayDir) <= 0.0f) qn = qng;

  float3 base, emissive;
  float roughness, metalness, clearcoat;
  if (sampleTextures) {
    wrEvalMaterial(m, h.uv, 1.0f, clay, base, roughness, metalness, clearcoat, emissive);
  } else if (clay) {
    base = float3(0.46f, 0.45f, 0.44f);
    emissive = float3(0.0f);
    roughness = 0.65f;
    metalness = 0.0f;
    clearcoat = 0.0f;
  } else {
    base = m.meanAlbedo.rgb;
    emissive = m.emissive.rgb;
    roughness = m.pbr.y;
    metalness = m.pbr.x;
    clearcoat = m.pbr.z;
  }

  float nv = max(dot(qn, -rayDir), 1e-4f);
  float coat;
  float3 fb, diffAlbedo, specAlbedo;
  wrBrdfParams(base, roughness, metalness, clearcoat, nv, coat, fb, diffAlbedo, specAlbedo);

  float4 cached = wrSharcQuery(q, qn, u, sharcResolved);
  float3 totalIrradQ;
  float eps = wrRayOffset(q, u);
  bool refresh = updateColdCache && (rng.next() < 0.06f);
  if (cached.w > 0.5f && !refresh) {
    totalIrradQ = cached.rgb;
  } else {
    float3 directQ = wrSecondaryDirect(q, qn, qng, eps, u, scene, instances, geomMeshes, meshes, materials, rng);
    float3 indirectQ = wrSampleSky(qn, u, envTex, false) * 0.42f;
    if (updateColdCache) {
      indirectQ = float3(0.0f);
      float3 b2Dir = ptCosine(qn, rng.next(), rng.next());
      if (dot(b2Dir, qng) > 0.0f) {
        WrHit h2 = wrTraceGi(q + qng * eps, b2Dir, eps, u, scene, instances, geomMeshes, meshes, 0x01u);
        if (!h2.hit) {
          indirectQ = wrSampleSky(b2Dir, u, envTex, false);
        } else {
          float3 q2 = q + qng * eps + b2Dir * h2.t;
          float3 q2ng = dot(h2.ng, b2Dir) > 0.0f ? -h2.ng : h2.ng;
          float3 q2n = dot(h2.ns, q2ng) < 0.0f ? -h2.ns : h2.ns;
          device const WrMaterialGpu& m2 = materials[h2.material];
          float3 base2 = clay ? float3(0.46f, 0.45f, 0.44f) : m2.meanAlbedo.rgb;
          float met2 = clay ? 0.0f : m2.pbr.x;
          float3 em2 = clay ? float3(0.0f) : m2.emissive.rgb;
          float4 c2 = wrSharcQuery(q2, q2n, u, sharcResolved);
          float3 irrad2 = c2.w > 0.5f ? c2.rgb : (wrSecondaryDirect(q2, q2n, q2ng, eps, u, scene, instances, geomMeshes, meshes, materials, rng) + wrSampleSky(q2n, u, envTex, false) * 0.35f);
          indirectQ = base2 * (1.0f - met2) * irrad2 + em2;
        }
      }
      totalIrradQ = directQ + indirectQ;
      wrSharcInsert(q, qn, totalIrradQ, u, sharcAccum);
    } else {
      totalIrradQ = directQ + indirectQ;
    }
  }

  float3 outRad = emissive + diffAlbedo * totalIrradQ;
  float3 r = reflect(rayDir, qn);
  if (dot(r, qng) > 0.0f) {
    float a2 = max(roughness * roughness, 2e-3f);
    a2 *= a2;
    float g1 = ptSmithG1(max(dot(qn, r), 1e-4f), a2);
    float visProxy = saturate(wrLum(totalIrradQ) / max(u.sky.x + 1.0f, 1e-4f));
    outRad += specAlbedo * g1 * wrSampleSky(r, u, envTex, true) * visProxy;
  }
  return outRad;
}

kernel void wrTraceFloor(
    constant WrUniforms& u [[buffer(0)]],
    metal::raytracing::instance_acceleration_structure scene [[buffer(1)]],
    device const WrInstanceGpu* instances [[buffer(2)]],
    device const WrMeshGpu* meshes [[buffer(3)]],
    device const WrMaterialGpu* materials [[buffer(4)]],
    device const uint* floorTiles [[buffer(5)]],
    device const uint* geomMeshes [[buffer(6)]],
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
  if (wrUnpackKind(posId.w) != 3u) return;

  float3 p = posId.xyz;
  float3 up = float3(0.0f, 1.0f, 0.0f);
  float eps = wrRayOffset(p, u);

  float2 prevFloor = float2(1.0f);
  bool hasReproj = false;
  if (u.flags.y != 0u) {
    float2 mv = gMotion.read(gid).xy;
    float2 prevUv = (float2(gid) + 0.5f) / float2(u.size.xy) + mv;
    if (all(prevUv >= 0.0f) && all(prevUv < 1.0f)) {
      uint2 prevPx = uint2(clamp(int2(prevUv * float2(u.size.xy)), int2(0), int2(u.size.xy) - 1));
      float4 pPosId = prevPosId.read(prevPx);
      if (wrUnpackKind(pPosId.w) == 3u && length(pPosId.xyz - p) < 0.08f * max(length(p - u.eye.xyz), 1e-3f)) {
        prevFloor = saturate(diffHistPrev.read(prevPx).rg);
        hasReproj = true;
      }
    }
  }
  float3 bmin = u.sceneMin.xyz, bmax = u.sceneMax.xyz;
  float diag = max(length(bmax - bmin), 1.0f);
  float2 dBox = max(max(bmin.xz - p.xz, p.xz - bmax.xz), float2(0.0f));
  bool nearModel = (max(dBox.x, dBox.y) < diag * 0.15f);
  if (!nearModel && hasReproj && (((gid.x ^ gid.y ^ u.size.z) & 1u) != 0u)) {
    diffOut.write(float4(prevFloor.r, prevFloor.g, 1.0f, 0.5f), gid);
    return;
  }

  float3 origin = p + up * eps;
  float2 rSky = wrR2(u.size.z * 2u, gid);
  float skyVis = wrShadow(origin, ptCosine(up, rSky.x, rSky.y), eps, u, scene, instances, geomMeshes, meshes, materials, true);
  float2 rSun = wrR2(u.size.z * 2u + 1u, gid);
  float3 l = ptAround(u.sun.xyz, 1.0f - rSun.x * (1.0f - u.sky.y), 2.0f * kWrPi * rSun.y);
  float sunVis = (dot(l, up) > 0.0f) ? wrShadow(origin, l, eps, u, scene, instances, geomMeshes, meshes, materials, true) : 1.0f;
  diffOut.write(float4(mix(1.0f, sunVis, 0.45f), skyVis, 1.0f, 1.0f), gid);
}

// PASS 4b-1: 100%-SIMD-Dense Half-Res Rotating 2x2 Diffuse GI + SHaRC Radiance Cache!
// Dispatched at (traceW+1)/2 x (traceH+1)/2 so 100% of SIMD lanes trace real GI rays (zero idle lanes!).
kernel void wrTraceGiQuarter(
    constant WrUniforms& u [[buffer(0)]],
    metal::raytracing::instance_acceleration_structure scene [[buffer(1)]],
    device const WrInstanceGpu* instances [[buffer(2)]],
    device const WrMeshGpu* meshes [[buffer(3)]],
    device const WrMaterialGpu* materials [[buffer(4)]],
    device const WrSharcResolved* sharcResolved [[buffer(5)]],
    device WrSharcAccum* sharcAccum [[buffer(6)]],
    device const uint* geomMeshes [[buffer(7)]],
    texture2d<float, access::read> gPosId [[texture(0)]],
    texture2d<float, access::read> gNorm [[texture(1)]],
    texture2d<float, access::read> diIn [[texture(2)]],
    texture2d<float, access::sample> envTex [[texture(3)]],
    texture2d<float, access::write> giQuarterOut [[texture(4)]],
    uint2 qid [[thread_position_in_grid]]) {
  uint2 qSize = (u.size.xy + 1u) >> 1u;
  if (qid.x >= qSize.x || qid.y >= qSize.y) return;

  uint2 phaseOff = uint2(u.size.z & 1u, (u.size.z >> 1u) & 1u);
  uint2 gid = min(qid * 2u + phaseOff, u.size.xy - 1u);
  float4 posId = gPosId.read(gid);
  if (wrUnpackKind(posId.w) != 1u) {
    // Fallback to another pixel in the 2x2 block if this sub-pixel is sky/glass!
    bool found = false;
    for (uint k = 0u; k < 4u && !found; k++) {
      uint2 cand = min(qid * 2u + uint2(k & 1u, k >> 1u), u.size.xy - 1u);
      float4 cp = gPosId.read(cand);
      if (wrUnpackKind(cp.w) == 1u) { gid = cand; posId = cp; found = true; }
    }
    if (!found) {
      giQuarterOut.write(float4(0.0f, 0.0f, 0.0f, -1.0f), qid);
      return;
    }
  }

  float3 p = posId.xyz;
  float4 nPacked = gNorm.read(gid);
  float3 n = wrOctDecode(nPacked.xy);
  float3 ng = wrOctDecode(nPacked.zw);
  float metalness = wrUnpackMetal(posId.w);
  float eps = wrRayOffset(p, u);

  PtRng rng;
  rng.s = ptHash(ptHash(gid.x * 1973u + gid.y * 9277u) ^ (u.size.z * 26699u + 911u));
  float2 rGi = wrR2(u.size.z * 3u, gid);
  bool doCacheUpdate = (((qid.x + qid.y + u.size.z) & 3u) == 0u);

  float3 indirectIrrad = float3(0.0f);
  if (metalness < 0.98f) {
    float3 giDir = ptCosine(n, rGi.x, rGi.y);
    if (dot(giDir, ng) > 0.0f) {
      WrHit gh = wrTraceGi(p + ng * eps, giDir, eps, u, scene, instances, geomMeshes, meshes, 0x03u);
      if (!gh.hit) {
        indirectIrrad = wrSampleSky(giDir, u, envTex, false);
      } else {
        indirectIrrad = wrShadeBounceHit(gh, p + ng * eps, giDir, u, scene, instances, geomMeshes, meshes, materials, sharcResolved, sharcAccum, envTex, rng, doCacheUpdate, false);
      }
    }
    indirectIrrad = min(indirectIrrad, float3(16.0f));
    if (doCacheUpdate) {
      float3 totalDiff = diIn.read(gid).rgb + indirectIrrad;
      wrSharcInsert(p, n, totalDiff, u, sharcAccum);
    }
  }
  uint subCode = (gid.x & 1u) | ((gid.y & 1u) << 1u);
  giQuarterOut.write(float4(indirectIrrad, float(subCode)), qid);
}

// PASS 4b-2: Full-Res Normal/Plane-Aware Bilateral GI Upsample + Crisp Direct Light + Glossy Specular RT!
kernel void wrTraceOpaque(
    constant WrUniforms& u [[buffer(0)]],
    metal::raytracing::instance_acceleration_structure scene [[buffer(1)]],
    device const WrInstanceGpu* instances [[buffer(2)]],
    device const WrMeshGpu* meshes [[buffer(3)]],
    device const WrMaterialGpu* materials [[buffer(4)]],
    device const WrSharcResolved* sharcResolved [[buffer(5)]],
    device WrSharcAccum* sharcAccum [[buffer(6)]],
    device const uint* opaqueTiles [[buffer(7)]],
    device const uint* geomMeshes [[buffer(8)]],
    texture2d<float, access::read> gPosId [[texture(0)]],
    texture2d<float, access::read> gNorm [[texture(1)]],
    texture2d<float, access::read> gMat [[texture(2)]],
    texture2d<float, access::read> diIn [[texture(3)]],
    texture2d<float, access::sample> envTex [[texture(4)]],
    texture2d<float, access::write> diffOut [[texture(5)]],
    texture2d<float, access::write> specOut [[texture(6)]],
    texture2d<float, access::read> giQuarterIn [[texture(7)]],
    uint2 lid [[thread_position_in_threadgroup]],
    uint2 tgid [[threadgroup_position_in_grid]]) {
  uint packedTile = opaqueTiles[tgid.x];
  uint2 gid = uint2(packedTile & 0xFFFFu, packedTile >> 16u) * 8u + lid;
  if (gid.x >= u.size.x || gid.y >= u.size.y) return;

  float4 posId = gPosId.read(gid);
  if (wrUnpackKind(posId.w) != 1u) return;

  float3 p = posId.xyz;
  float4 nPacked = gNorm.read(gid);
  float3 n = wrOctDecode(nPacked.xy);
  float3 ng = wrOctDecode(nPacked.zw);
  float4 matVal = gMat.read(gid);
  float roughness = matVal.a;
  float metalness = wrUnpackMetal(posId.w);
  float clearcoat = wrUnpackCoat(posId.w);
  float3 v = normalize(u.eye.xyz - p);
  float viewDist = max(length(p - u.eye.xyz), 1e-3f);
  float eps = wrRayOffset(p, u);

  // 1. Normal + Plane-Aware Bilateral Upsample of fresh half-res GI (3x3 half-res neighborhood -> zero seam, true variance!).
  float4 diVal = diIn.read(gid);
  float3 indirectIrrad = float3(0.0f);
  if (metalness < 0.98f) {
    int2 qSize = int2((u.size.xy + 1u) >> 1u);
    int2 qCenter = int2(gid >> 1u);
    float3 giSum = float3(0.0f);
    float wSum = 0.0f;
    float sigmaPlane = max(0.035f * viewDist, 1e-3f);
    for (int dy = -1; dy <= 1; dy++) {
      for (int dx = -1; dx <= 1; dx++) {
        int2 qpx = qCenter + int2(dx, dy);
        if (qpx.x < 0 || qpx.y < 0 || qpx.x >= qSize.x || qpx.y >= qSize.y) continue;
        float4 giTap = giQuarterIn.read(uint2(qpx));
        if (giTap.a < -0.5f) continue;
        uint sc = uint(round(giTap.a));
        uint2 srcGid = min(uint2(qpx) * 2u + uint2(sc & 1u, (sc >> 1u) & 1u), u.size.xy - 1u);
        float4 sPos = gPosId.read(srcGid);
        float3 sn = wrOctDecode(gNorm.read(srcGid).xy);
        float dist2 = float(int(srcGid.x) - int(gid.x)) * float(int(srcGid.x) - int(gid.x)) +
                      float(int(srcGid.y) - int(gid.y)) * float(int(srcGid.y) - int(gid.y));
        float ws = exp(-0.35f * dist2);
        float wn = pow(max(dot(n, sn), 0.0f), 16.0f);
        float wz = exp(-abs(dot(sPos.xyz - p, ng)) / sigmaPlane);
        float w = ws * wn * wz;
        giSum += giTap.rgb * w;
        wSum += w;
      }
    }
    if (wSum > 1e-4f) {
      indirectIrrad = giSum / wSum;
    } else {
      // Exact fallback for isolated 1px geometry slivers: read center half-res GI or sky proxy!
      float4 cTap = giQuarterIn.read(uint2(qCenter));
      indirectIrrad = (cTap.a >= -0.5f) ? cTap.rgb : (wrSampleSky(n, u, envTex, false) * 0.45f);
    }
  }
  float3 totalDiffIrrad = diVal.rgb + indirectIrrad;
  diffOut.write(float4(totalDiffIrrad, diVal.a), gid);

  // 2. Full-Res Glossy GGX VNDF Specular / Clearcoat Reflection (ONLY on glossy/metallic/clearcoat pixels!)
  bool clay = (u.flags.w & 1u) != 0u;
  float effRough = (clearcoat > 0.25f) ? mix(roughness, 0.06f, clearcoat * 0.65f) : roughness;
  // Rough matte dielectrics (rubber tires, stone, fabric) attenuate grazing specular cleanly (no washed-out rims!).
  float3 demodSpec = indirectIrrad * saturate(1.0f - roughness * 0.68f) + diVal.rgb * saturate(0.35f - roughness * 0.35f);
  if (!clay && (effRough < 0.36f || metalness > 0.12f || clearcoat > 0.15f)) {
    PtRng rng;
    rng.s = ptHash(ptHash(gid.x * 1973u + gid.y * 9277u) ^ (u.size.z * 26699u + 911u));
    float2 rSpec = wrR2(u.size.z * 3u + 1u, gid);
    float gW = 0.0f;
    float3 reflDir = wrSampleGgxVndf(n, v, effRough, rSpec.x, rSpec.y, gW);
    demodSpec = float3(0.0f);
    if (gW > 0.0f && dot(reflDir, ng) > 0.0f) {
      WrHit rh = wrTraceGi(p + ng * eps, reflDir, eps, u, scene, instances, geomMeshes, meshes, 0xFFu);
      if (!rh.hit) {
        demodSpec = gW * wrSampleSky(reflDir, u, envTex, true);
      } else {
        bool sharpTex = (effRough < 0.22f);
        demodSpec = gW * wrShadeBounceHit(rh, p + ng * eps, reflDir, u, scene, instances, geomMeshes, meshes, materials, sharcResolved, sharcAccum, envTex, rng, false, sharpTex);
      }
    }
  }
  specOut.write(float4(min(demodSpec, float3(18.0f)), 1.0f), gid);
}

// PASS 4c: Indirect Tile-Compacted 16-Bounce Beer-Lambert Volume Glass & Refraction!
// Supports full UV-textured, normal-mapped, SHaRC-shaded scenes seen through curved glass!
kernel void wrTraceGlass(
    constant WrUniforms& u [[buffer(0)]],
    metal::raytracing::instance_acceleration_structure scene [[buffer(1)]],
    device const WrInstanceGpu* instances [[buffer(2)]],
    device const WrMeshGpu* meshes [[buffer(3)]],
    device const WrMaterialGpu* materials [[buffer(4)]],
    device const WrSharcResolved* sharcResolved [[buffer(5)]],
    device WrSharcAccum* sharcAccum [[buffer(6)]],
    device const uint* glassTiles [[buffer(7)]],
    device const uint* geomMeshes [[buffer(8)]],
    texture2d<float, access::read> gPosId [[texture(0)]],
    texture2d<float, access::read> gNorm [[texture(1)]],
    texture2d<float, access::sample> envTex [[texture(2)]],
    texture2d<float, access::write> specOut [[texture(3)]],
    uint2 lid [[thread_position_in_threadgroup]],
    uint2 tgid [[threadgroup_position_in_grid]]) {
  uint packedTile = glassTiles[tgid.x];
  uint2 gid = uint2(packedTile & 0xFFFFu, packedTile >> 16u) * 8u + lid;
  if (gid.x >= u.size.x || gid.y >= u.size.y) return;
  float4 gPos = gPosId.read(gid);
  if (wrUnpackKind(gPos.w) != 2u) return;

  PtRng rng;
  rng.s = ptHash(ptHash(gid.x * 2971u + gid.y * 6553u) ^ (u.size.z * 0x9E3779B9u + 313u));

  float2 sub = float2(0.5f) - u.jitter.xy;
  float sx = (float(gid.x) + sub.x) / float(u.size.x) * 2.0f - 1.0f;
  float sy = 1.0f - (float(gid.y) + sub.y) / float(u.size.y) * 2.0f;
  float3 origin = u.eye.xyz;
  float3 dir = normalize(u.forward.xyz + u.right.xyz * (sx * u.eye.w * u.right.w) + u.up.xyz * (sy * u.eye.w));

  float3 throughput = float3(1.0f), radiance = float3(0.0f), absorb = float3(0.0f);
  float eps = wrRayOffset(gPos.xyz, u) * 0.25f;

  // Bounce 0: Reuse rasterized front glass hit directly!
  {
    uint matId = wrUnpackMat(gPos.w);
    device const WrMaterialGpu& gm = materials[matId];
    uint gmFlags = as_type<uint>(gm.attenuation.w);
    bool thinGlass = (gmFlags & 2048u) != 0u;
    float3 hp = gPos.xyz;
    float4 np = gNorm.read(gid);
    float3 gn = wrOctDecode(np.xy);
    float3 gng = wrOctDecode(np.zw);
    if (dot(dir, gn) >= 0.0f) gn = gng;
    if (dot(dir, gn) >= 0.0f) gn = -dir;
    float ior = max(gm.glass.y, 1.05f);
    float eta = 1.0f / ior;
    float f = ptFresnel(-dot(dir, gn), eta);
    float3 sigmaA = gm.attenuation.rgb;

    if (f < 0.999f) {
      float3 rDir = reflect(dir, gn);
      WrHit rh = wrTrace(hp + gng * eps, rDir, eps, u, scene, instances, geomMeshes, meshes, materials, 0xFFu);
      float3 reflCol = !rh.hit ? wrSampleSky(rDir, u, envTex, true)
                               : wrShadeBounceHit(rh, hp + gng * eps, rDir, u, scene, instances, geomMeshes, meshes, materials, sharcResolved, sharcAccum, envTex, rng, false, true);
      radiance += f * reflCol;
      float3 tint = mix(float3(1.0f), max(gm.baseColor.rgb, float3(0.25f)), 1.0f - gm.glass.x);
      throughput = float3(1.0f - f) * tint;
      if (!thinGlass) {
        dir = normalize(refract(dir, gn, eta));
        absorb = sigmaA;
      }
      origin = hp - gng * eps;
    } else {
      dir = reflect(dir, gn);
      origin = hp + gng * eps;
    }
  }

  for (uint bounce = 1u; bounce < 16u; bounce++) {
    WrHit h = wrTrace(origin, dir, eps, u, scene, instances, geomMeshes, meshes, materials, 0xFFu);
    if (any(absorb > 0.0f)) throughput *= exp(-absorb * (h.hit ? h.t : 1e3f));
    if (!h.hit) {
      radiance += throughput * wrSampleSky(dir, u, envTex, true);
      break;
    }
    float3 hp = origin + dir * h.t;
    device const WrMaterialGpu& m = materials[h.material];
    uint mFlags = as_type<uint>(m.attenuation.w);
    if ((mFlags & 1024u) != 0u) {
      bool thinGlass = (mFlags & 2048u) != 0u;
      bool entering = dot(dir, h.ng) < 0.0f;
      float3 gn = entering ? h.ns : -h.ns;
      if (dot(dir, gn) >= 0.0f) gn = entering ? h.ng : -h.ng;
      float ior = max(m.glass.y, 1.05f);
      float eta = (thinGlass || entering) ? (1.0f / ior) : ior;
      float f = ptFresnel(-dot(dir, gn), eta);
      if (rng.next() < f) {
        dir = reflect(dir, gn);
        origin = hp + gn * eps;
      } else {
        if (!thinGlass) {
          dir = normalize(refract(dir, gn, eta));
          absorb = entering ? m.attenuation.rgb : float3(0.0f);
        }
        origin = hp - gn * eps;
      }
    } else {
      // Full UV-textured, SHaRC-accelerated opaque shading behind glass (e.g. checkered dragon cloth, car seats, watch dial!)
      radiance += throughput * wrShadeBounceHit(h, origin, dir, u, scene, instances, geomMeshes, meshes, materials, sharcResolved, sharcAccum, envTex, rng, false, true);
      break;
    }
    if (bounce >= 8u) {
      float q = clamp(max(throughput.r, max(throughput.g, throughput.b)), 0.10f, 0.95f);
      if (rng.next() > q) break;
      throughput /= q;
    }
  }

  float3 outGlass = (!any(isnan(radiance)) && !any(isinf(radiance))) ? min(radiance, float3(18.0f)) : float3(0.0f);
  specOut.write(float4(outGlass, 1.0f), gid);
}

// ============================================================================
// PASS 5: 2D-Morton L2-Coherent SVGF Temporal + Zero-gPosId Floor A-Trous
// ============================================================================

kernel void wrSvgfTemporal(
    constant WrUniforms& u [[buffer(0)]],
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
  uint kind = wrUnpackKind(posId.w);
  if (kind == 0u || kind == 4u) {
    diffHistOut.write(float4(0.0f, 0.0f, 0.0f, -2.0f), gid);
    return;
  }

  float3 p = posId.xyz;
  float4 nPacked = gNorm.read(gid);
  float3 n = wrOctDecode(nPacked.xy);
  float3 ng = wrOctDecode(nPacked.zw);
  float viewDist = max(length(p - u.eye.xyz), 1e-3f);
  float4 dCur = (kind == 1u || kind == 3u) ? diffRaw.read(gid) : float4(0.0f, 0.0f, 0.0f, -2.0f);
  float4 sCur = (kind == 1u || kind == 2u) ? specRaw.read(gid) : float4(0.0f);
  bool still = (u.size.w > 1u);

  if (still && kind == 2u) {
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
    float2 prevUv = (float2(gid) + 0.5f) / float2(u.size.xy) + mv;
    if (all(prevUv >= 0.0f) && all(prevUv < 1.0f)) {
      float2 prevF = prevUv * float2(u.size.xy) - 0.5f;
      int2 base = int2(floor(prevF));
      float2 f = fract(prevF);
      float wSum = 0.0f;
      for (int k = 0; k < 4; k++) {
        int2 tap = clamp(base + int2(k & 1, k >> 1), int2(0), int2(u.size.xy) - 1);
        float4 tPosId = prevPosId.read(uint2(tap));
        if (wrUnpackKind(tPosId.w) != kind) continue;
        if (kind == 1u || kind == 2u) {
          float3 tn = wrOctDecode(prevNorm.read(uint2(tap)).xy);
          if (dot(n, tn) < 0.88f) continue;
          if (abs(dot(tPosId.xyz - p, ng)) > 0.04f * viewDist) continue;
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
        dPrev *= invW; sPrev *= invW; mPrev *= invW; prevHLen *= invW;
        validHistory = true;
      }
    }
  }

  float dLum = (kind == 3u) ? (0.5f * (dCur.r + dCur.g)) : wrLum(dCur.rgb);
  float sLum = wrLum(sCur.rgb);
  float2 curDM = float2(dLum, dLum * dLum);
  float2 curSM = float2(sLum, sLum * sLum);

  float4 dOut = dCur, sOut = sCur;
  float4 mOut = float4(curDM, curSM);
  float2 hLen = float2(1.0f, 1.0f);

  if (validHistory) {
    if (still) {
      if (kind == 3u && dCur.a < 0.75f) {
        dOut = float4(dPrev.rg, max(dPrev.b, dCur.b), -1.0f);
        hLen = prevHLen; mOut = mPrev;
      } else {
        hLen.x = min(prevHLen.x + 1.0f, kind == 3u ? 16.0f : 8.0f);
        hLen.y = min(prevHLen.y + 1.0f, 4.0f);
        float aD = 1.0f / hLen.x, aS = 1.0f / hLen.y;
        dOut = (kind == 3u) ? float4(mix(dPrev.rg, dCur.rg, aD), max(dPrev.b, dCur.b), -1.0f)
                            : float4(mix(dPrev.rgb, dCur.rgb, aD), mix(dPrev.a, dCur.a, 0.25f));
        sOut = float4(mix(sPrev.rgb, sCur.rgb, aS), 1.0f);
        mOut.xy = mix(mPrev.xy, curDM, aD);
        mOut.zw = mix(mPrev.zw, curSM, aS);
      }
    } else {
      if (kind == 3u && dCur.a < 0.75f) {
        dOut = float4(dPrev.rg, max(dPrev.b * 0.9f, dCur.b), -1.0f);
        hLen = prevHLen; mOut = mPrev;
      } else {
        hLen.x = min(prevHLen.x + 1.0f, 16.0f);
        float aD = max(1.0f / hLen.x, 0.12f);
        dOut = (kind == 3u) ? float4(mix(dPrev.rg, dCur.rg, aD), max(dPrev.b * 0.9f, dCur.b), -1.0f)
                            : float4(mix(dPrev.rgb, dCur.rgb, aD), mix(dPrev.a, dCur.a, 0.25f));
        mOut.xy = mix(mPrev.xy, curDM, aD);
      }
      if (kind == 1u || kind == 2u) {
        hLen.y = min(prevHLen.y + 1.0f, 12.0f);
        float aS = max(1.0f / hLen.y, 0.18f);
        sOut = float4(mix(sPrev.rgb, sCur.rgb, aS), 1.0f);
        mOut.zw = mix(mPrev.zw, curSM, aS);
      }
    }
  } else {
    mOut = float4(dLum, dLum * dLum + 0.08f, sLum, sLum * sLum + 0.10f);
  }

  if (kind == 3u) dOut.a = -1.0f;
  else if (kind != 1u) dOut = float4(0.0f, 0.0f, 0.0f, -2.0f);

  diffHistOut.write(dOut, gid);
  specHistOut.write(sOut, gid);
  momentsOut.write(mOut, gid);
  hLenOut.write(float4(hLen, 0.0f, 0.0f), gid);
}

kernel void wrSvgfAtrous(
    constant WrUniforms& u [[buffer(0)]],
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
  uint kind = wrUnpackKind(posId.w);
  if (kind == 0u || kind == 4u) {
    diffOut.write(float4(0.0f, 0.0f, 0.0f, -2.0f), gid);
    return;
  }
  if (kind == 2u) {
    diffOut.write(float4(0.0f, 0.0f, 0.0f, -2.0f), gid);
    specOut.write(specIn.read(gid), gid);
    return;
  }

  float4 dCenter = diffIn.read(gid);
  float2 hLen = max(hLenIn.read(gid).xy, float2(1.0f));
  float coldBoost = (hLen.x < 4.0f) ? 1.5f : 1.0f;
  float stillF = float(max(u.size.w, 1u));
  float filterScaleD = (u.size.w > 1u) ? saturate(10.0f / stillF) : 1.0f;

  if (kind == 3u) {
    float4 mom = momentsIn.read(gid);
    float diffVar = max(mom.y - mom.x * mom.x, 0.0f);
    float sigma = max(4.0f * sqrt(diffVar + 1e-4f) * filterScaleD * coldBoost, 0.04f);
    float lSum = dCenter.r * 0.25f, lW = 0.25f;
    float sSum = dCenter.g * 0.25f, sW = 0.25f;
    for (int dy = -1; dy <= 1; dy++) {
      for (int dx = -1; dx <= 1; dx++) {
        if (dx == 0 && dy == 0) continue;
        int2 qpx = int2(gid) + int2(dx, dy);
        if (qpx.x < 0 || qpx.y < 0 || qpx.x >= int(u.size.x) || qpx.y >= int(u.size.y)) continue;
        float4 dq = diffIn.read(uint2(qpx));
        if (dq.a > -0.5f || dq.a < -1.5f) continue;
        float kw = (dx == 0 || dy == 0) ? 0.125f : 0.0625f;
        float wl = kw * exp(-abs(dCenter.r - dq.r) / sigma);
        float ws = kw * exp(-abs(dCenter.g - dq.g) / sigma);
        lSum += dq.r * wl; lW += wl;
        sSum += dq.g * ws; sW += ws;
      }
    }
    diffOut.write(float4(lSum / max(lW, 1e-6f), sSum / max(sW, 1e-6f), dCenter.b, -1.0f), gid);
    return;
  }

  float4 sCenter = specIn.read(gid);
  float3 p = posId.xyz;
  float4 np = gNorm.read(gid);
  float3 n = wrOctDecode(np.xy), ng = wrOctDecode(np.zw);
  float roughness = gMat.read(gid).a;
  float viewDist = max(length(p - u.eye.xyz), 1e-3f);
  float4 mom = momentsIn.read(gid);
  float diffVar = max(mom.y - mom.x * mom.x, 0.0f);
  float specVar = max(mom.w - mom.z * mom.z, 0.0f);
  float dLumC = wrLum(dCenter.rgb), sLumC = wrLum(sCenter.rgb);
  float sigmaPlane = max(0.015f * viewDist, 1e-3f);
  float sigmaDiff = max(3.2f * sqrt(diffVar + 1e-4f) * filterScaleD * coldBoost, 0.02f);
  float sigmaSpec = max((0.75f + 2.5f * roughness) * sqrt(specVar + 1e-4f) * filterScaleD, 0.02f);
  bool filterSpec = (roughness > 0.18f || u.size.w < 6u);

  const int2 offs[4] = {int2(1, 0), int2(-1, 0), int2(0, 1), int2(0, -1)};
  float3 dSum = dCenter.rgb * 0.36f, sSum = sCenter.rgb * 0.36f;
  float dW = 0.36f, sW = 0.36f;
  for (int i = 0; i < 4; i++) {
    int2 qpx = int2(gid) + offs[i];
    if (qpx.x < 0 || qpx.y < 0 || qpx.x >= int(u.size.x) || qpx.y >= int(u.size.y)) continue;
    float4 qp = gPosId.read(uint2(qpx));
    if (wrUnpackKind(qp.w) != 1u) continue;
    float wz = exp(-abs(dot(qp.xyz - p, ng)) / sigmaPlane);
    float3 qn = wrOctDecode(gNorm.read(uint2(qpx)).xy);
    float nd = max(dot(n, qn), 0.0f);
    float4 dq = diffIn.read(uint2(qpx));
    float wd = 0.16f * wz * pow(nd, 48.0f) * exp(-abs(dLumC - wrLum(dq.rgb)) / sigmaDiff);
    dSum += dq.rgb * wd; dW += wd;
    if (filterSpec) {
      float4 sq = specIn.read(uint2(qpx));
      float ws = 0.16f * wz * pow(nd, 128.0f) * exp(-abs(sLumC - wrLum(sq.rgb)) / sigmaSpec);
      sSum += sq.rgb * ws; sW += ws;
    }
  }
  diffOut.write(float4(dSum / max(dW, 1e-6f), dCenter.a), gid);
  specOut.write(float4(filterSpec ? (sSum / max(sW, 1e-6f)) : sCenter.rgb, 1.0f), gid);
}

kernel void wrSvgfAtrousDiff(
    constant WrUniforms& u [[buffer(0)]],
    texture2d<float, access::read> gPosId [[texture(0)]],
    texture2d<float, access::read> gNorm [[texture(1)]],
    texture2d<float, access::read> diffIn [[texture(2)]],
    texture2d<float, access::read> momentsIn [[texture(3)]],
    texture2d<float, access::read> hLenIn [[texture(4)]],
    texture2d<float, access::write> diffOut [[texture(5)]],
    uint2 gid [[thread_position_in_grid]]) {
  if (gid.x >= u.size.x || gid.y >= u.size.y) return;
  float4 dCenter = diffIn.read(gid);
  if (dCenter.a < -1.5f) {
    diffOut.write(float4(0.0f, 0.0f, 0.0f, -2.0f), gid);
    return;
  }
  bool isFloor = (dCenter.a < -0.5f);
  int step = int(max(u.params.y & 0xFFFFu, 1u));
  uint passIdx = u.params.y >> 16u;
  float stillF = float(max(u.size.w, 1u));
  float filterScaleD = (u.size.w > 1u) ? saturate(10.0f / stillF) : 1.0f;
  if (!isFloor && u.size.w >= 12u && step >= 4) { diffOut.write(dCenter, gid); return; }
  if (!isFloor && u.size.w >= 24u && step >= 2) { diffOut.write(dCenter, gid); return; }

  float4 mom = momentsIn.read(gid);
  float diffVar = max(mom.y - mom.x * mom.x, 0.0f);
  float coldBoost = (hLenIn.read(gid).x < 4.0f) ? 1.5f : 1.0f;
  const int2 crossOffs[4] = {int2(1, 0), int2(-1, 0), int2(0, 1), int2(0, -1)};
  const int2 diagOffs[4] = {int2(1, 1), int2(-1, 1), int2(1, -1), int2(-1, -1)};

  if (isFloor) {
    float sigma = max(4.0f * sqrt(diffVar + 1e-4f) * filterScaleD * coldBoost, 0.04f);
    float lSum = dCenter.r * 0.36f, lW = 0.36f;
    float sSum = dCenter.g * 0.36f, sW = 0.36f;
    for (int i = 0; i < 4; i++) {
      int2 o = ((passIdx & 1u) == 0u) ? crossOffs[i] : diagOffs[i];
      int2 qpx = int2(gid) + o * step;
      if (qpx.x < 0 || qpx.y < 0 || qpx.x >= int(u.size.x) || qpx.y >= int(u.size.y)) continue;
      float4 dq = diffIn.read(uint2(qpx));
      if (dq.a > -0.5f || dq.a < -1.5f) continue;
      float wl = 0.16f * exp(-abs(dCenter.r - dq.r) / sigma);
      float ws = 0.16f * exp(-abs(dCenter.g - dq.g) / sigma);
      lSum += dq.r * wl; lW += wl;
      sSum += dq.g * ws; sW += ws;
    }
    diffOut.write(float4(lSum / max(lW, 1e-6f), sSum / max(sW, 1e-6f), dCenter.b, -1.0f), gid);
    return;
  }

  float4 posId = gPosId.read(gid);
  float3 p = posId.xyz;
  float4 np = gNorm.read(gid);
  float3 n = wrOctDecode(np.xy), ng = wrOctDecode(np.zw);
  float viewDist = max(length(p - u.eye.xyz), 1e-3f);
  float dLumC = wrLum(dCenter.rgb);
  float sigmaPlane = max(0.015f * viewDist * float(step), 1e-3f);
  float sigmaDiff = max(3.2f * sqrt(diffVar + 1e-4f) * filterScaleD * coldBoost, 0.02f);

  float3 dSum = dCenter.rgb * 0.36f;
  float dW = 0.36f;
  for (int i = 0; i < 4; i++) {
    int2 o = ((passIdx & 1u) == 0u) ? crossOffs[i] : diagOffs[i];
    int2 qpx = int2(gid) + o * step;
    if (qpx.x < 0 || qpx.y < 0 || qpx.x >= int(u.size.x) || qpx.y >= int(u.size.y)) continue;
    float4 qp = gPosId.read(uint2(qpx));
    if (wrUnpackKind(qp.w) != 1u) continue;
    float wz = exp(-abs(dot(qp.xyz - p, ng)) / sigmaPlane);
    float3 qn = wrOctDecode(gNorm.read(uint2(qpx)).xy);
    float4 dq = diffIn.read(uint2(qpx));
    float wd = 0.16f * wz * pow(max(dot(n, qn), 0.0f), 48.0f) * exp(-abs(dLumC - wrLum(dq.rgb)) / sigmaDiff);
    dSum += dq.rgb * wd; dW += wd;
  }
  diffOut.write(float4(dSum / max(dW, 1e-6f), dCenter.a), gid);
}

// ============================================================================
// PASS 6: Re-Modulation + Direct-Hit Sub-Pixel Halton TAAU + ACES Filmic Present
// ============================================================================

inline float3 wrReModulate(uint2 at, constant WrUniforms& u,
                           texture2d<float, access::read> gPosId,
                           texture2d<float, access::read> gNorm,
                           texture2d<float, access::read> gMat,
                           texture2d<float, access::read> diffFilt,
                           texture2d<float, access::read> specFilt,
                           texture2d<float, access::sample> envTex) {
  float4 posId = gPosId.read(at);
  uint kind = wrUnpackKind(posId.w);
  if (kind == 0u) {
    bool clay = (u.flags.w & 1u) != 0u;
    bool studioRig = (u.flags.w & 2u) != 0u;
    if (studioRig) return u.background.rgb;
    if (clay) return float3(0.015f, 0.016f, 0.018f);  // Clean dark architectural studio backdrop matching Bistro Clay reference!
    float2 sub = float2(0.5f) - u.jitter.xy;
    float sx = (float(at.x) + sub.x) / float(u.size.x) * 2.0f - 1.0f;
    float sy = 1.0f - (float(at.y) + sub.y) / float(u.size.y) * 2.0f;
    float3 dir = normalize(u.forward.xyz + u.right.xyz * (sx * u.eye.w * u.right.w) + u.up.xyz * (sy * u.eye.w));
    return wrSampleSky(dir, u, envTex, true);
  }
  if (kind == 3u) {
    float4 df = diffFilt.read(at);
    float shadow = saturate(df.r) * pow(saturate(df.g), 0.65f);
    bool studioRig = (u.flags.w & 2u) != 0u;
    if (studioRig) return u.background.rgb * shadow;
    // True seamless HDRI shadow-catcher: cast crisp ray-traced contact shadows directly onto the HDRI ground!
    float2 sub = float2(0.5f) - u.jitter.xy;
    float sx = (float(at.x) + sub.x) / float(u.size.x) * 2.0f - 1.0f;
    float sy = 1.0f - (float(at.y) + sub.y) / float(u.size.y) * 2.0f;
    float3 dir = normalize(u.forward.xyz + u.right.xyz * (sx * u.eye.w * u.right.w) + u.up.xyz * (sy * u.eye.w));
    return wrSampleSky(dir, u, envTex, false) * shadow;
  }
  if (kind == 4u) return max(gMat.read(at).rgb, float3(0.0f));
  if (kind == 2u) return max(specFilt.read(at).rgb, float3(0.0f));

  float3 p = posId.xyz;
  float3 n = wrOctDecode(gNorm.read(at).xy);
  float4 mv = gMat.read(at);
  float3 base = mv.rgb * mv.rgb;
  float rough = mv.a;
  float metal = wrUnpackMetal(posId.w);
  float coatP = wrUnpackCoat(posId.w);
  float nv = max(dot(n, normalize(u.eye.xyz - p)), 1e-4f);
  float coat;
  float3 fb, diffAlbedo, specAlbedo;
  wrBrdfParams(base, rough, metal, coatP, nv, coat, fb, diffAlbedo, specAlbedo);
  return diffAlbedo * max(diffFilt.read(at).rgb, float3(0.0f)) +
         specAlbedo * max(specFilt.read(at).rgb, float3(0.0f));
}

kernel void wrReModulateTrace(
    constant WrUniforms& u [[buffer(0)]],
    texture2d<float, access::read> gPosId [[texture(0)]],
    texture2d<float, access::read> gNorm [[texture(1)]],
    texture2d<float, access::read> gMat [[texture(2)]],
    texture2d<float, access::read> diffFilt [[texture(3)]],
    texture2d<float, access::read> specFilt [[texture(4)]],
    texture2d<float, access::sample> envTex [[texture(5)]],
    texture2d<float, access::write> colorOut [[texture(6)]],
    uint2 gid [[thread_position_in_grid]]) {
  if (gid.x >= u.size.x || gid.y >= u.size.y) return;
  uint kind = wrUnpackKind(gPosId.read(gid).w);
  float3 rgb = wrReModulate(gid, u, gPosId, gNorm, gMat, diffFilt, specFilt, envTex);
  colorOut.write(float4(max(rgb, float3(0.0f)), float(kind)), gid);
}

kernel void wrResolveTaau(
    constant WrUniforms& u [[buffer(0)]],
    texture2d<float, access::sample> colorTrace [[texture(0)]],
    texture2d<float, access::read> gMotion [[texture(1)]],
    texture2d<float, access::sample> taaPrev [[texture(2)]],
    texture2d<float, access::write> taaOut [[texture(3)]],
    uint2 gid [[thread_position_in_grid]]) {
  if (gid.x >= u.outSize.x || gid.y >= u.outSize.y) return;

  float2 outSizeF = float2(u.outSize.xy);
  float2 traceSizeF = float2(u.size.xy);
  int2 traceSizeI = int2(u.size.xy);
  bool native1to1 = (u.outSize.z == 0u);
  bool still = (u.size.w > 1u);

  if (native1to1) {
    float4 tap = colorTrace.read(gid);
    float3 cur = tap.rgb;
    if (u.flags.y == 0u) { taaOut.write(float4(cur, 1.0f), gid); return; }
    if (still) {
      float3 prev = taaPrev.read(gid).rgb;
      uint n = min(u.size.w, max(u.params.x, 64u));
      uint kind = uint(round(tap.a));
      float alpha = (kind == 2u) ? (1.0f / float(n)) : (n <= 12u ? (2.0f / float(n + 1u)) : (1.0f / float(n - 5u)));
      taaOut.write(float4(mix(prev, cur, alpha), 1.0f), gid);
      return;
    }
    float2 outUv = (float2(gid) + 0.5f) / outSizeF;
    float2 prevUv = outUv + gMotion.read(gid).xy;
    float3 out = cur;
    if (all(prevUv >= 0.0f) && all(prevUv < 1.0f)) {
      float3 prev = rtptSampleCatmullRom5(taaPrev, prevUv, outSizeF);
      float3 m1 = float3(0.0f), m2 = float3(0.0f);
      for (int dy = -1; dy <= 1; dy++) {
        for (int dx = -1; dx <= 1; dx++) {
          int2 q = clamp(int2(gid) + int2(dx, dy), int2(0), traceSizeI - 1);
          float3 y = rtptRgbToYCoCg(colorTrace.read(uint2(q)).rgb);
          m1 += y; m2 += y * y;
        }
      }
      float3 mean = m1 * (1.0f / 9.0f), sd = sqrt(max(m2 * (1.0f / 9.0f) - mean * mean, float3(0.0f)));
      float3 prevY = clamp(rtptRgbToYCoCg(prev), mean - sd * 1.25f, mean + sd * 1.25f);
      out = max(mix(rtptYCoCgToRgb(prevY), cur, 0.20f), float3(0.0f));
    }
    taaOut.write(float4(out, 1.0f), gid);
    return;
  }

  // Zero-blur Direct-Hit Sub-Pixel Halton TAAU!
  float2 scaleOut = outSizeF / traceSizeF;
  float2 outUv = (float2(gid) + 0.5f) / outSizeF;
  float2 tPosJit = outUv * traceSizeF + u.jitter.xy;
  int2 tNear = clamp(int2(floor(tPosJit)), int2(0), traceSizeI - 1);
  float4 nearTap = colorTrace.read(uint2(tNear));
  float2 dOut = (tPosJit - (float2(tNear) + 0.5f)) * scaleOut;
  float dOut2 = dot(dOut, dOut);

  if (still && u.flags.y != 0u) {
    float4 prevState = taaPrev.read(gid);
    float prevW = prevState.a;
    if (dOut2 < 0.52f) {
      bool isGlass = (uint(round(nearTap.a)) == 2u);
      float sampleW = exp(-3.4f * dOut2);
      if (prevW < 0.08f) { taaOut.write(float4(max(nearTap.rgb, float3(0.0f)), sampleW), gid); return; }
      if (!isGlass && u.size.w <= 12u) prevW *= 0.88f;
      prevW = min(prevW, max(float(u.params.x), 64.0f));
      float newW = prevW + sampleW;
      taaOut.write(float4(max(mix(prevState.rgb, nearTap.rgb, sampleW / newW), float3(0.0f)), newW), gid);
      return;
    }
    if (prevW >= 0.08f) { taaOut.write(prevState, gid); return; }
    float3 cMin = nearTap.rgb, cMax = nearTap.rgb;
    for (int dy = -1; dy <= 1; dy++)
      for (int dx = -1; dx <= 1; dx++) {
        float3 c = colorTrace.read(uint2(clamp(tNear + int2(dx, dy), int2(0), traceSizeI - 1))).rgb;
        cMin = min(cMin, c); cMax = max(cMax, c);
      }
    float3 cr = clamp(rtptSampleCatmullRom5(colorTrace, tPosJit / traceSizeF, traceSizeF), cMin, cMax);
    taaOut.write(float4(max(mix(prevState.rgb, cr, 0.35f), float3(0.0f)), prevW), gid);
    return;
  }

  float3 cMin = float3(1e9f), cMax = float3(-1e9f);
  float3 m1 = float3(0.0f), m2 = float3(0.0f);
  float2 bestMv = float2(0.0f);
  float bestMvL2 = -1.0f;
  for (int dy = -1; dy <= 1; dy++) {
    for (int dx = -1; dx <= 1; dx++) {
      int2 tidx = clamp(tNear + int2(dx, dy), int2(0), traceSizeI - 1);
      float3 c = colorTrace.read(uint2(tidx)).rgb;
      cMin = min(cMin, c); cMax = max(cMax, c);
      float3 y = rtptRgbToYCoCg(c);
      m1 += y; m2 += y * y;
      float2 mv = gMotion.read(uint2(tidx)).xy;
      float l2 = dot(mv, mv);
      if (l2 > bestMvL2) { bestMvL2 = l2; bestMv = mv; }
    }
  }
  float3 curCR = clamp(rtptSampleCatmullRom5(colorTrace, tPosJit / traceSizeF, traceSizeF), cMin, cMax);
  float onCenter = (dOut2 < 0.45f) ? exp(-3.5f * dOut2) : 0.0f;
  float3 cur = mix(curCR, nearTap.rgb, onCenter * 0.70f);
  if (u.flags.y == 0u) { taaOut.write(float4(max(cur, float3(0.0f)), 0.02f), gid); return; }
  float3 out = cur;
  float2 prevUv = outUv + bestMv;
  if (all(prevUv >= 0.0f) && all(prevUv < 1.0f)) {
    float3 prev = rtptSampleCatmullRom5(taaPrev, prevUv, outSizeF);
    float3 mean = m1 * (1.0f / 9.0f), sd = sqrt(max(m2 * (1.0f / 9.0f) - mean * mean, float3(0.0f)));
    float3 prevY = clamp(rtptRgbToYCoCg(prev), mean - sd * 1.25f, mean + sd * 1.25f);
    out = max(mix(rtptYCoCgToRgb(prevY), cur, mix(0.09f, 0.24f, onCenter)), float3(0.0f));
  }
  taaOut.write(float4(out, 0.5f), gid);
}

fragment float4 wrPresentFragment(
    ScreenOut in [[stage_in]],
    constant WrUniforms& u [[buffer(0)]],
    texture2d<float> resolved [[texture(0)]]) {
  uint2 at = uint2(in.position.xy);
  if (at.x >= u.outSize.x || at.y >= u.outSize.y) return float4(0.0f, 0.0f, 0.0f, 1.0f);
  bool clay = (u.flags.w & 1u) != 0u;
  float expScale = clay ? min(u.sky.z, 1.05f) : u.sky.z;
  float3 hdr = max(resolved.read(at).rgb, float3(0.0f)) * expScale;
  bool studioRig = (u.flags.w & 2u) != 0u;
  float3 out = studioRig ? saturate(hdr) : wrAcesFilmic(hdr);
  return float4(out, 1.0f);
}
