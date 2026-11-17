// The bricks themselves: one draw per mesh, material and level of detail, many instances.

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
  float3 ambient;  // the part of it that ambient occlusion dims: the white world and the fill lights
  float3 key;      // the part the key light gave, which its shadow dims
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
  float worldStrength = frame.rig.x, sinSquared = frame.rig.y;
  float cosRadius = sqrt(1.0 - sinSquared);

  // The white world: matt light and its reflection, both dimmed by occlusion later.
  float3 ambient = worldStrength * (matt * (1.0 - under) * (1.0 - coat) + under * (1.0 - coat) + coat);
  float3 direct = float3(0);
  for (int i = 0; i < 4; i++) {
    float3 l = frame.lights[i].xyz;
    float strength = frame.lights[i].w;
    // Matt (Lambert): irradiance / pi. The world, of radiance worldStrength all round, gives a matt face worldStrength.
    float3 light = matt * (1.0 - under) * (1.0 - coat) * strength * diskLight(dot(n, l), sinSquared) / 3.14159265;
    // The disk's mirror image: radiance strength / (pi sin^2), where the reflected ray meets it.
    float radiance = strength / (3.14159265 * sinSquared);
    float rl = dot(r, l);
    float soft = 0.02 + roughness * 0.5;
    float seen = smoothstep(cosRadius - soft, cosRadius + soft, rl) * step(0.0, dot(n, l) + 0.3);
    float coatSeen = smoothstep(cosRadius - 0.02, cosRadius + 0.02, rl) * step(0.0, dot(n, l) + 0.3);
    light += radiance * (under * (1.0 - coat) * seen + coat * coatSeen);
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
  out.color = ambient + direct;
  return out;
}

// An opaque surface: its light, and the share of it that came from the surroundings.
struct OpaqueOut {
  float4 color [[color(0)]];
  float4 shares [[color(3)]];  // r: the share occlusion dims, b: the share the key's shadow dims; g, a: the floor's (0 here)
};

float luminanceOf(float3 c) { return dot(c, float3(0.2126, 0.7152, 0.0722)); }

fragment OpaqueOut brickFragment(BrickOut in [[stage_in]], constant FrameUniforms& frame [[buffer(1)]], constant DrawUniforms& draw [[buffer(2)]], depth2d<float> shadowMap [[texture(0)]],
                                  sampler shadowSampler [[sampler(1)]]) {
  float3 base = in.fixedColor.a > 0.5 && draw.surface.w < 0.5 ? in.fixedColor.rgb : draw.base.rgb;
  float3 n = normalize(in.normal), v = normalize(frame.eye.xyz - in.world);
  Lit lit = shade(base, draw.surface.x, draw.surface.y, draw.surface.z, n, v, in.world, frame, false, uint2(in.position.xy), shadowMap, shadowSampler);
  OpaqueOut out;
  out.color = float4(lit.color, 1.0);  // rgb times coverage, coverage
  float total = max(luminanceOf(lit.color), 1e-4);
  out.shares = float4(saturate(luminanceOf(lit.ambient) / total), 0.0, saturate(luminanceOf(lit.key) / total), 0.0);
  return out;
}

// Transparent pieces: weighted blended order-independent transparency (McGuire and Bavoil 2013).
// Every layer adds its colour, weighted by opacity and nearness, to `accum`, and its optical
// depth (-log of what it lets through) to `reveal`; the last pass divides the one sum by its
// weight and takes exp(-reveal) as what all the layers let through together. Each layer's
// numbers are rounded to half precision here and summed in 32-bit targets, where a sum of a
// few of them is exact: the picture is the same whatever order the layers arrive in.
struct OitOut {
  float4 accum [[color(1)]];
  float reveal [[color(2)]];
};

fragment OitOut transparentFragment(BrickOut in [[stage_in]], constant FrameUniforms& frame [[buffer(1)]], constant DrawUniforms& draw [[buffer(2)]],
                                   depth2d<float> shadowMap [[texture(0)]], sampler shadowSampler [[sampler(1)]]) {
  float3 base = in.fixedColor.a > 0.5 && draw.surface.w < 0.5 ? in.fixedColor.rgb : draw.base.rgb;
  float3 n = normalize(in.normal), v = normalize(frame.eye.xyz - in.world);
  Lit lit = shade(base, draw.surface.x, draw.surface.y, draw.surface.z, n, v, in.world, frame, true, uint2(in.position.xy), shadowMap, shadowSampler);
  float a = draw.base.a;
  float depth = length(frame.eye.xyz - in.world) / frame.floorCentre.w;
  float w = a * clamp(0.03 / (1e-5 + depth * depth * depth * depth), 1e-2, 3e3);
  OitOut out;
  out.accum = float4(half4(float4(lit.color * a, a) * w));
  out.reveal = float(half(-log(max(1.0 - a, 1e-4))));
  return out;
}
