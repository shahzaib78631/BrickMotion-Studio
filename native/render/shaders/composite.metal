// The last pass: background where nothing was drawn, occlusion, transparency, the selection outline, and out as sRGB.

// A half-size picture at a full-size pixel: its four nearest cells, each weighted as bilinear
// filtering would and by how near its depth is to the pixel's, so that what was worked out on
// one surface does not bleed onto another across a silhouette. Reversed depth is about 1 / the
// distance, so a relative difference in it is one in distance.
float2 upsample(texture2d<float> coarse, depth2d<float> depth, bool onFloor, uint2 at, int stride) {
  int2 halfSize = int2(coarse.get_width(), coarse.get_height()), fullSize = int2(depth.get_width(), depth.get_height());
  float centre = depth.read(at);
  float2 h = (float2(at) + 0.5) / float(stride) - 0.5;
  int2 base = int2(floor(h));
  float2 f = h - float2(base);
  float2 sum = 0;
  float weight = 0, best = 1e9;
  float2 nearest = float2(1.0);
  for (int k = 0; k < 4; k++) {
    int2 cell = clamp(base + int2(k & 1, k >> 1), int2(0), halfSize - 1);
    float d = depth.read(uint2(clamp(cell * stride, int2(0), fullSize - 1)));
    float apart = abs(d - centre) / max(centre, 1e-6);
    float4 sample = coarse.read(uint2(cell));
    if (sample.a < 0.5 || (sample.b > 0.5) != onFloor) continue;
    float2 v = sample.rg;
    float w = ((k & 1) ? f.x : 1.0 - f.x) * ((k >> 1) ? f.y : 1.0 - f.y) * exp(-apart / 0.02);
    sum += v * w, weight += w;
    if (apart < best) best = apart, nearest = v;
  }
  return weight > 1e-4 ? sum / weight : nearest;
}

// The floor is sampled independently of the foreground depth. At an antialiased
// silhouette, the resolved MSAA depth is sample 0 (often the *brick*), whereas
// the floor and its coverage can occupy the other three samples. Rejecting
// floor-light samples against that brick depth makes an unshadowed bright rim.
// The floor is a single plane: nearby floor-light samples can be interpolated
// spatially without crossing any depth discontinuity *on the floor itself*.
float upsampleFloor(texture2d<float> coarse, uint2 at, int stride) {
  int2 size = int2(coarse.get_width(), coarse.get_height());
  float2 h = (float2(at) + 0.5) / float(stride) - 0.5;
  int2 base = int2(floor(h));
  float2 f = fract(h);
  float sum = 0.0, weight = 0.0;
  for (int k = 0; k < 4; ++k) {
    int2 q = clamp(base + int2(k & 1, k >> 1), int2(0), size - 1);
    float4 sample = coarse.read(uint2(q));
    // .b identifies the floor; .a identifies valid depth. Do not mix brick AO
    // (also in .r) into the floor light, even where they share an MSAA pixel.
    if (sample.b < 0.5 || sample.a < 0.5) continue;
    float w = ((k & 1) ? f.x : 1.0 - f.x) * ((k >> 1) ? f.y : 1.0 - f.y);
    sum += sample.r * w;
    weight += w;
  }
  if (weight > 1e-4) return sum / weight;

  // Only the few pixels right against a silhouette need this fallback: the
  // nearest half-resolution cell may contain the object at sample 0, leaving
  // no floor sample in the bilinear footprint. A short local search recovers
  // the floor light from just outside the silhouette. The common path above
  // costs only four reads and needs no extra render target or pass.
  float closest = 1e9, light = 1.0;
  for (int y = -2; y <= 2; ++y)
    for (int x = -2; x <= 2; ++x) {
      int2 q = clamp(base + int2(x, y), int2(0), size - 1);
      float4 sample = coarse.read(uint2(q));
      if (sample.b < 0.5 || sample.a < 0.5) continue;
      float d = dot(float2(q) - h, float2(q) - h);
      if (d < closest) { closest = d; light = sample.r; }
    }
  return light;
}

