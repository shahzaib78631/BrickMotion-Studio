// One frame: which instances, at which detail, in which order, into which targets.
#import "metal/impl.h"

#include <chrono>
#include <cmath>
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

  // Which instances, at which detail: what the eye sees (opaque groups first, as the scene
  // orders them, then transparent ones), and what the maps are drawn from (below).
  const bool forced = options.forceDetail >= 0 && options.forceDetail <= 2;
  const std::vector<Visible> inView = cull(scene, parts, camera, height, options.forceDetail, options.cull);
  std::vector<uint32_t> list;
  std::vector<Batch> seen;
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
  // What casts, into the key light's depth map and the height map over the model: every opaque
  // piece shown, in view or not (one out of view can shadow one in it), at low detail without
  // studs unless a detail is forced (a shadow does not show a stud's sides).
  const int casterDetail = forced ? options.forceDetail : static_cast<int>(Detail::Shadow);
  const LightRig rig = studioLights(camera, options.lightsFollowCamera);
  const bm::Vec3 toward = rig.toward[0], down{0, -1, 0};
  // The half-size pass (occlusion, the key's shadow, the floor's light) runs with either on;
  // the height map, for the floor's light, is kept only while the floor is drawn too.
  const bool screenPass = options.shadows || options.ambientOcclusion;
  const bool floorLit = screenPass && options.floor;
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
        if (!(group.instances[i].flags & kHidden) && keep(g, i)) shown.push_back(i);
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
      std::vector<uint64_t> triangles(groups, 0);
      uint64_t total = 0;
      for (uint32_t g = 0; g < groups; g++) {
        const Group& group = scene.groups[g];
        if (group.material.transparent() && !glass) continue;
        uint64_t count = 0;
        for (const Instance& in : group.instances) count += (in.flags & kHidden) ? 0 : 1;
        if (count) triangles[g] = count * (mesh(group, static_cast<Detail>(casterDetail)).indexCount / 3);
        total += triangles[g];
      }
      const uint64_t shares = std::max<uint64_t>(1, (total + options.mapTrianglesPerFrame - 1) / options.mapTrianglesPerFrame);
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

  FrameUniforms fu{};
  fu.viewProj = simdFrom(multiply(projectionMatrix(camera), viewMatrix(camera, scene.origin)));
  fu.shadowProj = simdFrom(options.shadows ? keyShown.matrix : key.matrix);
  const bm::Vec3 eye = camera.eye - scene.origin;
  fu.eye = simd_make_float4(static_cast<float>(eye.x), static_cast<float>(eye.y), static_cast<float>(eye.z), 1);
  for (int i = 0; i < 4; i++)
    fu.lights[i] = simd_make_float4(static_cast<float>(rig.toward[i].x), static_cast<float>(rig.toward[i].y), static_cast<float>(rig.toward[i].z), rig.strength[i]);
  fu.rig = simd_make_float4(kWorldStrength, kRigSinSquared, kAoBrickPower, 0);
  fu.background = simd_make_float4(options.background[0], options.background[1], options.background[2], 1);
  fu.viewport = simd_make_float4(static_cast<float>(width), static_cast<float>(height), 1.0f / static_cast<float>(width), 1.0f / static_cast<float>(height));
  fu.switches = simd_make_float4(options.shadows ? 1 : 0, options.ambientOcclusion ? 1 : 0, 0, 0);
  const double floorY = (b.empty() ? 0.0 : b.max.y - scene.origin.y) + kFloorLift;
  fu.floorPlane = simd_make_float4(static_cast<float>(floorY), static_cast<float>(kFloorExtent * diagonal), static_cast<float>(options.shadows ? keyShown.texel : key.texel), kShadowBias);
  fu.floorCentre = simd_make_float4(static_cast<float>(middle.x - scene.origin.x), static_cast<float>(middle.z - scene.origin.z), kFloorShadow, kOitDepthScale);
  fu.lens = simd_make_float4(static_cast<float>(std::tan(camera.fovY / 2)), static_cast<float>(kEdgeStudPixels / kStudLdu), static_cast<float>(kEdgeStudFullPixels / kStudLdu), 0);
  const simd_float3 accent = simd_make_float3(linearFromSrgb(kSelectionRgb[0]), linearFromSrgb(kSelectionRgb[1]), linearFromSrgb(kSelectionRgb[2]));
  fu.selection = simd_make_float4(accent.x, accent.y, accent.z, selected.empty() ? 0.0f : kSelectionWidth);
  fu.heightProj = simdFrom(floorLit ? heightShown.matrix : above.matrix);
  fu.floorLook = simd_make_float4(static_cast<float>(std::max(1.0, floorLit ? heightShown.texel : above.texel)), static_cast<float>(kFloorLookShare * kFloorExtent * diagonal), floorLit && !liveBounds.empty() ? 1.0f : 0.0f, kFloorSkyPower);
  // How much of each light's disk each of the floor's 12 directions and 16 elevation bins
  // holds (floor_light.metal), with each bin's light on a level floor (even in sin^2 elevation):
  // worked out again only when the lights have turned.
  id<MTLBuffer> binsBuffer = floorBins.get(dev, frame, sizeof(FloorBins));
  bool sameRig = floorTable != nullptr;
  for (int i = 0; i < 4 && sameRig; i++) sameRig = length(rig.toward[i] - floorTableToward[i]) <= 1e-12;
  if (floorLit && !floorTable) floorTable = std::make_unique<FloorBins>();
  for (int i = 0; i < 4 && floorLit && !sameRig; i++) {
    FloorBins& bins = *floorTable;
    floorTableToward[i] = rig.toward[i];
    const bm::Vec3 t = normalized(rig.toward[i]);
    const double cosRadius = std::sqrt(1.0 - kRigSinSquared);
    for (int d = 0; d < 48; d++)
      for (int b = 0; b < 16; b++) {
        int inside = 0;
        for (int u = 0; u < 4; u++)
          for (int v = 0; v < 4; v++) {
            const double azimuth = (d / 4.0 + (u + 0.5) / 4 - 0.5) * (2 * M_PI / 12), s = (b + (v + 0.5) / 4) / 16;
            const double up = std::sqrt(s), across = std::sqrt(1 - s);
            const bm::Vec3 dir{across * std::cos(azimuth), -up, across * std::sin(azimuth)};
            if (dot(dir, t) > cosRadius) inside++;
          }
        bins.weight[i][d][b] = static_cast<float>(inside) / 16.0f;
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
    du[i].edge = simd_make_float4(m.edge[0], m.edge[1], m.edge[2], kEdgeOpacity);
    du[i].flip = simd_make_float4(batch.mirrored ? -1 : 1, 0, 0, 0);
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
  stats.settling = overFrames && ((options.shadows && (shadow.building || stale(shadow, toward))) || (floorLit && (heights.building || stale(heights, down))));
  id<MTLTexture> shadowTexture = options.shadows && shadowMap ? shadowMap : placeholderShadow;

  // The model, multisampled, resolved into `color`, `accum` and `reveal`.
  {
    MTLRenderPassDescriptor* pass = [MTLRenderPassDescriptor new];
    id<MTLTexture> ms[4] = {colorMs, accumMs, revealMs, ambientMs}, resolved[4] = {color, accum, reveal, ambient};
    for (int i = 0; i < 4; i++) {
      pass.colorAttachments[i].texture = ms[i];
      pass.colorAttachments[i].resolveTexture = resolved[i];
      pass.colorAttachments[i].loadAction = MTLLoadActionClear;
      pass.colorAttachments[i].clearColor = MTLClearColorMake(0, 0, 0, 0);  // nothing drawn: no coverage, no optical depth, no ambient share
      pass.colorAttachments[i].storeAction = MTLStoreActionMultisampleResolve;
    }
    pass.depthAttachment.texture = depthMs;
    pass.depthAttachment.loadAction = MTLLoadActionClear;
    pass.depthAttachment.clearDepth = 0;  // reversed depth: 0 is the far plane
    // One sample of depth kept, for ambient occlusion and the key light's shadow.
    const bool keepDepth = options.ambientOcclusion || options.shadows;
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

    auto bricks = [&](bool transparent) {
      for (size_t i = 0; i < seen.size(); i++) {
        const Batch& batch = seen[i];
        const Group& group = scene.groups[batch.group];
        if (group.material.transparent() != transparent) continue;
        const GpuMesh& gpu = mesh(group, batch.detail);
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
    bricks(false);

    if (options.floor) {
      [enc setCullMode:MTLCullModeNone];
      [enc setRenderPipelineState:pipelines.floor];
      [enc setDepthStencilState:pipelines.depthWrite];  // in the depth buffer, so ambient occlusion sees it
      [enc drawPrimitives:MTLPrimitiveTypeTriangle vertexStart:0 vertexCount:6];
      stats.drawCalls++;
    }

    if (options.edges) {
      [enc setCullMode:MTLCullModeNone];
      [enc setRenderPipelineState:pipelines.edges];
      [enc setDepthStencilState:pipelines.depthRead];
      const float nearer = kEdgeNearer;
      [enc setVertexBytes:&nearer length:sizeof nearer atIndex:5];
      for (size_t k = 0; k < outlined.size(); k++) {
        const Batch& batch = outlined[k];
        const size_t i = seen.size() + k;  // its DrawUniforms
        const GpuMesh& gpu = mesh(scene.groups[batch.group], batch.detail);
        if (!gpu.edgeVertices) continue;
        [enc setVertexBuffer:gpu.edges offset:0 atIndex:0];
        [enc setVertexBuffer:instanceBuffers[batch.group][slot] offset:0 atIndex:3];
        [enc setVertexBufferOffset:i * sizeof(DrawUniforms) atIndex:2];
        [enc setFragmentBufferOffset:i * sizeof(DrawUniforms) atIndex:2];
        [enc setVertexBufferOffset:batch.first * sizeof(uint32_t) atIndex:4];
        [enc drawPrimitives:MTLPrimitiveTypeLine vertexStart:0 vertexCount:gpu.edgeVertices instanceCount:batch.count];
        stats.drawCalls++;
      }
    }

    [enc setCullMode:MTLCullModeBack];
    [enc setRenderPipelineState:pipelines.transparent];
    [enc setDepthStencilState:pipelines.depthRead];
    bricks(true);
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

  // Ambient occlusion at half size, then blurred.
  if (screenPass) {
    struct AoUniforms {
      simd_float4 lens, shape, size, eye, right, up, forward;
    } u;
    {
      // The camera's axes in world space, as viewMatrix makes them.
      const bm::Vec3 f = normalized(camera.target - camera.eye), r = normalized(cross(f, camera.up)), up = cross(r, f), e = camera.eye - scene.origin;
      auto v4 = [](bm::Vec3 v) { return simd_make_float4(static_cast<float>(v.x), static_cast<float>(v.y), static_cast<float>(v.z), 0); };
      u.eye = v4(e), u.right = v4(r), u.up = v4(up), u.forward = v4(f);
    }
    const float tanY = static_cast<float>(std::tan(camera.fovY / 2));
    u.lens = simd_make_float4(tanY, tanY * static_cast<float>(camera.aspect), static_cast<float>(camera.near), static_cast<float>(camera.far));
    u.shape = simd_make_float4(kAoRadius, kAoBias, kAoStrength, static_cast<float>(width));
    u.size = simd_make_float4(static_cast<float>(height), static_cast<float>(aoRaw.width), static_cast<float>(aoRaw.height), 0);
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
  }

  // Background, transparency, ambient occlusion, selection outline, tone curve, sRGB.
  {
    MTLRenderPassDescriptor* pass = [MTLRenderPassDescriptor new];
    pass.colorAttachments[0].texture = target;
    pass.colorAttachments[0].loadAction = MTLLoadActionDontCare;
    pass.colorAttachments[0].storeAction = MTLStoreActionStore;
    id<MTLRenderCommandEncoder> enc = [commands renderCommandEncoderWithDescriptor:pass];
    [enc setRenderPipelineState:pipelines.composite];
    [enc setFragmentBuffer:frameBuffer offset:0 atIndex:1];
    [enc setFragmentTexture:color atIndex:0];
    [enc setFragmentTexture:accum atIndex:1];
    [enc setFragmentTexture:reveal atIndex:2];
    [enc setFragmentTexture:mask atIndex:3];
    [enc setFragmentTexture:ambient atIndex:4];
    [enc setFragmentTexture:aoSoft atIndex:5];
    [enc setFragmentTexture:depth atIndex:6];
    [enc setFragmentSamplerState:pipelines.smooth atIndex:0];
    [enc drawPrimitives:MTLPrimitiveTypeTriangle vertexStart:0 vertexCount:3];
    [enc endEncoding];
  }

  // Kept for picking.
  drewFrame = true, idsReady = false, lastSlot = slot, lastCamera = camera;
  lastList.assign(list.begin(), list.end());
  lastSeen = seen;

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
