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

/// How a pipeline writes into the main pass's three targets.
enum class Writes { Opaque, Floor, Over, Glass, Transparent, Single, Least };

id<MTLRenderPipelineState> make(Device& device, NSString* vertex, NSString* fragment, Writes writes, MTLPixelFormat single, MTLPixelFormat depth, int samples, MTLVertexDescriptor* vertices,
                                std::string& error) {
  MTLRenderPipelineDescriptor* d = [MTLRenderPipelineDescriptor new];
  d.label = fragment ? fragment : vertex;
  d.vertexFunction = [device.library newFunctionWithName:vertex];
  d.fragmentFunction = fragment ? [device.library newFunctionWithName:fragment] : nil;
  d.depthAttachmentPixelFormat = depth;
  d.rasterSampleCount = static_cast<NSUInteger>(samples);
  d.vertexDescriptor = vertices;
  if (writes == Writes::Single || writes == Writes::Least) {
    d.colorAttachments[0].pixelFormat = single;
    if (writes == Writes::Least) {  // each channel keeps the least written to it
      MTLRenderPipelineColorAttachmentDescriptor* c = d.colorAttachments[0];
      c.blendingEnabled = YES;
      c.rgbBlendOperation = c.alphaBlendOperation = MTLBlendOperationMin;
      c.sourceRGBBlendFactor = c.sourceAlphaBlendFactor = c.destinationRGBBlendFactor = c.destinationAlphaBlendFactor = MTLBlendFactorOne;
    }
  } else {
    MTLRenderPipelineColorAttachmentDescriptor* c = d.colorAttachments[0];
    MTLRenderPipelineColorAttachmentDescriptor* sum = d.colorAttachments[1];
    MTLRenderPipelineColorAttachmentDescriptor* rev = d.colorAttachments[2];
    MTLRenderPipelineColorAttachmentDescriptor* amb = d.colorAttachments[3];
    c.pixelFormat = kColorFormat, sum.pixelFormat = kAccumFormat, rev.pixelFormat = kRevealFormat, amb.pixelFormat = kAmbientFormat;
    sum.writeMask = rev.writeMask = MTLColorWriteMaskNone;
    if (writes != Writes::Opaque && writes != Writes::Floor) amb.writeMask = MTLColorWriteMaskNone;
    if (writes == Writes::Over || writes == Writes::Floor) {
      // Colour arrives already multiplied by its coverage.
      c.blendingEnabled = YES;
      c.sourceRGBBlendFactor = c.sourceAlphaBlendFactor = MTLBlendFactorOne;
      c.destinationRGBBlendFactor = c.destinationAlphaBlendFactor = MTLBlendFactorOneMinusSourceAlpha;
    } else if (writes == Writes::Glass || writes == Writes::Transparent) {
      c.writeMask = MTLColorWriteMaskNone;
      sum.writeMask = rev.writeMask = MTLColorWriteMaskAll;
      sum.blendingEnabled = YES;  // accum += layer
      sum.sourceRGBBlendFactor = sum.sourceAlphaBlendFactor = MTLBlendFactorOne;
      sum.destinationRGBBlendFactor = sum.destinationAlphaBlendFactor = MTLBlendFactorOne;
      rev.blendingEnabled = YES;  // reveal += the layer's optical depth
      rev.sourceRGBBlendFactor = rev.sourceAlphaBlendFactor = MTLBlendFactorOne;
      rev.destinationRGBBlendFactor = rev.destinationAlphaBlendFactor = MTLBlendFactorOne;
      // Glass clears shares.g, which says the floor there is open (shaders/brick.metal).
      if (writes == Writes::Glass) amb.writeMask = MTLColorWriteMaskGreen;
    }
  }
  NSError* err = nil;
  id<MTLRenderPipelineState> state = d.vertexFunction && (d.fragmentFunction || !fragment) ? [device.device newRenderPipelineStateWithDescriptor:d error:&err] : nil;
  if (!state && error.empty()) error = std::string(d.label.UTF8String) + ": " + (err ? err.localizedDescription.UTF8String : "function not found");
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
  const MTLPixelFormat none = MTLPixelFormatInvalid, depth32 = MTLPixelFormatDepth32Float;
  p.brick = make(device, @"brickVertex", @"brickFragment", Writes::Opaque, none, depth32, kSamples, brickVertices(), error);
  p.glass = make(device, @"brickVertex", @"glassFragment", Writes::Glass, none, depth32, kSamples, brickVertices(), error);
  p.transparent = make(device, @"brickVertex", @"transparentFragment", Writes::Transparent, none, depth32, kSamples, brickVertices(), error);
  p.floor = make(device, @"floorVertex", @"floorFragment", Writes::Floor, none, depth32, kSamples, nil, error);
  p.ao = make(device, @"screenVertex", @"aoFragment", Writes::Single, MTLPixelFormatRG8Unorm, none, 1, nil, error);
  p.aoBlur = make(device, @"screenVertex", @"aoBlurFragment", Writes::Single, MTLPixelFormatRG8Unorm, none, 1, nil, error);
  p.edges = make(device, @"edgeVertex", @"edgeFragment", Writes::Over, none, depth32, kSamples, nil, error);
  p.height = make(device, @"heightVertex", @"heightFragment", Writes::Least, MTLPixelFormatRG16Float, none, 1, brickVertices(), error);
  p.shadow = make(device, @"shadowVertex", nil, Writes::Single, none, depth32, 1, brickVertices(), error);
  p.composite = make(device, @"screenVertex", @"compositeFragment", Writes::Single, MTLPixelFormatBGRA8Unorm_sRGB, none, 1, nil, error);
  p.mask = make(device, @"brickVertex", @"maskFragment", Writes::Single, MTLPixelFormatR8Unorm, none, 1, brickVertices(), error);
  p.ids = make(device, @"brickVertex", @"idFragment", Writes::Single, MTLPixelFormatR32Uint, depth32, 1, brickVertices(), error);
  p.shadowDepth = depth(device, MTLCompareFunctionLessEqual, true);  // the shadow map is not reversed: nearer the light is less
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
  p.shadowSampler = [device.device newSamplerStateWithDescriptor:sh];
  p.ok = p.height && p.ao && p.aoBlur && p.mask && p.ids && p.brick && p.glass && p.transparent && p.floor && p.edges && p.shadow && p.composite && p.depthWrite && p.shadowDepth && p.smooth && p.shadowSampler;
  return p;
}

}  // namespace bmr
