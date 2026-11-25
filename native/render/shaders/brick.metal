// The bricks themselves: one draw per mesh, material and level of detail, many instances.

// World-space diffuse directional probes. Same float4 layout as src/metal/impl.h.
struct WorldGiUniforms {
  float4 originStep;
  float4 shapeGain;
};

float3 legoProbeCoord(float3 world, float3 n, constant WorldGiUniforms& cache) {
  const float step = 1.0 / max(cache.originStep.w, 1e-6);
  const float3 position = world + n * (0.35 * step);
  return ((position - cache.originStep.xyz) * cache.originStep.w + 0.5) / cache.shapeGain.xyz;
}

float4 cachedLegoTransport(float3 uvw, float3 n,
                           texture3d<float> xp, texture3d<float> xn, texture3d<float> yp,
                           texture3d<float> yn, texture3d<float> zp, texture3d<float> zn,
                           sampler linearSampler) {
  if (any(uvw < float3(0.0)) || any(uvw > float3(1.0))) return float4(0.0, 0.0, 0.0, 1.0);
  const float3 positive = max(n, float3(0.0));
  const float3 negative = max(-n, float3(0.0));
  const float sum = max(positive.x + positive.y + positive.z +
                        negative.x + negative.y + negative.z, 1e-5);
  float4 incident = float4(0.0);
  if (positive.x > 0.0) incident += xp.sample(linearSampler, uvw) * positive.x;
  if (negative.x > 0.0) incident += xn.sample(linearSampler, uvw) * negative.x;
  if (positive.y > 0.0) incident += yp.sample(linearSampler, uvw) * positive.y;
  if (negative.y > 0.0) incident += yn.sample(linearSampler, uvw) * negative.y;
  if (positive.z > 0.0) incident += zp.sample(linearSampler, uvw) * positive.z;
  if (negative.z > 0.0) incident += zn.sample(linearSampler, uvw) * negative.z;
  return float4(min(incident.rgb / sum, float3(4.0)), saturate(incident.a / sum));
}

float4 cachedStudioVisibility(float3 uvw, texture3d<float> fourLights, sampler linearSampler) {
  if (any(uvw < float3(0.0)) || any(uvw > float3(1.0))) return float4(1.0);
  return fourLights.sample(linearSampler, uvw);
}

struct BrickIn {
  float3 position [[attribute(0)]];
  float3 normal [[attribute(1)]];
  float4 color [[attribute(2)]];  // the bytes of 0xAARRGGBB: b, g, r, a; a = 0 means the piece's own colour
};

struct BrickOut {
  float4 position [[position]];
  float3 world;
  float3 normal;
  float4 fixedColor;  // rgb linear; a: 1 if this corner has a colour of its own
  uint piece [[flat]];
  uint flags [[flat]];
};

vertex BrickOut brickVertex(BrickIn in [[stage_in]], uint iid [[instance_id]], constant FrameUniforms& frame [[buffer(1)]], constant DrawUniforms& draw [[buffer(2)]],
                            const device InstanceData* instances [[buffer(3)]], const device uint* visible [[buffer(4)]]) {
  InstanceData inst = instances[visible[iid]];
  BrickOut out;
  out.world = placePoint(inst, in.position);
  out.normal = placeNormal(inst, in.normal) * draw.flip.x;
  out.position = frame.viewProj * float4(out.world, 1.0);
  out.fixedColor = float4(linearFromSrgb(in.color.zyx), in.color.a);
  out.piece = inst.piece;
  out.flags = inst.flags;
  return out;
}

// What a surface of this roughness reflects of an even surrounding, by angle (Karis's fit to
// the split-sum table), so no table has to be made and kept.
float3 surroundReflectance(float3 f0, float roughness, float nv) {
  const float4 c0 = float4(-1.0, -0.0275, -0.572, 0.022), c1 = float4(1.0, 0.0425, 1.04, -0.04);
  float4 r = roughness * c0 + c1;
  float a004 = min(r.x * r.x, exp2(-9.28 * nv)) * r.x + r.y;
  float2 ab = float2(-1.04, 1.04) * a004 + r.zw;
  return f0 * ab.x + ab.y;
}

