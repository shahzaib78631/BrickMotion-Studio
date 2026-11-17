// One frame: which instances, at which detail, in which order, into which targets.
#import "metal/impl.h"

#include <chrono>
#include "bmr/cull.h"
#include "bmr/tolerances.h"

namespace bmr {
namespace {

/// One draw call's worth: instances of a group at one detail, mirrored or not.
struct Batch {
  uint32_t group;
  Detail detail;
  bool mirrored;
  uint32_t first, count;  // in the frame's list of visible instance numbers
};

}  // namespace

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
  const std::vector<Visible> inView = cull(scene, meshBounds, camera, height, options.forceDetail, options.cull);
  std::vector<uint32_t> list;
  std::vector<Batch> seen, casters;
  auto add = [&](std::vector<Batch>& into, uint32_t g, Detail d, const std::vector<uint32_t>& instances) {
    const Group& group = scene.groups[g];
    for (int mirrored = 0; mirrored < 2; mirrored++) {
      const uint32_t first = static_cast<uint32_t>(list.size());
      for (uint32_t i : instances)
        if (((group.instances[i].flags & kMirrored) != 0) == (mirrored != 0)) list.push_back(i);
      if (list.size() > first) into.push_back({g, d, mirrored != 0, first, static_cast<uint32_t>(list.size()) - first});
    }
  };
  for (uint32_t g = 0; g < scene.groups.size(); g++) {
    for (int d = 0; d < 3; d++) add(seen, g, static_cast<Detail>(d), inView[g].byDetail[d]);
    stats.culled += inView[g].culled;
  }
  if (options.shadows) {
    std::vector<uint32_t> shown;
    for (uint32_t g = 0; g < scene.groups.size(); g++) {
      const Group& group = scene.groups[g];
      if (group.material.transparent()) continue;
      shown.clear();
      for (uint32_t i = 0; i < group.instances.size(); i++)
        if (!(group.instances[i].flags & kHidden)) shown.push_back(i);
      add(casters, g, forced ? static_cast<Detail>(options.forceDetail) : Detail::Low, shown);
    }
  }

  dispatch_semaphore_wait(inFlight, DISPATCH_TIME_FOREVER);
  frame++;
  id<MTLDevice> dev = device->device;

  // The floor and the key light are fitted to the model at rest.
  const bm::Box& b = scene.bounds;
  const double diagonal = b.empty() ? 1.0 : std::max(1.0, length(b.max - b.min));
  const bm::Vec3 middle = b.empty() ? scene.origin : (b.min + b.max) * 0.5;
  const bm::Vec3 toward{kKeyDirection[0], kKeyDirection[1], kKeyDirection[2]};
  const KeyLight key = keyLight(b, scene.origin, toward, kShadowMapSize, kFloorExtent * diagonal);

  FrameUniforms fu{};
  fu.viewProj = simdFrom(multiply(projectionMatrix(camera), viewMatrix(camera, scene.origin)));
  fu.shadowProj = simdFrom(key.matrix);
  const bm::Vec3 eye = camera.eye - scene.origin;
  fu.eye = simd_make_float4(static_cast<float>(eye.x), static_cast<float>(eye.y), static_cast<float>(eye.z), 1);
  fu.keyDirection = keyDirectionVector();
  fu.background = simd_make_float4(options.background[0], options.background[1], options.background[2], 1);
  fu.viewport = simd_make_float4(static_cast<float>(width), static_cast<float>(height), 1.0f / static_cast<float>(width), 1.0f / static_cast<float>(height));
  fu.room = roomVector();
  fu.switches = simd_make_float4(options.shadows ? 1 : 0, options.ambientOcclusion ? 1 : 0, static_cast<float>(kReflectionMips - 1), kClearcoatRoughness);
  const double floorY = (b.empty() ? 0.0 : b.max.y - scene.origin.y) + kFloorLift;
  fu.floorPlane = simd_make_float4(static_cast<float>(floorY), static_cast<float>(kFloorExtent * diagonal), static_cast<float>(key.texel), kShadowBias);
  fu.floorCentre = simd_make_float4(static_cast<float>(middle.x - scene.origin.x), static_cast<float>(middle.z - scene.origin.z), kFloorShadow, kOitDepthScale);
  fu.lens = simd_make_float4(static_cast<float>(std::tan(camera.fovY / 2)), static_cast<float>(kFullPixels), static_cast<float>(kEdgeFullPixels), 0);
  id<MTLBuffer> frameBuffer = frameUniforms.get(dev, frame, sizeof fu);
  std::memcpy(frameBuffer.contents, &fu, sizeof fu);

