#import "metal/impl.h"

#include "bmr/tolerances.h"

namespace bmr {
namespace {

// Must match EnvironmentUniforms in shaders/environment.metal.
struct EnvironmentUniforms {
  simd_float4 keyDirection;
  simd_float4 room;
  simd_float4 strips;
  simd_float4 what;
};

id<MTLTexture> cube(Device& device, int size, int mips) {
  MTLTextureDescriptor* d = [MTLTextureDescriptor textureCubeDescriptorWithPixelFormat:MTLPixelFormatRGBA16Float size:static_cast<NSUInteger>(size) mipmapped:mips > 1];
  d.mipmapLevelCount = static_cast<NSUInteger>(mips);
  d.usage = MTLTextureUsageRenderTarget | MTLTextureUsageShaderRead;
  d.storageMode = MTLStorageModePrivate;
  return [device.device newTextureWithDescriptor:d];
}

}  // namespace

simd_float4 keyDirectionVector() {
  const simd_float3 d = simd_normalize(simd_make_float3(static_cast<float>(kKeyDirection[0]), static_cast<float>(kKeyDirection[1]), static_cast<float>(kKeyDirection[2])));
  return simd_make_float4(d.x, d.y, d.z, kKeyIntensity);
}
simd_float4 roomVector() { return simd_make_float4(kRoomLuminance, kBoxLuminance, kBoxInnerCos, kBoxOuterCos); }

Environment makeEnvironment(Device& device, const Pipelines& pipelines) {
  Environment env;
  env.reflection = cube(device, kReflectionSize, kReflectionMips);
  env.received = cube(device, kReceivedSize, 1);
  id<MTLCommandBuffer> commands = [device.queue commandBuffer];
  // One small pass per face and mip: 42 in all, once.
  auto gather = [&](id<MTLTexture> target, int mip, int face, float roughness, bool matt) {
    MTLRenderPassDescriptor* pass = [MTLRenderPassDescriptor new];
    pass.colorAttachments[0].texture = target;
    pass.colorAttachments[0].level = static_cast<NSUInteger>(mip);
    pass.colorAttachments[0].slice = static_cast<NSUInteger>(face);
    pass.colorAttachments[0].loadAction = MTLLoadActionDontCare;
    pass.colorAttachments[0].storeAction = MTLStoreActionStore;
    id<MTLRenderCommandEncoder> enc = [commands renderCommandEncoderWithDescriptor:pass];
    EnvironmentUniforms u{keyDirectionVector(), roomVector(), simd_make_float4(kStripLuminance, kStripInnerCos, kStripOuterCos, kFloorShare), simd_make_float4(static_cast<float>(face), roughness, matt ? 1.0f : 0.0f, static_cast<float>(kGatherSamples))};
    [enc setRenderPipelineState:pipelines.environment];
    [enc setFragmentBytes:&u length:sizeof u atIndex:0];
    [enc drawPrimitives:MTLPrimitiveTypeTriangle vertexStart:0 vertexCount:3];
    [enc endEncoding];
  };
  for (int face = 0; face < 6; face++) {
    for (int mip = 0; mip < kReflectionMips; mip++) gather(env.reflection, mip, face, static_cast<float>(mip) / (kReflectionMips - 1), false);
    gather(env.received, 0, face, 1, true);
  }
  [commands commit];
  [commands waitUntilCompleted];
  return env;
}

}  // namespace bmr