// The key light on a GGX surface: returns the mirror-like part; the matt part is added by the caller.
float ggx(float nh, float nv, float nl, float roughness) {
  float a = max(roughness * roughness, 2e-3), a2 = a * a;
  float d = nh * nh * (a2 - 1.0) + 1.0;
  float distribution = a2 / (3.14159265 * d * d);
  float visibility = 0.5 / max(nl * sqrt(nv * nv * (1.0 - a2) + a2) + nv * sqrt(nl * nl * (1.0 - a2) + a2), 1e-5);
  return distribution * visibility;
}

// Light from a distant disk of angular radius asin(sqrt(sinSquared)) on a face whose normal is
// at cos theta to its centre, as a share of what the disk gives a face square on to it: cos
// theta while the disk is wholly above the face's horizon, less as it sinks below (Lagarde and
// de Rousiers, "Moving Frostbite to PBR", 2014, the sphere-light formula).
float diskLight(float cosTheta, float sinSquared) {
  float c = clamp(cosTheta, -1.0, 1.0);
  if (c * c > sinSquared) return max(c, 0.0);
  float sinTheta = sqrt(1.0 - c * c);
  float x = sqrt(1.0 / sinSquared - 1.0);
  float y = -x * (c / max(sinTheta, 1e-5));
  float sinThetaSqrtY = sinTheta * sqrt(max(1.0 - y * y, 0.0));
  float e = (c * acos(y) - x * sinThetaSqrtY) * sinSquared + atan(sinThetaSqrtY / x);
  return max(e, 0.0) / (3.14159265 * sinSquared);
}

float schlick(float f0, float cosine) { return f0 + (1.0 - f0) * pow(1.0 - saturate(cosine), 5.0); }

struct Lit {
  float3 color;
  float3 ambient;    // the part of it that ambient occlusion dims: the white world and the fill lights
  float3 key;        // the part the key light gave, which its shadow dims
  float3 aoDiffuse;  // diffuse-only share that AO can obscure; preserves clearcoat glints
};

// EyeSight's studio (tolerances.h kRig*, kWorldStrength): a uniform white world and four large
// distant disk lights, on plastic with a base layer (GGX) and a clear coat. A disk's mirror
// image is seen on a glossy face wherever the reflected view ray falls inside it, at the disk's
// radiance; roughness only softens its rim.
// With `shadowHere`, the key light's shadow is taken here; otherwise it is left to the last
// pass, which dims `key` by the shadow worked out (and smoothed) at half size.
Lit shade(float3 base, float roughness, float metalness, float clearcoat, float3 n, float3 v, float3 world, constant FrameUniforms& frame, bool shadowHere, uint2 at,
          depth2d<float> shadowMap, sampler shadowSampler) {
  float nv = max(dot(n, v), 1e-3);
  float3 f0 = mix(float3(0.0337), base, metalness), matt = base * (1.0 - metalness);  // IOR 1.45
  float3 r = reflect(-v, n);
  float coat = clearcoat * schlick(0.04, nv);
  float3 under = surroundReflectance(f0, roughness, nv);  // the base layer's mirror share, all angles
  bool studio = frame.grid.w > 0.5;
  float worldStrength = frame.rig.x * (studio ? 0.62 : 1.0), sinSquared = frame.rig.y;
  float cosRadius = sqrt(1.0 - sinSquared);

  // The white world: matt light and its reflection, both dimmed by occlusion later.
  float3 ambient = worldStrength * (matt * (1.0 - under) * (1.0 - coat) + under * (1.0 - coat) + coat);
  float3 direct = float3(0);
  for (int i = 0; i < 4; i++) {
    float3 l = frame.lights[i].xyz;
    float strength = frame.lights[i].w * (studio ? (i == 0 ? 1.24 : 0.68) : 1.0);
    // Matt (Lambert): irradiance / pi. The world, of radiance worldStrength all round, gives a matt face worldStrength.
    float3 light = matt * (1.0 - under) * (1.0 - coat) * strength * diskLight(dot(n, l), sinSquared) / 3.14159265;
    // The disk's mirror image: radiance strength / (pi sin^2), where the reflected ray meets it.
    float radiance = strength / (3.14159265 * sinSquared);
    float rl = dot(r, l);
    float soft = studio ? (0.015 + roughness * 0.22) : (0.02 + roughness * 0.5);
    float seen = smoothstep(cosRadius - soft, cosRadius + soft, rl) * step(0.0, dot(n, l) + 0.3);
    float coatSeen = smoothstep(cosRadius - (studio ? 0.014 : 0.02), cosRadius + (studio ? 0.014 : 0.02), rl) * step(0.0, dot(n, l) + 0.3);
    light += radiance * (under * (1.0 - coat) * seen + coat * coatSeen * (studio ? 1.35 : 1.0));
    if (studio && dot(n, l) > 0.0) {
      // Tight molded-ABS clearcoat specular glint on rounded bevels, stud rims, and cylinders.
      float3 h = normalize(v + l);
      float nh = max(dot(n, h), 0.0);
      float nl = max(dot(n, l), 0.0);
      float coatGgx = ggx(nh, nv, nl, 0.13) * coat * nl * strength * 0.38;
      light += float3(coatGgx);
    }
    if (i == 0) {
      if (shadowHere && frame.switches.x > 0.5) light *= keyShadow(world, n, frame, shadowMap, shadowSampler, tileTurn(uint2(at)));
      direct += light;
    } else {
      ambient += light;
    }
  }
  Lit out;
  out.ambient = ambient;
  out.key = direct;
  out.aoDiffuse = ambient;
  out.color = ambient + direct;
  return out;
}

