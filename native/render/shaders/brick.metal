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

float keyShadow(float3 world, float3 n, constant FrameUniforms& frame, depth2d<float> shadowMap, sampler shadowSampler);

struct Lit {
  float3 color;
  float3 ambient;  // the part of it that came from the surrounding, which ambient occlusion dims
};

Lit shade(float3 base, float roughness, float metalness, float clearcoat, float3 n, float3 v, float3 world, constant FrameUniforms& frame, texturecube<float> reflection, texturecube<float> received,
          depth2d<float> shadowMap, sampler smooth, sampler shadowSampler) {
  float nv = max(dot(n, v), 1e-3);
  float3 f0 = mix(float3(0.04), base, metalness), matt = base * (1.0 - metalness);
  float3 r = reflect(-v, n);
  float coatRough = frame.switches.w;
  float coat = clearcoat * surroundReflectance(float3(0.04), coatRough, nv).x;

  // From the surrounding.
  float3 ambient = matt * received.sample(smooth, n).rgb + reflection.sample(smooth, r, level(roughness * frame.switches.z)).rgb * surroundReflectance(f0, roughness, nv);
  ambient = ambient * (1.0 - coat) + reflection.sample(smooth, r, level(coatRough * frame.switches.z)).rgb * coat;

  // From the key light.
  float3 l = frame.keyDirection.xyz;
  float nl = dot(n, l);
  float3 direct = float3(0);
  if (nl > 0) {
    float3 h = normalize(l + v);
    float nh = max(dot(n, h), 0.0), vh = max(dot(v, h), 0.0);
    float3 fresnel = f0 + (1.0 - f0) * pow(1.0 - vh, 5.0);
    float3 under = matt / 3.14159265 + fresnel * ggx(nh, nv, nl, roughness);
    float coatFresnel = clearcoat * (0.04 + 0.96 * pow(1.0 - vh, 5.0));
    direct = (under * (1.0 - coatFresnel) + coatFresnel * ggx(nh, nv, nl, coatRough)) * nl * frame.keyDirection.w;
    if (frame.switches.x > 0.5) direct *= keyShadow(world, n, frame, shadowMap, shadowSampler);
  }
  Lit out;
  out.ambient = ambient;
  out.color = ambient + direct;
  return out;
}

fragment float4 brickFragment(BrickOut in [[stage_in]], constant FrameUniforms& frame [[buffer(1)]], constant DrawUniforms& draw [[buffer(2)]], texturecube<float> reflection [[texture(0)]],
                                  texturecube<float> received [[texture(1)]], depth2d<float> shadowMap [[texture(2)]], sampler smooth [[sampler(0)]], sampler shadowSampler [[sampler(1)]]) {
  float3 base = in.fixedColor.a > 0.5 && draw.surface.w < 0.5 ? in.fixedColor.rgb : draw.base.rgb;
  float3 n = normalize(in.normal), v = normalize(frame.eye.xyz - in.world);
  Lit lit = shade(base, draw.surface.x, draw.surface.y, draw.surface.z, n, v, in.world, frame, reflection, received, shadowMap, smooth, shadowSampler);
  return float4(lit.color, 1.0);  // rgb times coverage, coverage
}
