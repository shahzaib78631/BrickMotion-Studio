// 60 FPS Hybrid Raster + Instanced Metal Hardware-RT + Temporal SVGF:
// 1. hybridRtGlass: exact deterministic multi-bounce dielectric glass using PathScene's instanced
//    BLAS/TLAS (replaces flat-BVH glass_transport.metal, runs ONLY on glass pixels).
// 2. hybridRtGiRefl: half-res 1-spp instanced hardware-RT glossy clearcoat reflections + colored
//    indirect GI (zero screen-space ghosting, reflects off-screen bricks and glass).
// 3. hybridRtTemporal: motion-reprojected temporal accumulation across frames (works while orbiting).

struct HybridRtUniforms {
  float4x4 prevViewProj;
  uint frameIndex;
  uint hasHistory;
  uint fullWidth;
  uint fullHeight;
};

// Fast direct studio shading for a secondary RT hit (opaque brick), with optional 1-ray key shadow.
inline float3 hybridShadeHit(float3 base, float roughness, float metalness, float clearcoat,
                             float3 n, float3 v, float3 pos, constant PtUniforms& u,
                             metal::raytracing::instance_acceleration_structure scene,
                             device const PtInstance* instances, device const PtMesh* meshes,
                             device const PtMaterial* materials, bool traceKeyShadow) {
  float nv = max(dot(n, v), 1e-3f);
  float3 f0 = mix(float3(0.0337f), base, metalness);
  float3 matt = base * (1.0f - metalness);
  float3 r = reflect(-v, n);
  float coat = clearcoat * ptSchlick(0.04f, nv);
  float3 under = surroundReflectance(f0, roughness, nv);
  float worldStrength = u.rig.x * (u.rig.w > 1.5f ? 0.58f : 1.0f), sinSquared = u.rig.y;
  float cosRadius = u.rig.z;

  float3 col = worldStrength * (matt * (1.0f - under) * (1.0f - coat) + under * (1.0f - coat) + coat);
  if (u.rig.w > 0.5f) {
    for (int i = 0; i < 4; i++) {
      float3 l = u.lights[i].xyz;
      float strength = u.lights[i].w;
      float nl = dot(n, l);
      if (nl <= -0.3f) continue;
      float vis = 1.0f;
      if (i == 0 && traceKeyShadow && nl > 0.0f) {
        PtHit sh = ptTrace(pos + n * kPtEps, l, u, scene, instances, meshes);
        if (sh.hit) vis = 0.0f;
      }
      if (vis <= 0.0f) continue;
      float3 light = matt * (1.0f - under) * (1.0f - coat) * strength * diskLight(nl, sinSquared) / kPtPi;
      float radiance = strength / (kPtPi * sinSquared);
      float rl = dot(r, l);
      float soft = 0.02f + roughness * 0.5f;
      float seen = smoothstep(cosRadius - soft, cosRadius + soft, rl) * step(0.0f, nl + 0.3f);
      float coatSeen = smoothstep(cosRadius - 0.02f, cosRadius + 0.02f, rl) * step(0.0f, nl + 0.3f);
      light += radiance * (under * (1.0f - coat) * seen + coat * coatSeen);
      col += light * vis;
    }
  }
  return col;
}

inline float3 hybridEnv(float3 dir, constant PtUniforms& u) {
  float3 result = float3(u.rig.x);
  if (u.rig.w > 0.5f) {
    for (int i = 0; i < 4; i++) {
      float rad = u.lights[i].w / (kPtPi * u.rig.y);
      result += rad * smoothstep(u.rig.z - 0.02f, u.rig.z + 0.02f, dot(dir, u.lights[i].xyz));
    }
  }
  return result;
}

struct HybridGlassRay {
  float3 origin, direction, weight, absorption;
  uint depth;
  bool reflected;
};