float ggxDiskCoverage(float rimDistance, float elliptic, float roughness, float pixelAngle) {
  float alpha = max(roughness * roughness, 0.0025);
  float microAngle = 1.75 * alpha * elliptic;
  float width = sqrt(microAngle * microAngle + pixelAngle * pixelAngle);
  return smoothstep(-width * 1.25, width * 1.25, rimDistance);
}

float ggxG1(float cosTheta, float roughness) {
  float a = max(roughness * roughness, 0.002);
  float a2 = a * a;
  float c = saturate(cosTheta);
  return 2.0 * c / max(c + sqrt(a2 + (1.0 - a2) * c * c), 1e-4);
}

// Matched injection-molded ABS plastic BRDF with cached sky & studio-light visibility.
Lit shadePlasticMatched(float3 base, float roughness, float clearcoat, float3 n, float3 ng, float3 v,
                        constant FrameUniforms& frame, float sky, float4 lightVisibility, bool cached) {
  const float nv = max(dot(n, v), 1e-3);
  const float nvGeom = max(dot(ng, v), 1e-3);
  // Prevent normal-fillet strips (roundRenderEdges / softenStudRoots) from triggering a fake
  // grazing nv -> 0 Fresnel white-rim spike when the underlying geometric triangle is not grazing.
  const float nvFresnel = max(nv, nvGeom * 0.85);
  const float3 r = reflect(-v, n);
  // As in path_trace.metal (dot(dir, ng) <= 0), reflection rays that dive below the geometric
  // triangle plane are self-occluded by the face itself.
  const float reflHorizon = smoothstep(-0.02, 0.16, dot(r, ng));
  const float3 f0 = float3(0.0337);
  const float3 fresnel = f0 + (1.0 - f0) * pow(1.0 - saturate(nvFresnel), 5.0);
  const float coat = clearcoat * schlick(0.04, nvFresnel);
  const float3 diffuse = base * (1.0 - fresnel) * (1.0 - coat);
  const float3 worldSpec = surroundReflectance(f0, roughness, nvFresnel) * (1.0 - coat);
  const float3 worldDiffuse = frame.rig.x * diffuse * sky;
  // Detect concave stud-root collar strips (vertical stud wall ng with upward-bent normal n).
  const bool isStudRoot = abs(ng.y) < 0.25 && n.y < ng.y - 0.12;
  const float reflectedSky = (isStudRoot ? pow(saturate(sky), 1.25) : mix(1.0, sky, 0.20)) * reflHorizon;
  float3 ambient = worldDiffuse + frame.rig.x * (worldSpec + coat) * reflectedSky;
  // When 3D World GI (`cached`) is active, macro hemispherical sky & fill occlusion is already
  // baked into `sky` and `lightVisibility`; only pass a small contact share to HBAO so broad
  // overhangs (rotor blades, fuselage over skids) are never double-darkened.
  float3 aoDiffuse = cached
      ? (worldDiffuse * 0.35 + frame.rig.x * (worldSpec + coat) * reflectedSky * 0.30)
      : (worldDiffuse * 0.85 + frame.rig.x * (worldSpec + coat) * reflectedSky * 0.50);
  float3 key = float3(0.0);
  const float sin2 = frame.rig.y;
  const float cosRadius = sqrt(max(1.0 - sin2, 0.0));
  const float sinRadius = sqrt(max(sin2, 1e-5));
  const float baseG1 = ggxG1(nvFresnel, roughness);
  const float coatG1 = ggxG1(nvFresnel, 0.03);
  const float baseVis = baseG1 * baseG1 * reflHorizon;
  const float coatVis = coatG1 * coatG1 * reflHorizon;
  const float nvsq = nvFresnel * nvFresnel;

  for (int i = 0; i < 4; ++i) {
    float3 l = frame.lights[i].xyz;
    float strength = frame.lights[i].w * (i == 0 ? 1.0 : frame.plastic.y);
    if (i > 0) strength *= lightVisibility[i];
    float nl = dot(n, l);
    float rl = clamp(dot(r, l), -1.0, 1.0);
    float irradiance = strength * diskLight(nl, sin2) * (1.0 / 3.14159265);
    float3 light = diffuse * irradiance;
    // Do not use unclamped fwidth(rl): across 0.3-LDU rounded-edge fillet strips, n rotates 45-90 deg
    // in < 1 pixel, causing fwidth(rl) to explode to ~1.5 and paint white wireframe lines on every edge.
    const float pixelAngle = 0.016;
    float along = clamp((nl - nvFresnel * rl) * rsqrt(max((1.0 - nvsq) * (1.0 - rl * rl), 1e-6)), -1.0, 1.0);
    float elliptic = sqrt(nvsq + (1.0 - nvsq) * along * along);
    float rimDistance = (rl - cosRadius) / max(sinRadius, 1e-3);
    float lightHorizon = isStudRoot ? 0.0 : smoothstep(-0.04, 0.08, nl);
    float baseDisk = ggxDiskCoverage(rimDistance, elliptic, roughness, pixelAngle) * lightHorizon;
    float coatDisk = ggxDiskCoverage(rimDistance, elliptic, 0.03, pixelAngle) * lightHorizon;
    float diskRadiance = strength / (3.14159265 * sin2);
    float3 specLight = diskRadiance * ((1.0 - coat) * fresnel * baseDisk * baseVis + coat * coatDisk * coatVis);
    light += specLight;
    if (i == 0) key += light;
    else {
      ambient += light;
      if (!cached) aoDiffuse += diffuse * irradiance * 0.55;
    }
  }
  Lit out;
  out.ambient = ambient;
  out.key = key;
  out.aoDiffuse = aoDiffuse;
  out.color = ambient + key;
  return out;
}

