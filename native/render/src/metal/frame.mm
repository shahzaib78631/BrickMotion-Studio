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
  // orders them, then transparent ones), and what casts a shadow (every opaque piece shown, in
  // view or not, since one out of view can shadow one in it; at low detail unless a detail is
  // forced, as a shadow does not show a stud's sides).
  const bool forced = options.forceDetail >= 0 && options.forceDetail <= 2;
  const std::vector<Visible> inView = cull(scene, parts, camera, height, options.forceDetail, options.cull);
  std::vector<uint32_t> list;
  std::vector<Batch> seen, casters;
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
  // The shadow map is drawn again only when a piece has moved, appeared or gone since it was,
  // or it was drawn at another detail.
  const int casterDetail = forced ? options.forceDetail : static_cast<int>(Detail::Shadow);
  const LightRig rig = studioLights(camera, options.lightsFollowCamera);
  const bm::Vec3 toward = rig.toward[0];
  const bool redrawShadow = options.shadows && (!shadowMap || shadowDetail != casterDetail || length(toward - shadowToward) > 1e-9);
  // The half-size pass (occlusion, the key's shadow, the floor's light) runs with either on;
  // the height map, for the floor's light, is kept only while the floor is drawn too, and is
  // drawn again only when a piece has moved, appeared or gone.
  const bool screenPass = options.shadows || options.ambientOcclusion;
  const bool floorLit = screenPass && options.floor;
  const bool redrawHeight = floorLit && (!heightMap || heightDetail != casterDetail);
  if (redrawShadow || redrawHeight) {
    std::vector<uint32_t> shown;
    for (uint32_t g = 0; g < scene.groups.size(); g++) {
      const Group& group = scene.groups[g];
      if (group.material.transparent()) continue;
      shown.clear();
      for (uint32_t i = 0; i < group.instances.size(); i++)
        if (!(group.instances[i].flags & kHidden)) shown.push_back(i);
      add(casters, g, static_cast<Detail>(casterDetail), shown);
    }
  }

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

  // The floor and the key light are fitted to the model at rest.
  const bm::Box& b = scene.bounds;
  const double diagonal = b.empty() ? 1.0 : std::max(1.0, length(b.max - b.min));
  const bm::Vec3 middle = b.empty() ? scene.origin : (b.min + b.max) * 0.5;
  const KeyLight key = keyLight(liveBounds, scene.origin, toward, kShadowMapSize, kFloorExtent * diagonal);
  const KeyLight above = keyLight(liveBounds, scene.origin, bm::Vec3{0, -1, 0}, kHeightMapSize, 0);

  FrameUniforms fu{};
  fu.viewProj = simdFrom(multiply(projectionMatrix(camera), viewMatrix(camera, scene.origin)));
  fu.shadowProj = simdFrom(key.matrix);
  const bm::Vec3 eye = camera.eye - scene.origin;
  fu.eye = simd_make_float4(static_cast<float>(eye.x), static_cast<float>(eye.y), static_cast<float>(eye.z), 1);
  for (int i = 0; i < 4; i++)
    fu.lights[i] = simd_make_float4(static_cast<float>(rig.toward[i].x), static_cast<float>(rig.toward[i].y), static_cast<float>(rig.toward[i].z), rig.strength[i]);
  fu.rig = simd_make_float4(kWorldStrength, kRigSinSquared, kAoBrickPower, 0);
  fu.background = simd_make_float4(options.background[0], options.background[1], options.background[2], 1);
  fu.viewport = simd_make_float4(static_cast<float>(width), static_cast<float>(height), 1.0f / static_cast<float>(width), 1.0f / static_cast<float>(height));
  fu.switches = simd_make_float4(options.shadows ? 1 : 0, options.ambientOcclusion ? 1 : 0, 0, 0);
  const double floorY = (b.empty() ? 0.0 : b.max.y - scene.origin.y) + kFloorLift;
  fu.floorPlane = simd_make_float4(static_cast<float>(floorY), static_cast<float>(kFloorExtent * diagonal), static_cast<float>(key.texel), kShadowBias);
  fu.floorCentre = simd_make_float4(static_cast<float>(middle.x - scene.origin.x), static_cast<float>(middle.z - scene.origin.z), kFloorShadow, kOitDepthScale);
  fu.lens = simd_make_float4(static_cast<float>(std::tan(camera.fovY / 2)), static_cast<float>(kEdgeStudPixels / kStudLdu), static_cast<float>(kEdgeStudFullPixels / kStudLdu), 0);
  const simd_float3 accent = simd_make_float3(linearFromSrgb(kSelectionRgb[0]), linearFromSrgb(kSelectionRgb[1]), linearFromSrgb(kSelectionRgb[2]));
  fu.selection = simd_make_float4(accent.x, accent.y, accent.z, selected.empty() ? 0.0f : kSelectionWidth);
  fu.heightProj = simdFrom(above.matrix);
  fu.floorLook = simd_make_float4(static_cast<float>(std::max(1.0, above.texel)), static_cast<float>(kFloorLookShare * kFloorExtent * diagonal), floorLit && !liveBounds.empty() ? 1.0f : 0.0f, kFloorSkyPower);
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

  // One DrawUniforms per batch: the seen ones, then the shadow casters', then the outlined.
  const size_t batchCount = seen.size() + casters.size() + outlined.size();
  id<MTLBuffer> drawBuffer = drawUniforms.get(dev, frame, std::max<size_t>(1, batchCount) * sizeof(DrawUniforms));
  auto* du = static_cast<DrawUniforms*>(drawBuffer.contents);
  for (size_t i = 0; i < batchCount; i++) {
    const Batch& batch = i < seen.size() ? seen[i] : i < seen.size() + casters.size() ? casters[i - seen.size()] : outlined[i - seen.size() - casters.size()];
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

  // The key light's depth map.
  if (options.shadows && !shadowMap) {
    MTLTextureDescriptor* d = [MTLTextureDescriptor texture2DDescriptorWithPixelFormat:MTLPixelFormatDepth32Float width:kShadowMapSize height:kShadowMapSize mipmapped:NO];
    d.usage = MTLTextureUsageRenderTarget | MTLTextureUsageShaderRead;
    d.storageMode = MTLStorageModePrivate;
    shadowMap = [dev newTextureWithDescriptor:d];
  }
  if (redrawShadow && shadowMap) {
    shadowDetail = casterDetail, shadowToward = toward;
    stats.shadowDrawn = true;
    MTLRenderPassDescriptor* pass = [MTLRenderPassDescriptor new];
    pass.depthAttachment.texture = shadowMap;
    pass.depthAttachment.loadAction = MTLLoadActionClear;
    pass.depthAttachment.clearDepth = 1;
    pass.depthAttachment.storeAction = MTLStoreActionStore;
    id<MTLRenderCommandEncoder> enc = [commands renderCommandEncoderWithDescriptor:pass];
    [enc setRenderPipelineState:pipelines.shadow];
    [enc setDepthStencilState:pipelines.shadowDepth];
    [enc setCullMode:MTLCullModeNone];
    [enc setDepthBias:0 slopeScale:kShadowSlopeBias clamp:0];
    [enc setVertexBuffer:frameBuffer offset:0 atIndex:1];
    [enc setVertexBuffer:visibleBuffer offset:0 atIndex:4];
    for (const Batch& batch : casters) {
      const GpuMesh& gpu = mesh(scene.groups[batch.group], batch.detail);
      if (!gpu.indexCount) continue;
      [enc setVertexBuffer:gpu.vertices offset:0 atIndex:0];
      [enc setVertexBuffer:instanceBuffers[batch.group][slot] offset:0 atIndex:3];
      [enc setVertexBufferOffset:batch.first * sizeof(uint32_t) atIndex:4];
      [enc drawIndexedPrimitives:MTLPrimitiveTypeTriangle indexCount:gpu.indexCount indexType:MTLIndexTypeUInt32 indexBuffer:gpu.indices indexBufferOffset:0 instanceCount:batch.count];
      stats.drawCalls++;
      stats.shadowTriangles += static_cast<uint64_t>(gpu.indexCount / 3) * batch.count;
    }
    [enc endEncoding];
  }
  // The height map over the model, for the floor's light.
  if (floorLit && !heightMap) {
    MTLTextureDescriptor* d = [MTLTextureDescriptor texture2DDescriptorWithPixelFormat:MTLPixelFormatRG16Float width:kHeightMapSize height:kHeightMapSize mipmapped:NO];
    d.usage = MTLTextureUsageRenderTarget | MTLTextureUsageShaderRead;
    d.storageMode = MTLStorageModePrivate;
    heightMap = [dev newTextureWithDescriptor:d];
  }
  if (redrawHeight && heightMap) {
    heightDetail = casterDetail;
    MTLRenderPassDescriptor* pass = [MTLRenderPassDescriptor new];
    pass.colorAttachments[0].texture = heightMap;
    pass.colorAttachments[0].loadAction = MTLLoadActionClear;
    pass.colorAttachments[0].clearColor = MTLClearColorMake(65504, 65504, 0, 0);  // nothing: no top, no underside
    pass.colorAttachments[0].storeAction = MTLStoreActionStore;
    id<MTLRenderCommandEncoder> enc = [commands renderCommandEncoderWithDescriptor:pass];
    [enc setRenderPipelineState:pipelines.height];
    [enc setCullMode:MTLCullModeNone];
    [enc setVertexBuffer:frameBuffer offset:0 atIndex:1];
    [enc setVertexBuffer:visibleBuffer offset:0 atIndex:4];
    for (const Batch& batch : casters) {
      const GpuMesh& gpu = mesh(scene.groups[batch.group], batch.detail);
      if (!gpu.indexCount) continue;
      [enc setVertexBuffer:gpu.vertices offset:0 atIndex:0];
      [enc setVertexBuffer:instanceBuffers[batch.group][slot] offset:0 atIndex:3];
      [enc setVertexBufferOffset:batch.first * sizeof(uint32_t) atIndex:4];
      [enc drawIndexedPrimitives:MTLPrimitiveTypeTriangle indexCount:gpu.indexCount indexType:MTLIndexTypeUInt32 indexBuffer:gpu.indices indexBufferOffset:0 instanceCount:batch.count];
      stats.drawCalls++;
    }
    [enc endEncoding];
  }
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
        const size_t i = seen.size() + casters.size() + k;  // its DrawUniforms
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