// Stage 2: Exact instanced hardware-RT glass transport (runs ONLY on glass pixels, 2x supersampled).
kernel void hybridRtGlass(
    constant PtUniforms& u [[buffer(0)]],
    metal::raytracing::instance_acceleration_structure scene [[buffer(1)]],
    device const PtInstance* instances [[buffer(2)]],
    device const PtMesh* meshes [[buffer(3)]],
    device const PtMaterial* materials [[buffer(4)]],
    texture2d<float, access::read> glassFront [[texture(0)]],
    texture2d<float, access::write> glassResolved [[texture(1)]],
    uint2 gid [[thread_position_in_grid]]) {
  if (gid.x >= u.size.x || gid.y >= u.size.y) return;
  float4 front = glassFront.read(gid);
  if (front.w <= 0.0f) {
    glassResolved.write(float4(0.0f), gid);
    return;
  }

  const float2 subOffsets[2] = { float2(0.25f, 0.25f), float2(0.75f, 0.75f) };
  // u.size.z: supersamples per pixel (1 or 2); u.seed.y: the work-loop cap (0 keeps 28).
  const uint ssCount = clamp(u.size.z, 1u, 2u);
  const int workCap = u.seed.y > 0u ? int(u.seed.y) : 28;
  float3 totalResult = float3(0.0f);

  for (uint ss = 0; ss < ssCount; ss++) {
    // One sample is taken at the pixel centre; two at the quarter points, as they were.
    float2 off = ssCount == 1u ? float2(0.5f, 0.5f) : subOffsets[ss];
    float2 ndc = float2((float(gid.x) + off.x) / float(u.size.x) * 2.0f - 1.0f,
                        1.0f - (float(gid.y) + off.y) / float(u.size.y) * 2.0f);
    float3 rd = normalize(u.forward.xyz + u.right.xyz * (ndc.x * u.right.w * u.eye.w) + u.up.xyz * (ndc.y * u.eye.w));

    HybridGlassRay pending[12];
    int size = 1;
    // Start directly from camera eye so Detail::Low vs Detail::Full depth offsets never clip into glass bevels.
    pending[0] = HybridGlassRay{u.eye.xyz, rd, float3(1.0f), float3(0.0f), 0u, false};
    float3 result = float3(0.0f);

    for (int work = 0; work < workCap && size > 0; ++work) {
      HybridGlassRay ray = pending[--size];
      if (max(max(ray.weight.r, ray.weight.g), ray.weight.b) < 0.015f) continue;

      PtHit h = ptTrace(ray.origin, ray.direction, u, scene, instances, meshes);
      float floorDist = (u.floorPlane.y > 0.5f && ray.direction.y > 1e-5f) ? (u.floorPlane.x - ray.origin.y) / ray.direction.y : -1.0f;
      if (floorDist > 0.0f && (!h.hit || floorDist < h.t)) {
        result += ray.weight * (ray.reflected ? float3(u.rig.x) : u.background.rgb * u.glass.w);
        continue;
      }
      if (!h.hit) {
        float3 env = ray.reflected ? min(hybridEnv(ray.direction, u), float3(2.2f)) : u.background.rgb * u.glass.w;
        result += ray.weight * env;
        continue;
      }

      ray.weight *= exp(-ray.absorption * h.t);
      PtMaterial m = materials[h.material];
      float3 point = ray.origin + ray.direction * h.t;
      bool entering = dot(ray.direction, h.ng) < 0.0f;
      float3 ngFace = entering ? h.ng : -h.ng;
      // Resolve coincident LDraw glass-to-opaque contact planes deterministically:
      // if a glass exit face is pressed flat against a closed opaque brick, stepping 0.02 LDU
      // across the boundary places the probe inside that opaque brick (hitting its back wall
      // with dot(-ngFace, tie.ng) > 0), eliminating 1-ULP TIR z-fighting speckles at seams.
      if (!entering && ray.depth <= 2u && m.surface.w >= 0.5f && m.surface.w < 1.5f) {
        PtHit tie = ptTrace(point - ngFace * 0.02f, -ngFace, u, scene, instances, meshes);
        if (tie.hit && tie.t < 20.0f && materials[tie.material].surface.w < 0.5f && dot(-ngFace, tie.ng) > 0.0f) {
          m = materials[tie.material];
          h.material = tie.material;
          h.color = tie.color;
        }
      }
      float3 nsFace = (ray.depth == 0u && entering) ? h.ns : ngFace;
      if (dot(nsFace, -ray.direction) < 0.08f || dot(nsFace, ngFace) < 0.35f) nsFace = ngFace;

      // Hit an opaque brick inside or behind the glass: shade directly with studio lights + key shadow.
      if (m.surface.w < 0.5f) {
        float3 base = h.color != 0u ? ptLinear(h.color) : m.base.rgb;
        float3 lit = hybridShadeHit(base, m.surface.x, m.surface.y, m.surface.z, nsFace, -ray.direction,
                                    point, u, scene, instances, meshes, materials, true);
        result += ray.weight * min(lit, float3(2.2f));
        continue;
      }
      if (m.surface.w >= 1.5f) {
        if (size < 12) pending[size++] = HybridGlassRay{point + ray.direction * 0.02f, ray.direction, ray.weight, ray.absorption, ray.depth + 1u, ray.reflected};
        continue;
      }
      if (ray.depth >= 10u) continue;

      float eta = entering ? (1.0f / u.glass.x) : u.glass.x;
      // Use geometric normal ngFace for refraction so 0.25-LDU normal-fillet strips on flat
      // glass walls never act as 45-degree internal prisms causing TIR edge speckles.
      GlassInterface boundary = glassInterface(ray.direction, ngFace, eta);
      float3 reflected = normalize(reflect(ray.direction, nsFace));
      if (dot(reflected, ngFace) <= 1e-4f) {
        reflected = normalize(reflect(ray.direction, ngFace));
      }

      float3 reflWeight = ray.weight * boundary.fresnel;
      if (size < 11 && max(max(reflWeight.r, reflWeight.g), reflWeight.b) >= 0.015f) {
        pending[size++] = HybridGlassRay{point + ngFace * kPtEps, reflected, reflWeight, ray.absorption, ray.depth + 1u, true};
      }
      if (boundary.transmits && size < 12) {
        float3 absorption = entering ? u.glass.z * saturate(1.0f - m.base.rgb) : float3(0.0f);
        pending[size++] = HybridGlassRay{point - ngFace * kPtEps, boundary.transmitted,
                                         ray.weight * (1.0f - boundary.fresnel), absorption, ray.depth + 1u, ray.reflected};
      }
    }
    totalResult += result / float(ssCount);
  }

  glassResolved.write(float4(saturate(totalResult), 1.0f), gid);
}