float4 upsample4(texture2d<float> coarse, depth2d<float> depth, texture2d<float> ambient, bool onFloor, uint2 at, int stride) {
  int2 halfSize = int2(coarse.get_width(), coarse.get_height()), fullSize = int2(depth.get_width(), depth.get_height());
  float centre = depth.read(at);
  float2 h = (float2(at) + 0.5) / float(stride) - 0.5;
  int2 base = int2(floor(h));
  float2 f = h - float2(base);
  float4 sum = float4(0.0);
  float weight = 0.0, best = 1e9;
  float4 nearest = float4(0.0, 0.0, 0.0, 1.0);
  for (int k = 0; k < 4; k++) {
    int2 cell = clamp(base + int2(k & 1, k >> 1), int2(0), halfSize - 1);
    int2 cFull = clamp(cell * stride, int2(0), fullSize - 1);
    float d = depth.read(uint2(cFull));
    if (d <= 0.0) continue;
    bool cFloor = ambient.read(uint2(cFull)).a > 0.5;
    if (cFloor != onFloor) continue;
    float apart = abs(d - centre) / max(centre, 1e-6);
    float4 sample = coarse.read(uint2(cell));
    float w = ((k & 1) ? f.x : 1.0 - f.x) * ((k >> 1) ? f.y : 1.0 - f.y) * exp(-apart / 0.02);
    sum += sample * w, weight += w;
    if (apart < best) best = apart, nearest = sample;
  }
  return weight > 1e-4 ? sum / weight : nearest;
}

