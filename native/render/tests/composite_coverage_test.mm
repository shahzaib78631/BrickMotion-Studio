// Regression: a floor shadow must darken only the floor-covered samples of an
// antialiased pixel. In particular, MSAA sample 0 can be on the brick while the
// other samples are on the floor: the brick's resolved depth is *not* the floor.
#import "metal/impl.h"

#include <catch2/catch_test_macros.hpp>
#include <algorithm>
#include <cmath>
#include <cstdint>
#include <string>
#include "bmr/device.h"

namespace {

float srgb(float linear) {
  return linear <= 0.0031308f ? 12.92f * linear : 1.055f * std::pow(linear, 1.0f / 2.4f) - 0.055f;
}

} // namespace

TEST_CASE("shadowed floor at an MSAA silhouette keeps independent brick and floor coverage", "[gpu][composite]") {
  if (!bmr::gpuAvailable()) SKIP("no Metal GPU");
  @autoreleasepool {
    bmr::Device* dev = bmr::sharedDevice();
    std::string error;
    const bmr::Pipelines pipelines = bmr::makePipelines(*dev, error);
    INFO(error);
    REQUIRE(pipelines.ok);

    auto texture = [&](MTLPixelFormat format, MTLTextureUsage usage, MTLStorageMode storage) {
      MTLTextureDescriptor* desc = [MTLTextureDescriptor texture2DDescriptorWithPixelFormat:format width:1 height:1 mipmapped:NO];
      desc.usage = usage;
      desc.storageMode = storage;
      return [dev->device newTextureWithDescriptor:desc];
    };
    const MTLTextureUsage read = MTLTextureUsageShaderRead;
    id<MTLTexture> color = texture(bmr::kColorFormat, read, MTLStorageModeShared);
    id<MTLTexture> ambient = texture(bmr::kAmbientFormat, read, MTLStorageModeShared);
    id<MTLTexture> accum = texture(bmr::kAccumFormat, read, MTLStorageModeShared);
    id<MTLTexture> reveal = texture(bmr::kRevealFormat, read, MTLStorageModeShared);
    id<MTLTexture> mask = texture(MTLPixelFormatR8Unorm, read, MTLStorageModeShared);
    id<MTLTexture> ao = texture(MTLPixelFormatRGBA8Unorm, read, MTLStorageModeShared);
    id<MTLTexture> depth = texture(MTLPixelFormatDepth32Float, MTLTextureUsageShaderRead | MTLTextureUsageRenderTarget, MTLStorageModePrivate);
    id<MTLTexture> final = texture(MTLPixelFormatBGRA8Unorm_sRGB, MTLTextureUsageRenderTarget, MTLStorageModeShared);
    REQUIRE(color); REQUIRE(ambient); REQUIRE(accum); REQUIRE(reveal);
    REQUIRE(mask); REQUIRE(ao); REQUIRE(depth); REQUIRE(final);

    const MTLRegion pixel = MTLRegionMake2D(0, 0, 1, 1);
    // Simulate four MSAA samples: two red brick (0.5 linear red each), two
    // unlit floor. The resolved brick colour is .25 red, .5 coverage.
    const uint16_t redAndCoverage[4] = {0x3400, 0, 0, 0x3800};
    const uint16_t floorCoverage[4] = {0, 0x3800, 0, 0x3800};
    const float noTransparency[4] = {0, 0, 0, 0};
    const uint8_t noMask = 0;
    const uint8_t floorLight[4] = {64, 255, 255, 255};  // ~25% light; a valid floor sample
    [color replaceRegion:pixel mipmapLevel:0 withBytes:redAndCoverage bytesPerRow:sizeof redAndCoverage];
    [ambient replaceRegion:pixel mipmapLevel:0 withBytes:floorCoverage bytesPerRow:sizeof floorCoverage];
    [accum replaceRegion:pixel mipmapLevel:0 withBytes:noTransparency bytesPerRow:sizeof noTransparency];
    [reveal replaceRegion:pixel mipmapLevel:0 withBytes:noTransparency bytesPerRow:sizeof noTransparency];
    [mask replaceRegion:pixel mipmapLevel:0 withBytes:&noMask bytesPerRow:1];
    [ao replaceRegion:pixel mipmapLevel:0 withBytes:floorLight bytesPerRow:sizeof floorLight];

    bmr::FrameUniforms uniform{};
    uniform.background = simd_make_float4(1, 1, 1, 1);
    uniform.switches = simd_make_float4(1, 0, 0, 0);
    uniform.rig = simd_make_float4(0, 0, 1, 0);
    uniform.glass = simd_make_float4(2, 0.58f, 1.49f, 0);
    id<MTLCommandBuffer> commands = [dev->queue commandBuffer];
    MTLRenderPassDescriptor* clear = [MTLRenderPassDescriptor new];
    clear.depthAttachment.texture = depth;
    clear.depthAttachment.loadAction = MTLLoadActionClear;
    clear.depthAttachment.clearDepth = 0.8;  // representative brick sample 0
    clear.depthAttachment.storeAction = MTLStoreActionStore;
    [[commands renderCommandEncoderWithDescriptor:clear] endEncoding];

    MTLRenderPassDescriptor* pass = [MTLRenderPassDescriptor new];
    pass.colorAttachments[0].texture = final;
    pass.colorAttachments[0].loadAction = MTLLoadActionClear;
    pass.colorAttachments[0].storeAction = MTLStoreActionStore;
    id<MTLRenderCommandEncoder> enc = [commands renderCommandEncoderWithDescriptor:pass];
    [enc setRenderPipelineState:pipelines.composite];
    [enc setFragmentBytes:&uniform length:sizeof uniform atIndex:1];
    [enc setFragmentTexture:color atIndex:0];
    [enc setFragmentTexture:accum atIndex:1];
    [enc setFragmentTexture:reveal atIndex:2];
    [enc setFragmentTexture:mask atIndex:3];
    [enc setFragmentTexture:ambient atIndex:4];
    [enc setFragmentTexture:ao atIndex:5];
    [enc setFragmentTexture:depth atIndex:6];
    [enc setFragmentSamplerState:pipelines.smooth atIndex:0];
    [enc drawPrimitives:MTLPrimitiveTypeTriangle vertexStart:0 vertexCount:3];
    [enc endEncoding];
    [commands commit];
    [commands waitUntilCompleted];
    REQUIRE(commands.status == MTLCommandBufferStatusCompleted);

    uint8_t bgra[4]{};
    [final getBytes:bgra bytesPerRow:4 fromRegion:pixel mipmapLevel:0];
    // .25 of the pixel is the resolved red surface; .5 is floor at 25%
    // illumination. The floor shadow must not alter the brick contribution.
    const float light = 64.0f / 255.0f;
    const int expectedRed = static_cast<int>(std::lround(255 * srgb(0.25f + 0.5f * light)));
    const int expectedOther = static_cast<int>(std::lround(255 * srgb(0.5f * light)));
    INFO("BGRA " << int(bgra[0]) << ',' << int(bgra[1]) << ',' << int(bgra[2]));
    REQUIRE(std::abs(int(bgra[2]) - expectedRed) <= 3);
    REQUIRE(std::abs(int(bgra[1]) - expectedOther) <= 3);
    REQUIRE(std::abs(int(bgra[0]) - expectedOther) <= 3);
  }
}