// Stage 3: Half-resolution 1-spp instanced hardware-RT glossy reflections + colored indirect GI.
kernel void hybridRtGiRefl(
    constant PtUniforms& u [[buffer(0)]],
    constant AoUniforms& ao [[buffer(1)]],
    constant HybridRtUniforms& hru [[buffer(2)]],
    metal::raytracing::instance_acceleration_structure scene [[buffer(3)]],
    device const PtInstance* instances [[buffer(4)]],
    device const PtMesh* meshes [[buffer(5)]],
    device const PtMaterial* materials [[buffer(6)]],
    depth2d<float> depth [[texture(0)]],
    texture2d<float, access::read> shares [[texture(1)]],
    texture2d<float, access::write> giOut [[texture(2)]],
    texture2d<float, access::write> reflOut [[texture(3)]],
    uint2 gid [[thread_position_in_grid]]) {
  uint halfW = uint(ao.size.y), halfH = uint(ao.size.z);
  if (gid.x >= halfW || gid.y >= halfH) return;

  int2 at = int2(gid) * int(ao.grid.x);
  float4 p = viewPoint(depth, at, ao);
  if (p.w == 0.0f) {
    giOut.write(float4(0.0f, 0.0f, 0.0f, 1.0f), gid);
    reflOut.write(float4(0.0f), gid);
    return;
  }

  // Reconstruct world-space position & normal from full-res depth buffer (zero primary rays!).
  float4 l = viewPoint(depth, at - int2(1, 0), ao), r = viewPoint(depth, at + int2(1, 0), ao);
  float4 t = viewPoint(depth, at - int2(0, 1), ao), b = viewPoint(depth, at + int2(0, 1), ao);
  float3 dx = (r.w > 0.0f && (l.w == 0.0f || abs(r.z - p.z) < abs(l.z - p.z))) ? r.xyz - p.xyz : p.xyz - l.xyz;
  float3 dy = (b.w > 0.0f && (t.w == 0.0f || abs(b.z - p.z) < abs(t.z - p.z))) ? p.xyz - b.xyz : t.xyz - p.xyz;
  float3 nView = normalize(cross(dx, dy));
  if (dot(nView, -p.xyz) < 0.0f) nView = -nView;

  float3 worldP = ao.eye.xyz + ao.right.xyz * p.x + ao.up.xyz * p.y - ao.forward.xyz * p.z;
  float3 worldN = normalize(ao.right.xyz * nView.x + ao.up.xyz * nView.y - ao.forward.xyz * nView.z);
  float3 viewW = normalize(ao.eye.xyz - worldP);
  float nv = saturate(dot(worldN, viewW));

  float4 share = shares.read(uint2(at));
  bool onFloor = share.a > 0.0f && abs(worldP.y - u.floorPlane.x) < 0.05f;
  if (onFloor) worldN = float3(0.0f, -1.0f, 0.0f);  // LDraw +Y down, floor normal points up (-Y)

  PtRng rng;
  rng.s = ptHash(gid.x + gid.y * 4099u + hru.frameIndex * 1181213u + 911u);

  // 1. Colored Indirect Diffuse GI (1 cosine-weighted hemisphere RT ray).
  float3 giDir = ptCosine(worldN, rng.next(), rng.next());
  float3 giRad = float3(0.0f);
  PtHit giHit = ptTrace(worldP + worldN * 0.05f, giDir, u, scene, instances, meshes);
  if (giHit.hit && giHit.t < 90.0f) {
    PtMaterial m = materials[giHit.material];
    float3 hp = worldP + worldN * 0.05f + giDir * giHit.t;
    float3 hn = dot(giHit.ns, -giDir) < 0.0f ? -giHit.ns : giHit.ns;
    float3 base = giHit.color != 0u ? ptLinear(giHit.color) : m.base.rgb;
    if (m.surface.w < 0.5f) {
      giRad = hybridShadeHit(base, m.surface.x, m.surface.y, m.surface.z, hn, -giDir, hp, u, scene, instances, meshes, materials, false);
    } else if (m.surface.w < 1.5f) {
      // Colored light transmitted/scattered from glass bricks.
      giRad = base * u.rig.x * 1.1f;
    }
  }
  giOut.write(float4(giRad, 1.0f), gid);

  // 2. Glossy Clearcoat Reflection (1 narrow GGX RT ray on opaque bricks, guarded against silhouette normals).
  float4 refl = float4(0.0f);
  float edgeJump = max(length(dx), length(dy));
  if (!onFloor && edgeJump < 2.2f) {
    float gWeight = 1.0f;
    float3 reflDir = ptGgx(worldN, viewW, 0.12f, rng.next(), rng.next(), gWeight);
    if (gWeight > 0.0f && dot(reflDir, worldN) > 0.05f) {
      PtHit rh = ptTrace(worldP + worldN * 0.12f, reflDir, u, scene, instances, meshes);
      if (rh.hit && rh.t > 0.35f) {
        PtMaterial m = materials[rh.material];
        float3 hp = worldP + worldN * 0.12f + reflDir * rh.t;
        float3 hn = dot(rh.ns, -reflDir) < 0.0f ? -rh.ns : rh.ns;
        float3 base = rh.color != 0u ? ptLinear(rh.color) : m.base.rgb;
        float3 rCol;
        if (m.surface.w < 0.5f) {
          rCol = hybridShadeHit(base, m.surface.x, m.surface.y, m.surface.z, hn, -reflDir, hp, u, scene, instances, meshes, materials, false);
        } else {
          float gf = ptFresnel(saturate(dot(hn, -reflDir)), 1.0f / u.glass.x);
          rCol = mix(base * u.background.rgb * 0.9f, min(hybridEnv(reflect(reflDir, hn), u), float3(2.0f)), gf);
        }
        float fresnel = 0.04f + 0.96f * pow(1.0f - nv, 5.0f);
        refl = float4(min(rCol, float3(1.8f)), saturate(fresnel * 0.85f));
      }
    }
  }
  reflOut.write(refl, gid);
}

