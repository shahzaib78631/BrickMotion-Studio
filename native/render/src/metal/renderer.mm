#import "metal/impl.h"

#include <algorithm>
#include <cstdio>
#include <cstdlib>
#include <cmath>
#if defined(__aarch64__)
#include <arm_neon.h>
#endif

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

Rounding Renderer::rounding() const { return impl_->rounding; }

void Renderer::setRounding(Rounding rounding) {
  Impl& impl = *impl_;
  if (rounding == impl.rounding) return;
  impl.rounding = rounding;
  impl.meshes = std::make_unique<MeshLibrary>(*impl.model, *impl.full, *impl.low, rounding);
  impl.gpuMeshes.clear();
  impl.ptScene.reset();  // its parts were made from the old meshes; made again when next needed
  impl.ptInitTried = false;
  impl.groupsChanged(true);
}

std::unique_ptr<Renderer> Renderer::create(const bm::Model& model, bm::ldraw::PartCache& full, bm::ldraw::PartCache& low,
                                           Rounding rounding) {
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
    impl.full = &full;
    impl.rounding = rounding;
    impl.low = &low;
    impl.meshes = std::make_unique<MeshLibrary>(model, full, low, rounding);
    impl.scene = buildScene(model, full);
    impl.inFlight = dispatch_semaphore_create(3);
    impl.makeGroups(0);
    impl.liveBounds = impl.scene.bounds;
    // A depth map of one pixel, bound where the shadow map goes until there is one.
    MTLTextureDescriptor* d = [MTLTextureDescriptor texture2DDescriptorWithPixelFormat:MTLPixelFormatDepth32Float width:1 height:1 mipmapped:NO];
    d.usage = MTLTextureUsageShaderRead | MTLTextureUsageRenderTarget;
    d.storageMode = MTLStorageModePrivate;
    impl.placeholderShadow = [device->device newTextureWithDescriptor:d];
    // Always bind valid 3D textures to the plastic fragment shader.
    MTLTextureDescriptor* gi = [MTLTextureDescriptor new];
    gi.textureType = MTLTextureType3D;
    gi.pixelFormat = MTLPixelFormatRGBA16Float;
    gi.width = 1;
    gi.height = 1;
    gi.depth = 1;
    gi.mipmapLevelCount = 1;
    gi.storageMode = MTLStorageModeShared;
    gi.usage = MTLTextureUsageShaderRead;
    impl.worldGiFallback = [device->device newTextureWithDescriptor:gi];
    if (!impl.worldGiFallback) return nullptr;
    const uint16_t black[4] = {0, 0, 0, 0};
    [impl.worldGiFallback replaceRegion:MTLRegionMake3D(0, 0, 0, 1, 1, 1)
                            mipmapLevel:0 slice:0 withBytes:black bytesPerRow:8 bytesPerImage:8];
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
    ++worldGiEpoch;
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

void Renderer::Impl::makeGroups(uint64_t madeAt) {
  parts.clear();
  instanceBuffers.clear();
  changedAt.clear();
  for (auto& queue : pending) queue.clear();
  for (const Group& g : scene.groups) {
    if (g.placeholder) {
      parts.push_back(PartShape{bm::kPlaceholderBox, 0});
    } else {
      const auto whole = meshes->get(g.part, Detail::Full), low = meshes->get(g.part, Detail::Low);
      const bool under = whole->hasUnderside() || low->hasUnderside();
      parts.push_back(PartShape{whole->bounds, low->lowError, under ? static_cast<double>(whole->hasUnderside() ? whole->bottom : low->bottom) : -1e300});
    }
    const size_t bytes = std::max<size_t>(1, g.instances.size()) * sizeof(Instance);
    std::array<id<MTLBuffer>, 3> copies;
    for (auto& buffer : copies) {
      buffer = [device->device newBufferWithLength:bytes options:MTLResourceStorageModeShared];
      if (!g.instances.empty()) std::memcpy(buffer.contents, g.instances.data(), g.instances.size() * sizeof(Instance));
    }
    instanceBuffers.push_back(copies);
    changedAt.emplace_back(g.instances.size(), madeAt);
  }
}

void Renderer::Impl::groupsChanged(bool castersChanged) {
  @autoreleasepool {
    // Ready caster maps depend on geometry, not the colors of its opaque pieces. Restart any
    // partial map because its remaining batches reference the earlier groups.
    if (castersChanged) lastChange = frame + 1;
    ++worldGiEpoch;
    makeGroups(lastChange);
    shadow.building = heights.building = false;
    shadow.back.detail = heights.back.detail = -1;
    lastSeen.clear();
    lastList.clear();
    idsReady = false;
    glassRevision = UINT64_MAX;
  }
  if (castersChanged) updateLiveBounds();
}

void Renderer::Impl::updateLiveBounds() {
  bm::Box b;
  for (size_t g = 0; g < scene.groups.size(); g++) {
    const bm::Box& part = parts[g].bounds;
    if (part.empty()) continue;
    for (const Instance& in : scene.groups[g].instances)
      if (!(in.flags & kNotShown)) b.merge(placedBox(in, part, scene.origin));
  }
  liveBounds = b.empty() ? scene.bounds : b;
}

const bm::Box& Renderer::visibleBounds() const { return impl_->liveBounds; }

bm::Box Renderer::selectionBounds() const {
  const Impl& impl = *impl_;
  bm::Box b;
  for (size_t g = 0; g < impl.scene.groups.size(); g++) {
    const bm::Box& part = impl.parts[g].bounds;
    if (part.empty()) continue;
    for (const Instance& in : impl.scene.groups[g].instances)
      if ((in.flags & kSelected) && !(in.flags & kNotShown)) b.merge(placedBox(in, part, impl.scene.origin));
  }
  return b;
}

void Renderer::setFrame(const bm::plan::Plan& plan, const bm::plan::Timeline& timeline, double frame,
                        const std::vector<PiecePose>& keyed) {
  const auto changed = applyFrame(impl_->scene, *impl_->model, plan, timeline, frame, keyed);
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

void Renderer::modelChanged(const bm::Model& model, const std::vector<uint32_t>* moved) {
  Impl& impl = *impl_;
  if (moved && model.pieces().size() == impl.scene.where.size()) {
    impl.model = &model;
    const auto changed = applyMoved(impl.scene, model, *moved);
    if (changed.empty()) return;
    impl.upload(changed);
    impl.updateLiveBounds();
    return;
  }
  // What the person chose to see is kept, by piece index.
  std::vector<uint32_t> selected, hidden;
  for (uint32_t p = 0; p < impl.scene.where.size(); p++) {
    const auto [g, i] = impl.scene.where[p];
    if (g == UINT32_MAX) continue;
    const uint32_t flags = impl.scene.groups[g].instances[i].flags;
    if (flags & kSelected) selected.push_back(p);
    if (flags & kUserHidden) hidden.push_back(p);
  }
  impl.model = &model;
  impl.meshes->rebind(model);
  impl.scene = buildScene(model, *impl.full);
  applySelection(impl.scene, selected);
  applyUserHidden(impl.scene, hidden);
  impl.groupsChanged();
}

void Renderer::recolored(const std::vector<uint32_t>& pieces) {
  if (pieces.empty()) return;
  const auto result = applyRecolored(impl_->scene, *impl_->model, pieces);
  if (result != RecolorResult::Unchanged) impl_->groupsChanged(result == RecolorResult::Transparency);
}

void Renderer::modelDeleted(const bm::Model& model, const std::vector<uint32_t>& removed) {
  Impl& impl = *impl_;
  if (removed.empty() || model.pieces().size() + removed.size() != impl.scene.where.size()) {
    modelChanged(model);
    return;
  }
  impl.model = &model;
  impl.scene.where.assign(model.pieces().size(), {UINT32_MAX, UINT32_MAX});
  impl.scene.bounds = {};
  for (uint32_t gi = 0; gi < impl.scene.groups.size(); ++gi) {
    auto& group = impl.scene.groups[gi];
    uint32_t write = 0;
    for (uint32_t read = 0; read < group.instances.size(); ++read) {
      auto instance = group.instances[read];
      const auto prior = std::lower_bound(removed.begin(), removed.end(), instance.piece);
      if (prior != removed.end() && *prior == instance.piece) continue;
      instance.piece -= static_cast<uint32_t>(prior - removed.begin());
      group.instances[write] = instance;
      group.restBoxes[write] = group.restBoxes[read];
      impl.scene.where[instance.piece] = {gi, write};
      impl.scene.bounds.merge(group.restBoxes[write]);
      ++write;
    }
    group.instances.resize(write);
    group.restBoxes.resize(write);
  }
  impl.groupsChanged();
}

void Renderer::setHidden(const std::vector<uint32_t>& pieces) {
  const auto changed = applyUserHidden(impl_->scene, pieces);
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
  colorMs = depthMs = accumMs = revealMs = ambientMs = color = accum = reveal = ambient = depth = final = mask = aoRaw = aoSoft = giRaw = giSoft = ssrRaw = ssrSoft = glassFront = glassMat = glassBackNear = glassBackFar = glassDepthTex = glassResolved = nil;
  giHist[0] = giHist[1] = ssrHist[0] = ssrHist[1] = rtDepthHist[0] = rtDepthHist[1] = nil;
  rtptDepth = rtptMat = rtptMotion = rtptGiQuarter = rtptDiffRaw = rtptSpecRaw = rtptDiffPing = rtptSpecPing = rtptDiffPong = nil;
  rtptGlassTiles = rtptOpaqueTiles = rtptFloorTiles = rtptSpecTiles = nil;
  for (int i = 0; i < 2; i++) {
    rtptPosId[i] = rtptNorm[i] = rtptDi[i] = rtptDiffHist[i] = rtptSpecHist[i] = rtptMoments[i] = rtptHLen[i] = rtptTaa[i] = nil;
  }
  rtptW = rtptH = rtptTraceW = rtptTraceH = 0;
  rtptHasHistory = false;
  rtptStillFrames = 0;
  hybridHasHistory = false;
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
  const MTLTextureUsage rw = MTLTextureUsageRenderTarget | MTLTextureUsageShaderRead | MTLTextureUsageShaderWrite;
  color = make(kColorFormat, 1, readable, MTLStorageModePrivate);
  accum = make(kAccumFormat, 1, readable, MTLStorageModePrivate);
  reveal = make(kRevealFormat, 1, readable, MTLStorageModePrivate);
  mask = make(MTLPixelFormatR8Unorm, 1, readable, MTLStorageModePrivate);
  ambient = make(kAmbientFormat, 1, readable, MTLStorageModePrivate);
  depth = make(MTLPixelFormatDepth32Float, 1, readable, MTLStorageModePrivate);
  {
    // The ambient-occlusion / GI / SSR grid: half size by default, quarter with BM_HYBRID_DIV=4.
    if (const char* d = getenv("BM_HYBRID_DIV")) screenDiv = std::max(1, std::min(8, std::atoi(d)));
    const int fullW = width, fullH = height;
    width = (fullW + screenDiv - 1) / screenDiv, height = (fullH + screenDiv - 1) / screenDiv;  // make() reads the size
    aoRaw = make(MTLPixelFormatRGBA8Unorm, 1, readable, MTLStorageModePrivate);
    aoSoft = make(MTLPixelFormatRGBA8Unorm, 1, readable, MTLStorageModePrivate);
    giRaw = make(MTLPixelFormatRGBA16Float, 1, rw, MTLStorageModePrivate);
    giSoft = make(MTLPixelFormatRGBA16Float, 1, rw, MTLStorageModePrivate);
    ssrRaw = make(MTLPixelFormatRGBA16Float, 1, rw, MTLStorageModePrivate);
    ssrSoft = make(MTLPixelFormatRGBA16Float, 1, rw, MTLStorageModePrivate);
    for (int i = 0; i < 2; i++) {
      giHist[i] = make(MTLPixelFormatRGBA16Float, 1, rw, MTLStorageModePrivate);
      ssrHist[i] = make(MTLPixelFormatRGBA16Float, 1, rw, MTLStorageModePrivate);
      rtDepthHist[i] = make(MTLPixelFormatRGBA16Float, 1, rw, MTLStorageModePrivate);
    }
    width = fullW, height = fullH;
  }
  final = make(MTLPixelFormatBGRA8Unorm_sRGB, 1, MTLTextureUsageRenderTarget | MTLTextureUsageShaderRead, MTLStorageModeShared);
}

void Renderer::Impl::makeGlassTargets() {
  auto make = [&](MTLPixelFormat format, MTLTextureUsage usage) {
    MTLTextureDescriptor* descriptor = [MTLTextureDescriptor texture2DDescriptorWithPixelFormat:format width:width height:height mipmapped:NO];
    descriptor.usage = usage;
    descriptor.storageMode = MTLStorageModePrivate;
    return [device->device newTextureWithDescriptor:descriptor];
  };
  constexpr MTLTextureUsage readable = MTLTextureUsageRenderTarget | MTLTextureUsageShaderRead;
  glassFront = make(MTLPixelFormatRGBA16Float, readable);
  glassMat = make(MTLPixelFormatRGBA16Float, readable);
  glassBackNear = make(MTLPixelFormatRGBA16Float, readable);
  glassBackFar = make(MTLPixelFormatRGBA16Float, readable);
  glassDepthTex = make(MTLPixelFormatDepth32Float, MTLTextureUsageRenderTarget);
  glassResolved = make(MTLPixelFormatRGBA16Float, readable | MTLTextureUsageShaderWrite);
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
#if defined(__aarch64__)
  uint8_t* p = out.rgba.data();
  const size_t n = out.rgba.size();
  size_t i = 0;
  for (; i + 64 <= n; i += 64) {
    uint8x16x4_t v = vld4q_u8(p + i);
    const uint8x16_t tmp = v.val[0];
    v.val[0] = v.val[2];
    v.val[2] = tmp;
    vst4q_u8(p + i, v);
  }
  for (; i < n; i += 4) std::swap(p[i], p[i + 2]);
#else
  for (size_t i = 0; i < out.rgba.size(); i += 4) std::swap(out.rgba[i], out.rgba[i + 2]);  // stored blue first
#endif
  return out;
}

}  // namespace bmr