// An opaque surface: its light, and the share of it that came from the surroundings.
struct OpaqueOut {
  float4 color [[color(0)]];
  float4 shares [[color(3)]];  // r: the share occlusion dims, b: the share the key's shadow dims; g, a: the floor's (0 here: not floor)
};

float luminanceOf(float3 c) { return dot(c, float3(0.2126, 0.7152, 0.0722)); }

fragment OpaqueOut brickFragment(BrickOut in [[stage_in]], constant FrameUniforms& frame [[buffer(1)]], constant DrawUniforms& draw [[buffer(2)]], depth2d<float> shadowMap [[texture(0)]],
                                  texture3d<float> giXP [[texture(2)]], texture3d<float> giXN [[texture(3)]],
                                  texture3d<float> giYP [[texture(4)]], texture3d<float> giYN [[texture(5)]],
                                  texture3d<float> giZP [[texture(6)]], texture3d<float> giZN [[texture(7)]],
                                  texture3d<float> studioVis [[texture(8)]],
                                  constant WorldGiUniforms& giCache [[buffer(8)]],
                                  sampler shadowSampler [[sampler(1)]], sampler linearSampler [[sampler(2)]]) {
  float3 base = in.fixedColor.a > 0.5 && draw.surface.w < 0.5 ? in.fixedColor.rgb : draw.base.rgb;
  float3 n = normalize(in.normal), v = normalize(frame.eye.xyz - in.world);
  float3 ngRaw = cross(dfdx(in.world), dfdy(in.world));
  float3 ng = dot(ngRaw, ngRaw) > 1e-12 ? normalize(ngRaw) : n;
  if (dot(ng, v) < 0.0) ng = -ng;
  if (dot(n, ng) < 0.0) n = ng;
  const bool matchedPlastic = frame.plastic.x > 0.5 && draw.surface.y < 0.05 &&
                              draw.surface.z > 0.0 && draw.surface.w < 0.5;
  const bool useCache = matchedPlastic && frame.plastic.w > 0.5;
  const float3 cacheUV = useCache ? legoProbeCoord(in.world, ng, giCache) : float3(-1.0);
  const float4 cacheLight = useCache ? cachedLegoTransport(cacheUV, n, giXP, giXN, giYP, giYN, giZP, giZN, linearSampler)
                                     : float4(0.0, 0.0, 0.0, 1.0);
  const float visibilityWeight = useCache ? saturate(giCache.shapeGain.w) : 0.0;
  const float sky = mix(1.0, cacheLight.a, visibilityWeight);
  const float4 fillVisibility = mix(float4(1.0),
      useCache ? cachedStudioVisibility(cacheUV, studioVis, linearSampler) : float4(1.0),
      visibilityWeight);
  Lit lit = matchedPlastic ? shadePlasticMatched(base, draw.surface.x, draw.surface.z, n, ng, v, frame, sky, fillVisibility,
                                                 useCache && visibilityWeight > 0.5)
                           : shade(base, draw.surface.x, draw.surface.y, draw.surface.z, n, v, in.world, frame, false, uint2(in.position.xy), shadowMap, shadowSampler);
  OpaqueOut out;
  if (useCache) {
    const float nv = max(dot(n, v), 1e-3);
    const float baseFresnel = schlick(0.0337, nv);
    const float coatFresnel = draw.surface.z * schlick(0.04, nv);
    lit.color += base * (1.0 - baseFresnel) * (1.0 - coatFresnel) * cacheLight.rgb;
  }
  out.color = float4(lit.color, 1.0);  // rgb times coverage, coverage
  if (frame.switches.z > 0.5) out.color = frame.switches.z < 1.5 ? float4(n * 0.5 + 0.5, 1.0) : float4(saturate((in.world.y + 128.0) / 256.0), 0.0, 0.0, 1.0);  // DEBUG HOOK
  float total = max(luminanceOf(lit.color), 1e-4);
  out.shares = float4(saturate(luminanceOf(lit.aoDiffuse) / total), 0.0, saturate(luminanceOf(lit.key) / total), 0.0);
  return out;
}