// Stage 4: GPU Temporal Reprojection (SVGF-style exponential moving average across frames).
kernel void hybridRtTemporal(
    constant AoUniforms& ao [[buffer(0)]],
    constant HybridRtUniforms& hru [[buffer(1)]],
    depth2d<float> depth [[texture(0)]],
    texture2d<float, access::read> shares [[texture(1)]],
    texture2d<float, access::read> giCur [[texture(2)]],
    texture2d<float, access::read> reflCur [[texture(3)]],
    texture2d<float, access::read> giPrev [[texture(4)]],
    texture2d<float, access::read> reflPrev [[texture(5)]],
    texture2d<float, access::read> depthPrev [[texture(6)]],
    texture2d<float, access::write> giHistOut [[texture(7)]],
    texture2d<float, access::write> reflHistOut [[texture(8)]],
    texture2d<float, access::write> depthHistOut [[texture(9)]],
    uint2 gid [[thread_position_in_grid]]) {
  uint halfW = uint(ao.size.y), halfH = uint(ao.size.z);
  if (gid.x >= halfW || gid.y >= halfH) return;

  int2 at = int2(gid) * int(ao.grid.x);
  float4 p = viewPoint(depth, at, ao);
  float4 g = giCur.read(gid);
  float4 r = reflCur.read(gid);
  if (p.w == 0.0f) {
    giHistOut.write(g, gid);
    reflHistOut.write(r, gid);
    depthHistOut.write(float4(0.0f), gid);
    return;
  }

  float z = -p.z;
  float3 worldP = ao.eye.xyz + ao.right.xyz * p.x + ao.up.xyz * p.y - ao.forward.xyz * p.z;
  float onFloor = (shares.read(uint2(at)).a > 0.5f) ? 1.0f : 0.0f;
  depthHistOut.write(float4(z, onFloor, 0.0f, 1.0f), gid);

  if (hru.hasHistory != 0u) {
    // 3x3 neighborhood clamping bounds to eliminate temporal ghosting during camera motion.
    float4 gMin = g, gMax = g, rMin = r, rMax = r;
    for (int dy = -1; dy <= 1; dy++) {
      for (int dx = -1; dx <= 1; dx++) {
        if (dx == 0 && dy == 0) continue;
        uint2 nb = uint2(clamp(int2(gid) + int2(dx, dy), int2(0), int2(int(halfW) - 1, int(halfH) - 1)));
        float4 ng = giCur.read(nb);
        float4 nr = reflCur.read(nb);
        gMin = min(gMin, ng); gMax = max(gMax, ng);
        rMin = min(rMin, nr); rMax = max(rMax, nr);
      }
    }
    float4 prevClip = hru.prevViewProj * float4(worldP, 1.0f);
    if (prevClip.w > 1e-4f) {
      float2 prevNdc = prevClip.xy / prevClip.w;
      float2 prevUv = float2(prevNdc.x * 0.5f + 0.5f, 0.5f - prevNdc.y * 0.5f);
      if (prevUv.x >= 0.0f && prevUv.y >= 0.0f && prevUv.x < 1.0f && prevUv.y < 1.0f) {
        uint2 prevCell = uint2(clamp(int2(prevUv * float2(float(halfW), float(halfH))), int2(0), int2(int(halfW) - 1, int(halfH) - 1)));
        float4 pd = depthPrev.read(prevCell);
        if (pd.w > 0.5f && abs(pd.y - onFloor) < 0.5f && abs(pd.x - z) / max(z, 1e-4f) < 0.025f) {
          float4 pg = clamp(giPrev.read(prevCell), gMin, gMax);
          float4 pr = clamp(reflPrev.read(prevCell), rMin, rMax);
          float alpha = 0.16f;
          g = mix(pg, g, alpha);
          r = mix(pr, r, alpha);
        }
      }
    }
  }

  giHistOut.write(g, gid);
  reflHistOut.write(r, gid);
}
