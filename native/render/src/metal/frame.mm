// One frame: which instances, at which detail, in which order, into which targets.
#import "metal/impl.h"
#import "metal/path_impl.h"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <sstream>
#include <string>
#include "bmr/cull.h"
#include "bmr/material.h"
#include "bmr/tolerances.h"

namespace bmr {
FrameStats Renderer::Impl::draw(const Camera& camera, const FrameOptions& options, id<CAMetalDrawable> drawable) {
  FrameStats stats;
  const auto started = std::chrono::steady_clock::now();
  id<MTLTexture> target = drawable ? drawable.texture : final;
  if (!target || width < 1 || height < 1 || !colorMs) return stats;
  if (drawable && (static_cast<int>(target.width) != width || static_cast<int>(target.height) != height)) return stats;  // the layer has not caught up with a resize
  if (options.realtimePathTrace && !options.wireframe) {
    const FrameStats rt = drawRealtimePathTraced(camera, options, drawable);
    if (rt.submitted) return rt;
  } else {
    rtptHasHistory = false;
    rtptStillFrames = 0;
  }
  if (options.pathTraced && camera.orthoHalfHeight <= 0) {
    const FrameStats pt = drawPathTraced(camera, options, drawable);
    if (pt.submitted) return pt;
  }

  // Which instances, at which detail: what the eye sees (opaque groups first, as the scene
  // orders them, then transparent ones), and what the maps are drawn from (below).
  const bool forced = options.forceDetail >= 0 && options.forceDetail <= 2;
  cullInto(inView, scene, parts, camera, height, options.forceDetail, options.cull, options.edges);
  auto& list = nextList;
  auto& seen = nextSeen;
  list.clear();
  seen.clear();
  auto add = [&](std::vector<Batch>& into, uint32_t g, Detail d, const std::vector<uint32_t>& instances, bool top = false) {
    const Group& group = scene.groups[g];
    for (int mirrored = 0; mirrored < 2; mirrored++) {
      const uint32_t first = static_cast<uint32_t>(list.size());
      for (uint32_t i : instances)
        if (((group.instances[i].flags & kMirrored) != 0) == (mirrored != 0)) list.push_back(i);
      if (list.size() > first) into.push_back({g, d, mirrored != 0, first, static_cast<uint32_t>(list.size()) - first, top});
    }
  };
  std::vector<Batch> outlined;  // whose outlines show, at the detail they are drawn at
  for (uint32_t g = 0; g < scene.groups.size(); g++) {
    // Seen from above, a piece's underside (the tubes and pins in it) is left out.
    for (int d = 0; d < 2; d++) {
      add(seen, g, static_cast<Detail>(d), inView[g].above[d], true);
      add(seen, g, static_cast<Detail>(d), inView[g].below[d]);
    }
    add(seen, g, Detail::Box, inView[g].byDetail[2]);
    if (options.edges)
      for (int d = 0; d < 2; d++) add(outlined, g, static_cast<Detail>(d), inView[g].edges[d]);
    stats.culled += inView[g].culled;
  }
  const bool glassInView = !options.clay && std::any_of(seen.begin(), seen.end(), [&](const Batch& batch) {
    const Group& g = scene.groups[batch.group];
    return g.material.transparent() && !g.placeholder;
  });
  const bool needsBlend = glassInView || !preview.empty() || std::any_of(seen.begin(), seen.end(), [&](const Batch& batch) {
    return scene.groups[batch.group].placeholder;
  });
  const bool refract = glassInView && options.refractiveGlass && camera.orthoHalfHeight <= 0;
  if (refract) prepareGlass();

  // What casts, into the key light's depth map and the height map over the model: every opaque
  // piece shown, in view or not (one out of view can shadow one in it), at low detail without
  // studs unless a detail is forced (a shadow does not show a stud's sides).
  const int casterDetail = forced ? options.forceDetail : static_cast<int>(Detail::Shadow);
  LightRig rig = studioLights(camera, options.lightsFollowCamera && !getenv("BM_LIGHTS_FIXED"));  // DEBUG HOOK: BM_LIGHTS_FIXED
  if (const char* turn = getenv("BM_RIG_TURN")) {  // DEBUG HOOK: the rig turned about the vertical (degrees)
    const double t = atof(turn) * M_PI / 180, c = std::cos(t), sn = std::sin(t);
    for (int i = 0; i < 4; i++) rig.toward[i] = bm::Vec3{rig.toward[i].x * c - rig.toward[i].z * sn, rig.toward[i].y, rig.toward[i].x * sn + rig.toward[i].z * c};
  }
  float hookWorld = kWorldStrength;  // DEBUG HOOK
  if (const char* sc = getenv("BM_RIG_SCALE")) {  // DEBUG HOOK: key,RL,FR,RR,world scales
    float f[5] = {1, 1, 1, 1, 1};
    sscanf(sc, "%f,%f,%f,%f,%f", &f[0], &f[1], &f[2], &f[3], &f[4]);
    for (int i = 0; i < 4; i++) rig.strength[i] *= f[i];
    hookWorld *= f[4];
  }  // DEBUG HOOK: BM_LIGHT_ONLY=k (light k alone, as the key) or 9 (the world alone)
  if (const char* only = getenv("BM_LIGHT_ONLY")) {
    const int k = atoi(only);
    if (k >= 0 && k < 4) std::swap(rig.toward[0], rig.toward[k]), std::swap(rig.strength[0], rig.strength[k]), hookWorld = 0;
    for (int i = (k >= 0 && k < 4) ? 1 : 0; i < 4; i++) rig.strength[i] = 0;
  }
  const bm::Vec3 toward = rig.toward[0], down{0, -1, 0};
  // The half-size pass (occlusion, the key's shadow, the floor's light) runs with either on;
  // the height map, for the floor's light, is kept only while the floor is drawn too.
  const bool useHybridRt = !options.studioLook && options.hybridRt && camera.orthoHalfHeight <= 0 && pipelines.hybridRtGlass && pipelines.hybridRtGiRefl && pipelines.hybridRtTemporal;
  const bool useStudioGlass = options.studioLook && !refract && glassInView && camera.orthoHalfHeight <= 0 && pipelines.hybridRtGlass;
  const bool useNeural = (options.neuralShader || (getenv("BM_NEURAL") && std::atoi(getenv("BM_NEURAL")) != 0)) &&
                         pipelines.neuralFeatures && pipelines.neuralInfer;
  // Depth of field: the finished picture is blurred by its depth (shaders/lens.metal).
  const float lensMaxPx = static_cast<float>(std::max(0.0, std::isfinite(options.lensBlur) ? options.lensBlur : 0.0) * height);
  const bool lensOn = pipelines.lens && lensMaxPx >= 0.5f && std::isfinite(options.focusDistance) && options.focusDistance > 0;
  if (lensOn && (!lensSource || static_cast<int>(lensSource.width) != width || static_cast<int>(lensSource.height) != height)) {
    MTLTextureDescriptor* d = [MTLTextureDescriptor texture2DDescriptorWithPixelFormat:MTLPixelFormatBGRA8Unorm_sRGB width:width height:height mipmapped:NO];
    d.usage = MTLTextureUsageRenderTarget | MTLTextureUsageShaderRead;
    d.storageMode = MTLStorageModePrivate;
    lensSource = [device->device newTextureWithDescriptor:d];
  }
  const bool wantMatchedPlastic = (options.studioLook || options.plasticMatch || options.worldGi) && !options.clay;
  const bool wantWorldGi = (options.studioLook || options.worldGi) && wantMatchedPlastic && !options.screenSpaceGi && !useHybridRt;
  const bool worldGiActive = wantWorldGi && prepareWorldGi(rig, hookWorld, options.interactive, drawable == nil);
  stats.worldGiReady = worldGiActive;
  stats.worldGiBaking = wantWorldGi && worldGiPending;
  const bool wantNeuralRt = useNeural && camera.orthoHalfHeight <= 0 &&
                            (options.studioLook || (getenv("BM_NEURAL_RT") && std::atoi(getenv("BM_NEURAL_RT")) != 0));
  if (useHybridRt || useStudioGlass || wantNeuralRt) {
    if (!ptInitTried) {
      ptInitTried = true;
      std::string err;
      ptScene = PathScene::create(&err);
    }
    if (ptScene && ptSceneRevision != lastChange) {
      ptScene->prepare(scene, *meshes);
      ptSceneRevision = lastChange;
      hybridHasHistory = false;
    }
  }
  const bool hybridActive = useHybridRt && ptScene != nullptr;
  if (!hybridActive) {
    // Other modes (notably Neural) reuse giHist[0] and rtDepthHist[0], so never carry
    // HybridRT temporal history across shading mode switches.
    hybridHasHistory = false;
    hybridStillFrames = 0;
  } else {
    const bool hybridLookChanged = hybridBg[0] != options.background[0] || hybridBg[1] != options.background[1] ||
                                   hybridBg[2] != options.background[2] || hybridFloor != options.floor ||
                                   hybridLightsFollow != options.lightsFollowCamera || hybridShadows != options.shadows ||
                                   hybridAo != options.ambientOcclusion;
    if (hybridLookChanged) {
      hybridHasHistory = false;
      hybridStillFrames = 0;
      std::copy(std::begin(options.background), std::end(options.background), std::begin(hybridBg));
      hybridFloor = options.floor;
      hybridLightsFollow = options.lightsFollowCamera;
      hybridShadows = options.shadows;
      hybridAo = options.ambientOcclusion;
    }
  }
  const bool studioGlassActive = useStudioGlass && ptScene != nullptr;
  if ((refract || hybridActive || studioGlassActive || options.studioLook || options.screenSpaceGi) && !glassResolved) makeGlassTargets();
  // DEBUG HOOK: BM_HYBRID_SKIP=<csv of glass,glassmask,glasscompute,gi,temporal,ao> ablates hybrid passes for profiling.
  std::vector<std::string> hybridSkipList;
  if (const char* skipped = getenv("BM_HYBRID_SKIP")) {
    std::stringstream ss(skipped);
    std::string tok;
    while (std::getline(ss, tok, ',')) hybridSkipList.push_back(tok);
  }
  auto skipStage = [&](const std::string& name) { return std::find(hybridSkipList.begin(), hybridSkipList.end(), name) != hybridSkipList.end(); };
  const bool screenPass = options.shadows || options.ambientOcclusion;
  const bool floorLit = screenPass && options.floor;
  const bool surfaceShare = screenPass || needsBlend || options.screenSpaceGi || hybridActive || options.studioLook || useNeural;
  // The floor is fitted to the model at rest; a map, when it is begun, to where the pieces are
  // then and to the model at rest, where every flight ends.
  const bm::Box& b = scene.bounds;
  const double diagonal = b.empty() ? 1.0 : std::max(1.0, length(b.max - b.min));
  const bm::Vec3 middle = b.empty() ? scene.origin : (b.min + b.max) * 0.5;
  bm::Box fitted = liveBounds;
  fitted.merge(scene.bounds);
  const KeyLight key = keyLight(fitted, scene.origin, toward, kShadowMapSize, kFloorExtent * diagonal);
  const KeyLight above = keyLight(fitted, scene.origin, down, kHeightMapSize, 0);
  const uint64_t now = frame + 1;  // this frame's number (counted below)
  std::vector<uint32_t> shown;
  // Into `into`: the pieces shown in groups [begin, end) that `keep` (group, instance) takes,
  // opaque ones, and glass too with `glass`.
  auto casting = [&](std::vector<Batch>& into, uint32_t begin, uint32_t end, bool glass, auto keep) {
    for (uint32_t g = begin; g < end; g++) {
      const Group& group = scene.groups[g];
      if (group.material.transparent() && !glass) continue;
      shown.clear();
      for (uint32_t i = 0; i < group.instances.size(); i++)
        if (!(group.instances[i].flags & kNotShown) && keep(g, i)) shown.push_back(i);
      add(into, g, static_cast<Detail>(casterDetail), shown);
    }
  };
  // What a map draws this frame (CasterMap): all of it (into front), a share of it (into back,
  // and back is shown from this frame when it is the last), and what moved since the one shown
  // was begun (over a copy of it).
  struct MapWork {
    std::vector<Batch> share, movers;
    bool whole = false, clear = false, swap = false;
  };
  const bool overFrames = options.mapTrianglesPerFrame > 0;
  auto stale = [&](const CasterMap& map, bm::Vec3 dir) { return lastChange >= map.front.cutoff || length(dir - map.front.toward) > 1e-9; };
  // Whether every piece in `batches` lies across a map seen through `matrix` (its depth does
  // not matter: the key's map clamps it, the height map has none).
  auto covers = [&](const Mat4& matrix, const std::vector<Batch>& batches) {
    for (const Batch& batch : batches) {
      const Group& group = scene.groups[batch.group];
      for (uint32_t k = 0; k < batch.count; k++) {
        const bm::Box box = placedBox(group.instances[list[batch.first + k]], parts[batch.group].bounds, bm::Vec3{});
        for (int c = 0; c < 8; c++) {
          float clip[4];
          transform(matrix, bm::Vec3{c & 1 ? box.max.x : box.min.x, c & 2 ? box.max.y : box.min.y, c & 4 ? box.max.z : box.min.z}, clip);
          if (std::abs(clip[0]) > clip[3] || std::abs(clip[1]) > clip[3]) return false;
        }
      }
    }
    return true;
  };
  // `glass`: transparent pieces cast too. They do into the height map: EyeSight's ground is a
  // shadow catcher, and glass shadows it as an opaque piece would (native/corpus/calib/glass.ldr:
  // floor RMSE 6.0 so, 14.9 letting half the light through).
  auto plan = [&](CasterMap& map, bool on, const KeyLight& fit, bm::Vec3 dir, bool glass) {
    MapWork w;
    const uint32_t groups = static_cast<uint32_t>(scene.groups.size());
    if (!on) {
      map.building = false;
      return w;
    }
    auto whole = [&] {
      map.building = false;
      map.front.matrix = fit.matrix, map.front.texel = fit.texel, map.front.toward = dir, map.front.detail = casterDetail, map.front.cutoff = now + 1;
      map.front.bounds = fitted;
      w = MapWork{};
      w.whole = w.clear = true;
      casting(w.share, 0, groups, glass, [](uint32_t, uint32_t) { return true; });
      return w;
    };
    const bool old = stale(map, dir);
    if (!map.front.texture || map.front.detail != casterDetail || (old && (!overFrames || dot(dir, map.front.toward) < std::cos(kMapTurnLimit)))) return whole();
    if (!overFrames) {
      map.building = false;
      return w;
    }
    if (!map.building && old) {
      // Begun now, with what has not moved since the frame before (what is moving now is
      // drawn over it until the next); in shares of about equal triangles, whole groups each.
      map.back.matrix = fit.matrix, map.back.texel = fit.texel, map.back.toward = dir, map.back.detail = casterDetail, map.back.cutoff = now;
      map.back.bounds = fitted;
      std::vector<uint64_t> triangles(groups, 0);
      uint64_t total = 0;
      for (uint32_t g = 0; g < groups; g++) {
        const Group& group = scene.groups[g];
        if (group.material.transparent() && !glass) continue;
        uint64_t count = 0;
        for (const Instance& in : group.instances) count += (in.flags & kNotShown) ? 0 : 1;
        if (count) triangles[g] = count * (mesh(group, static_cast<Detail>(casterDetail)).indexCount / 3);
        total += triangles[g];
      }
      const uint64_t shares = std::max<uint64_t>(1, (total + options.mapTrianglesPerFrame - 1) / options.mapTrianglesPerFrame);
      // A small map fits in one pass. Drawing into back and copying it before drawing
      // this frame's movers would cost two passes and a texture copy for the same map.
      if (shares == 1) return whole();
      map.ends.clear();
      uint64_t sum = 0;
      for (uint32_t g = 0; g < groups && map.ends.size() + 1 < shares; g++) {
        sum += triangles[g];
        if (sum * shares >= total * (map.ends.size() + 1)) map.ends.push_back(g + 1);
      }
      map.ends.push_back(groups);
      map.done = 0, map.building = true;
    }
    // The map shown this frame: back, once its last share is drawn now.
    w.swap = map.building && map.done + 1 == map.ends.size();
    const CasterMap::Side& shown = w.swap ? map.back : map.front;
    const uint64_t cutoff = shown.cutoff;
    if (lastChange >= cutoff) casting(w.movers, 0, groups, glass, [&](uint32_t g, uint32_t i) { return changedAt[g][i] >= cutoff; });
    // A piece moved out of what that map covers: drawn whole now.
    if (!covers(shown.matrix, w.movers)) return whole();
    if (map.building) {
      const uint32_t begin = map.done ? map.ends[map.done - 1] : 0, end = map.ends[map.done];
      const uint64_t before = map.back.cutoff;
      casting(w.share, begin, end, glass, [&](uint32_t g, uint32_t i) { return changedAt[g][i] < before; });
      w.clear = map.done == 0;
      map.done++;
    }
    return w;
  };
  MapWork shadowWork = plan(shadow, options.shadows, key, toward, false), heightWork = plan(heights, floorLit, above, down, true);
  // The maps as this frame reads them (copies: drawMap swaps the sides below).
  const CasterMap::Side keyShown = shadowWork.swap ? shadow.back : shadow.front;
  const CasterMap::Side heightShown = heightWork.swap ? heights.back : heights.front;

  // The selected pieces in view, for their outline.
  std::vector<Batch> selected;
  for (const Batch& batch : seen) {
    const Group& group = scene.groups[batch.group];
    const uint32_t first = static_cast<uint32_t>(list.size());
    for (uint32_t k = 0; k < batch.count; k++) {
      const uint32_t i = list[batch.first + k];
      if (group.instances[i].flags & kSelected) list.push_back(i);
    }
    if (list.size() > first) selected.push_back({batch.group, batch.detail, batch.mirrored, first, static_cast<uint32_t>(list.size()) - first, batch.top});
  }

  dispatch_semaphore_wait(inFlight, DISPATCH_TIME_FOREVER);
  frame++;
  const int slot = static_cast<int>(frame % 3);
  flush(slot);
  id<MTLDevice> dev = device->device;

  if (useNeural) {
    const char* extWeights = getenv("BM_NEURAL_WEIGHTS");
    const std::string extPath = extWeights ? extWeights : "";
    if (!neuralWeightsBuffer || extPath != neuralWeightsPath) {
      neuralWeightsPath = extPath;
      neuralWeightsCpu = defaultNeuralWeights();
      if (!extPath.empty()) loadNeuralWeightsFromFile(extPath.c_str(), neuralWeightsCpu);
      if (!neuralWeightsBuffer) {
        neuralWeightsBuffer = [dev newBufferWithLength:sizeof(NeuralWeights) options:MTLResourceStorageModeShared];
      }
      std::memcpy(neuralWeightsBuffer.contents, &neuralWeightsCpu, sizeof(NeuralWeights));
    }
  }

  FrameUniforms fu{};
  fu.viewProj = simdFrom(multiply(projectionMatrix(camera), viewMatrix(camera, scene.origin)));
  fu.shadowProj = simdFrom(options.shadows ? keyShown.matrix : key.matrix);
  const bm::Vec3 eye = camera.eye - scene.origin;
  fu.eye = simd_make_float4(static_cast<float>(eye.x), static_cast<float>(eye.y), static_cast<float>(eye.z), useNeural ? 1.0f : 0.0f);
  fu.neuralGlass0 = neuralWeightsCpu.glassParams[0];
  fu.neuralGlass1 = neuralWeightsCpu.glassParams[1];
  fu.plastic = simd_make_float4(wantMatchedPlastic ? 1.0f : 0.0f, 0.85f, 0.0f, worldGiActive ? 1.0f : 0.0f);
  for (int i = 0; i < 4; i++)
    fu.lights[i] = simd_make_float4(static_cast<float>(rig.toward[i].x), static_cast<float>(rig.toward[i].y), static_cast<float>(rig.toward[i].z), rig.strength[i]);
  fu.rig = simd_make_float4(hookWorld, kRigSinSquared, getenv("BM_AO_POWER") ? static_cast<float>(atof(getenv("BM_AO_POWER"))) : kAoBrickPower,
                            (options.screenSpaceGi || hybridActive) ? 1.0f : 0.0f);  // DEBUG HOOK
  fu.background = simd_make_float4(options.background[0], options.background[1], options.background[2], 1);
  fu.viewport = simd_make_float4(static_cast<float>(width), static_cast<float>(height), 1.0f / static_cast<float>(width), 1.0f / static_cast<float>(height));
  fu.switches = simd_make_float4(options.shadows ? 1 : 0, options.ambientOcclusion ? 1 : 0,
                               getenv("BM_DEBUG_VIEW") ? static_cast<float>(atof(getenv("BM_DEBUG_VIEW"))) : 0,
                               needsBlend ? 1 : 0);  // DEBUG HOOK: BM_DEBUG_VIEW
  const double floorY = (b.empty() ? 0.0 : b.max.y - scene.origin.y) + kFloorLift;
  fu.floorPlane = simd_make_float4(static_cast<float>(floorY), static_cast<float>(kFloorExtent * diagonal), static_cast<float>(options.shadows ? keyShown.texel : key.texel), kShadowBias);
  fu.floorCentre = simd_make_float4(static_cast<float>(middle.x - scene.origin.x), static_cast<float>(middle.z - scene.origin.z), kFloorShadow, kOitDepthScale);
  fu.lens = simd_make_float4(static_cast<float>(std::tan(camera.fovY / 2)), static_cast<float>(kEdgeStudPixels / kStudLdu), static_cast<float>(kEdgeStudFullPixels / kStudLdu),
                             static_cast<float>(camera.orthoHalfHeight));
  fu.grid.w = options.studioLook ? 1.0f : 0.0f;
  if (options.gridSpacing > 0) {
    fu.grid = simd_make_float4(static_cast<float>(options.gridSpacing),
      static_cast<float>(std::fmod(scene.origin.x, options.gridSpacing * 5)),
      static_cast<float>(std::fmod(scene.origin.z, options.gridSpacing * 5)), options.studioLook ? 1.0f : 0.0f);
  }
  const simd_float3 accent = simd_make_float3(linearFromSrgb(kSelectionRgb[0]), linearFromSrgb(kSelectionRgb[1]), linearFromSrgb(kSelectionRgb[2]));
  fu.selection = simd_make_float4(accent.x, accent.y, accent.z, selected.empty() ? 0.0f : kSelectionWidth);
  fu.heightProj = simdFrom(floorLit ? heightShown.matrix : above.matrix);
  fu.glass = simd_make_float4(kGlassAbsorption, kFloorThroughGlass, kGlassIor, options.floor && eye.y < floorY ? 1 : 0);
  fu.floorLook = simd_make_float4(static_cast<float>(std::max(1.0, floorLit ? heightShown.texel : above.texel)), static_cast<float>(kFloorLookShare * kFloorExtent * diagonal), floorLit && !liveBounds.empty() ? 1.0f : 0.0f, kFloorSkyPower);
  if (floorLit && !liveBounds.empty()) {
    bm::Box casterBounds = heightShown.bounds;
    casterBounds.merge(liveBounds);
    // The shown map may contain pieces from an older frame. Include those, the
    // current movers and the reach of nearest-texel sampling at the footprint edge.
    const double margin = 2 * heightShown.texel;
    fu.floorCasters = simd_make_float4(static_cast<float>(casterBounds.min.x - scene.origin.x - margin),
                                      static_cast<float>(casterBounds.min.z - scene.origin.z - margin),
                                      static_cast<float>(casterBounds.max.x - scene.origin.x + margin),
                                      static_cast<float>(casterBounds.max.z - scene.origin.z + margin));
  }
  // How much of each light's disk each of the floor's 12 directions and 16 elevation bins
  // holds (floor_light.metal), with each bin's light on a level floor (even in sin^2 elevation):
  // worked out again only when the lights have turned.
  id<MTLBuffer> binsBuffer = floorBins.get(dev, frame, sizeof(FloorBins));
  bool sameRig = floorTable != nullptr;
  for (int i = 0; i < 4 && sameRig; i++) sameRig = length(rig.toward[i] - floorTableToward[i]) <= 1e-12;
  if (floorLit && !floorTable) {
    floorTable = std::make_unique<FloorBins>();
    for (int row = 0; row < 48; ++row) {
      const float angle = (static_cast<float>(row) / 4) * (6.2831853f / 12);
      const float x = std::cos(angle), z = std::sin(angle);
      const auto reciprocal = [](float v) { return std::copysign(1.0f / std::max(std::abs(v), 1e-8f), v); };
      floorTable->rays[row] = simd_make_float4(x, z, reciprocal(x), reciprocal(z));
    }
  }
  for (int i = 0; i < 4 && floorLit && !sameRig; i++) {
    FloorBins& bins = *floorTable;
    floorTableToward[i] = rig.toward[i];
    const bm::Vec3 t = normalized(rig.toward[i]);
    const double cosRadius = std::sqrt(1.0 - kRigSinSquared);
    for (auto& total : bins.total[i]) total = 0;
    for (int d = 0; d < 48; d++) {
      auto& weights = bins.weights[i][d];
      for (auto& plane : weights) plane = 0;
      for (int b = 0; b < 16; b++) {
        int inside = 0;
        for (int u = 0; u < 4; u++)
          for (int v = 0; v < 4; v++) {
            const double azimuth = (d / 4.0 + (u + 0.5) / 4 - 0.5) * (2 * M_PI / 12), s = (b + (v + 0.5) / 4) / 16;
            const double up = std::sqrt(s), across = std::sqrt(1 - s);
            const bm::Vec3 dir{across * std::cos(azimuth), -up, across * std::sin(azimuth)};
            if (dot(dir, t) > cosRadius) inside++;
          }
        for (int bit = 0; bit < 5; ++bit)
          weights[bit] |= static_cast<uint16_t>(((inside >> bit) & 1) << b);
        bins.total[i][d & 3] += static_cast<uint32_t>(inside);
      }
    }
    // A level floor's light from it: E diskLight(cos) / pi, as brick.metal's diskLight has it.
    const double c = std::max(-1.0, std::min(1.0, -t.y)), sinSq = kRigSinSquared;
    double disk = std::max(c, 0.0);
    if (c * c <= sinSq) {
      const double sinT = std::sqrt(1 - c * c), x = std::sqrt(1 / sinSq - 1), y = -x * (c / std::max(sinT, 1e-5));
      const double sinTy = sinT * std::sqrt(std::max(1 - y * y, 0.0));
      disk = std::max((c * std::acos(std::max(-1.0, std::min(1.0, y))) - x * sinTy) * sinSq + std::atan(sinTy / x), 0.0) / (M_PI * sinSq);
    }
    bins.lit[i] = static_cast<float>(rig.strength[i] * disk / M_PI * (i == 0 ? kFloorKeyShare : 1.0f));
  }
  if (floorLit) std::memcpy(binsBuffer.contents, floorTable.get(), sizeof(FloorBins));
  id<MTLBuffer> frameBuffer = frameUniforms.get(dev, frame, sizeof fu);
  std::memcpy(frameBuffer.contents, &fu, sizeof fu);

  // One DrawUniforms per batch: the seen ones, then the outlined.
  const size_t batchCount = seen.size() + outlined.size();
  id<MTLBuffer> drawBuffer = drawUniforms.get(dev, frame, std::max<size_t>(1, batchCount) * sizeof(DrawUniforms));
  auto* du = static_cast<DrawUniforms*>(drawBuffer.contents);
  for (size_t i = 0; i < batchCount; i++) {
    const Batch& batch = i < seen.size() ? seen[i] : outlined[i - seen.size()];
    const Group& group = scene.groups[batch.group];
    const Material& m = group.material;
    du[i].base = simd_make_float4(m.base[0], m.base[1], m.base[2], m.alpha);
    du[i].surface = simd_make_float4(m.roughness, m.metalness, m.clearcoat, group.placeholder ? 1 : 0);
    du[i].edge = simd_make_float4(m.edge[0], m.edge[1], m.edge[2], m.transparent() && !group.placeholder ? kGlassEdgeOpacity : kEdgeOpacity);
    if (options.clay && !group.placeholder) {
      du[i].base = simd_make_float4(0.56f, 0.58f, 0.6f, 1);
      du[i].surface = simd_make_float4(0.57f, 0, 0.1f, 0);
      du[i].edge = simd_make_float4(0.18f, 0.19f, 0.2f, kEdgeOpacity);
    }
    du[i].flip = simd_make_float4(batch.mirrored ? -1 : 1, batch.detail == Detail::Box ? 2 : 1, 0, 0);
    const bm::Box& part = parts[batch.group].bounds;
    const bm::Vec3 c = part.empty() ? bm::Vec3{} : (part.min + part.max) * 0.5;
    du[i].sphere = simd_make_float4(static_cast<float>(c.x), static_cast<float>(c.y), static_cast<float>(c.z), part.empty() ? 0.0f : static_cast<float>(length(part.max - part.min) / 2));
  }
  id<MTLBuffer> visibleBuffer = visible.get(dev, frame, std::max<size_t>(1, list.size()) * sizeof(uint32_t));
  if (!list.empty()) std::memcpy(visibleBuffer.contents, list.data(), list.size() * sizeof(uint32_t));

  id<MTLCommandBuffer> commands = [device->queue commandBuffer];

  // The maps: what each draws this frame, then the texture read from it.
  auto mapTexture = [&](MTLPixelFormat format, int size) {
    MTLTextureDescriptor* d = [MTLTextureDescriptor texture2DDescriptorWithPixelFormat:format width:static_cast<NSUInteger>(size) height:static_cast<NSUInteger>(size) mipmapped:NO];
    d.usage = MTLTextureUsageRenderTarget | MTLTextureUsageShaderRead;
    d.storageMode = MTLStorageModePrivate;
    return [dev newTextureWithDescriptor:d];
  };
  // `batches` into a map (depth: the key light's, else the height map), seen through `matrix`.
  auto drawInto = [&](bool depth, id<MTLTexture> into, bool clear, const Mat4& matrix, const std::vector<Batch>& batches) {
    MTLRenderPassDescriptor* pass = [MTLRenderPassDescriptor new];
    if (depth) {
      pass.depthAttachment.texture = into;
      pass.depthAttachment.loadAction = clear ? MTLLoadActionClear : MTLLoadActionLoad;
      pass.depthAttachment.clearDepth = 1;
      pass.depthAttachment.storeAction = MTLStoreActionStore;
    } else {
      pass.colorAttachments[0].texture = into;
      pass.colorAttachments[0].loadAction = clear ? MTLLoadActionClear : MTLLoadActionLoad;
      pass.colorAttachments[0].clearColor = MTLClearColorMake(65504, 65504, 0, 0);  // nothing: no top, no underside
      pass.colorAttachments[0].storeAction = MTLStoreActionStore;
    }
    id<MTLRenderCommandEncoder> enc = [commands renderCommandEncoderWithDescriptor:pass];
    [enc setRenderPipelineState:depth ? pipelines.shadow : pipelines.height];
    if (depth) {
      [enc setDepthStencilState:pipelines.shadowDepth];
      [enc setDepthBias:0 slopeScale:kShadowSlopeBias clamp:0];
      [enc setDepthClipMode:MTLDepthClipModeClamp];  // a caster nearer the light than the map's box still casts
    }
    [enc setCullMode:MTLCullModeNone];
    const simd_float4x4 m = simdFrom(matrix);
    [enc setVertexBytes:&m length:sizeof m atIndex:2];
    [enc setVertexBuffer:frameBuffer offset:0 atIndex:1];
    [enc setVertexBuffer:visibleBuffer offset:0 atIndex:4];
    uint64_t triangles = 0;
    for (const Batch& batch : batches) {
      const GpuMesh& gpu = mesh(scene.groups[batch.group], batch.detail);
      if (!gpu.indexCount) continue;
      [enc setVertexBuffer:gpu.vertices offset:0 atIndex:0];
      [enc setVertexBuffer:instanceBuffers[batch.group][slot] offset:0 atIndex:3];
      [enc setVertexBufferOffset:batch.first * sizeof(uint32_t) atIndex:4];
      [enc drawIndexedPrimitives:MTLPrimitiveTypeTriangle indexCount:gpu.indexCount indexType:MTLIndexTypeUInt32 indexBuffer:gpu.indices indexBufferOffset:0 instanceCount:batch.count];
      stats.drawCalls++;
      triangles += static_cast<uint64_t>(gpu.indexCount / 3) * batch.count;
    }
    [enc endEncoding];
    if (depth) stats.shadowDrawn = true, stats.shadowTriangles += triangles;
  };
  auto drawMap = [&](CasterMap& map, const MapWork& w, bool on, bool depth, MTLPixelFormat format, int size) -> id<MTLTexture> {
    if (!on) return nil;
    if (w.whole) stats.mapWhole = true;
    if (w.clear || !w.share.empty()) {
      CasterMap::Side& side = w.whole ? map.front : map.back;
      if (!side.texture) side.texture = mapTexture(format, size);
      drawInto(depth, side.texture, w.clear, side.matrix, w.share);
    }
    if (w.swap) std::swap(map.front, map.back), map.building = false;
    if (w.movers.empty()) return map.front.texture;
    if (!map.live) map.live = mapTexture(format, size);
    id<MTLBlitCommandEncoder> blit = [commands blitCommandEncoder];
    [blit copyFromTexture:map.front.texture toTexture:map.live];
    [blit endEncoding];
    drawInto(depth, map.live, false, map.front.matrix, w.movers);
    return map.live;
  };
  id<MTLTexture> shadowMap = drawMap(shadow, shadowWork, options.shadows, true, MTLPixelFormatDepth32Float, kShadowMapSize);
  id<MTLTexture> heightMap = drawMap(heights, heightWork, floorLit, false, MTLPixelFormatRG16Float, kHeightMapSize);
  stats.settling = (overFrames && ((options.shadows && (shadow.building || stale(shadow, toward))) || (floorLit && (heights.building || stale(heights, down))))) || (wantWorldGi && worldGiPending);
  id<MTLTexture> shadowTexture = options.shadows && shadowMap ? shadowMap : placeholderShadow;

  // The model, multisampled, resolved into `color`, `accum` and `reveal`.
  {
    MTLRenderPassDescriptor* pass = [MTLRenderPassDescriptor new];
    id<MTLTexture> ms[4] = {colorMs, accumMs, revealMs, ambientMs}, resolved[4] = {color, accum, reveal, ambient};
    for (int i = 0; i < 4; i++) {
      const bool store = i == 0 || (i == 3 ? surfaceShare : needsBlend);
      pass.colorAttachments[i].texture = ms[i];
      pass.colorAttachments[i].resolveTexture = store ? resolved[i] : nil;
      pass.colorAttachments[i].loadAction = store ? MTLLoadActionClear : MTLLoadActionDontCare;
      pass.colorAttachments[i].clearColor = MTLClearColorMake(0, 0, 0, 0);  // nothing drawn: no coverage, no optical depth, no ambient share
      pass.colorAttachments[i].storeAction = store ? MTLStoreActionMultisampleResolve : MTLStoreActionDontCare;
    }
    pass.depthAttachment.texture = depthMs;
    pass.depthAttachment.loadAction = MTLLoadActionClear;
    pass.depthAttachment.clearDepth = 0;  // reversed depth: 0 is the far plane
    // One sample of depth kept, for ambient occlusion and the key light's shadow.
    const bool keepDepth = options.ambientOcclusion || options.shadows || useNeural || lensOn;  // and for the lens blur
    pass.depthAttachment.storeAction = keepDepth ? MTLStoreActionMultisampleResolve : MTLStoreActionDontCare;
    pass.depthAttachment.resolveTexture = keepDepth ? depth : nil;
    pass.depthAttachment.depthResolveFilter = MTLMultisampleDepthResolveFilterSample0;
    id<MTLRenderCommandEncoder> enc = [commands renderCommandEncoderWithDescriptor:pass];
    [enc setVertexBuffer:frameBuffer offset:0 atIndex:1];
    [enc setFragmentBuffer:frameBuffer offset:0 atIndex:1];
    [enc setVertexBuffer:drawBuffer offset:0 atIndex:2];
    [enc setFragmentBuffer:drawBuffer offset:0 atIndex:2];
    [enc setVertexBuffer:visibleBuffer offset:0 atIndex:4];
    [enc setFragmentTexture:shadowTexture atIndex:0];
    [enc setFragmentSamplerState:pipelines.shadowSampler atIndex:1];
    WorldGiUniforms giUniforms = worldGiUniforms;
    giUniforms.shapeGain.w = (worldGiActive && options.worldGiOcclusion) ? 1.0f : 0.0f;
    [enc setFragmentBytes:&giUniforms length:sizeof giUniforms atIndex:8];
    for (int i = 0; i < 6; i++)
      [enc setFragmentTexture:(worldGiActive && worldGiTextures[i]) ? worldGiTextures[i] : worldGiFallback atIndex:2 + i];
    [enc setFragmentTexture:(worldGiActive && worldGiStudioTexture) ? worldGiStudioTexture : worldGiFallback atIndex:8];
    [enc setFragmentSamplerState:pipelines.smooth atIndex:2];

    // Opaque pieces, glass (transparent ones), and placeholders (missing parts, translucent).
    enum class Kind { Opaque, Glass, Placeholder };
    auto bricks = [&](Kind kind) {
      for (size_t i = 0; i < seen.size(); i++) {
        const Batch& batch = seen[i];
        const Group& group = scene.groups[batch.group];
        const Kind material = group.placeholder ? Kind::Placeholder :
            !group.material.transparent() || options.clay ? Kind::Opaque : Kind::Glass;
        if (material != kind) continue;
        const Detail detail = options.interactive && batch.detail == Detail::Low && kind == Kind::Opaque &&
            !options.wireframe ? Detail::Shadow : batch.detail;
        const GpuMesh& gpu = mesh(group, detail);
        if (!gpu.indexCount) continue;
        // Triangles are counter-clockwise seen from outside; a mirrored instance shows them the other way round.
        [enc setFrontFacingWinding:batch.mirrored ? MTLWindingClockwise : MTLWindingCounterClockwise];
        [enc setVertexBuffer:gpu.vertices offset:0 atIndex:0];
        [enc setVertexBuffer:instanceBuffers[batch.group][slot] offset:0 atIndex:3];
        [enc setVertexBufferOffset:i * sizeof(DrawUniforms) atIndex:2];
        [enc setFragmentBufferOffset:i * sizeof(DrawUniforms) atIndex:2];
        [enc setVertexBufferOffset:batch.first * sizeof(uint32_t) atIndex:4];
        const uint32_t indexCount = batch.top ? gpu.topIndexCount : gpu.indexCount;
        [enc drawIndexedPrimitives:MTLPrimitiveTypeTriangle indexCount:indexCount indexType:MTLIndexTypeUInt32 indexBuffer:gpu.indices indexBufferOffset:0 instanceCount:batch.count];
        stats.drawCalls++;
        stats.instances += batch.count;
        stats.triangles += static_cast<uint64_t>(indexCount / 3) * batch.count;
        stats.byDetail[static_cast<int>(batch.detail)] += batch.count;
      }
    };

    [enc setCullMode:MTLCullModeBack];
    [enc setRenderPipelineState:pipelines.brick];
    [enc setDepthStencilState:pipelines.depthWrite];
    if (options.wireframe) [enc setTriangleFillMode:MTLTriangleFillModeLines];
    bricks(Kind::Opaque);
    if (options.wireframe) [enc setTriangleFillMode:MTLTriangleFillModeFill];

    if ((options.floor && surfaceShare) || options.gridSpacing > 0) {
      [enc setCullMode:MTLCullModeNone];
      [enc setRenderPipelineState:pipelines.floor];
      [enc setDepthStencilState:pipelines.depthWrite];  // in the depth buffer, so ambient occlusion sees it
      [enc drawPrimitives:MTLPrimitiveTypeTriangle vertexStart:0 vertexCount:6];
      stats.drawCalls++;
    }

    // Draw opaque outlines before glass, and glass outlines after glass's depth
    // and colour. Otherwise glassTransportFragment overwrites its own edges and
    // the panes lose the darker, well-defined contours visible in EyeSight.
    // Each outlined batch is still drawn exactly once (no extra mesh work).
    auto drawOutlines = [&](bool glass) {
      if (!options.edges || options.wireframe || options.studioLook) return;
      [enc setCullMode:MTLCullModeNone];
      [enc setRenderPipelineState:pipelines.edges];
      [enc setDepthStencilState:pipelines.depthRead];
      const float nearer = kEdgeNearer;
      [enc setVertexBytes:&nearer length:sizeof nearer atIndex:5];
      for (size_t k = 0; k < outlined.size(); k++) {
        const Batch& batch = outlined[k];
        const Group& group = scene.groups[batch.group];
        if ((group.material.transparent() && !group.placeholder && !options.clay) != glass) continue;
        const size_t i = seen.size() + k;
        const GpuMesh& gpu = mesh(group, batch.detail);
        if (!gpu.edgeVertices) continue;
        [enc setVertexBuffer:gpu.edges offset:0 atIndex:0];
        [enc setVertexBuffer:instanceBuffers[batch.group][slot] offset:0 atIndex:3];
        [enc setVertexBufferOffset:i * sizeof(DrawUniforms) atIndex:2];
        [enc setFragmentBufferOffset:i * sizeof(DrawUniforms) atIndex:2];
        [enc setVertexBufferOffset:batch.first * sizeof(uint32_t) atIndex:4];
        [enc drawPrimitives:MTLPrimitiveTypeLine vertexStart:0 vertexCount:gpu.edgeVertices instanceCount:batch.count];
        stats.drawCalls++;
      }
    };
    drawOutlines(false);

    const bool useRmidt = (options.screenSpaceGi || hybridActive || studioGlassActive) && !refract && glassInView;
    [enc setCullMode:MTLCullModeBack];
    [enc setDepthStencilState:pipelines.depthRead];
    if (refract && glassNodes && glassTriangles) {
      [enc setDepthStencilState:pipelines.depthWrite];
      // Resolve the nearest glass surface before running the expensive transport shader.
      [enc setRenderPipelineState:pipelines.glassDepth];
      bricks(Kind::Glass);
      [enc setDepthStencilState:pipelines.depthRead];
      [enc setFragmentBuffer:glassNodes offset:0 atIndex:3];
      [enc setFragmentBuffer:glassTriangles offset:0 atIndex:4];
      if (glassAcceleration) {
        [enc setFragmentAccelerationStructure:glassAcceleration atBufferIndex:6];
        [enc useResource:glassAcceleration usage:MTLResourceUsageRead stages:MTLRenderStageFragment];
      }
      [enc setFragmentBytes:&glassNodeCount length:sizeof glassNodeCount atIndex:5];
      [enc setRenderPipelineState:pipelines.glass];
      bricks(Kind::Glass);
    } else if (glassInView && !useRmidt) {
      [enc setRenderPipelineState:pipelines.glassPreview];
      bricks(Kind::Glass);
    }
    [enc setDepthStencilState:pipelines.depthRead];
    [enc setRenderPipelineState:pipelines.transparent];
    bricks(Kind::Placeholder);
    if (options.wireframe) [enc setTriangleFillMode:MTLTriangleFillModeFill];
    if (!useRmidt) drawOutlines(true);
    for (const auto& ghost : preview) drawPreview(enc, ghost, stats);
    [enc endEncoding];
  }

  // Where the selected pieces are, for their outline: all of each, hidden parts too.
  if (!selected.empty()) {
    MTLRenderPassDescriptor* pass = [MTLRenderPassDescriptor new];
    pass.colorAttachments[0].texture = mask;
    pass.colorAttachments[0].loadAction = MTLLoadActionClear;
    pass.colorAttachments[0].clearColor = MTLClearColorMake(0, 0, 0, 0);
    pass.colorAttachments[0].storeAction = MTLStoreActionStore;
    id<MTLRenderCommandEncoder> enc = [commands renderCommandEncoderWithDescriptor:pass];
    [enc setRenderPipelineState:pipelines.mask];
    [enc setCullMode:MTLCullModeNone];
    [enc setVertexBuffer:frameBuffer offset:0 atIndex:1];
    [enc setVertexBuffer:drawBuffer offset:0 atIndex:2];
    [enc setVertexBuffer:visibleBuffer offset:0 atIndex:4];
    for (const Batch& batch : selected) {
      const GpuMesh& gpu = mesh(scene.groups[batch.group], batch.detail);
      if (!gpu.indexCount) continue;
      [enc setVertexBuffer:gpu.vertices offset:0 atIndex:0];
      [enc setVertexBuffer:instanceBuffers[batch.group][slot] offset:0 atIndex:3];
      [enc setVertexBufferOffset:batch.first * sizeof(uint32_t) atIndex:4];
      [enc drawIndexedPrimitives:MTLPrimitiveTypeTriangle indexCount:batch.top ? gpu.topIndexCount : gpu.indexCount indexType:MTLIndexTypeUInt32 indexBuffer:gpu.indices indexBufferOffset:0 instanceCount:batch.count];
      stats.drawCalls++;
    }
    [enc endEncoding];
  }

  // Ambient occlusion and optional screen-space GI/SSR, Hybrid HW-RT, or Metal Neural Shader at half size.
  if (screenPass || options.screenSpaceGi || hybridActive || options.studioLook || useNeural) {
    struct AoUniforms {
      simd_float4 lens, shape, size, samplePosition, eye, right, up, forward, grid;
    } u;
    {
      // The camera's axes in world space, as viewMatrix makes them.
      const bm::Vec3 f = normalized(camera.target - camera.eye), r = normalized(cross(f, camera.up)), up = cross(r, f), e = camera.eye - scene.origin;
      auto v4 = [](bm::Vec3 v) { return simd_make_float4(static_cast<float>(v.x), static_cast<float>(v.y), static_cast<float>(v.z), 0); };
      u.eye = v4(e), u.right = v4(r), u.up = v4(up), u.forward = v4(f);
    }
    MTLSamplePosition samples[kSamples];
    [device->device getDefaultSamplePositions:samples count:kSamples];
    u.samplePosition = simd_make_float4(samples[0].x, samples[0].y, 0, 0);
    const float tanY = static_cast<float>(camera.orthoHalfHeight > 0 ? camera.orthoHalfHeight : std::tan(camera.fovY / 2));
    u.lens = simd_make_float4(tanY, tanY * static_cast<float>(camera.aspect), static_cast<float>(camera.near), static_cast<float>(camera.far));
    u.shape = simd_make_float4(kAoRadius, kAoBias, kAoStrength, static_cast<float>(width));
    u.size = simd_make_float4(static_cast<float>(height), static_cast<float>(aoRaw.width), static_cast<float>(aoRaw.height),
                             camera.orthoHalfHeight > 0 ? 1 : 0);
    u.grid = simd_make_float4(static_cast<float>(screenDiv), 0, 0, 0);  // the half/quarter grid's stride over the full one
    if (screenPass && !skipStage("ao")) {
      for (int pass = 0; pass < 2; pass++) {
        MTLRenderPassDescriptor* d = [MTLRenderPassDescriptor new];
        d.colorAttachments[0].texture = pass == 0 ? aoRaw : aoSoft;
        d.colorAttachments[0].loadAction = MTLLoadActionDontCare;
        d.colorAttachments[0].storeAction = MTLStoreActionStore;
        id<MTLRenderCommandEncoder> enc = [commands renderCommandEncoderWithDescriptor:d];
        [enc setRenderPipelineState:pass == 0 ? pipelines.ao : pipelines.aoBlur];
        [enc setFragmentBytes:&u length:sizeof u atIndex:0];
        if (pass == 0) {
          [enc setFragmentBuffer:frameBuffer offset:0 atIndex:1];
          [enc setFragmentTexture:depth atIndex:0];
          [enc setFragmentTexture:shadowTexture atIndex:1];
          [enc setFragmentSamplerState:pipelines.shadowSampler atIndex:1];
          [enc setFragmentTexture:heightMap atIndex:2];
          [enc setFragmentTexture:ambient atIndex:3];
          [enc setFragmentBuffer:binsBuffer offset:0 atIndex:2];
        } else {
          [enc setFragmentTexture:aoRaw atIndex:0];
          [enc setFragmentTexture:depth atIndex:1];
          [enc setFragmentTexture:ambient atIndex:2];
        }
        [enc drawPrimitives:MTLPrimitiveTypeTriangle vertexStart:0 vertexCount:3];
        [enc endEncoding];
      }
    } else if (useNeural && aoSoft) {
      // Neural reads aoSoft even when shadows and AO are both off; clear so stale AO never bleeds in.
      MTLRenderPassDescriptor* d = [MTLRenderPassDescriptor new];
      d.colorAttachments[0].texture = aoSoft;
      d.colorAttachments[0].loadAction = MTLLoadActionClear;
      d.colorAttachments[0].clearColor = MTLClearColorMake(1, 1, 0, 1);
      d.colorAttachments[0].storeAction = MTLStoreActionStore;
      id<MTLRenderCommandEncoder> enc = [commands renderCommandEncoderWithDescriptor:d];
      [enc endEncoding];
    }
    // Studio ABS Look: glass-only instanced Metal RT (zero GI noise, zero SVGF ghosting).
    if (options.studioLook) {
      if (studioGlassActive && ptScene->impl().instances) {
        PathScene::Impl& ps = ptScene->impl();
        struct PtUniformsGpu {
          simd_float4 eye, right, up, forward;
          simd_float4 lights[4];
          simd_float4 rig, background, floorPlane, glass;
          simd_uint4 size, seed;
        } ptu{};
        ptu.eye = simd_make_float4(u.eye.x, u.eye.y, u.eye.z, static_cast<float>(std::tan(camera.fovY / 2)));
        ptu.right = simd_make_float4(u.right.x, u.right.y, u.right.z, static_cast<float>(width) / height);
        ptu.up = simd_make_float4(u.up.x, u.up.y, u.up.z, 0.0f);
        ptu.forward = simd_make_float4(u.forward.x, u.forward.y, u.forward.z, 0.0f);
        for (int i = 0; i < 4; i++)
          ptu.lights[i] = simd_make_float4(static_cast<float>(rig.toward[i].x), static_cast<float>(rig.toward[i].y), static_cast<float>(rig.toward[i].z), rig.strength[i] * (i == 0 ? 1.15f : kPathFillShare * 0.7f));
        // rig.w = 2.0 signals Studio Look deeper interior ambient inside glass.
        ptu.rig = simd_make_float4(kWorldStrength, kRigSinSquared, std::sqrt(1.0f - kRigSinSquared), 2.0f);
        ptu.background = simd_make_float4(options.background[0], options.background[1], options.background[2], 1.0f);
        ptu.floorPlane = simd_make_float4(ps.floorY, options.floor ? 1.0f : 0.0f, kFloorKeyShare, 0.0f);
        ptu.glass = simd_make_float4(kGlassIor, kGlassAbsorption, kGlassAbsorption / kPathGlassWall, kFloorThroughGlass);
        ptu.size = simd_make_uint4(static_cast<uint32_t>(width), static_cast<uint32_t>(height), 1u, 0u);
        ptu.seed = simd_make_uint4(0u, 14u, 1u, kPathMaxBounces);

        MTLRenderPassDescriptor* d = [MTLRenderPassDescriptor new];
        d.colorAttachments[0].texture = glassFront;
        d.colorAttachments[0].loadAction = MTLLoadActionClear;
        d.colorAttachments[0].clearColor = MTLClearColorMake(0, 0, 0, 0);
        d.colorAttachments[0].storeAction = MTLStoreActionStore;
        d.colorAttachments[1].texture = glassMat;
        d.colorAttachments[1].loadAction = MTLLoadActionClear;
        d.colorAttachments[1].clearColor = MTLClearColorMake(0, 0, 0, 0);
        d.colorAttachments[1].storeAction = MTLStoreActionDontCare;
        d.depthAttachment.texture = glassDepthTex;
        d.depthAttachment.loadAction = MTLLoadActionClear;
        d.depthAttachment.clearDepth = 0.0;
        d.depthAttachment.storeAction = MTLStoreActionDontCare;
        id<MTLRenderCommandEncoder> enc = [commands renderCommandEncoderWithDescriptor:d];
        [enc setRenderPipelineState:pipelines.rmidtFront];
        [enc setDepthStencilState:pipelines.depthWrite];
        [enc setCullMode:MTLCullModeBack];
        [enc setVertexBuffer:frameBuffer offset:0 atIndex:1];
        [enc setVertexBuffer:drawBuffer offset:0 atIndex:2];
        [enc setVertexBuffer:visibleBuffer offset:0 atIndex:4];
        [enc setFragmentBuffer:frameBuffer offset:0 atIndex:1];
        [enc setFragmentBuffer:drawBuffer offset:0 atIndex:2];
        [enc setFragmentTexture:depth atIndex:0];
        for (size_t i = 0; i < seen.size(); i++) {
          const Batch& batch = seen[i];
          const Group& group = scene.groups[batch.group];
          if (!(group.material.transparent() && !group.placeholder && !options.clay)) continue;
          const GpuMesh& gpu = mesh(group, batch.detail);
          if (!gpu.indexCount) continue;
          [enc setFrontFacingWinding:batch.mirrored ? MTLWindingClockwise : MTLWindingCounterClockwise];
          [enc setVertexBuffer:gpu.vertices offset:0 atIndex:0];
          [enc setVertexBuffer:instanceBuffers[batch.group][slot] offset:0 atIndex:3];
          [enc setVertexBufferOffset:i * sizeof(DrawUniforms) atIndex:2];
          [enc setFragmentBufferOffset:i * sizeof(DrawUniforms) atIndex:2];
          [enc setVertexBufferOffset:batch.first * sizeof(uint32_t) atIndex:4];
          [enc drawIndexedPrimitives:MTLPrimitiveTypeTriangle indexCount:gpu.indexCount indexType:MTLIndexTypeUInt32 indexBuffer:gpu.indices indexBufferOffset:0 instanceCount:batch.count];
          stats.drawCalls++;
        }
        [enc endEncoding];

        id<MTLComputeCommandEncoder> ce = [commands computeCommandEncoder];
        [ce setComputePipelineState:pipelines.hybridRtGlass];
        [ce setBytes:&ptu length:sizeof(ptu) atIndex:0];
        [ce setAccelerationStructure:ps.instances atBufferIndex:1];
        for (const PartStructure& p : ps.structures) {
          [ce useResource:p.structure usage:MTLResourceUsageRead];
          [ce useResource:p.vertices usage:MTLResourceUsageRead];
          [ce useResource:p.indices usage:MTLResourceUsageRead];
        }
        [ce setBuffer:ps.instanceTable offset:0 atIndex:2];
        [ce setBuffer:ps.meshTable offset:0 atIndex:3];
        [ce setBuffer:ps.materialTable offset:0 atIndex:4];
        [ce setTexture:glassFront atIndex:0];
        [ce setTexture:glassResolved atIndex:1];
        [ce dispatchThreads:MTLSizeMake(static_cast<NSUInteger>(width), static_cast<NSUInteger>(height), 1) threadsPerThreadgroup:MTLSizeMake(8, 8, 1)];
        [ce endEncoding];
      } else if (glassResolved) {
        MTLRenderPassDescriptor* d = [MTLRenderPassDescriptor new];
        d.colorAttachments[0].texture = glassResolved;
        d.colorAttachments[0].loadAction = MTLLoadActionClear;
        d.colorAttachments[0].clearColor = MTLClearColorMake(0, 0, 0, 0);
        d.colorAttachments[0].storeAction = MTLStoreActionStore;
        id<MTLRenderCommandEncoder> enc = [commands renderCommandEncoderWithDescriptor:d];
        [enc endEncoding];
      }
    } else if (hybridActive) {
      PathScene::Impl& ps = ptScene->impl();
      struct PtUniformsGpu {
        simd_float4 eye, right, up, forward;
        simd_float4 lights[4];
        simd_float4 rig, background, floorPlane, glass;
        simd_uint4 size, seed;
      } ptu{};
      ptu.eye = simd_make_float4(u.eye.x, u.eye.y, u.eye.z, static_cast<float>(std::tan(camera.fovY / 2)));
      ptu.right = simd_make_float4(u.right.x, u.right.y, u.right.z, static_cast<float>(width) / height);
      ptu.up = simd_make_float4(u.up.x, u.up.y, u.up.z, 0.0f);
      ptu.forward = simd_make_float4(u.forward.x, u.forward.y, u.forward.z, 0.0f);
      for (int i = 0; i < 4; i++)
        ptu.lights[i] = simd_make_float4(static_cast<float>(rig.toward[i].x), static_cast<float>(rig.toward[i].y), static_cast<float>(rig.toward[i].z), rig.strength[i] * (i == 0 ? 1.0f : kPathFillShare));
      ptu.rig = simd_make_float4(kWorldStrength, kRigSinSquared, std::sqrt(1.0f - kRigSinSquared), 1.0f);
      ptu.background = simd_make_float4(options.background[0], options.background[1], options.background[2], 1.0f);
      ptu.floorPlane = simd_make_float4(ps.floorY, options.floor ? 1.0f : 0.0f, kFloorKeyShare, 0.0f);
      ptu.glass = simd_make_float4(kGlassIor, kGlassAbsorption, kGlassAbsorption / kPathGlassWall, kFloorThroughGlass);
      // DEBUG HOOK: BM_GLASS_SS (1|2), BM_GLASS_WORK (work-loop cap) tune the glass RT kernel.
      // One supersample and a 16-step work loop keep the live glass within 60 FPS: the depth of
      // transport the cap drops is past every path a single transparent brick holds.
      const uint32_t glassSS = getenv("BM_GLASS_SS") ? static_cast<uint32_t>(std::max(1, std::atoi(getenv("BM_GLASS_SS")))) : 1u;
      const uint32_t glassWork = getenv("BM_GLASS_WORK") ? static_cast<uint32_t>(std::max(0, std::atoi(getenv("BM_GLASS_WORK")))) : 16u;
      ptu.size = simd_make_uint4(static_cast<uint32_t>(width), static_cast<uint32_t>(height), glassSS, hybridFrameIdx);
      ptu.seed = simd_make_uint4(hybridFrameIdx, glassWork, ps.instances ? 1u : 0u, kPathMaxBounces);

      struct HybridRtUniformsGpu {
        simd_float4x4 prevViewProj;
        uint32_t frameIndex;
        uint32_t hasHistory;
        uint32_t fullWidth;
        uint32_t fullHeight;
      } hru{};
      hru.prevViewProj = hybridPrevViewProj;
      hru.frameIndex = hybridFrameIdx;
      hru.hasHistory = hybridHasHistory ? 1u : 0u;
      hru.fullWidth = static_cast<uint32_t>(width);
      hru.fullHeight = static_cast<uint32_t>(height);

      // Stage 2: Glass pixel mask (nearest front face only) + Instanced HW-RT Glass Resolve.
      if (!skipStage("glass") && !refract && glassInView && ps.instances) {
        if (!skipStage("glassmask")) {
          MTLRenderPassDescriptor* d = [MTLRenderPassDescriptor new];
          d.colorAttachments[0].texture = glassFront;
          d.colorAttachments[0].loadAction = MTLLoadActionClear;
          d.colorAttachments[0].clearColor = MTLClearColorMake(0, 0, 0, 0);
          d.colorAttachments[0].storeAction = MTLStoreActionStore;
          d.colorAttachments[1].texture = glassMat;
          d.colorAttachments[1].loadAction = MTLLoadActionClear;
          d.colorAttachments[1].clearColor = MTLClearColorMake(0, 0, 0, 0);
          d.colorAttachments[1].storeAction = MTLStoreActionDontCare;
          d.depthAttachment.texture = glassDepthTex;
          d.depthAttachment.loadAction = MTLLoadActionClear;
          d.depthAttachment.clearDepth = 0.0;
          d.depthAttachment.storeAction = MTLStoreActionDontCare;
          id<MTLRenderCommandEncoder> enc = [commands renderCommandEncoderWithDescriptor:d];
          [enc setRenderPipelineState:pipelines.rmidtFront];
          [enc setDepthStencilState:pipelines.depthWrite];
          [enc setCullMode:MTLCullModeBack];
          [enc setVertexBuffer:frameBuffer offset:0 atIndex:1];
          [enc setVertexBuffer:drawBuffer offset:0 atIndex:2];
          [enc setVertexBuffer:visibleBuffer offset:0 atIndex:4];
          [enc setFragmentBuffer:frameBuffer offset:0 atIndex:1];
          [enc setFragmentBuffer:drawBuffer offset:0 atIndex:2];
          [enc setFragmentTexture:depth atIndex:0];
          for (size_t i = 0; i < seen.size(); i++) {
            const Batch& batch = seen[i];
            const Group& group = scene.groups[batch.group];
            if (!(group.material.transparent() && !group.placeholder && !options.clay)) continue;
            const GpuMesh& gpu = mesh(group, batch.detail);
            if (!gpu.indexCount) continue;
            [enc setFrontFacingWinding:batch.mirrored ? MTLWindingClockwise : MTLWindingCounterClockwise];
            [enc setVertexBuffer:gpu.vertices offset:0 atIndex:0];
            [enc setVertexBuffer:instanceBuffers[batch.group][slot] offset:0 atIndex:3];
            [enc setVertexBufferOffset:i * sizeof(DrawUniforms) atIndex:2];
            [enc setFragmentBufferOffset:i * sizeof(DrawUniforms) atIndex:2];
            [enc setVertexBufferOffset:batch.first * sizeof(uint32_t) atIndex:4];
            [enc drawIndexedPrimitives:MTLPrimitiveTypeTriangle indexCount:gpu.indexCount indexType:MTLIndexTypeUInt32 indexBuffer:gpu.indices indexBufferOffset:0 instanceCount:batch.count];
            stats.drawCalls++;
          }
          [enc endEncoding];
        }

        if (!skipStage("glasscompute")) {
          id<MTLComputeCommandEncoder> ce = [commands computeCommandEncoder];
          [ce setComputePipelineState:pipelines.hybridRtGlass];
          [ce setBytes:&ptu length:sizeof(ptu) atIndex:0];
          [ce setAccelerationStructure:ps.instances atBufferIndex:1];
          for (const PartStructure& p : ps.structures) {
            [ce useResource:p.structure usage:MTLResourceUsageRead];
            [ce useResource:p.vertices usage:MTLResourceUsageRead];
            [ce useResource:p.indices usage:MTLResourceUsageRead];
          }
          [ce setBuffer:ps.instanceTable offset:0 atIndex:2];
          [ce setBuffer:ps.meshTable offset:0 atIndex:3];
          [ce setBuffer:ps.materialTable offset:0 atIndex:4];
          [ce setTexture:glassFront atIndex:0];
          [ce setTexture:glassResolved atIndex:1];
          [ce dispatchThreads:MTLSizeMake(static_cast<NSUInteger>(width), static_cast<NSUInteger>(height), 1) threadsPerThreadgroup:MTLSizeMake(8, 8, 1)];
          [ce endEncoding];
        }
      } else {
        MTLRenderPassDescriptor* d = [MTLRenderPassDescriptor new];
        d.colorAttachments[0].texture = glassResolved;
        d.colorAttachments[0].loadAction = MTLLoadActionClear;
        d.colorAttachments[0].clearColor = MTLClearColorMake(0, 0, 0, 0);
        d.colorAttachments[0].storeAction = MTLStoreActionStore;
        id<MTLRenderCommandEncoder> enc = [commands renderCommandEncoderWithDescriptor:d];
        [enc endEncoding];
      }

      // Stage 3: Half-res 1-spp Instanced HW-RT Glossy Reflections + Colored GI.
      const NSUInteger halfW = giRaw.width, halfH = giRaw.height;
      if (!skipStage("gi")) {
        id<MTLComputeCommandEncoder> ce = [commands computeCommandEncoder];
        [ce setComputePipelineState:pipelines.hybridRtGiRefl];
        [ce setBytes:&ptu length:sizeof(ptu) atIndex:0];
        [ce setBytes:&u length:sizeof(u) atIndex:1];
        [ce setBytes:&hru length:sizeof(hru) atIndex:2];
        if (ps.instances) {
          [ce setAccelerationStructure:ps.instances atBufferIndex:3];
          for (const PartStructure& p : ps.structures) {
            [ce useResource:p.structure usage:MTLResourceUsageRead];
            [ce useResource:p.vertices usage:MTLResourceUsageRead];
            [ce useResource:p.indices usage:MTLResourceUsageRead];
          }
          [ce setBuffer:ps.instanceTable offset:0 atIndex:4];
          [ce setBuffer:ps.meshTable offset:0 atIndex:5];
        }
        [ce setBuffer:ps.materialTable offset:0 atIndex:6];
        [ce setTexture:depth atIndex:0];
        [ce setTexture:ambient atIndex:1];
        [ce setTexture:giRaw atIndex:2];
        [ce setTexture:ssrRaw atIndex:3];
        [ce dispatchThreads:MTLSizeMake(halfW, halfH, 1) threadsPerThreadgroup:MTLSizeMake(8, 8, 1)];
        [ce endEncoding];
      }

      // Stage 4: GPU Temporal Reprojection + Edge-Preserving Bilateral Filter.
      const int curH = static_cast<int>(hybridFrameIdx & 1u), prevH = curH ^ 1;
      if (!skipStage("temporal")) {
      {
        id<MTLComputeCommandEncoder> ce = [commands computeCommandEncoder];
        [ce setComputePipelineState:pipelines.hybridRtTemporal];
        [ce setBytes:&u length:sizeof(u) atIndex:0];
        [ce setBytes:&hru length:sizeof(hru) atIndex:1];
        [ce setTexture:depth atIndex:0];
        [ce setTexture:ambient atIndex:1];
        [ce setTexture:giRaw atIndex:2];
        [ce setTexture:ssrRaw atIndex:3];
        [ce setTexture:giHist[prevH] atIndex:4];
        [ce setTexture:ssrHist[prevH] atIndex:5];
        [ce setTexture:rtDepthHist[prevH] atIndex:6];
        [ce setTexture:giHist[curH] atIndex:7];
        [ce setTexture:ssrHist[curH] atIndex:8];
        [ce setTexture:rtDepthHist[curH] atIndex:9];
        [ce dispatchThreads:MTLSizeMake(halfW, halfH, 1) threadsPerThreadgroup:MTLSizeMake(8, 8, 1)];
        [ce endEncoding];
      }
      {
        MTLRenderPassDescriptor* d = [MTLRenderPassDescriptor new];
        d.colorAttachments[0].texture = giSoft;
        d.colorAttachments[0].loadAction = MTLLoadActionDontCare;
        d.colorAttachments[0].storeAction = MTLStoreActionStore;
        d.colorAttachments[1].texture = ssrSoft;
        d.colorAttachments[1].loadAction = MTLLoadActionDontCare;
        d.colorAttachments[1].storeAction = MTLStoreActionStore;
        id<MTLRenderCommandEncoder> enc = [commands renderCommandEncoderWithDescriptor:d];
        [enc setRenderPipelineState:pipelines.ssptBlur];
        [enc setFragmentBytes:&u length:sizeof u atIndex:0];
        [enc setFragmentTexture:giHist[curH] atIndex:0];
        [enc setFragmentTexture:ssrHist[curH] atIndex:1];
        [enc setFragmentTexture:depth atIndex:2];
        [enc setFragmentTexture:ambient atIndex:3];
        [enc drawPrimitives:MTLPrimitiveTypeTriangle vertexStart:0 vertexCount:3];
        [enc endEncoding];
      }
      }
      const bool sameProj = std::memcmp(&hybridPrevViewProj, &fu.viewProj, sizeof(fu.viewProj)) == 0;
      hybridStillFrames = (hybridHasHistory && sameProj) ? (hybridStillFrames + 1u) : 1u;
      if (hybridStillFrames < 12u) stats.settling = true;
      hybridPrevViewProj = fu.viewProj;
      hybridHasHistory = true;
      hybridFrameIdx++;
    } else if (options.screenSpaceGi) {
      const bool useRmidt = !refract && glassInView;
      if (useRmidt) {
        auto drawGlassBatches = [&](id<MTLRenderCommandEncoder> enc) {
          [enc setVertexBuffer:frameBuffer offset:0 atIndex:1];
          [enc setVertexBuffer:drawBuffer offset:0 atIndex:2];
          [enc setVertexBuffer:visibleBuffer offset:0 atIndex:4];
          [enc setFragmentBuffer:frameBuffer offset:0 atIndex:1];
          [enc setFragmentBuffer:drawBuffer offset:0 atIndex:2];
          [enc setFragmentTexture:depth atIndex:0];
          for (size_t i = 0; i < seen.size(); i++) {
            const Batch& batch = seen[i];
            const Group& group = scene.groups[batch.group];
            if (!(group.material.transparent() && !group.placeholder && !options.clay)) continue;
            const GpuMesh& gpu = mesh(group, batch.detail);
            if (!gpu.indexCount) continue;
            [enc setFrontFacingWinding:batch.mirrored ? MTLWindingClockwise : MTLWindingCounterClockwise];
            [enc setVertexBuffer:gpu.vertices offset:0 atIndex:0];
            [enc setVertexBuffer:instanceBuffers[batch.group][slot] offset:0 atIndex:3];
            [enc setVertexBufferOffset:i * sizeof(DrawUniforms) atIndex:2];
            [enc setFragmentBufferOffset:i * sizeof(DrawUniforms) atIndex:2];
            [enc setVertexBufferOffset:batch.first * sizeof(uint32_t) atIndex:4];
            [enc drawIndexedPrimitives:MTLPrimitiveTypeTriangle indexCount:gpu.indexCount indexType:MTLIndexTypeUInt32 indexBuffer:gpu.indices indexBufferOffset:0 instanceCount:batch.count];
            stats.drawCalls++;
          }
        };
        // Pass 1: Nearest front glass face (normal + distance + base color)
        {
          MTLRenderPassDescriptor* d = [MTLRenderPassDescriptor new];
          d.colorAttachments[0].texture = glassFront;
          d.colorAttachments[0].loadAction = MTLLoadActionClear;
          d.colorAttachments[0].clearColor = MTLClearColorMake(0, 0, 0, 0);
          d.colorAttachments[0].storeAction = MTLStoreActionStore;
          d.colorAttachments[1].texture = glassMat;
          d.colorAttachments[1].loadAction = MTLLoadActionClear;
          d.colorAttachments[1].clearColor = MTLClearColorMake(0, 0, 0, 0);
          d.colorAttachments[1].storeAction = MTLStoreActionStore;
          d.depthAttachment.texture = glassDepthTex;
          d.depthAttachment.loadAction = MTLLoadActionClear;
          d.depthAttachment.clearDepth = 0.0;
          d.depthAttachment.storeAction = MTLStoreActionDontCare;
          id<MTLRenderCommandEncoder> enc = [commands renderCommandEncoderWithDescriptor:d];
          [enc setRenderPipelineState:pipelines.rmidtFront];
          [enc setDepthStencilState:pipelines.depthWrite];
          [enc setCullMode:MTLCullModeBack];
          drawGlassBatches(enc);
          [enc endEncoding];
        }
        // Pass 2: Nearest back glass face (inner wall exit -> exact wall thickness)
        {
          MTLRenderPassDescriptor* d = [MTLRenderPassDescriptor new];
          d.colorAttachments[0].texture = glassBackNear;
          d.colorAttachments[0].loadAction = MTLLoadActionClear;
          d.colorAttachments[0].clearColor = MTLClearColorMake(0, 0, 0, 0);
          d.colorAttachments[0].storeAction = MTLStoreActionStore;
          d.depthAttachment.texture = glassDepthTex;
          d.depthAttachment.loadAction = MTLLoadActionClear;
          d.depthAttachment.clearDepth = 0.0;
          d.depthAttachment.storeAction = MTLStoreActionDontCare;
          id<MTLRenderCommandEncoder> enc = [commands renderCommandEncoderWithDescriptor:d];
          [enc setRenderPipelineState:pipelines.rmidtBack];
          [enc setDepthStencilState:pipelines.depthWrite];
          [enc setCullMode:MTLCullModeFront];
          drawGlassBatches(enc);
          [enc endEncoding];
        }
        // Pass 3: Farthest back glass face (hollow cavity far wall)
        {
          MTLRenderPassDescriptor* d = [MTLRenderPassDescriptor new];
          d.colorAttachments[0].texture = glassBackFar;
          d.colorAttachments[0].loadAction = MTLLoadActionClear;
          d.colorAttachments[0].clearColor = MTLClearColorMake(0, 0, 0, 0);
          d.colorAttachments[0].storeAction = MTLStoreActionStore;
          d.depthAttachment.texture = glassDepthTex;
          d.depthAttachment.loadAction = MTLLoadActionClear;
          d.depthAttachment.clearDepth = 1.0;
          d.depthAttachment.storeAction = MTLStoreActionDontCare;
          id<MTLRenderCommandEncoder> enc = [commands renderCommandEncoderWithDescriptor:d];
          [enc setRenderPipelineState:pipelines.rmidtBack];
          [enc setDepthStencilState:pipelines.depthWriteLess];
          [enc setCullMode:MTLCullModeFront];
          drawGlassBatches(enc);
          [enc endEncoding];
        }
        // Pass 4: Analytic multi-interface dielectric transport resolve
        {
          MTLRenderPassDescriptor* d = [MTLRenderPassDescriptor new];
          d.colorAttachments[0].texture = glassResolved;
          d.colorAttachments[0].loadAction = MTLLoadActionDontCare;
          d.colorAttachments[0].storeAction = MTLStoreActionStore;
          id<MTLRenderCommandEncoder> enc = [commands renderCommandEncoderWithDescriptor:d];
          [enc setRenderPipelineState:pipelines.rmidtResolve];
          [enc setFragmentBytes:&u length:sizeof u atIndex:0];
          [enc setFragmentBuffer:frameBuffer offset:0 atIndex:1];
          [enc setFragmentTexture:glassFront atIndex:0];
          [enc setFragmentTexture:glassMat atIndex:1];
          [enc setFragmentTexture:glassBackNear atIndex:2];
          [enc setFragmentTexture:glassBackFar atIndex:3];
          [enc setFragmentTexture:depth atIndex:4];
          [enc setFragmentTexture:color atIndex:5];
          [enc setFragmentTexture:ambient atIndex:6];
          [enc drawPrimitives:MTLPrimitiveTypeTriangle vertexStart:0 vertexCount:3];
          [enc endEncoding];
        }
      } else {
        MTLRenderPassDescriptor* d = [MTLRenderPassDescriptor new];
        d.colorAttachments[0].texture = glassResolved;
        d.colorAttachments[0].loadAction = MTLLoadActionClear;
        d.colorAttachments[0].clearColor = MTLClearColorMake(0, 0, 0, 0);
        d.colorAttachments[0].storeAction = MTLStoreActionStore;
        d.colorAttachments[1].texture = glassFront;
        d.colorAttachments[1].loadAction = MTLLoadActionClear;
        d.colorAttachments[1].clearColor = MTLClearColorMake(0, 0, 0, 0);
        d.colorAttachments[1].storeAction = MTLStoreActionStore;
        id<MTLRenderCommandEncoder> enc = [commands renderCommandEncoderWithDescriptor:d];
        [enc endEncoding];
      }

      for (int pass = 0; pass < 2; pass++) {
        MTLRenderPassDescriptor* d = [MTLRenderPassDescriptor new];
        d.colorAttachments[0].texture = pass == 0 ? giRaw : giSoft;
        d.colorAttachments[0].loadAction = MTLLoadActionDontCare;
        d.colorAttachments[0].storeAction = MTLStoreActionStore;
        d.colorAttachments[1].texture = pass == 0 ? ssrRaw : ssrSoft;
        d.colorAttachments[1].loadAction = MTLLoadActionDontCare;
        d.colorAttachments[1].storeAction = MTLStoreActionStore;
        id<MTLRenderCommandEncoder> enc = [commands renderCommandEncoderWithDescriptor:d];
        [enc setRenderPipelineState:pass == 0 ? pipelines.sspt : pipelines.ssptBlur];
        [enc setFragmentBytes:&u length:sizeof u atIndex:0];
        if (pass == 0) {
          [enc setFragmentBuffer:frameBuffer offset:0 atIndex:1];
          [enc setFragmentTexture:depth atIndex:0];
          [enc setFragmentTexture:color atIndex:1];
          [enc setFragmentTexture:accum atIndex:2];
          [enc setFragmentTexture:reveal atIndex:3];
          [enc setFragmentTexture:ambient atIndex:4];
          [enc setFragmentTexture:glassResolved atIndex:5];
          [enc setFragmentTexture:glassFront atIndex:6];
        } else {
          [enc setFragmentTexture:giRaw atIndex:0];
          [enc setFragmentTexture:ssrRaw atIndex:1];
          [enc setFragmentTexture:depth atIndex:2];
          [enc setFragmentTexture:ambient atIndex:3];
        }
        [enc drawPrimitives:MTLPrimitiveTypeTriangle vertexStart:0 vertexCount:3];
        [enc endEncoding];
      }
    }
    if (useNeural && !skipStage("neural")) {
      const bool neuralRtActive = wantNeuralRt && ptScene && ptScene->impl().instances != nil;
      u.grid.y = neuralRtActive ? 1.0f : 0.0f;
      const NSUInteger halfW = aoRaw.width, halfH = aoRaw.height;
      const MTLSize tgSize = MTLSizeMake(8, 8, 1);
      const MTLSize tgCount = MTLSizeMake((halfW + 7) / 8, (halfH + 7) / 8, 1);
      id<MTLComputeCommandEncoder> ce = [commands computeCommandEncoder];
      // Pass 1: 3D Multi-Ring Horizon, Bent-Normal, Curvature, HW-RT Reflection/Shadow & Multi-Bounce Gather.
      [ce setComputePipelineState:pipelines.neuralFeatures];
      [ce setBytes:&u length:sizeof(u) atIndex:0];
      [ce setBuffer:frameBuffer offset:0 atIndex:1];
      if (neuralRtActive) {
        PathScene::Impl& ps = ptScene->impl();
        [ce setAccelerationStructure:ps.instances atBufferIndex:2];
        for (const PartStructure& p : ps.structures) {
          [ce useResource:p.structure usage:MTLResourceUsageRead];
          [ce useResource:p.vertices usage:MTLResourceUsageRead];
          [ce useResource:p.indices usage:MTLResourceUsageRead];
        }
        [ce setBuffer:ps.instanceTable offset:0 atIndex:3];
        [ce setBuffer:ps.meshTable offset:0 atIndex:4];
        [ce setBuffer:ps.materialTable offset:0 atIndex:5];
      }
      [ce setTexture:depth atIndex:0];
      [ce setTexture:color atIndex:1];
      [ce setTexture:ambient atIndex:2];
      [ce setTexture:aoSoft atIndex:3];
      [ce setTexture:accum atIndex:4];
      [ce setTexture:reveal atIndex:5];
      [ce setTexture:giRaw atIndex:6];
      [ce setTexture:ssrRaw atIndex:7];
      [ce setTexture:rtDepthHist[0] atIndex:8];
      [ce dispatchThreadgroups:tgCount threadsPerThreadgroup:tgSize];
      // Pass 2: 10x10 Threadgroup-SRAM Spatial Graph Conv + Fused 4-Layer FP16 Residual MLP.
      [ce setComputePipelineState:pipelines.neuralInfer];
      [ce setBytes:&u length:sizeof(u) atIndex:0];
      [ce setBuffer:frameBuffer offset:0 atIndex:1];
      [ce setBuffer:neuralWeightsBuffer offset:0 atIndex:2];
      [ce setTexture:depth atIndex:0];
      [ce setTexture:color atIndex:1];
      [ce setTexture:ambient atIndex:2];
      [ce setTexture:aoSoft atIndex:3];
      [ce setTexture:giRaw atIndex:4];
      [ce setTexture:ssrRaw atIndex:5];
      [ce setTexture:giSoft atIndex:6];
      [ce setTexture:ssrSoft atIndex:7];
      [ce setTexture:rtDepthHist[0] atIndex:8];
      [ce setTexture:giHist[0] atIndex:9];
      [ce dispatchThreadgroups:tgCount threadsPerThreadgroup:tgSize];
      [ce endEncoding];
    }
  }

  // Background, transparency, ambient occlusion, selection outline, tone curve, sRGB.
  {
    MTLRenderPassDescriptor* pass = [MTLRenderPassDescriptor new];
    pass.colorAttachments[0].texture = lensOn && lensSource ? lensSource : target;
    pass.colorAttachments[0].loadAction = MTLLoadActionDontCare;
    pass.colorAttachments[0].storeAction = MTLStoreActionStore;
    id<MTLRenderCommandEncoder> enc = [commands renderCommandEncoderWithDescriptor:pass];
    [enc setRenderPipelineState:pipelines.composite];
    // Lighting textures round up to whole cells, so their dimensions do not recover the stride.
    const int32_t lightingStride = screenDiv;
    [enc setFragmentBytes:&lightingStride length:sizeof lightingStride atIndex:0];
    [enc setFragmentBuffer:frameBuffer offset:0 atIndex:1];
    [enc setFragmentTexture:color atIndex:0];
    [enc setFragmentTexture:accum atIndex:1];
    [enc setFragmentTexture:reveal atIndex:2];
    [enc setFragmentTexture:mask atIndex:3];
    [enc setFragmentTexture:ambient atIndex:4];
    [enc setFragmentTexture:aoSoft atIndex:5];
    [enc setFragmentTexture:depth atIndex:6];
    [enc setFragmentTexture:giSoft atIndex:7];
    [enc setFragmentTexture:ssrSoft atIndex:8];
    [enc setFragmentTexture:glassResolved ? glassResolved : color atIndex:9];
    [enc setFragmentTexture:giHist[0] atIndex:10];
    [enc setFragmentSamplerState:pipelines.smooth atIndex:0];
    [enc drawPrimitives:MTLPrimitiveTypeTriangle vertexStart:0 vertexCount:3];
    [enc endEncoding];
  }

  if (lensOn && lensSource) {
    // Must match LensUniforms in shaders/lens.metal.
    struct LensUniforms {
      float texel[2], focus, maxR, radScale, depthA, depthB, ortho, depthNear, depthFar;
    } lu{};
    const Mat4 projection = projectionMatrix(camera);
    lu.texel[0] = 1.0f / width, lu.texel[1] = 1.0f / height;
    lu.focus = static_cast<float>(options.focusDistance);
    lu.maxR = lensMaxPx;
    lu.radScale = std::max(0.5f, lensMaxPx / 24);  // keeps the sample count near 12 per pixel of blur radius
    lu.depthA = projection.m[10], lu.depthB = projection.m[14];
    lu.ortho = camera.orthoHalfHeight > 0 ? 1.0f : 0.0f;
    lu.depthNear = static_cast<float>(std::max(1e-3, camera.near)), lu.depthFar = static_cast<float>(std::max(std::max(1e-3, camera.near) * 1.001, camera.far));
    MTLRenderPassDescriptor* pass = [MTLRenderPassDescriptor new];
    pass.colorAttachments[0].texture = target;
    pass.colorAttachments[0].loadAction = MTLLoadActionDontCare;
    pass.colorAttachments[0].storeAction = MTLStoreActionStore;
    id<MTLRenderCommandEncoder> enc = [commands renderCommandEncoderWithDescriptor:pass];
    [enc setRenderPipelineState:pipelines.lens];
    [enc setFragmentBytes:&lu length:sizeof lu atIndex:0];
    [enc setFragmentTexture:lensSource atIndex:0];
    [enc setFragmentTexture:depth atIndex:1];
    [enc setFragmentSamplerState:pipelines.smooth atIndex:0];
    [enc drawPrimitives:MTLPrimitiveTypeTriangle vertexStart:0 vertexCount:3];
    [enc endEncoding];
  }

  // Kept for picking.
  drewFrame = true, idsReady = false, lastSlot = slot, lastCamera = camera;
  lastList.swap(list);
  lastSeen.swap(seen);

  dispatch_semaphore_t done = inFlight;
  std::atomic<double>* gpu = &gpuMs;
  [commands addCompletedHandler:^(id<MTLCommandBuffer> finished) {
    gpu->store((finished.GPUEndTime - finished.GPUStartTime) * 1000.0);
    dispatch_semaphore_signal(done);
  }];
  if (drawable) [commands presentDrawable:drawable];
  [commands commit];
  stats.submitted = true;
  stats.cpuMs = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - started).count();
  if (!drawable) {
    [commands waitUntilCompleted];
    stats.gpuMs = (commands.GPUEndTime - commands.GPUStartTime) * 1000.0;
    drewOffscreen = true;
  }
  return stats;
}

}  // namespace bmr