  // One DrawUniforms per batch, the shadow casters' after the seen ones.
  const size_t batchCount = seen.size() + casters.size();
  id<MTLBuffer> drawBuffer = drawUniforms.get(dev, frame, std::max<size_t>(1, batchCount) * sizeof(DrawUniforms));
  auto* du = static_cast<DrawUniforms*>(drawBuffer.contents);
  for (size_t i = 0; i < batchCount; i++) {
    const Batch& batch = i < seen.size() ? seen[i] : casters[i - seen.size()];
    const Group& group = scene.groups[batch.group];
    const Material& m = group.material;
    du[i].base = simd_make_float4(m.base[0], m.base[1], m.base[2], m.alpha);
    du[i].surface = simd_make_float4(m.roughness, m.metalness, m.clearcoat, group.placeholder ? 1 : 0);
    du[i].edge = simd_make_float4(m.edge[0], m.edge[1], m.edge[2], kEdgeOpacity);
    du[i].flip = simd_make_float4(batch.mirrored ? -1 : 1, 0, 0, 0);
    const bm::Box& part = meshBounds[batch.group];
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
  if (options.shadows && shadowMap) {
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
      [enc setVertexBuffer:instanceBuffers[batch.group] offset:0 atIndex:3];
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
    id<MTLTexture> ms[3] = {colorMs, accumMs, revealMs}, resolved[3] = {color, accum, reveal};
    const MTLClearColor clears[3] = {MTLClearColorMake(0, 0, 0, 0), MTLClearColorMake(0, 0, 0, 0), MTLClearColorMake(0, 0, 0, 0)};  // nothing drawn: no coverage, no optical depth
    for (int i = 0; i < 3; i++) {
      pass.colorAttachments[i].texture = ms[i];
      pass.colorAttachments[i].resolveTexture = resolved[i];
      pass.colorAttachments[i].loadAction = MTLLoadActionClear;
      pass.colorAttachments[i].clearColor = clears[i];
      pass.colorAttachments[i].storeAction = MTLStoreActionMultisampleResolve;
    }
    pass.depthAttachment.texture = depthMs;
    pass.depthAttachment.loadAction = MTLLoadActionClear;
    pass.depthAttachment.clearDepth = 0;  // reversed depth: 0 is the far plane
    pass.depthAttachment.storeAction = MTLStoreActionDontCare;
    id<MTLRenderCommandEncoder> enc = [commands renderCommandEncoderWithDescriptor:pass];
    [enc setVertexBuffer:frameBuffer offset:0 atIndex:1];
    [enc setFragmentBuffer:frameBuffer offset:0 atIndex:1];
    [enc setVertexBuffer:drawBuffer offset:0 atIndex:2];
    [enc setFragmentBuffer:drawBuffer offset:0 atIndex:2];
    [enc setVertexBuffer:visibleBuffer offset:0 atIndex:4];
    [enc setFragmentTexture:environment.reflection atIndex:0];
    [enc setFragmentTexture:environment.received atIndex:1];
    [enc setFragmentTexture:shadowTexture atIndex:2];
    [enc setFragmentSamplerState:pipelines.smooth atIndex:0];
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
        [enc setVertexBuffer:instanceBuffers[batch.group] offset:0 atIndex:3];
        [enc setVertexBufferOffset:i * sizeof(DrawUniforms) atIndex:2];
        [enc setFragmentBufferOffset:i * sizeof(DrawUniforms) atIndex:2];
        [enc setVertexBufferOffset:batch.first * sizeof(uint32_t) atIndex:4];
        [enc drawIndexedPrimitives:MTLPrimitiveTypeTriangle indexCount:gpu.indexCount indexType:MTLIndexTypeUInt32 indexBuffer:gpu.indices indexBufferOffset:0 instanceCount:batch.count];
        stats.drawCalls++;
        stats.instances += batch.count;
        stats.triangles += static_cast<uint64_t>(gpu.indexCount / 3) * batch.count;
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
      [enc setDepthStencilState:pipelines.depthRead];
      [enc drawPrimitives:MTLPrimitiveTypeTriangle vertexStart:0 vertexCount:6];
      stats.drawCalls++;
    }

    if (options.edges) {
      [enc setCullMode:MTLCullModeNone];
      [enc setRenderPipelineState:pipelines.edges];
      [enc setDepthStencilState:pipelines.depthRead];
      const float nearer = kEdgeNearer;
      [enc setVertexBytes:&nearer length:sizeof nearer atIndex:5];
      for (size_t i = 0; i < seen.size(); i++) {
        const Batch& batch = seen[i];
        if (batch.detail != Detail::Full) continue;
        const GpuMesh& gpu = mesh(scene.groups[batch.group], batch.detail);
        if (!gpu.edgeVertices) continue;
        [enc setVertexBuffer:gpu.edges offset:0 atIndex:0];
        [enc setVertexBuffer:instanceBuffers[batch.group] offset:0 atIndex:3];
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

  // Background, transparency, tone curve, sRGB.
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
    [enc drawPrimitives:MTLPrimitiveTypeTriangle vertexStart:0 vertexCount:3];
    [enc endEncoding];
  }

  dispatch_semaphore_t done = inFlight;
  double* gpu = &gpuMs;
  [commands addCompletedHandler:^(id<MTLCommandBuffer> finished) {
    *gpu = (finished.GPUEndTime - finished.GPUStartTime) * 1000.0;
    dispatch_semaphore_signal(done);
  }];
  if (drawable) [commands presentDrawable:drawable];
  [commands commit];
  stats.cpuMs = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - started).count();
  if (!drawable) {
    [commands waitUntilCompleted];
    stats.gpuMs = (commands.GPUEndTime - commands.GPUStartTime) * 1000.0;
    drewOffscreen = true;
  }
  return stats;
}

}  // namespace bmr