// Transparent pieces: weighted blended order-independent transparency (McGuire and Bavoil 2013).
// Every layer adds the colour it covers with, weighted by that coverage and nearness, to
// `accum`; and to `reveal` its optical depth: what it absorbs, per channel (rgb), and what it
// covers with that colour (a). The last pass divides the one sum by its weight and lets
// through exp(-reveal) of what is behind. Each layer's numbers are rounded to half precision
// here and summed in 32-bit targets, where a sum of a few of them is exact: the picture is the
// same whatever order the layers arrive in.
struct OitOut {
  float4 accum [[color(1)]];
  float4 reveal [[color(2)]];
  float4 shares [[color(3)]];  // glass only: g, 0 (the floor behind it is not open floor)
};

float oitWeight(float3 world, constant FrameUniforms& frame) {
  float depth = length(frame.eye.xyz - world) / frame.floorCentre.w;
  return clamp(0.03 / (1e-5 + depth * depth * depth * depth), 1e-2, 3e3);
}

// Glass (tolerances.h kGlass*): no matt light. A surface drawn is one wall, two faces: it
// lets through 1 - 2F / (1 + F) (a, in `reveal`), less what its colour absorbs along the ray
// inside it (rgb). What its mirror direction sees (the white world and the lights' disks) it
// returns from the outer face as it is, F of it, and from the inner face through the wall and
// back, F (1 - F)^2 t^2 of it, t being what the wall lets through.
fragment OitOut glassFragment(BrickOut in [[stage_in]], constant FrameUniforms& frame [[buffer(1)]], constant DrawUniforms& draw [[buffer(2)]]) {
  float3 base = in.fixedColor.a > 0.5 ? in.fixedColor.rgb : draw.base.rgb;
  float3 n = normalize(in.normal), v = normalize(frame.eye.xyz - in.world);
  float nv = saturate(abs(dot(n, v)));
  float ior = frame.glass.z, eta = 1.0 / ior;
  float inside = sqrt(max(0.0, 1.0 - eta * eta * (1.0 - nv * nv)));
  float rs = (eta * nv - inside) / max(eta * nv + inside, 1e-5);
  float rp = (nv - eta * inside) / max(nv + eta * inside, 1e-5);
  float f = 0.5 * (rs * rs + rp * rp);  // unpolarized exact dielectric Fresnel
  float reflects = 2.0 * f / (1.0 + f);
  float3 r = reflect(-v, n);
  float cosRadius = sqrt(1.0 - frame.rig.y);
  float3 seen = float3(frame.rig.x);
  for (int i = 0; i < 4; i++)
    seen += frame.lights[i].w / (3.14159265 * frame.rig.y) * smoothstep(cosRadius - 0.02, cosRadius + 0.02, dot(r, frame.lights[i].xyz));
  float3 absorbs = frame.glass.x * saturate(1.0 - base) / inside, through = exp(-absorbs);
  float walls = draw.flip.y;  // a box's face stands for both walls a ray through the part crosses
  float w = oitWeight(in.world, frame) * walls;
  OitOut out;
  out.accum = float4(half4(float4(seen * (f + f * (1.0 - f) * (1.0 - f) * through * through), reflects) * w));
  out.reveal = float4(half4(float4(absorbs, -log(max(1.0 - reflects, 1e-4))) * walls));
  out.shares = float4(0.0);
  return out;
}

// Anything else transparent (a placeholder): its colour over what is behind, at its opacity.

fragment OitOut transparentFragment(BrickOut in [[stage_in]], constant FrameUniforms& frame [[buffer(1)]], constant DrawUniforms& draw [[buffer(2)]],
                                   depth2d<float> shadowMap [[texture(0)]], sampler shadowSampler [[sampler(1)]]) {
  float3 base = in.fixedColor.a > 0.5 && draw.surface.w < 0.5 ? in.fixedColor.rgb : draw.base.rgb;
  float3 n = normalize(in.normal), v = normalize(frame.eye.xyz - in.world);
  Lit lit = shade(base, draw.surface.x, draw.surface.y, draw.surface.z, n, v, in.world, frame, true, uint2(in.position.xy), shadowMap, shadowSampler);
  float a = draw.base.a;
  float w = a * oitWeight(in.world, frame);
  OitOut out;
  out.accum = float4(half4(float4(lit.color * a, a) * w));
  out.reveal = float4(0.0, 0.0, 0.0, float(half(-log(max(1.0 - a, 1e-4)))));
  out.shares = float4(0.0);  // not written (pipelines.mm)
  return out;
}
