// One frame: which instances, at which detail, in which order, into which targets.
#import "metal/impl.h"

#include <chrono>
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

  // Which instances, and at which detail.
  std::vector<uint32_t> list;
  std::vector<Batch> batches;
  const Detail detail = options.forceDetail >= 0 && options.forceDetail <= 2 ? static_cast<Detail>(options.forceDetail) : Detail::Full;
  for (uint32_t g = 0; g < scene.groups.size(); g++) {
    const Group& group = scene.groups[g];
    for (int mirrored = 0; mirrored < 2; mirrored++) {
      const uint32_t first = static_cast<uint32_t>(list.size());
      for (uint32_t i = 0; i < group.instances.size(); i++) {
        const uint32_t flags = group.instances[i].flags;
        if ((flags & kHidden) || ((flags & kMirrored) != 0) != (mirrored != 0)) continue;
        list.push_back(i);
      }
      if (list.size() > first) batches.push_back({g, detail, mirrored != 0, first, static_cast<uint32_t>(list.size()) - first});
    }
  }

  dispatch_semaphore_wait(inFlight, DISPATCH_TIME_FOREVER);
  frame++;
  id<MTLDevice> dev = device->device;

  FrameUniforms fu{};
  fu.viewProj = simdFrom(multiply(projectionMatrix(camera), viewMatrix(camera, scene.origin)));
  fu.shadowProj = matrix_identity_float4x4;
  const bm::Vec3 eye = camera.eye - scene.origin;
  fu.eye = simd_make_float4(static_cast<float>(eye.x), static_cast<float>(eye.y), static_cast<float>(eye.z), 1);
  fu.keyDirection = keyDirectionVector();
  fu.background = simd_make_float4(options.background[0], options.background[1], options.background[2], 1);
  fu.viewport = simd_make_float4(static_cast<float>(width), static_cast<float>(height), 1.0f / static_cast<float>(width), 1.0f / static_cast<float>(height));
  fu.room = roomVector();
  fu.switches = simd_make_float4(0, options.ambientOcclusion ? 1 : 0, static_cast<float>(kReflectionMips - 1), kClearcoatRoughness);
  id<MTLBuffer> frameBuffer = frameUniforms.get(dev, frame, sizeof fu);
  std::memcpy(frameBuffer.contents, &fu, sizeof fu);

  id<MTLBuffer> drawBuffer = drawUniforms.get(dev, frame, std::max<size_t>(1, batches.size()) * sizeof(DrawUniforms));
  auto* du = static_cast<DrawUniforms*>(drawBuffer.contents);
  for (size_t b = 0; b < batches.size(); b++) {
    const Material& m = scene.groups[batches[b].group].material;
    du[b].base = simd_make_float4(m.base[0], m.base[1], m.base[2], m.alpha);
    du[b].surface = simd_make_float4(m.roughness, m.metalness, m.clearcoat, scene.groups[batches[b].group].placeholder ? 1 : 0);
    du[b].edge = simd_make_float4(m.edge[0], m.edge[1], m.edge[2], kEdgeOpacity);
    du[b].flip = simd_make_float4(batches[b].mirrored ? -1 : 1, 0, 0, 0);
  }
  id<MTLBuffer> visibleBuffer = visible.get(dev, frame, std::max<size_t>(1, list.size()) * sizeof(uint32_t));
  if (!list.empty()) std::memcpy(visibleBuffer.contents, list.data(), list.size() * sizeof(uint32_t));

  id<MTLCommandBuffer> commands = [device->queue commandBuffer];

  // The model, multisampled, resolved into `color`.
  {
    MTLRenderPassDescriptor* pass = [MTLRenderPassDescriptor new];
    pass.colorAttachments[0].texture = colorMs;
    pass.colorAttachments[0].resolveTexture = color;
    pass.colorAttachments[0].loadAction = MTLLoadActionClear;
    pass.colorAttachments[0].clearColor = MTLClearColorMake(0, 0, 0, 0);  // nothing drawn: no coverage
    pass.colorAttachments[0].storeAction = MTLStoreActionMultisampleResolve;
    pass.depthAttachment.texture = depthMs;
    pass.depthAttachment.loadAction = MTLLoadActionClear;
    pass.depthAttachment.clearDepth = 0;  // reversed depth: 0 is the far plane
    pass.depthAttachment.storeAction = MTLStoreActionDontCare;
    id<MTLRenderCommandEncoder> enc = [commands renderCommandEncoderWithDescriptor:pass];
    [enc setRenderPipelineState:pipelines.brick];
    [enc setDepthStencilState:pipelines.depthWrite];
    [enc setCullMode:MTLCullModeBack];
    [enc setVertexBuffer:frameBuffer offset:0 atIndex:1];
    [enc setFragmentBuffer:frameBuffer offset:0 atIndex:1];
    [enc setVertexBuffer:drawBuffer offset:0 atIndex:2];
    [enc setFragmentBuffer:drawBuffer offset:0 atIndex:2];
    [enc setVertexBuffer:visibleBuffer offset:0 atIndex:4];
    [enc setFragmentTexture:environment.reflection atIndex:0];
    [enc setFragmentTexture:environment.received atIndex:1];
    [enc setFragmentTexture:placeholderShadow atIndex:2];
    [enc setFragmentSamplerState:pipelines.smooth atIndex:0];
    [enc setFragmentSamplerState:pipelines.shadow atIndex:1];
    for (size_t b = 0; b < batches.size(); b++) {
      const Batch& batch = batches[b];
      const GpuMesh& gpu = mesh(scene.groups[batch.group], batch.detail);
      if (!gpu.indexCount) continue;
      // Triangles are counter-clockwise seen from outside; a mirrored instance shows them the other way round.
      [enc setFrontFacingWinding:batch.mirrored ? MTLWindingClockwise : MTLWindingCounterClockwise];
      [enc setVertexBuffer:gpu.vertices offset:0 atIndex:0];
      [enc setVertexBuffer:instanceBuffers[batch.group] offset:0 atIndex:3];
      [enc setVertexBufferOffset:b * sizeof(DrawUniforms) atIndex:2];
      [enc setFragmentBufferOffset:b * sizeof(DrawUniforms) atIndex:2];
      [enc setVertexBufferOffset:batch.first * sizeof(uint32_t) atIndex:4];
      [enc drawIndexedPrimitives:MTLPrimitiveTypeTriangle indexCount:gpu.indexCount indexType:MTLIndexTypeUInt32 indexBuffer:gpu.indices indexBufferOffset:0 instanceCount:batch.count];
      stats.drawCalls++;
      stats.instances += batch.count;
      stats.triangles += static_cast<uint64_t>(gpu.indexCount / 3) * batch.count;
      stats.byDetail[static_cast<int>(batch.detail)] += batch.count;
    }
    [enc endEncoding];
  }

  // Background, tone curve, sRGB.
  {
    MTLRenderPassDescriptor* pass = [MTLRenderPassDescriptor new];
    pass.colorAttachments[0].texture = target;
    pass.colorAttachments[0].loadAction = MTLLoadActionDontCare;
    pass.colorAttachments[0].storeAction = MTLStoreActionStore;
    id<MTLRenderCommandEncoder> enc = [commands renderCommandEncoderWithDescriptor:pass];
    [enc setRenderPipelineState:pipelines.composite];
    [enc setFragmentBuffer:frameBuffer offset:0 atIndex:1];
    [enc setFragmentTexture:color atIndex:0];
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
