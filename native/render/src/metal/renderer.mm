#import "metal/impl.h"

#include <cstdio>
#include <cmath>

#include "bmr/device.h"
#include "bmr/tolerances.h"

namespace bmr {

Renderer::Renderer() : impl_(new Impl) {}
Renderer::~Renderer() {
  // Frames drawn into a drawable may still be on their way: let them finish before the buffers go.
  if (impl_ && impl_->inFlight)
    for (int i = 0; i < 3; i++) dispatch_semaphore_wait(impl_->inFlight, DISPATCH_TIME_FOREVER);
  if (impl_ && impl_->inFlight)
    for (int i = 0; i < 3; i++) dispatch_semaphore_signal(impl_->inFlight);
}

std::unique_ptr<Renderer> Renderer::create(const bm::Model& model, bm::ldraw::PartCache& full, bm::ldraw::PartCache& low) {
  Device* device = sharedDevice();
  if (!device) return nullptr;
  @autoreleasepool {
    std::unique_ptr<Renderer> r(new Renderer);
    Impl& impl = *r->impl_;
    impl.device = device;
    impl.model = &model;
    std::string error;
    impl.pipelines = makePipelines(*device, error);
    if (!impl.pipelines.ok) {
      std::fprintf(stderr, "bmrender: %s\n", error.c_str());  // a shader that does not compile is a bug, and says so
      return nullptr;
    }
    impl.meshes = std::make_unique<MeshLibrary>(model, full, low);
    impl.scene = buildScene(model, full);
    impl.inFlight = dispatch_semaphore_create(3);
    for (const Group& g : impl.scene.groups) {
      if (g.placeholder) {
        impl.parts.push_back(PartShape{bm::kPlaceholderBox, 0});
        continue;
      }
      const auto full = impl.meshes->get(g.part, Detail::Full), low = impl.meshes->get(g.part, Detail::Low);
      const bool under = full->hasUnderside() || low->hasUnderside();
      impl.parts.push_back(PartShape{full->bounds, low->lowError, under ? static_cast<double>(full->hasUnderside() ? full->bottom : low->bottom) : -1e300});
    }
    for (const Group& g : impl.scene.groups) {
      const size_t bytes = std::max<size_t>(1, g.instances.size()) * sizeof(Instance);
      std::array<id<MTLBuffer>, 3> copies;
      for (auto& buffer : copies) {
        buffer = [device->device newBufferWithLength:bytes options:MTLResourceStorageModeShared];
        if (!g.instances.empty()) std::memcpy(buffer.contents, g.instances.data(), g.instances.size() * sizeof(Instance));
      }
      impl.instanceBuffers.push_back(copies);
      impl.changedAt.emplace_back(g.instances.size(), 0);
    }
    impl.liveBounds = impl.scene.bounds;
    // A depth map of one pixel, bound where the shadow map goes until there is one.
    MTLTextureDescriptor* d = [MTLTextureDescriptor texture2DDescriptorWithPixelFormat:MTLPixelFormatDepth32Float width:1 height:1 mipmapped:NO];
    d.usage = MTLTextureUsageShaderRead | MTLTextureUsageRenderTarget;
    d.storageMode = MTLStorageModePrivate;
    impl.placeholderShadow = [device->device newTextureWithDescriptor:d];
    return r;
  }
}

const Scene& Renderer::scene() const { return impl_->scene; }
double Renderer::lastGpuMs() const { return impl_->gpuMs; }

const GpuMesh& Renderer::Impl::mesh(const Group& group, Detail detail) {
  const auto key = std::make_pair(group.placeholder ? std::string() : group.part, group.placeholder ? 0 : static_cast<int>(detail));
  const auto found = gpuMeshes.find(key);
  if (found != gpuMeshes.end()) return found->second;
  GpuMesh gpu;
  std::shared_ptr<const RenderMesh> cpu = group.placeholder ? std::make_shared<const RenderMesh>(boxMesh(bm::kPlaceholderBox)) : meshes->get(group.part, detail);
  if (!cpu->empty()) {
    gpu.vertices = [device->device newBufferWithBytes:cpu->vertices.data() length:cpu->vertices.size() * sizeof(Vertex) options:MTLResourceStorageModeShared];
    gpu.indices = [device->device newBufferWithBytes:cpu->indices.data() length:cpu->indices.size() * sizeof(uint32_t) options:MTLResourceStorageModeShared];
    gpu.indexCount = static_cast<uint32_t>(cpu->indices.size());
    gpu.topIndexCount = cpu->topIndices;
    if (!cpu->edges.empty()) {
      gpu.edges = [device->device newBufferWithBytes:cpu->edges.data() length:cpu->edges.size() * sizeof(float) options:MTLResourceStorageModeShared];
      gpu.edgeVertices = static_cast<uint32_t>(cpu->edges.size() / 3);
    }
  }
  return gpuMeshes.emplace(key, gpu).first->second;
}

void Renderer::Impl::upload(const std::vector<std::pair<uint32_t, uint32_t>>& changed, bool moved) {
  if (changed.empty()) return;
  if (moved) {
    // First shown by the next frame drawn.
    lastChange = frame + 1;
    for (const auto& [g, i] : changed)
      if (g < changedAt.size() && i < changedAt[g].size()) changedAt[g][i] = lastChange;
  }
  for (auto& queue : pending) queue.insert(queue.end(), changed.begin(), changed.end());
  // The pick map stays: it is of the last frame drawn, which a change does not alter.
}

void Renderer::Impl::flush(int slot) {
  for (const auto& [g, i] : pending[slot]) {
    if (g >= scene.groups.size() || i >= scene.groups[g].instances.size()) continue;
    std::memcpy(static_cast<uint8_t*>(instanceBuffers[g][slot].contents) + i * sizeof(Instance), &scene.groups[g].instances[i], sizeof(Instance));
  }
  pending[slot].clear();
}

void Renderer::Impl::updateLiveBounds() {
  bm::Box b;
  for (size_t g = 0; g < scene.groups.size(); g++) {
    const bm::Box& part = parts[g].bounds;
    if (part.empty()) continue;
    for (const Instance& in : scene.groups[g].instances)
      if (!(in.flags & kHidden)) b.merge(placedBox(in, part, scene.origin));
  }
  liveBounds = b.empty() ? scene.bounds : b;
}

bm::Box Renderer::selectionBounds() const {
  const Impl& impl = *impl_;
  bm::Box b;
  for (size_t g = 0; g < impl.scene.groups.size(); g++) {
    const bm::Box& part = impl.parts[g].bounds;
    if (part.empty()) continue;
    for (const Instance& in : impl.scene.groups[g].instances)
      if ((in.flags & kSelected) && !(in.flags & kHidden)) b.merge(placedBox(in, part, impl.scene.origin));
  }
  return b;
}

void Renderer::setFrame(const bm::plan::Plan& plan, const bm::plan::Timeline& timeline, int frame) {
  const auto changed = applyFrame(impl_->scene, *impl_->model, plan, timeline, frame);
  if (changed.empty()) return;
  impl_->upload(changed);
  impl_->updateLiveBounds();
}

void Renderer::setRest() {
  const auto changed = applyRest(impl_->scene, *impl_->model);
  if (changed.empty()) return;
  impl_->upload(changed);
  impl_->updateLiveBounds();
}

void Renderer::select(const std::vector<uint32_t>& pieces) { impl_->upload(applySelection(impl_->scene, pieces), false); }

uint32_t Renderer::pick(int x, int y) {
  Impl& impl = *impl_;
  if (!impl.drewFrame || x < 0 || y < 0 || x >= impl.width || y >= impl.height) return UINT32_MAX;
  @autoreleasepool {
    if (!impl.idsReady) impl.drawIds();
  }
  if (!impl.idsReady) return UINT32_MAX;
  uint32_t id = 0;
  [impl.ids getBytes:&id bytesPerRow:static_cast<NSUInteger>(impl.width) * 4 fromRegion:MTLRegionMake2D(static_cast<NSUInteger>(x), static_cast<NSUInteger>(y), 1, 1) mipmapLevel:0];
  return id == 0 ? UINT32_MAX : id - 1;
}

void Renderer::Impl::drawIds() {
  id<MTLDevice> dev = device->device;
  if (!ids || static_cast<int>(ids.width) != width || static_cast<int>(ids.height) != height) {
    MTLTextureDescriptor* d = [MTLTextureDescriptor texture2DDescriptorWithPixelFormat:MTLPixelFormatR32Uint width:static_cast<NSUInteger>(width) height:static_cast<NSUInteger>(height) mipmapped:NO];
    d.usage = MTLTextureUsageRenderTarget;
    d.storageMode = MTLStorageModeShared;
    ids = [dev newTextureWithDescriptor:d];
    d.pixelFormat = MTLPixelFormatDepth32Float;
    d.storageMode = MTLStorageModePrivate;
    idDepth = [dev newTextureWithDescriptor:d];
  }
  // The last frame's copy of the instances, as it was drawn: changes queued since are for the
  // frames to come, and are not written here (the GPU may still be reading this copy; it only
  // reads it here too). So the pick is of the picture last shown.
  FrameUniforms fu{};
  fu.viewProj = simdFrom(multiply(projectionMatrix(lastCamera), viewMatrix(lastCamera, scene.origin)));
  if (!pickList || pickList.length < std::max<size_t>(1, lastList.size()) * sizeof(uint32_t))
    pickList = [dev newBufferWithLength:std::max<size_t>(4096, lastList.size() * sizeof(uint32_t)) options:MTLResourceStorageModeShared];
  if (!lastList.empty()) std::memcpy(pickList.contents, lastList.data(), lastList.size() * sizeof(uint32_t));
  DrawUniforms du{};
  du.flip = simd_make_float4(1, 0, 0, 0);
  id<MTLCommandBuffer> commands = [device->queue commandBuffer];
  MTLRenderPassDescriptor* pass = [MTLRenderPassDescriptor new];
  pass.colorAttachments[0].texture = ids;
  pass.colorAttachments[0].loadAction = MTLLoadActionClear;
  pass.colorAttachments[0].clearColor = MTLClearColorMake(0, 0, 0, 0);
  pass.colorAttachments[0].storeAction = MTLStoreActionStore;
  pass.depthAttachment.texture = idDepth;
  pass.depthAttachment.loadAction = MTLLoadActionClear;
  pass.depthAttachment.clearDepth = 0;  // reversed
  pass.depthAttachment.storeAction = MTLStoreActionDontCare;
  id<MTLRenderCommandEncoder> enc = [commands renderCommandEncoderWithDescriptor:pass];
  [enc setRenderPipelineState:pipelines.ids];
  [enc setDepthStencilState:pipelines.depthWrite];
  [enc setCullMode:MTLCullModeBack];
  [enc setVertexBytes:&fu length:sizeof fu atIndex:1];
  [enc setVertexBytes:&du length:sizeof du atIndex:2];
  [enc setVertexBuffer:pickList offset:0 atIndex:4];
  // Opaque and transparent alike: the nearest surface is the piece meant.
  for (const Batch& batch : lastSeen) {
    const GpuMesh& gpu = mesh(scene.groups[batch.group], batch.detail);
    if (!gpu.indexCount) continue;
    [enc setFrontFacingWinding:batch.mirrored ? MTLWindingClockwise : MTLWindingCounterClockwise];
    [enc setVertexBuffer:gpu.vertices offset:0 atIndex:0];
    [enc setVertexBuffer:instanceBuffers[batch.group][lastSlot] offset:0 atIndex:3];
    [enc setVertexBufferOffset:batch.first * sizeof(uint32_t) atIndex:4];
    [enc drawIndexedPrimitives:MTLPrimitiveTypeTriangle indexCount:batch.top ? gpu.topIndexCount : gpu.indexCount indexType:MTLIndexTypeUInt32 indexBuffer:gpu.indices indexBufferOffset:0 instanceCount:batch.count];
  }
  [enc endEncoding];
  [commands commit];
  [commands waitUntilCompleted];
  idsReady = true;
}

void Renderer::Impl::makeTargets() {
  colorMs = depthMs = accumMs = revealMs = ambientMs = color = accum = reveal = ambient = depth = final = mask = aoRaw = aoSoft = nil;
  if (width < 1 || height < 1) return;
  auto make = [&](MTLPixelFormat format, int samples, MTLTextureUsage usage, MTLStorageMode storage) {
    MTLTextureDescriptor* d = [MTLTextureDescriptor texture2DDescriptorWithPixelFormat:format width:static_cast<NSUInteger>(width) height:static_cast<NSUInteger>(height) mipmapped:NO];
    d.textureType = samples > 1 ? MTLTextureType2DMultisample : MTLTextureType2D;
    d.sampleCount = static_cast<NSUInteger>(samples);
    d.usage = usage;
    d.storageMode = storage;
    return [device->device newTextureWithDescriptor:d];
  };
  // The multisampled targets live only in tile memory where the GPU allows it (Apple GPUs):
  // they are resolved within the pass and never read back.
  const MTLStorageMode tile = [device->device supportsFamily:MTLGPUFamilyApple1] ? MTLStorageModeMemoryless : MTLStorageModePrivate;
  colorMs = make(kColorFormat, kSamples, MTLTextureUsageRenderTarget, tile);
  depthMs = make(MTLPixelFormatDepth32Float, kSamples, MTLTextureUsageRenderTarget, tile);
  accumMs = make(kAccumFormat, kSamples, MTLTextureUsageRenderTarget, tile);
  revealMs = make(kRevealFormat, kSamples, MTLTextureUsageRenderTarget, tile);
  ambientMs = make(kAmbientFormat, kSamples, MTLTextureUsageRenderTarget, tile);
  const MTLTextureUsage readable = MTLTextureUsageRenderTarget | MTLTextureUsageShaderRead;
  color = make(kColorFormat, 1, readable, MTLStorageModePrivate);
  accum = make(kAccumFormat, 1, readable, MTLStorageModePrivate);
  reveal = make(kRevealFormat, 1, readable, MTLStorageModePrivate);
  mask = make(MTLPixelFormatR8Unorm, 1, readable, MTLStorageModePrivate);
  ambient = make(kAmbientFormat, 1, readable, MTLStorageModePrivate);
  depth = make(MTLPixelFormatDepth32Float, 1, readable, MTLStorageModePrivate);
  {
    const int fullW = width, fullH = height;
    width = (fullW + 1) / 2, height = (fullH + 1) / 2;  // make() reads the size
    aoRaw = make(MTLPixelFormatRG8Unorm, 1, readable, MTLStorageModePrivate);
    aoSoft = make(MTLPixelFormatRG8Unorm, 1, readable, MTLStorageModePrivate);
    width = fullW, height = fullH;
  }
  final = make(MTLPixelFormatBGRA8Unorm_sRGB, 1, MTLTextureUsageRenderTarget | MTLTextureUsageShaderRead, MTLStorageModeShared);
}

void Renderer::resize(int width, int height) {
  // The largest picture a texture can be on this GPU; more than that is held to it.
  const int most = 16384;
  width = std::min(width, most), height = std::min(height, most);
  if (width == impl_->width && height == impl_->height) return;
  impl_->width = width, impl_->height = height;
  impl_->drewOffscreen = impl_->drewFrame = impl_->idsReady = false;
  @autoreleasepool {
    impl_->makeTargets();
  }
}

FrameStats Renderer::draw(const Camera& camera, const FrameOptions& options, void* drawable) {
  @autoreleasepool {
    return impl_->draw(camera, options, (__bridge id<CAMetalDrawable>)drawable);
  }
}

Image Renderer::readback() {
  Image out;
  Impl& impl = *impl_;
  if (!impl.drewOffscreen || !impl.final || impl.width < 1 || impl.height < 1) return out;
  out.width = impl.width, out.height = impl.height;
  out.rgba.resize(static_cast<size_t>(impl.width) * static_cast<size_t>(impl.height) * 4);
  [impl.final getBytes:out.rgba.data() bytesPerRow:static_cast<NSUInteger>(impl.width) * 4 fromRegion:MTLRegionMake2D(0, 0, static_cast<NSUInteger>(impl.width), static_cast<NSUInteger>(impl.height)) mipmapLevel:0];
  for (size_t i = 0; i < out.rgba.size(); i += 4) std::swap(out.rgba[i], out.rgba[i + 2]);  // stored blue first
  return out;
}

}  // namespace bmr
