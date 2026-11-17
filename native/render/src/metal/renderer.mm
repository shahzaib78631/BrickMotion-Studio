#import "metal/impl.h"

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
    if (!impl.pipelines.ok) return nullptr;
    impl.environment = makeEnvironment(*device, impl.pipelines);
    impl.meshes = std::make_unique<MeshLibrary>(model, full, low);
    impl.scene = buildScene(model, full);
    impl.inFlight = dispatch_semaphore_create(3);
    for (const Group& g : impl.scene.groups) {
      const size_t bytes = std::max<size_t>(1, g.instances.size()) * sizeof(Instance);
      id<MTLBuffer> buffer = [device->device newBufferWithLength:bytes options:MTLResourceStorageModeShared];
      if (!g.instances.empty()) std::memcpy(buffer.contents, g.instances.data(), g.instances.size() * sizeof(Instance));
      impl.instanceBuffers.push_back(buffer);
    }
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
    if (!cpu->edges.empty()) {
      gpu.edges = [device->device newBufferWithBytes:cpu->edges.data() length:cpu->edges.size() * sizeof(float) options:MTLResourceStorageModeShared];
      gpu.edgeVertices = static_cast<uint32_t>(cpu->edges.size() / 3);
    }
  }
  return gpuMeshes.emplace(key, gpu).first->second;
}

void Renderer::Impl::upload(const std::vector<std::pair<uint32_t, uint32_t>>& changed) {
  for (const auto& [g, i] : changed) {
    if (g >= scene.groups.size() || i >= scene.groups[g].instances.size()) continue;
    std::memcpy(static_cast<uint8_t*>(instanceBuffers[g].contents) + i * sizeof(Instance), &scene.groups[g].instances[i], sizeof(Instance));
  }
}

void Renderer::Impl::makeTargets() {
  colorMs = depthMs = color = final = nil;
  if (width < 1 || height < 1) return;
  auto make = [&](MTLPixelFormat format, int samples, MTLTextureUsage usage, MTLStorageMode storage) {
    MTLTextureDescriptor* d = [MTLTextureDescriptor texture2DDescriptorWithPixelFormat:format width:static_cast<NSUInteger>(width) height:static_cast<NSUInteger>(height) mipmapped:NO];
    d.textureType = samples > 1 ? MTLTextureType2DMultisample : MTLTextureType2D;
    d.sampleCount = static_cast<NSUInteger>(samples);
    d.usage = usage;
    d.storageMode = storage;
    return [device->device newTextureWithDescriptor:d];
  };
  colorMs = make(MTLPixelFormatRGBA16Float, kSamples, MTLTextureUsageRenderTarget, MTLStorageModePrivate);
  depthMs = make(MTLPixelFormatDepth32Float, kSamples, MTLTextureUsageRenderTarget, MTLStorageModePrivate);
  color = make(MTLPixelFormatRGBA16Float, 1, MTLTextureUsageRenderTarget | MTLTextureUsageShaderRead, MTLStorageModePrivate);
  final = make(MTLPixelFormatBGRA8Unorm_sRGB, 1, MTLTextureUsageRenderTarget | MTLTextureUsageShaderRead, MTLStorageModeShared);
}

void Renderer::resize(int width, int height) {
  // The largest picture a texture can be on this GPU; more than that is held to it.
  const int most = 16384;
  width = std::min(width, most), height = std::min(height, most);
  if (width == impl_->width && height == impl_->height) return;
  impl_->width = width, impl_->height = height;
  impl_->drewOffscreen = false;
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