fragment float4 compositeFragment(ScreenOut in [[stage_in]], constant int& lightingStride [[buffer(0)]],
                                  constant FrameUniforms& frame [[buffer(1)]], texture2d<float> scene [[texture(0)]], texture2d<float> accum [[texture(1)]],
                                  texture2d<float> reveal [[texture(2)]], texture2d<float> mask [[texture(3)]], texture2d<float> ambient [[texture(4)]],
                                  texture2d<float> occlusion [[texture(5)]], depth2d<float> depth [[texture(6)]], texture2d<float> giSoft [[texture(7)]],
                                  texture2d<float> ssrSoft [[texture(8)]], texture2d<float> glassResolved [[texture(9)]],
                                  texture2d<float> neuralReflTex [[texture(10)]], sampler smooth [[sampler(0)]]) {
  uint2 at = uint2(in.position.xy);
  float4 c = scene.read(at);
  // Ambient occlusion dims the light an opaque surface had from its surroundings, and the floor.
  // Occlusion (r) and the key light's shadow (g), worked out at half size and smoothed.
  // On the floor, r is instead the share of its light that reaches it.
  bool worked = frame.switches.x > 0.5 || frame.switches.y > 0.5;
  bool blend = frame.switches.w > 0.5;
  bool useSsgi = frame.rig.w > 0.5;
  bool studio = frame.grid.w > 0.5;
  bool useNeural = frame.eye.w > 0.5;
  float4 share = worked || blend || useSsgi || studio || useNeural ? ambient.read(at) : float4(0.0);
  float floorAo = 1.0;
  float4 giBrick = float4(0.0, 0.0, 0.0, 1.0);
  float4 ssrBrick = float4(0.0);
  float4 giFloor = float4(0.0, 0.0, 0.0, 1.0);
  float4 neural0 = float4(0.0, 0.0, 0.0, 1.0);
  float4 neural1 = float4(1.0, 1.0, 0.0, 0.0);
  float4 neuralRefl = float4(0.0);
  float4 neuralFloor0 = float4(0.0, 0.0, 0.0, 1.0);
  float4 neuralFloor1 = float4(1.0, 1.0, 0.0, 0.0);
  if (useNeural) {
    if (c.a > 1e-4) {
      neural0 = upsample4(giSoft, depth, ambient, false, at, lightingStride);
      neural1 = upsample4(ssrSoft, depth, ambient, false, at, lightingStride);
      neuralRefl = upsample4(neuralReflTex, depth, ambient, false, at, lightingStride);
    }
    if (share.g > 1e-4) {
      neuralFloor0 = upsample4(giSoft, depth, ambient, true, at, lightingStride);
      neuralFloor1 = upsample4(ssrSoft, depth, ambient, true, at, lightingStride);
    }
  } else if (useSsgi) {
    if (c.a > 1e-4) {
      giBrick = upsample4(giSoft, depth, ambient, false, at, lightingStride);
      ssrBrick = upsample4(ssrSoft, depth, ambient, false, at, lightingStride);
    }
    if (share.g > 1e-4) {
      giFloor = upsample4(giSoft, depth, ambient, true, at, lightingStride);
    }
  }
  float brickAo = 1.0;
  if (worked && c.a > 1e-4) {
    float2 seen = upsample(occlusion, depth, false, at, lightingStride);
    // When 3D World GI (`frame.plastic.w > 0.5`) is active, macro hemispherical occlusion is
    // already baked into brick.metal; keep HBAO as a mild local contact term instead of
    // stacking pow(seen.r, 2.64) on top of World GI.
    float aoExp = frame.rig.z * (studio ? (frame.plastic.w > 0.5 ? 0.55 : 1.10) : 1.0);
    brickAo = pow(seen.r, aoExp);
    if (studio) {
      // Full-res short-range micro-AO: crisp stud-base collars and brick-to-brick seam grooves.
      int2 fullSize = int2(depth.get_width(), depth.get_height());
      float dc = depth.read(at);
      if (dc > 0.0) {
        const int2 offs[8] = { int2(2, 0), int2(-2, 0), int2(0, 2), int2(0, -2),
                               int2(3, 3), int2(-3, 3), int2(3, -3), int2(-3, -3) };
        float microOcc = 0.0;
        for (int k = 0; k < 8; k++) {
          int2 q = clamp(int2(at) + offs[k], int2(0), fullSize - 1);
          float dq = depth.read(uint2(q));
          // Reversed depth: dq > dc means neighbour is closer to camera (stud wall / brick ledge).
          float rel = (dq - dc) / max(dc, 1e-6);
          if (rel > 0.00025 && rel < 0.014) {
            microOcc += smoothstep(0.00025, 0.0022, rel) * (1.0 - smoothstep(0.007, 0.014, rel));
          }
        }
        float microAo = 1.0 - saturate(microOcc / 8.0) * (frame.plastic.w > 0.5 ? 0.22 : 0.34);
        brickAo *= microAo;
      }
    }
    if (useNeural) {
      float keyPenumbra = pow(max(seen.g, 1e-4), max(1.0 + neural1.b, 0.5));
      float ambAo = saturate(pow(max(brickAo, 1e-4), 1.0 / max(neural0.a, 0.45)));
      // EyeSight's key light is a giant 45-degree-radius softbox (kRigSinSquared = 0.5):
      // thin overhangs (like rotor blades) only partially occlude the disk when the surrounding
      // sky hemisphere (`seen.r`) is open, while deep cavities keep full contact shadow.
      float softboxWrap = studio ? (0.38 * smoothstep(0.30, 0.85, seen.r)) : 0.0;
      float keySeen = saturate(mix(softboxWrap, 1.0, saturate(keyPenumbra * min(neural1.r, 1.05))));
      c.rgb *= saturate(1.0 - share.r * (1.0 - ambAo) - share.b * (1.0 - keySeen));
      brickAo = ambAo;
    } else {
      float keySeen = useSsgi ? min(seen.g, giBrick.a) : seen.g;
      c.rgb *= saturate(1.0 - share.r * (1.0 - brickAo) - share.b * (1.0 - keySeen));
    }
  } else if (useSsgi && c.a > 1e-4) {
    c.rgb *= saturate(1.0 - share.b * (1.0 - giBrick.a));
  }
  if (worked && share.g > 1e-4) {
    floorAo = upsampleFloor(occlusion, at, lightingStride);
    if (studio) floorAo = pow(saturate(floorAo), 1.18);
    if (useNeural) {
      float shadowMask = smoothstep(0.999, 0.965, floorAo);
      float shapedFloor = saturate(pow(max(floorAo, 1e-4), max(1.0 + neuralFloor1.b, 0.5)) * neuralFloor0.a);
      floorAo = mix(floorAo, shapedFloor, shadowMask);
    }
  }
  // MSAA resolves coverage, surface light, and floor coverage separately.
  // Reconstruct the covered surface and uncovered floor independently; applying
  // the floor shadow to the whole pixel instead brightens the uncovered part at
  // silhouettes *and* darkens brick samples that should not receive it.
  // Clamp only the per-sample light to white, preserving subpixel coverage.
  float coverage = saturate(c.a);
  float3 rawSurf = c.a > 1e-4 ? max(c.rgb / c.a, float3(0.0)) : float3(0.0);
  // Soft highlight roll-off in Studio Look so bright clearcoat glints roll off smoothly instead of clipping flat.
  float3 solid = studio ? (saturate((rawSurf * 1.16) / (1.0 + 0.16 * rawSurf)) * coverage) : (saturate(rawSurf) * coverage);
  if (useNeural && coverage > 1e-4) {
    // Physically-decoupled Neural Radiance & Surface Transport re-modulation at full MSAA resolution:
    // 1. Chromatic ABS cavity multiple-scattering (restores warm multi-bounce saturation in occluded crevices).
    // 2. Demodulated multi-bounce indirect irradiance (neural0.rgb) from neighboring 3D geometry.
    // 3. Key-coupled direct radiance transfer (neural1.r) and glossy specular modulation (neural1.g).
    float3 surf = saturate(rawSurf);
    float surfSat = max(surf.r, max(surf.g, surf.b)) - min(surf.r, min(surf.g, surf.b));
    float occLoss = saturate(share.r * (1.0 - brickAo));
    float3 cavityScatter = surf * (0.35 + 0.65 * surfSat) * (occLoss * neural1.a);
    float3 giBounce = neural0.rgb * (0.20 * float3(1.0) + 0.80 * surf) * (0.15 + 0.70 * occLoss) * frame.neuralGlass1.z;
    float3 specPeak = max(rawSurf - float3(0.65), float3(0.0));
    // Clamp negative keyBoost so 3D ray-traced stud shadows in neural1.r never double-darken ambient light.
    float keyBoost = share.b * clamp(neural1.r - 1.0, -0.04, 0.25) * 0.32;
    float3 neuralSurf = rawSurf * (1.0 + keyBoost) + cavityScatter + giBounce + specPeak * (neural1.g - 1.0);
    // 4. Exact 3D Hardware-Ray-Traced Glossy Clearcoat & Base Specular Reflection Transport:
    // Replaces ONLY the achromatic white studio sky specular surviving in rawSurf (never subtracting
    // into saturated brick diffuse albedo) with the 3D ray-traced reflected brick radiance.
    if (studio && neuralRefl.a > 1e-4) {
      float achromaticFloor = min(rawSurf.r, min(rawSurf.g, rawSurf.b));
      float ambSurvive = saturate(1.0 - share.r * (1.0 - brickAo));
      float maxSkySpec = min(frame.rig.x * neuralRefl.a * ambSurvive, achromaticFloor * 0.85);
      neuralSurf = max(neuralSurf - float3(maxSkySpec), float3(0.0)) + neuralRefl.rgb * 0.90;
    }
    solid = (studio ? saturate((neuralSurf * 1.06) / (1.0 + 0.06 * neuralSurf)) : saturate(neuralSurf)) * coverage;
  } else if (useSsgi && coverage > 1e-4) {
    // Energy-conserving colored indirect bounce: only replaces occluded white-world ambient
    // in crevices (zero grey lift on black bricks, no double-counting on lit faces).
    float3 surf = solid / coverage;
    float occluded = share.r * (1.0 - brickAo);
    float3 bounce = giBrick.rgb * surf * (0.28 * occluded);
    // Physical clearcoat reflection of neighboring bricks and transparent glass.
    float3 refl = mix(surf + bounce, ssrBrick.rgb, saturate(ssrBrick.a * 0.75));
    solid = saturate(refl) * coverage;
  }
  float floorCoverage = min(saturate(share.g), 1.0 - coverage);
  float freeCoverage = max(1.0 - coverage - floorCoverage, 0.0);
  float3 floorCol = frame.background.rgb * floorAo;
  if (useNeural && floorCoverage > 1e-4) {
    floorCol = saturate(floorCol + neuralFloor0.rgb * (0.06 * (1.0 - floorAo)) * frame.neuralGlass1.w);
  } else if (useSsgi && floorCoverage > 1e-4) {
    // Subtle colored bounce from nearby bricks onto the shadowed studio floor.
    floorCol = saturate(floorCol + giFloor.rgb * (0.10 * (1.0 - floorAo)));
  }
  float3 behind = solid + frame.background.rgb * freeCoverage + floorCol * floorCoverage;
  float3 out = behind;
  if (blend) {
    // The transparent layers let through exp(-depth) of what is behind and cover it with their weighted mean colour.
    float4 depthOf = reveal.read(at);
    if (any(depthOf != 0.0) || share.a > share.g) {
      float4 sum = accum.read(at);
      // The floor seen through glass is where the glass cleared the floor's uncovered share.
      float f0 = (frame.glass.z - 1.0) / (frame.glass.z + 1.0);
      f0 *= f0;
      float glassIn = saturate(depthOf.a / -log(1.0 - 2.0 * f0 / (1.0 + f0)));
      float through = saturate(share.a - share.g) + saturate(1.0 - c.a - share.a) * glassIn;
      if (useNeural) {
        // Multi-wall Beer-Lambert internal reflection absorption, TIR horizon attenuation,
        // and calibrated floor-through-glass shadow-catcher coupling.
        float floorCoupling = frame.neuralGlass0.w;
        behind = max(behind - frame.background.rgb * through * (1.0 - frame.glass.y) * floorCoupling, float3(0.0));
        float3 mean = sum.a > 1e-6 ? sum.rgb / sum.a : float3(0);
        float3 internalTint = exp(-depthOf.rgb * frame.neuralGlass0.x);
        float multiWall = max(depthOf.a - frame.neuralGlass0.z, 0.0);
        float tirDecay = exp(-multiWall * frame.neuralGlass0.y);
        float3 transDepth = depthOf.rgb * frame.neuralGlass1.y + depthOf.a * (1.0 + frame.neuralGlass1.x);
        out = saturate(behind * exp(-transDepth) + mean * internalTint * tirDecay * (1.0 - exp(-depthOf.a)));
      } else {
        behind -= frame.background.rgb * through * (1.0 - frame.glass.y);
        float3 mean = sum.a > 1e-6 ? sum.rgb / sum.a : float3(0);
        out = behind * exp(-depthOf.rgb - depthOf.a) + mean * (1.0 - exp(-depthOf.a));
      }
    }
  }
  if (useSsgi || studio) {
    float4 gr = glassResolved.read(at);
    if (gr.a > 0.5) out = gr.rgb;
  }
  // The selection's outline: just outside where the selected pieces are, within its width.
  int width = int(frame.selection.w);
  if (width > 0 && mask.read(at).r < 0.5) {
    int2 size = int2(mask.get_width(), mask.get_height());
    bool near = false;
    for (int dy = -width; dy <= width && !near; dy++)
      for (int dx = -width; dx <= width && !near; dx++) {
        if (dx * dx + dy * dy > width * width) continue;
        int2 q = clamp(int2(at) + int2(dx, dy), int2(0), size - 1);
        near = mask.read(uint2(q)).r > 0.5;
      }
    if (near) out = frame.selection.rgb;
  }
  return float4(out, 1.0);
}
