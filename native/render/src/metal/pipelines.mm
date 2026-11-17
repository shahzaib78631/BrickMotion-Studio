#import "metal/impl.h"

#include "bmr/tolerances.h"

namespace bmr {

id<MTLBuffer> FrameBuffer::get(id<MTLDevice> device, uint64_t frame, size_t bytes) {
  id<MTLBuffer> __strong& slot = copies[frame % 3];
  if (!slot || slot.length < bytes) {
    size_t size = 4096;
    while (size < bytes) size *= 2;
    slot = [device newBufferWithLength:size options:MTLResourceStorageModeShared];
  }
  return slot;
}

namespace {

MTLVertexDescriptor* brickVertices() {
  // bmr::Vertex: position, normal, colour bytes (render_mesh.h), 28 bytes.
  MTLVertexDescriptor* d = [MTLVertexDescriptor new];
  d.attributes[0].format = MTLVertexFormatFloat3, d.attributes[0].offset = 0, d.attributes[0].bufferIndex = 0;
  d.attributes[1].format = MTLVertexFormatFloat3, d.attributes[1].offset = 12, d.attributes[1].bufferIndex = 0;
  d.attributes[2].format = MTLVertexFormatUChar4Normalized, d.attributes[2].offset = 24, d.attributes[2].bufferIndex = 0;
  d.layouts[0].stride = sizeof(Vertex);
  return d;
}

id<MTLRenderPipelineState> make(Device& device, NSString* vertex, NSString* fragment, MTLPixelFormat color, MTLPixelFormat depth, int samples, MTLVertexDescriptor* vertices, bool blend, std::string& error) {
  MTLRenderPipelineDescriptor* d = [MTLRenderPipelineDescriptor new];
  d.label = fragment;
  d.vertexFunction = [device.library newFunctionWithName:vertex];
  d.fragmentFunction = [device.library newFunctionWithName:fragment];
  d.colorAttachments[0].pixelFormat = color;
  d.depthAttachmentPixelFormat = depth;
  d.rasterSampleCount = static_cast<NSUInteger>(samples);
  d.vertexDescriptor = vertices;
  if (blend) {
    // Colour arrives already multiplied by its coverage.
    d.colorAttachments[0].blendingEnabled = YES;
    d.colorAttachments[0].sourceRGBBlendFactor = MTLBlendFactorOne, d.colorAttachments[0].sourceAlphaBlendFactor = MTLBlendFactorOne;
    d.colorAttachments[0].destinationRGBBlendFactor = MTLBlendFactorOneMinusSourceAlpha, d.colorAttachments[0].destinationAlphaBlendFactor = MTLBlendFactorOneMinusSourceAlpha;
  }
  NSError* err = nil;
  id<MTLRenderPipelineState> state = d.vertexFunction && d.fragmentFunction ? [device.device newRenderPipelineStateWithDescriptor:d error:&err] : nil;
  if (!state && error.empty()) error = std::string(fragment.UTF8String) + ": " + (err ? err.localizedDescription.UTF8String : "function not found");
  return state;
}

id<MTLDepthStencilState> depth(Device& device, MTLCompareFunction compare, bool write) {
  MTLDepthStencilDescriptor* d = [MTLDepthStencilDescriptor new];
  d.depthCompareFunction = compare;
  d.depthWriteEnabled = write;
  return [device.device newDepthStencilStateWithDescriptor:d];
}

}  // namespace

Pipelines makePipelines(Device& device, std::string& error) {
  Pipelines p;
  p.brick = make(device, @"brickVertex", @"brickFragment", MTLPixelFormatRGBA16Float, MTLPixelFormatDepth32Float, kSamples, brickVertices(), false, error);
  p.composite = make(device, @"screenVertex", @"compositeFragment", MTLPixelFormatBGRA8Unorm_sRGB, MTLPixelFormatInvalid, 1, nil, false, error);
  p.environment = make(device, @"screenVertex", @"environmentFragment", MTLPixelFormatRGBA16Float, MTLPixelFormatInvalid, 1, nil, false, error);
  // Depth is reversed (common.metal): nearer is greater.
  p.depthWrite = depth(device, MTLCompareFunctionGreaterEqual, true);
  p.depthRead = depth(device, MTLCompareFunctionGreaterEqual, false);
  p.depthNone = depth(device, MTLCompareFunctionAlways, false);
  MTLSamplerDescriptor* s = [MTLSamplerDescriptor new];
  s.minFilter = s.magFilter = MTLSamplerMinMagFilterLinear;
  s.mipFilter = MTLSamplerMipFilterLinear;
  p.smooth = [device.device newSamplerStateWithDescriptor:s];
  MTLSamplerDescriptor* sh = [MTLSamplerDescriptor new];
  sh.minFilter = sh.magFilter = MTLSamplerMinMagFilterLinear;
  sh.compareFunction = MTLCompareFunctionLessEqual;  // the shadow map is an ordinary depth map: nearer the light is less
  sh.sAddressMode = sh.tAddressMode = MTLSamplerAddressModeClampToEdge;
  p.shadow = [device.device newSamplerStateWithDescriptor:sh];
  p.ok = p.brick && p.composite && p.environment && p.depthWrite && p.smooth && p.shadow;
  return p;
}

}  // namespace bmr
