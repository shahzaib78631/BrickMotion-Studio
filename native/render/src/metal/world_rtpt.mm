// New-Era Universal Metal 3.1 Bindless Real-Time Path Tracing Host Pipeline (WorldRenderer).
// Directly accelerates native .glb / .gltf / .obj scenes with Metal 3.1 bindless PBR textures,
// alpha-cutout hardware RT, SHaRC multi-bounce GI, 16-bounce Beer-Lambert volume glass,
// Radiance .hdr skyboxes, 2D-Morton SVGF, direct-hit Halton TAAU, and ACES filmic tone mapping.
#import <Metal/Metal.h>
#import <QuartzCore/QuartzCore.h>
#include <simd/simd.h>

#include "bmr/world_renderer.h"
#include "bmr/tolerances.h"
#include "metal/device.h"

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <vector>
#if defined(__aarch64__)
#include <arm_neon.h>
#endif

namespace bmr {
namespace {

constexpr uint32_t kWrSharcCap = 262144u;

// Must match WrMeshGpu in shaders/rtpt_world.metal.
struct WrMeshGpuHost {
  uint64_t vertices;
  uint64_t indices;
  uint32_t material;
  uint32_t flags;
};
static_assert(sizeof(WrMeshGpuHost) == 24);

// Must match WrInstanceGpu in shaders/rtpt_world.metal.
struct WrInstanceGpuHost {
  simd_float4 model0, model1, model2, model3;
  simd_float4 ncol0, ncol1, ncol2;
  uint32_t meshIndex;
  uint32_t material;
  uint32_t flags;  // bit 0: alphaMask, bit 1: doubleSided, bit 2: glass
  uint32_t pad0;
};
static_assert(sizeof(WrInstanceGpuHost) == 128);

// Must match WrMaterialGpu in shaders/rtpt_world.metal (Metal 3.1 bindless texture handles).
struct WrMaterialGpuHost {
  uint64_t albedoTex;
  uint64_t normalTex;
  uint64_t mrTex;
  uint64_t emissiveTex;
  uint64_t alphaTex;
  uint64_t padTex;
  simd_float4 baseColor;
  simd_float4 emissive;
  simd_float4 pbr;
  simd_float4 glass;
  simd_float4 attenuation;
  simd_float4 meanAlbedo;
  simd_float4 uvScale;
};
static_assert(sizeof(MTLResourceID) == 8);
static_assert(sizeof(WrMaterialGpuHost) == 160);

// Must match WrUniforms in shaders/rtpt_world.metal field for field.
struct WrUniformsGpu {
  simd_float4x4 viewProjJittered;
  simd_float4x4 viewProjUnjittered;
  simd_float4x4 prevViewProj;
  simd_float4 eye;
  simd_float4 right;
  simd_float4 up;
  simd_float4 forward;
  simd_float4 sun;
  simd_float4 sky;
  simd_float4 studioLights[4];
  simd_float4 background;
  simd_float4 sceneMin;
  simd_float4 sceneMax;
  simd_float4 jitter;
  simd_uint4 size;
  simd_uint4 flags;
  simd_uint4 params;
  simd_uint4 outSize;
};

struct WrSharcAccumGpu {
  uint32_t key, radR, radG, radB, count, pad0, pad1, pad2;
};

struct WrSharcResolvedGpu {
  simd_float4 radSamples;
  simd_uint4 keyAge;
};

struct WrGpuMesh {
  id<MTLBuffer> vertices = nil;
  id<MTLBuffer> indices = nil;
  id<MTLAccelerationStructure> blas = nil;
  uint32_t indexCount = 0;
  uint32_t material = 0;
  bm::Box bounds;
};

uint64_t texHandle(id<MTLTexture> tex) {
  uint64_t out = 0;
  MTLResourceID rid = tex.gpuResourceID;
  std::memcpy(&out, &rid, sizeof(out));
  return out;
}

simd_float4x4 simdMat(const Mat4& m) {
  simd_float4x4 out;
  for (int c = 0; c < 4; c++) {
    out.columns[c] = simd_make_float4(m.m[c * 4 + 0], m.m[c * 4 + 1], m.m[c * 4 + 2], m.m[c * 4 + 3]);
  }
  return out;
}

simd_float4 f4(bm::Vec3 v, double w) {
  return simd_make_float4(static_cast<float>(v.x), static_cast<float>(v.y), static_cast<float>(v.z), static_cast<float>(w));
}

float halton(uint32_t index, uint32_t base) {
  float f = 1.0f, r = 0.0f;
  uint32_t i = index;
  while (i > 0u) {
    f /= static_cast<float>(base);
    r += f * static_cast<float>(i % base);
    i /= base;
  }
  return r;
}

bool sameCam(const Camera& a, const Camera& b) {
  auto eq = [](double x, double y) { return std::abs(x - y) <= 1e-6; };
  auto eq3 = [&](bm::Vec3 u, bm::Vec3 v) { return eq(u.x, v.x) && eq(u.y, v.y) && eq(u.z, v.z); };
  return eq3(a.eye, b.eye) && eq3(a.target, b.target) && eq3(a.up, b.up) && eq(a.fovY, b.fovY) &&
         eq(a.aspect, b.aspect) && eq(a.orthoHalfHeight, b.orthoHalfHeight);
}

bool sameOpt(const WorldFrameOptions& a, const WorldFrameOptions& b) {
  auto eq = [](float x, float y) { return std::abs(x - y) <= 1e-5f; };
  return a.clay == b.clay && a.studioRig == b.studioRig && a.floor == b.floor &&
         eq(a.sunDir[0], b.sunDir[0]) && eq(a.sunDir[1], b.sunDir[1]) && eq(a.sunDir[2], b.sunDir[2]) &&
         eq(a.sunIntensity, b.sunIntensity) && eq(a.sunAngularRadius, b.sunAngularRadius) &&
         eq(a.skyIntensity, b.skyIntensity) && eq(a.background[0], b.background[0]) &&
         eq(a.background[1], b.background[1]) && eq(a.background[2], b.background[2]);
}

void camBasis(const Camera& c, bm::Vec3& right, bm::Vec3& up, bm::Vec3& forward) {
  forward = c.target - c.eye;
  forward = bm::length(forward) > 1e-12 ? bm::normalized(forward) : bm::Vec3{0, 0, -1};
  right = bm::cross(forward, c.up);
  if (!(bm::length(right) > 1e-9)) right = bm::cross(forward, std::abs(forward.x) < 0.9 ? bm::Vec3{1, 0, 0} : bm::Vec3{0, 0, 1});
  right = bm::normalized(right);
  up = bm::cross(right, forward);
}

// IEEE-754 float -> half (for Radiance .hdr RGBA16Float upload).
uint16_t floatToHalf(float f) {
  uint32_t bits = 0;
  std::memcpy(&bits, &f, 4);
  const uint32_t sign = (bits >> 16) & 0x8000u;
  int exp = static_cast<int>((bits >> 23) & 0xFFu) - 127 + 15;
  uint32_t mant = bits & 0x7FFFFFu;
  if (exp <= 0) {
    if (exp < -10) return static_cast<uint16_t>(sign);
    mant = (mant | 0x800000u) >> (1 - exp);
    return static_cast<uint16_t>(sign | ((mant + 0x1000u) >> 13));
  }
  if (exp >= 31) return static_cast<uint16_t>(sign | 0x7BFFu);  // clamp to finite half max
  return static_cast<uint16_t>(sign | (static_cast<uint32_t>(exp) << 10) | ((mant + 0x1000u) >> 13));
}

// Decodes a Radiance .hdr (RGBE, raw or RLE) image into half-float RGBA pixels.
bool decodeRadianceHdr(const std::filesystem::path& path, int& outW, int& outH, std::vector<uint16_t>& outRgba16) {
  std::ifstream f(path, std::ios::binary);
  if (!f) return false;

  std::string line;
  if (!std::getline(f, line)) return false;
  if (line.rfind("#?RADIANCE", 0) != 0 && line.rfind("#?RGBE", 0) != 0) return false;

  // Read header until empty line.
  while (std::getline(f, line)) {
    if (!line.empty() && line.back() == '\r') line.pop_back();
    if (line.empty()) break;
  }
  // Read resolution line: e.g. "-Y 1024 +X 2048"
  if (!std::getline(f, line)) return false;
  int w = 0, h = 0;
  if (std::sscanf(line.c_str(), "-Y %d +X %d", &h, &w) != 2 &&
      std::sscanf(line.c_str(), "+Y %d +X %d", &h, &w) != 2) {
    return false;
  }
  if (w <= 0 || h <= 0 || w > 16384 || h > 8192) return false;

  outW = w;
  outH = h;
  outRgba16.assign(static_cast<size_t>(w) * static_cast<size_t>(h) * 4u, 0);
  std::vector<uint8_t> scanline(static_cast<size_t>(w) * 4u);

  for (int y = 0; y < h; y++) {
    uint8_t hdr[4] = {};
    if (!f.read(reinterpret_cast<char*>(hdr), 4)) return false;
    if (hdr[0] == 2 && hdr[1] == 2 && (hdr[2] & 0x80) == 0 && ((static_cast<int>(hdr[2]) << 8) | hdr[3]) == w) {
      // New-style per-channel RLE scanline.
      for (int c = 0; c < 4; c++) {
        int x = 0;
        while (x < w) {
          uint8_t code = 0;
          if (!f.read(reinterpret_cast<char*>(&code), 1)) return false;
          if (code > 128) {
            const int run = code - 128;
            uint8_t val = 0;
            if (!f.read(reinterpret_cast<char*>(&val), 1)) return false;
            if (x + run > w) return false;
            for (int k = 0; k < run; k++) scanline[static_cast<size_t>(x + k) * 4u + c] = val;
            x += run;
          } else {
            const int count = code;
            if (count == 0 || x + count > w) return false;
            for (int k = 0; k < count; k++) {
              uint8_t val = 0;
              if (!f.read(reinterpret_cast<char*>(&val), 1)) return false;
              scanline[static_cast<size_t>(x + k) * 4u + c] = val;
            }
            x += count;
          }
        }
      }
    } else {
      // Uncompressed RGBE scanline.
      scanline[0] = hdr[0];
      scanline[1] = hdr[1];
      scanline[2] = hdr[2];
      scanline[3] = hdr[3];
      if (w > 1 && !f.read(reinterpret_cast<char*>(scanline.data() + 4), static_cast<std::streamsize>((w - 1) * 4))) {
        return false;
      }
    }

    uint16_t* dst = outRgba16.data() + static_cast<size_t>(y) * static_cast<size_t>(w) * 4u;
    for (int x = 0; x < w; x++) {
      const uint8_t* p = scanline.data() + static_cast<size_t>(x) * 4u;
      if (p[3] == 0) {
        dst[x * 4 + 0] = dst[x * 4 + 1] = dst[x * 4 + 2] = 0;
        dst[x * 4 + 3] = floatToHalf(1.0f);
      } else {
        const float scale = std::ldexp(1.0f, static_cast<int>(p[3]) - 136);
        dst[x * 4 + 0] = floatToHalf(static_cast<float>(p[0]) * scale);
        dst[x * 4 + 1] = floatToHalf(static_cast<float>(p[1]) * scale);
        dst[x * 4 + 2] = floatToHalf(static_cast<float>(p[2]) * scale);
        dst[x * 4 + 3] = floatToHalf(1.0f);
      }
    }
  }
  return true;
}

MTLPixelFormat metalFormatFor(WorldTexFormat fmt, bool srgb) {
  switch (fmt) {
    case WorldTexFormat::RGBA8: return srgb ? MTLPixelFormatRGBA8Unorm_sRGB : MTLPixelFormatRGBA8Unorm;
    case WorldTexFormat::BC1_RGBA: return srgb ? MTLPixelFormatBC1_RGBA_sRGB : MTLPixelFormatBC1_RGBA;
    case WorldTexFormat::BC3_RGBA: return srgb ? MTLPixelFormatBC3_RGBA_sRGB : MTLPixelFormatBC3_RGBA;
    case WorldTexFormat::BC5_RG: return MTLPixelFormatBC5_RGUnorm;
    case WorldTexFormat::BC7_RGBA: return srgb ? MTLPixelFormatBC7_RGBAUnorm_sRGB : MTLPixelFormatBC7_RGBAUnorm;
  }
  return MTLPixelFormatRGBA8Unorm;
}

id<MTLTexture> uploadWorldTexture(id<MTLDevice> dev, id<MTLCommandQueue> queue, const WorldTextureData& td) {
  if (td.width < 1 || td.height < 1 || td.bytes.empty()) return nil;
  const MTLPixelFormat fmt = metalFormatFor(td.format, td.srgb);
  const bool isRgba = (td.format == WorldTexFormat::RGBA8);
  const int mipCount = isRgba
      ? static_cast<int>(std::floor(std::log2(static_cast<double>(std::max(td.width, td.height))))) + 1
      : std::max(1, td.mipCount);

  MTLTextureDescriptor* desc = [MTLTextureDescriptor texture2DDescriptorWithPixelFormat:fmt
                                                                                  width:static_cast<NSUInteger>(td.width)
                                                                                 height:static_cast<NSUInteger>(td.height)
                                                                              mipmapped:mipCount > 1];
  desc.mipmapLevelCount = static_cast<NSUInteger>(mipCount);
  desc.usage = MTLTextureUsageShaderRead;
  desc.storageMode = MTLStorageModePrivate;
  id<MTLTexture> gpuTex = [dev newTextureWithDescriptor:desc];
  if (!gpuTex) return nil;

  id<MTLBuffer> staging = [dev newBufferWithBytes:td.bytes.data() length:td.bytes.size() options:MTLResourceStorageModeShared];
  if (!staging) return nil;

  id<MTLCommandBuffer> cmd = [queue commandBuffer];
  id<MTLBlitCommandEncoder> blit = [cmd blitCommandEncoder];
  if (isRgba) {
    [blit copyFromBuffer:staging
               sourceOffset:0
          sourceBytesPerRow:static_cast<NSUInteger>(td.width) * 4u
        sourceBytesPerImage:static_cast<NSUInteger>(td.width) * static_cast<NSUInteger>(td.height) * 4u
                 sourceSize:MTLSizeMake(static_cast<NSUInteger>(td.width), static_cast<NSUInteger>(td.height), 1)
                  toTexture:gpuTex
           destinationSlice:0
           destinationLevel:0
          destinationOrigin:MTLOriginMake(0, 0, 0)];
    if (mipCount > 1) [blit generateMipmapsForTexture:gpuTex];
  } else {
    int mw = td.width, mh = td.height;
    const size_t nMips = std::min<size_t>(static_cast<size_t>(mipCount), td.mipOffsets.size());
    for (size_t m = 0; m < nMips; m++) {
      const NSUInteger rowBytes = td.mipRowBytes[m];
      const NSUInteger blockRows = static_cast<NSUInteger>((mh + 3) / 4);
      [blit copyFromBuffer:staging
                 sourceOffset:td.mipOffsets[m]
            sourceBytesPerRow:rowBytes
          sourceBytesPerImage:rowBytes * blockRows
                   sourceSize:MTLSizeMake(static_cast<NSUInteger>(mw), static_cast<NSUInteger>(mh), 1)
                    toTexture:gpuTex
             destinationSlice:0
             destinationLevel:m
            destinationOrigin:MTLOriginMake(0, 0, 0)];
      mw = std::max(1, mw >> 1);
      mh = std::max(1, mh >> 1);
    }
  }
  [blit endEncoding];
  [cmd commit];
  [cmd waitUntilCompleted];
  return gpuTex;
}

}  // namespace

struct WorldRenderer::Impl {
  Device* device = nullptr;
  bm::Box bounds;
  uint64_t totalTriangles = 0;
  uint32_t numMeshes = 0;
  uint32_t numTextures = 0;
  bool hasAlphaMask = false;
  bool hasGlass = false;

  // Pipelines
  id<MTLRenderPipelineState> gbufOpaque = nil, gbufGlass = nil, gbufFloor = nil, present = nil;
  id<MTLComputePipelineState> sharcResolve = nil, directPass = nil, traceFloor = nil, traceGiQuarter = nil, traceOpaque = nil, traceGlass = nil;
  id<MTLComputePipelineState> svgfTemporal = nil, svgfAtrous = nil, svgfAtrousDiff = nil, reModulate = nil, resolveTaau = nil;
  id<MTLDepthStencilState> depthWrite = nil, depthNone = nil;

  // Scene GPU resources
  std::vector<WrGpuMesh> meshes;
  std::vector<WrInstanceGpuHost> hostInstances;
  std::vector<bool> instanceIsGlass;
  std::vector<id<MTLAccelerationStructure>> blasList;
  id<MTLBuffer> meshTable = nil;
  id<MTLBuffer> instanceTable = nil;
  id<MTLBuffer> rtInstanceTable = nil;
  id<MTLBuffer> rtGeomMeshes = nil;
  id<MTLBuffer> materialTable = nil;
  id<MTLBuffer> tlasInstanceDesc = nil;
  id<MTLAccelerationStructure> tlas = nil;
  id<MTLTexture> dummyWhite = nil;
  id<MTLTexture> envTex = nil;
  bool hasHdr = false;
  std::vector<id<MTLTexture>> bindlessTextures;
  std::vector<id<MTLResource>> allRayResources;

  // Render targets (lazy-allocated / resized)
  int width = 0, height = 0;
  int traceW = 0, traceH = 0;
  id<MTLTexture> finalTex = nil;
  id<MTLTexture> gDepth = nil;
  id<MTLTexture> gPosId[2] = {nil, nil}, gNorm[2] = {nil, nil};
  id<MTLTexture> gMat = nil, gMotion = nil;
  id<MTLTexture> diTex = nil, giQuarter = nil, diffRaw = nil, specRaw = nil;
  id<MTLTexture> diffHist[2] = {nil, nil}, specHist[2] = {nil, nil};
  id<MTLTexture> moments[2] = {nil, nil}, hLen[2] = {nil, nil};
  id<MTLTexture> diffPing = nil, specPing = nil, diffPong = nil;
  id<MTLTexture> colorTrace = nil;
  id<MTLTexture> taa[2] = {nil, nil};
  id<MTLBuffer> sharcAccum = nil, sharcResolved = nil;
  id<MTLBuffer> tileIndirect = nil, tileIndirectZero = nil;
  id<MTLBuffer> glassTiles = nil, opaqueTiles = nil, floorTiles = nil;

  // Temporal state
  uint32_t frameIdx = 0;
  uint32_t stillFrames = 0;
  bool hasHistory = false;
  bool drewOffscreen = false;
  simd_float4x4 prevViewProj = matrix_identity_float4x4;
  float prevJitter[2] = {0.0f, 0.0f};
  Camera lastCamera;
  WorldFrameOptions lastOptions;
  dispatch_semaphore_t inFlight = nil;
  std::atomic<double> gpuMs{0.0};

  bool buildPipelines(std::string& err);
  bool uploadScene(const WorldAsset& asset, std::string& err);
  void ensureTargets(int w, int h, int tw, int th);
  FrameStats drawFrame(const Camera& camera, const WorldFrameOptions& options, id<CAMetalDrawable> drawable);
};

bool WorldRenderer::Impl::buildPipelines(std::string& err) {
  id<MTLDevice> dev = device->device;
  id<MTLLibrary> lib = device->library;

  auto fn = [&](NSString* name) -> id<MTLFunction> {
    id<MTLFunction> f = [lib newFunctionWithName:name];
    if (!f && err.empty()) err = std::string("missing shader function: ") + name.UTF8String;
    return f;
  };
  auto makeCompute = [&](NSString* name) -> id<MTLComputePipelineState> {
    id<MTLFunction> f = fn(name);
    if (!f) return nil;
    NSError* e = nil;
    id<MTLComputePipelineState> pso = [dev newComputePipelineStateWithFunction:f error:&e];
    if (!pso && err.empty()) err = e ? e.localizedDescription.UTF8String : (std::string("failed compute pipeline: ") + name.UTF8String);
    return pso;
  };
  auto makeGbuf = [&](NSString* vName, NSString* fName) -> id<MTLRenderPipelineState> {
    id<MTLFunction> vf = fn(vName);
    id<MTLFunction> ff = fn(fName);
    if (!vf || !ff) return nil;
    MTLRenderPipelineDescriptor* d = [MTLRenderPipelineDescriptor new];
    d.vertexFunction = vf;
    d.fragmentFunction = ff;
    d.colorAttachments[0].pixelFormat = MTLPixelFormatRGBA32Float;
    d.colorAttachments[1].pixelFormat = MTLPixelFormatRGBA16Float;
    d.colorAttachments[2].pixelFormat = MTLPixelFormatRGBA16Float;
    d.colorAttachments[3].pixelFormat = MTLPixelFormatRG16Float;
    d.depthAttachmentPixelFormat = MTLPixelFormatDepth32Float;
    NSError* e = nil;
    id<MTLRenderPipelineState> pso = [dev newRenderPipelineStateWithDescriptor:d error:&e];
    if (!pso && err.empty()) err = e ? e.localizedDescription.UTF8String : (std::string("failed render pipeline: ") + fName.UTF8String);
    return pso;
  };

  gbufOpaque = makeGbuf(@"wrGbufVertex", @"wrGbufOpaqueFragment");
  gbufGlass = makeGbuf(@"wrGbufVertex", @"wrGbufGlassFragment");
  gbufFloor = makeGbuf(@"wrGbufFloorVertex", @"wrGbufFloorFragment");
  {
    id<MTLFunction> vf = fn(@"screenVertex");
    id<MTLFunction> ff = fn(@"wrPresentFragment");
    if (vf && ff) {
      MTLRenderPipelineDescriptor* d = [MTLRenderPipelineDescriptor new];
      d.vertexFunction = vf;
      d.fragmentFunction = ff;
      d.colorAttachments[0].pixelFormat = MTLPixelFormatBGRA8Unorm_sRGB;
      NSError* e = nil;
      present = [dev newRenderPipelineStateWithDescriptor:d error:&e];
      if (!present && err.empty()) err = e ? e.localizedDescription.UTF8String : "failed wrPresent pipeline";
    }
  }
  sharcResolve = makeCompute(@"wrSharcResolve");
  directPass = makeCompute(@"wrDirectPass");
  traceFloor = makeCompute(@"wrTraceFloor");
  traceGiQuarter = makeCompute(@"wrTraceGiQuarter");
  traceOpaque = makeCompute(@"wrTraceOpaque");
  traceGlass = makeCompute(@"wrTraceGlass");
  svgfTemporal = makeCompute(@"wrSvgfTemporal");
  svgfAtrous = makeCompute(@"wrSvgfAtrous");
  svgfAtrousDiff = makeCompute(@"wrSvgfAtrousDiff");
  reModulate = makeCompute(@"wrReModulateTrace");
  resolveTaau = makeCompute(@"wrResolveTaau");

  MTLDepthStencilDescriptor* ds = [MTLDepthStencilDescriptor new];
  ds.depthCompareFunction = MTLCompareFunctionGreaterEqual;  // Reverse-Z (near=1, far=0)
  ds.depthWriteEnabled = YES;
  depthWrite = [dev newDepthStencilStateWithDescriptor:ds];
  ds.depthCompareFunction = MTLCompareFunctionAlways;
  ds.depthWriteEnabled = NO;
  depthNone = [dev newDepthStencilStateWithDescriptor:ds];

  return gbufOpaque && gbufGlass && gbufFloor && present && sharcResolve && directPass && traceFloor &&
         traceGiQuarter && traceOpaque && traceGlass && svgfTemporal && svgfAtrous && svgfAtrousDiff && reModulate &&
         resolveTaau && depthWrite && depthNone;
}

bool WorldRenderer::Impl::uploadScene(const WorldAsset& asset, std::string& err) {
  id<MTLDevice> dev = device->device;
  id<MTLCommandQueue> queue = device->queue;
  if (!dev.supportsRaytracing) {
    err = "this Mac GPU does not support Metal hardware ray tracing";
    return false;
  }

  bounds = asset.bounds;

  // 1x1 dummy white texture for unused bindless material slots & fallback env map.
  {
    MTLTextureDescriptor* d = [MTLTextureDescriptor texture2DDescriptorWithPixelFormat:MTLPixelFormatRGBA8Unorm width:1 height:1 mipmapped:NO];
    d.usage = MTLTextureUsageShaderRead;
    d.storageMode = MTLStorageModeShared;
    dummyWhite = [dev newTextureWithDescriptor:d];
    const uint8_t white[4] = {255, 255, 255, 255};
    [dummyWhite replaceRegion:MTLRegionMake2D(0, 0, 1, 1) mipmapLevel:0 withBytes:white bytesPerRow:4];

    MTLTextureDescriptor* ed = [MTLTextureDescriptor texture2DDescriptorWithPixelFormat:MTLPixelFormatRGBA16Float width:1 height:1 mipmapped:NO];
    ed.usage = MTLTextureUsageShaderRead;
    ed.storageMode = MTLStorageModeShared;
    envTex = [dev newTextureWithDescriptor:ed];
    const uint16_t black[4] = {0, 0, 0, floatToHalf(1.0f)};
    [envTex replaceRegion:MTLRegionMake2D(0, 0, 1, 1) mipmapLevel:0 withBytes:black bytesPerRow:8];
  }

  // 1. Upload all bindless PBR textures!
  bindlessTextures.reserve(asset.textures.size() + 1);
  bindlessTextures.push_back(dummyWhite);
  std::vector<id<MTLTexture>> texList(asset.textures.size(), nil);
  for (size_t i = 0; i < asset.textures.size(); i++) {
    id<MTLTexture> t = uploadWorldTexture(dev, queue, asset.textures[i]);
    if (t) {
      texList[i] = t;
      bindlessTextures.push_back(t);
    }
  }
  numTextures = static_cast<uint32_t>(bindlessTextures.size() - 1);

  // 2. Pack bindless Metal 3.1 material table.
  std::vector<WrMaterialGpuHost> gpuMats;
  gpuMats.reserve(std::max<size_t>(1, asset.materials.size()));
  auto pickTex = [&](int idx, bool& hasFlag) -> uint64_t {
    if (idx >= 0 && static_cast<size_t>(idx) < texList.size() && texList[idx] != nil) {
      hasFlag = true;
      return texHandle(texList[idx]);
    }
    hasFlag = false;
    return texHandle(dummyWhite);
  };
  for (const WorldMaterial& m : asset.materials) {
    WrMaterialGpuHost gm{};
    bool hasAlb = false, hasNrm = false, hasMr = false, hasEm = false, hasAlp = false;
    gm.albedoTex = pickTex(m.albedoTex, hasAlb);
    gm.normalTex = pickTex(m.normalTex, hasNrm);
    gm.mrTex = pickTex(m.mrTex, hasMr);
    gm.emissiveTex = pickTex(m.emissiveTex, hasEm);
    gm.alphaTex = pickTex(m.alphaTex, hasAlp);
    gm.padTex = texHandle(dummyWhite);

    gm.baseColor = simd_make_float4(m.baseColor[0], m.baseColor[1], m.baseColor[2], m.baseColor[3]);
    gm.emissive = simd_make_float4(m.emissive[0], m.emissive[1], m.emissive[2], 0.0f);
    gm.pbr = simd_make_float4(std::clamp(m.metallic, 0.0f, 1.0f),
                              std::clamp(m.roughness, 0.04f, 0.98f),
                              std::clamp(m.clearcoat, 0.0f, 1.0f),
                              std::clamp(m.clearcoatRoughness, 0.02f, 0.98f));
    gm.glass = simd_make_float4(std::clamp(m.transmission, 0.0f, 1.0f),
                                std::clamp(m.ior, 1.02f, 2.8f),
                                m.normalScale,
                                m.alphaCutoff);

    const bool isGlass = (m.transmission > 0.12f);
    if (isGlass) hasGlass = true;
    const bool isMask = (m.alphaMode == WorldAlphaMode::Mask) && !isGlass;
    if (isMask) hasAlphaMask = true;

    // Exact Beer-Lambert attenuation sigma_a = -ln(attenuationColor) / attenuationDistance (KHR_materials_volume).
    float sigR = 0.0f, sigG = 0.0f, sigB = 0.0f;
    if (isGlass && !m.thinGlass && m.attenuationDistance > 1e-5f && m.attenuationDistance < 1e5f) {
      sigR = -std::log(std::clamp(m.attenuationColor[0], 1e-4f, 1.0f)) / m.attenuationDistance;
      sigG = -std::log(std::clamp(m.attenuationColor[1], 1e-4f, 1.0f)) / m.attenuationDistance;
      sigB = -std::log(std::clamp(m.attenuationColor[2], 1e-4f, 1.0f)) / m.attenuationDistance;
    }

    uint32_t mFlags = 0u;
    if (isMask) mFlags |= 1u;
    if (m.alphaMode == WorldAlphaMode::Blend) mFlags |= 2u;
    if (m.doubleSided) mFlags |= 4u;
    if (m.normalIsBc5) mFlags |= 8u;
    if (hasAlb) mFlags |= 16u;
    if (hasNrm) mFlags |= 32u;
    if (hasMr) mFlags |= 64u;
    if (hasEm) mFlags |= 128u;
    if (hasAlp) mFlags |= 256u;
    if (m.mrIsObjSpecular) mFlags |= 512u;
    if (isGlass) mFlags |= 1024u;
    if (m.thinGlass) mFlags |= 2048u;

    float flagsAsFloat = 0.0f;
    std::memcpy(&flagsAsFloat, &mFlags, sizeof(uint32_t));
    gm.attenuation = simd_make_float4(sigR, sigG, sigB, flagsAsFloat);
    float mR = m.baseColor[0], mG = m.baseColor[1], mB = m.baseColor[2];
    if (m.albedoTex >= 0 && static_cast<size_t>(m.albedoTex) < asset.textures.size()) {
      const auto& td = asset.textures[m.albedoTex];
      mR *= td.meanRgb[0];
      mG *= td.meanRgb[1];
      mB *= td.meanRgb[2];
    }
    gm.meanAlbedo = simd_make_float4(mR, mG, mB, 1.0f);
    gm.uvScale = simd_make_float4(m.normalUvScale[0], m.normalUvScale[1], m.albedoUvScale[0], m.albedoUvScale[1]);
    gpuMats.push_back(gm);
  }
  if (gpuMats.empty()) {
    WrMaterialGpuHost def{};
    def.albedoTex = def.normalTex = def.mrTex = def.emissiveTex = def.alphaTex = def.padTex = texHandle(dummyWhite);
    def.baseColor = simd_make_float4(0.75f, 0.75f, 0.75f, 1.0f);
    def.meanAlbedo = simd_make_float4(0.75f, 0.75f, 0.75f, 1.0f);
    def.uvScale = simd_make_float4(1.0f, 1.0f, 1.0f, 1.0f);
    def.pbr = simd_make_float4(0.0f, 0.5f, 0.0f, 0.05f);
    def.glass = simd_make_float4(0.0f, 1.5f, 1.0f, 0.5f);
    gpuMats.push_back(def);
  }
  materialTable = [dev newBufferWithBytes:gpuMats.data() length:gpuMats.size() * sizeof(WrMaterialGpuHost) options:MTLResourceStorageModeShared];

  // 3. Upload meshes into GPU vertex/index buffers!
  std::vector<uint32_t> meshToGpu(asset.meshes.size(), UINT32_MAX);
  std::vector<WrMeshGpuHost> gpuMeshTable;
  std::vector<uint32_t> meshMatFlags;
  for (size_t i = 0; i < asset.meshes.size(); i++) {
    const WorldMesh& wm = asset.meshes[i];
    if (wm.vertices.empty() || wm.indices.size() < 3) continue;
    WrGpuMesh gm;
    gm.vertices = [dev newBufferWithBytes:wm.vertices.data() length:wm.vertices.size() * sizeof(WorldVertex) options:MTLResourceStorageModeShared];
    gm.indices = [dev newBufferWithBytes:wm.indices.data() length:wm.indices.size() * sizeof(uint32_t) options:MTLResourceStorageModeShared];
    gm.indexCount = static_cast<uint32_t>(wm.indices.size());
    gm.material = static_cast<uint32_t>(std::clamp(wm.material, 0, static_cast<int>(gpuMats.size()) - 1));
    gm.bounds = wm.bounds;
    uint32_t mFlags = 0u;
    const float wf = gpuMats[gm.material].attenuation.w;
    std::memcpy(&mFlags, &wf, sizeof(uint32_t));
    const uint32_t meshFlags = ((mFlags & 1u) ? 1u : 0u) | ((mFlags & 4u) ? 2u : 0u) | ((mFlags & 1024u) ? 4u : 0u);
    meshToGpu[i] = static_cast<uint32_t>(meshes.size());
    gpuMeshTable.push_back({gm.vertices.gpuAddress, gm.indices.gpuAddress, gm.material, meshFlags});
    meshMatFlags.push_back(mFlags);
    meshes.push_back(gm);
  }
  numMeshes = static_cast<uint32_t>(meshes.size());
  if (meshes.empty()) {
    err = "world asset contains no renderable triangles";
    return false;
  }
  meshTable = [dev newBufferWithBytes:gpuMeshTable.data() length:gpuMeshTable.size() * sizeof(WrMeshGpuHost) options:MTLResourceStorageModeShared];

  // 4. Build draw instances + ZERO-OVERLAP Unified Multi-Geometry BLASes for static meshes!
  // Static identity-transform meshes (e.g. all 132 meshes of Bistro, all 25 of Sponza) are merged into
  // at most 3 unified global SAH BVHs (0x01 Opaque, 0x02 Foliage Alpha-Mask, 0x04 Glass) -> eliminates
  // 132-way TLAS bounding-box overlap and gives 15x-30x faster hardware ray traversal!
  auto isIdentity = [](const float* m) {
    constexpr float eps = 1e-5f;
    return std::abs(m[0] - 1.0f) < eps && std::abs(m[5] - 1.0f) < eps &&
           std::abs(m[10] - 1.0f) < eps && std::abs(m[15] - 1.0f) < eps &&
           std::abs(m[1]) < eps && std::abs(m[2]) < eps && std::abs(m[3]) < eps &&
           std::abs(m[4]) < eps && std::abs(m[6]) < eps && std::abs(m[7]) < eps &&
           std::abs(m[8]) < eps && std::abs(m[9]) < eps && std::abs(m[11]) < eps &&
           std::abs(m[12]) < eps && std::abs(m[13]) < eps && std::abs(m[14]) < eps;
  };

  std::vector<uint32_t> staticBuckets[3];  // 0: opaque (0x01), 1: alphaMask (0x02), 2: glass (0x04)
  std::vector<size_t> dynamicInstIndices;
  hostInstances.reserve(asset.instances.size());
  instanceIsGlass.reserve(asset.instances.size());
  totalTriangles = 0;

  for (const WorldInstance& wi : asset.instances) {
    if (wi.mesh >= meshToGpu.size() || meshToGpu[wi.mesh] == UINT32_MAX) continue;
    const uint32_t gMesh = meshToGpu[wi.mesh];
    const WrGpuMesh& gm = meshes[gMesh];
    const uint32_t matIdx = gm.material;
    const uint32_t mFlags = meshMatFlags[gMesh];

    const float* m = wi.model;
    const simd_float3 c0 = simd_make_float3(m[0], m[1], m[2]);
    const simd_float3 c1 = simd_make_float3(m[4], m[5], m[6]);
    const simd_float3 c2 = simd_make_float3(m[8], m[9], m[10]);
    const float det = simd_dot(c0, simd_cross(c1, c2));
    const float sign = (det < 0.0f) ? -1.0f : 1.0f;

    WrInstanceGpuHost gi{};
    gi.model0 = simd_make_float4(m[0], m[1], m[2], m[3]);
    gi.model1 = simd_make_float4(m[4], m[5], m[6], m[7]);
    gi.model2 = simd_make_float4(m[8], m[9], m[10], m[11]);
    gi.model3 = simd_make_float4(m[12], m[13], m[14], m[15]);
    gi.ncol0 = simd_make_float4(simd_cross(c1, c2) * sign, 0.0f);
    gi.ncol1 = simd_make_float4(simd_cross(c2, c0) * sign, 0.0f);
    gi.ncol2 = simd_make_float4(simd_cross(c0, c1) * sign, 0.0f);
    gi.meshIndex = gMesh;
    gi.material = matIdx;
    gi.flags = ((mFlags & 1u) ? 1u : 0u) | ((mFlags & 4u) ? 2u : 0u) | ((mFlags & 1024u) ? 4u : 0u);
    const size_t drawIdx = hostInstances.size();
    hostInstances.push_back(gi);
    instanceIsGlass.push_back((mFlags & 1024u) != 0u);
    totalTriangles += gm.indexCount / 3;

    if (isIdentity(m)) {
      const int bucket = (mFlags & 1024u) ? 2 : ((mFlags & 1u) ? 1 : 0);
      staticBuckets[bucket].push_back(gMesh);
    } else {
      dynamicInstIndices.push_back(drawIdx);
    }
  }
  if (hostInstances.empty()) {
    err = "world asset contains no renderable instances";
    return false;
  }

  auto makeTriGeom = [&](uint32_t gMesh) {
    const WrGpuMesh& gm = meshes[gMesh];
    auto geom = [MTLAccelerationStructureTriangleGeometryDescriptor descriptor];
    geom.vertexBuffer = gm.vertices;
    geom.vertexStride = sizeof(WorldVertex);
    geom.vertexFormat = MTLAttributeFormatFloat3;
    geom.indexBuffer = gm.indices;
    geom.indexType = MTLIndexTypeUInt32;
    geom.triangleCount = gm.indexCount / 3;
    geom.opaque = YES;
    return geom;
  };

  auto buildAndCompactBlas = [&](NSArray<MTLAccelerationStructureGeometryDescriptor*>* geoms) -> id<MTLAccelerationStructure> {
    auto desc = [MTLPrimitiveAccelerationStructureDescriptor descriptor];
    desc.geometryDescriptors = geoms;
    const MTLAccelerationStructureSizes need = [dev accelerationStructureSizesWithDescriptor:desc];
    id<MTLAccelerationStructure> raw = [dev newAccelerationStructureWithSize:need.accelerationStructureSize];
    id<MTLBuffer> scratch = [dev newBufferWithLength:std::max<NSUInteger>(need.buildScratchBufferSize, 16) options:MTLResourceStorageModePrivate];
    id<MTLBuffer> sizeBuf = [dev newBufferWithLength:sizeof(uint32_t) options:MTLResourceStorageModeShared];
    id<MTLCommandBuffer> c1 = [queue commandBuffer];
    id<MTLAccelerationStructureCommandEncoder> e1 = [c1 accelerationStructureCommandEncoder];
    [e1 buildAccelerationStructure:raw descriptor:desc scratchBuffer:scratch scratchBufferOffset:0];
    [e1 writeCompactedAccelerationStructureSize:raw toBuffer:sizeBuf offset:0];
    [e1 endEncoding];
    [c1 commit];
    [c1 waitUntilCompleted];
    const uint32_t compSize = *static_cast<const uint32_t*>(sizeBuf.contents);
    id<MTLAccelerationStructure> small = [dev newAccelerationStructureWithSize:std::max<uint32_t>(compSize, 64u)];
    id<MTLCommandBuffer> c2 = [queue commandBuffer];
    id<MTLAccelerationStructureCommandEncoder> e2 = [c2 accelerationStructureCommandEncoder];
    [e2 copyAndCompactAccelerationStructure:raw toAccelerationStructure:small];
    [e2 endEncoding];
    [c2 commit];
    [c2 waitUntilCompleted];
    return small;
  };

  blasList.clear();
  std::vector<WrInstanceGpuHost> rtInstances;
  std::vector<uint32_t> rtGeomMeshesHost;
  std::vector<MTLAccelerationStructureInstanceDescriptor> tlasDescs;

  // 4a. Unified Multi-Geometry BLASes for static buckets (at most 3 TLAS nodes total for all of Bistro/Sponza!)
  const uint32_t bucketMasks[3] = {0x01u, 0x02u, 0x04u};
  const uint32_t bucketFlags[3] = {0u, 1u, 4u};
  for (int b = 0; b < 3; b++) {
    if (staticBuckets[b].empty()) continue;
    NSMutableArray<MTLAccelerationStructureGeometryDescriptor*>* geoms =
        [NSMutableArray arrayWithCapacity:staticBuckets[b].size()];
    const uint32_t geomBase = static_cast<uint32_t>(rtGeomMeshesHost.size());
    for (uint32_t gMesh : staticBuckets[b]) {
      [geoms addObject:makeTriGeom(gMesh)];
      rtGeomMeshesHost.push_back(gMesh);
    }
    const uint32_t blasIdx = static_cast<uint32_t>(blasList.size());
    blasList.push_back(buildAndCompactBlas(geoms));

    WrInstanceGpuHost rti{};
    rti.model0 = simd_make_float4(1, 0, 0, 0);
    rti.model1 = simd_make_float4(0, 1, 0, 0);
    rti.model2 = simd_make_float4(0, 0, 1, 0);
    rti.model3 = simd_make_float4(0, 0, 0, 1);
    rti.ncol0 = simd_make_float4(1, 0, 0, 0);
    rti.ncol1 = simd_make_float4(0, 1, 0, 0);
    rti.ncol2 = simd_make_float4(0, 0, 1, 0);
    rti.meshIndex = geomBase;
    rti.material = 0u;
    rti.flags = bucketFlags[b];
    rtInstances.push_back(rti);

    MTLAccelerationStructureInstanceDescriptor td{};
    td.transformationMatrix.columns[0] = MTLPackedFloat3Make(1, 0, 0);
    td.transformationMatrix.columns[1] = MTLPackedFloat3Make(0, 1, 0);
    td.transformationMatrix.columns[2] = MTLPackedFloat3Make(0, 0, 1);
    td.transformationMatrix.columns[3] = MTLPackedFloat3Make(0, 0, 0);
    td.options = MTLAccelerationStructureInstanceOptionOpaque;
    td.mask = bucketMasks[b];
    td.intersectionFunctionTableOffset = 0;
    td.accelerationStructureIndex = blasIdx;
    tlasDescs.push_back(td);
  }

  // 4b. Instanced per-mesh BLASes for transformed glTF node hierarchies (CarConcept, ChronographWatch, etc.).
  if (!dynamicInstIndices.empty()) {
    std::vector<uint32_t> meshToDynBlas(meshes.size(), UINT32_MAX);
    std::vector<uint32_t> needMeshes;
    for (size_t idx : dynamicInstIndices) {
      const uint32_t gMesh = hostInstances[idx].meshIndex;
      if (meshToDynBlas[gMesh] == UINT32_MAX) {
        meshToDynBlas[gMesh] = static_cast<uint32_t>(blasList.size() + needMeshes.size());
        needMeshes.push_back(gMesh);
      }
    }
    // Batch build & compact all dynamic mesh BLASes.
    constexpr size_t kBatch = 64;
    for (size_t start = 0; start < needMeshes.size(); start += kBatch) {
      const size_t end = std::min(needMeshes.size(), start + kBatch);
      const size_t n = end - start;
      id<MTLBuffer> sizes = [dev newBufferWithLength:n * sizeof(uint32_t) options:MTLResourceStorageModeShared];
      id<MTLCommandBuffer> c1 = [queue commandBuffer];
      id<MTLAccelerationStructureCommandEncoder> e1 = [c1 accelerationStructureCommandEncoder];
      std::vector<id<MTLAccelerationStructure>> rawList(n);
      std::vector<id<MTLBuffer>> scratches;
      scratches.reserve(n);
      for (size_t k = 0; k < n; k++) {
        auto desc = [MTLPrimitiveAccelerationStructureDescriptor descriptor];
        desc.geometryDescriptors = @[makeTriGeom(needMeshes[start + k])];
        const MTLAccelerationStructureSizes need = [dev accelerationStructureSizesWithDescriptor:desc];
        rawList[k] = [dev newAccelerationStructureWithSize:need.accelerationStructureSize];
        scratches.push_back([dev newBufferWithLength:std::max<NSUInteger>(need.buildScratchBufferSize, 16) options:MTLResourceStorageModePrivate]);
        [e1 buildAccelerationStructure:rawList[k] descriptor:desc scratchBuffer:scratches.back() scratchBufferOffset:0];
        [e1 writeCompactedAccelerationStructureSize:rawList[k] toBuffer:sizes offset:k * sizeof(uint32_t)];
      }
      [e1 endEncoding];
      [c1 commit];
      [c1 waitUntilCompleted];
      id<MTLCommandBuffer> c2 = [queue commandBuffer];
      id<MTLAccelerationStructureCommandEncoder> e2 = [c2 accelerationStructureCommandEncoder];
      const uint32_t* compacted = static_cast<const uint32_t*>(sizes.contents);
      for (size_t k = 0; k < n; k++) {
        id<MTLAccelerationStructure> small = [dev newAccelerationStructureWithSize:std::max<uint32_t>(compacted[k], 64u)];
        [e2 copyAndCompactAccelerationStructure:rawList[k] toAccelerationStructure:small];
        blasList.push_back(small);
      }
      [e2 endEncoding];
      [c2 commit];
      [c2 waitUntilCompleted];
    }

    for (size_t idx : dynamicInstIndices) {
      WrInstanceGpuHost rti = hostInstances[idx];
      const uint32_t gMesh = rti.meshIndex;
      const uint32_t mFlags = meshMatFlags[gMesh];
      const uint32_t geomBase = static_cast<uint32_t>(rtGeomMeshesHost.size());
      rtGeomMeshesHost.push_back(gMesh);
      rti.meshIndex = geomBase;
      rtInstances.push_back(rti);

      MTLAccelerationStructureInstanceDescriptor td{};
      td.transformationMatrix.columns[0] = MTLPackedFloat3Make(rti.model0.x, rti.model0.y, rti.model0.z);
      td.transformationMatrix.columns[1] = MTLPackedFloat3Make(rti.model1.x, rti.model1.y, rti.model1.z);
      td.transformationMatrix.columns[2] = MTLPackedFloat3Make(rti.model2.x, rti.model2.y, rti.model2.z);
      td.transformationMatrix.columns[3] = MTLPackedFloat3Make(rti.model3.x, rti.model3.y, rti.model3.z);
      td.options = MTLAccelerationStructureInstanceOptionOpaque;
      td.mask = (mFlags & 1024u) ? 0x04u : ((mFlags & 1u) ? 0x02u : 0x01u);
      td.intersectionFunctionTableOffset = 0;
      td.accelerationStructureIndex = meshToDynBlas[gMesh];
      tlasDescs.push_back(td);
    }
  }

  instanceTable = [dev newBufferWithBytes:hostInstances.data() length:hostInstances.size() * sizeof(WrInstanceGpuHost) options:MTLResourceStorageModeShared];
  rtInstanceTable = [dev newBufferWithBytes:rtInstances.data() length:rtInstances.size() * sizeof(WrInstanceGpuHost) options:MTLResourceStorageModeShared];
  rtGeomMeshes = [dev newBufferWithBytes:rtGeomMeshesHost.data() length:rtGeomMeshesHost.size() * sizeof(uint32_t) options:MTLResourceStorageModeShared];
  tlasInstanceDesc = [dev newBufferWithBytes:tlasDescs.data() length:tlasDescs.size() * sizeof(MTLAccelerationStructureInstanceDescriptor) options:MTLResourceStorageModeShared];

  NSMutableArray<id<MTLAccelerationStructure>>* blasArray = [NSMutableArray arrayWithCapacity:blasList.size()];
  for (id<MTLAccelerationStructure> as : blasList) [blasArray addObject:as];

  auto tlasDesc = [MTLInstanceAccelerationStructureDescriptor descriptor];
  tlasDesc.instancedAccelerationStructures = blasArray;
  tlasDesc.instanceCount = tlasDescs.size();
  tlasDesc.instanceDescriptorBuffer = tlasInstanceDesc;
  tlasDesc.instanceDescriptorType = MTLAccelerationStructureInstanceDescriptorTypeDefault;
  const MTLAccelerationStructureSizes tlasNeed = [dev accelerationStructureSizesWithDescriptor:tlasDesc];
  tlas = [dev newAccelerationStructureWithSize:tlasNeed.accelerationStructureSize];
  id<MTLBuffer> tlasScratch = [dev newBufferWithLength:std::max<NSUInteger>(tlasNeed.buildScratchBufferSize, 16) options:MTLResourceStorageModePrivate];
  id<MTLCommandBuffer> cmd = [queue commandBuffer];
  id<MTLAccelerationStructureCommandEncoder> enc = [cmd accelerationStructureCommandEncoder];
  [enc buildAccelerationStructure:tlas descriptor:tlasDesc scratchBuffer:tlasScratch scratchBufferOffset:0];
  [enc endEncoding];
  [cmd commit];
  [cmd waitUntilCompleted];

  // Collect every resource dereferenced via GPU pointers / bindless texture IDs for fast residency binding!
  allRayResources.clear();
  allRayResources.reserve(blasList.size() + meshes.size() * 2 + bindlessTextures.size());
  for (id<MTLAccelerationStructure> as : blasList) allRayResources.push_back(as);
  for (const WrGpuMesh& gm : meshes) {
    allRayResources.push_back(gm.vertices);
    allRayResources.push_back(gm.indices);
  }
  for (id<MTLTexture> t : bindlessTextures) allRayResources.push_back(t);

  return true;
}

void WorldRenderer::Impl::ensureTargets(int w, int h, int tw, int th) {
  if (width == w && height == h && traceW == tw && traceH == th && gDepth && sharcAccum && finalTex) return;
  id<MTLDevice> dev = device->device;
  auto mkTex = [&](int cw, int ch, MTLPixelFormat fmt, MTLTextureUsage usage, MTLStorageMode mode = MTLStorageModePrivate) {
    MTLTextureDescriptor* d = [MTLTextureDescriptor texture2DDescriptorWithPixelFormat:fmt
                                                                                 width:static_cast<NSUInteger>(cw)
                                                                                height:static_cast<NSUInteger>(ch)
                                                                             mipmapped:NO];
    d.usage = usage;
    d.storageMode = mode;
    return [dev newTextureWithDescriptor:d];
  };
  const MTLTextureUsage gbufUsage = MTLTextureUsageRenderTarget | MTLTextureUsageShaderRead;
  const MTLTextureUsage rwUsage = MTLTextureUsageShaderRead | MTLTextureUsageShaderWrite;

  finalTex = mkTex(w, h, MTLPixelFormatBGRA8Unorm_sRGB, MTLTextureUsageRenderTarget | MTLTextureUsageShaderRead, MTLStorageModeShared);
  gDepth = mkTex(tw, th, MTLPixelFormatDepth32Float, MTLTextureUsageRenderTarget);
  for (int i = 0; i < 2; i++) {
    gPosId[i] = mkTex(tw, th, MTLPixelFormatRGBA32Float, gbufUsage);
    gNorm[i] = mkTex(tw, th, MTLPixelFormatRGBA16Float, gbufUsage);
    diffHist[i] = mkTex(tw, th, MTLPixelFormatRGBA16Float, rwUsage);
    specHist[i] = mkTex(tw, th, MTLPixelFormatRGBA16Float, rwUsage);
    moments[i] = mkTex(tw, th, MTLPixelFormatRGBA16Float, rwUsage);
    hLen[i] = mkTex(tw, th, MTLPixelFormatRG16Float, rwUsage);
    taa[i] = mkTex(w, h, MTLPixelFormatRGBA16Float, rwUsage);
  }
  gMat = mkTex(tw, th, MTLPixelFormatRGBA16Float, gbufUsage);
  gMotion = mkTex(tw, th, MTLPixelFormatRG16Float, gbufUsage);
  diTex = mkTex(tw, th, MTLPixelFormatRGBA16Float, rwUsage);
  giQuarter = mkTex((tw + 1) / 2, (th + 1) / 2, MTLPixelFormatRGBA16Float, rwUsage);
  diffRaw = mkTex(tw, th, MTLPixelFormatRGBA16Float, rwUsage);
  specRaw = mkTex(tw, th, MTLPixelFormatRGBA16Float, rwUsage);
  diffPing = mkTex(tw, th, MTLPixelFormatRGBA16Float, rwUsage);
  specPing = mkTex(tw, th, MTLPixelFormatRGBA16Float, rwUsage);
  diffPong = mkTex(tw, th, MTLPixelFormatRGBA16Float, rwUsage);
  colorTrace = mkTex(tw, th, MTLPixelFormatRGBA16Float, rwUsage);

  const NSUInteger tilesX = static_cast<NSUInteger>((tw + 7) / 8);
  const NSUInteger tilesY = static_cast<NSUInteger>((th + 7) / 8);
  const NSUInteger tileBytes = std::max<NSUInteger>(tilesX * tilesY * sizeof(uint32_t), 16);
  glassTiles = [dev newBufferWithLength:tileBytes options:MTLResourceStorageModePrivate];
  opaqueTiles = [dev newBufferWithLength:tileBytes options:MTLResourceStorageModePrivate];
  floorTiles = [dev newBufferWithLength:tileBytes options:MTLResourceStorageModePrivate];
  if (!tileIndirect) {
    const uint32_t initArgs[12] = {
        0u, 1u, 1u, 0u,
        0u, 1u, 1u, 0u,
        0u, 1u, 1u, 0u,
    };
    tileIndirectZero = [dev newBufferWithBytes:initArgs length:sizeof(initArgs) options:MTLResourceStorageModeShared];
    tileIndirect = [dev newBufferWithLength:sizeof(initArgs) options:MTLResourceStorageModePrivate];
  }
  if (!sharcAccum) {
    sharcAccum = [dev newBufferWithLength:kWrSharcCap * sizeof(WrSharcAccumGpu) options:MTLResourceStorageModePrivate];
    sharcResolved = [dev newBufferWithLength:kWrSharcCap * sizeof(WrSharcResolvedGpu) options:MTLResourceStorageModePrivate];
    id<MTLCommandBuffer> cmd = [device->queue commandBuffer];
    id<MTLBlitCommandEncoder> blit = [cmd blitCommandEncoder];
    [blit fillBuffer:sharcAccum range:NSMakeRange(0, sharcAccum.length) value:0];
    [blit fillBuffer:sharcResolved range:NSMakeRange(0, sharcResolved.length) value:0];
    [blit endEncoding];
    [cmd commit];
    [cmd waitUntilCompleted];
  }

  width = w;
  height = h;
  traceW = tw;
  traceH = th;
  hasHistory = false;
  stillFrames = 0;
}

FrameStats WorldRenderer::Impl::drawFrame(const Camera& cameraIn, const WorldFrameOptions& options, id<CAMetalDrawable> drawable) {
  FrameStats stats;
  const auto started = std::chrono::steady_clock::now();
  if (width < 1 || height < 1) return stats;

  // Choose internal trace resolution: 100% native 1:1 up to ~720p (<= 1.1M px), and Quality-mode
  // sub-pixel Halton TAAU (~1.25M trace px -> full display output) on 1080p / 2x Retina / 4K.
  double traceScale = 1.0;
  const double totalPx = static_cast<double>(width) * static_cast<double>(height);
  if (const char* envScale = std::getenv("BM_RTPT_SCALE")) {
    const double s = std::atof(envScale);
    if (s >= 0.4 && s <= 1.0) traceScale = s;
  } else if (totalPx > 1100000.0) {
    traceScale = std::clamp(std::sqrt(1250000.0 / totalPx), 0.55, 1.0);
  }
  int tw = width, th = height;
  if (traceScale < 0.995) {
    tw = std::clamp(static_cast<int>(std::lround(width * traceScale) + 1) & ~1, std::min(64, width), width);
    th = std::clamp(static_cast<int>(std::lround(height * traceScale) + 1) & ~1, std::min(64, height), height);
  }
  ensureTargets(width, height, tw, th);
  const bool taauActive = (traceW < width || traceH < height);

  id<MTLTexture> target = drawable ? drawable.texture : finalTex;
  if (!target) return stats;
  if (drawable && (static_cast<int>(target.width) != width || static_cast<int>(target.height) != height)) {
    return stats;
  }

  // Ensure standard right-handed +Y up even if caller constructed a default LDraw Camera.
  Camera camera = cameraIn;
  if (camera.up.y < 0.0 && std::abs(camera.up.x) < 1e-6 && std::abs(camera.up.z) < 1e-6) {
    camera.up = {0.0, 1.0, 0.0};
  }
  camera.aspect = static_cast<double>(width) / static_cast<double>(height);
  if (!bounds.empty()) {
    const double diag = std::max(1e-2, bm::length(bounds.max - bounds.min));
    const double eyeDist = bm::length((bounds.min + bounds.max) * 0.5 - camera.eye);
    if (camera.far < eyeDist + diag * 1.5) camera.far = std::max(camera.far, (eyeDist + diag) * 2.5);
    if (camera.near <= 0.0 || camera.near > diag * 0.05) camera.near = std::max(diag * 2e-4, 0.01);
  }

  const bool lookChanged = hasHistory && !sameOpt(options, lastOptions);
  const bool camSame = hasHistory && sameCam(camera, lastCamera);
  if (lookChanged) {
    hasHistory = false;
    stillFrames = 0;
  }
  stillFrames = (camSame && !lookChanged && hasHistory) ? (stillFrames + 1u) : 1u;
  lastCamera = camera;
  lastOptions = options;

  dispatch_semaphore_wait(inFlight, DISPATCH_TIME_FOREVER);

  // Halton(2, 3) subpixel jitter.
  const uint32_t jitterPeriod = taauActive ? 32u : 16u;
  const uint32_t jitterIdx = (frameIdx % jitterPeriod) + 1u;
  const float jx = (frameIdx == 0u && !hasHistory) ? 0.0f : (halton(jitterIdx, 2u) - 0.5f);
  const float jy = (frameIdx == 0u && !hasHistory) ? 0.0f : (halton(jitterIdx, 3u) - 0.5f);

  const Mat4 view = viewMatrix(camera, {0, 0, 0});
  const Mat4 proj = projectionMatrix(camera);
  Mat4 projJittered = proj;
  const float dxNdc = (2.0f * jx) / static_cast<float>(traceW);
  const float dyNdc = (-2.0f * jy) / static_cast<float>(traceH);
  if (camera.orthoHalfHeight > 0) {
    projJittered.m[12] += dxNdc;
    projJittered.m[13] += dyNdc;
  } else {
    projJittered.m[8] -= dxNdc;
    projJittered.m[9] -= dyNdc;
  }
  const simd_float4x4 vpUnjittered = simdMat(multiply(proj, view));
  const simd_float4x4 vpJittered = simdMat(multiply(projJittered, view));

  bm::Vec3 right, up, forward;
  camBasis(camera, right, up, forward);

  // Normalize sun direction.
  bm::Vec3 sunD{options.sunDir[0], options.sunDir[1], options.sunDir[2]};
  sunD = bm::length(sunD) > 1e-6 ? bm::normalized(sunD) : bm::Vec3{0.22, 0.82, 0.52};

  // Studio 4-softbox rig in +Y UP space (matching BrickMotion's crisp white-studio product look!).
  bm::Vec3 ahead = {forward.x, 0.0, forward.z};
  ahead = bm::length(ahead) > 1e-6 ? bm::normalized(ahead) : bm::Vec3{0, 0, -1};
  const bm::Vec3 upY{0, 1, 0};
  const bm::Vec3 rigRight = bm::normalized(bm::cross(ahead, upY));

  const double diag = bounds.empty() ? 10.0 : std::max(0.1, bm::length(bounds.max - bounds.min));
  const float sharcBase = std::max(0.015f, static_cast<float>(diag / 140.0));
  const double floorY = bounds.empty() ? 0.0 : (bounds.min.y - diag * 1e-4);

  const float sunCosR = options.studioRig
      ? static_cast<float>(std::sqrt(1.0 - kRigSinSquared))
      : std::cos(std::clamp(options.sunAngularRadius, 0.003f, 0.25f));
  const float sunSinSq = options.studioRig
      ? static_cast<float>(kRigSinSquared)
      : (1.0f - sunCosR * sunCosR);

  WrUniformsGpu u{};
  u.viewProjJittered = vpJittered;
  u.viewProjUnjittered = vpUnjittered;
  u.prevViewProj = hasHistory ? prevViewProj : vpUnjittered;
  u.eye = f4(camera.eye, std::tan(camera.fovY * 0.5));
  u.right = f4(right, camera.aspect);
  u.up = f4(up, camera.orthoHalfHeight);
  u.forward = f4(forward, camera.near);
  u.sun = f4(sunD, options.sunIntensity);
  u.sky = simd_make_float4(options.studioRig ? static_cast<float>(kWorldStrength) : options.skyIntensity,
                           sunCosR,
                           std::max(options.exposure, 0.05f),
                           sunSinSq);
  for (int i = 0; i < 4; i++) {
    const bm::Vec3 d = bm::normalized(rigRight * kRigToward[i][0] + ahead * kRigToward[i][1] + upY * kRigToward[i][2]);
    u.studioLights[i] = f4(d, kRigStrength[i] * (i == 0 ? 1.0f : kPathFillShare));
  }
  u.background = simd_make_float4(options.background[0], options.background[1], options.background[2], static_cast<float>(floorY));
  const bm::Vec3 sMin = bounds.empty() ? bm::Vec3{-1, -1, -1} : bounds.min;
  const bm::Vec3 sMax = bounds.empty() ? bm::Vec3{1, 1, 1} : bounds.max;
  u.sceneMin = f4(sMin, sharcBase);
  u.sceneMax = f4(sMax, lookChanged ? 0.35f : 0.96f);
  u.jitter = simd_make_float4(jx, jy, prevJitter[0], prevJitter[1]);
  u.size = simd_make_uint4(static_cast<uint32_t>(traceW), static_cast<uint32_t>(traceH), frameIdx, stillFrames);
  const uint32_t modeBits = (options.clay ? 1u : 0u) | (options.studioRig ? 2u : 0u) |
                            (options.floor ? 4u : 0u) | (hasHdr ? 8u : 0u);
  u.flags = simd_make_uint4(tlas != nil ? 1u : 0u, hasHistory ? 1u : 0u, hasAlphaMask ? 1u : 0u, modeBits);
  u.params = simd_make_uint4(static_cast<uint32_t>(std::max(1, options.maxSamples)), 1u, static_cast<uint32_t>(hostInstances.size()), 0u);
  u.outSize = simd_make_uint4(static_cast<uint32_t>(width), static_cast<uint32_t>(height), taauActive ? 1u : 0u, 0u);

  const int cur = static_cast<int>(frameIdx & 1u);
  const int prev = cur ^ 1;
  const MTLSize tg = MTLSizeMake(8, 8, 1);

  id<MTLCommandBuffer> cmd = [device->queue commandBuffer];
  const bool profile = std::getenv("BM_RTPT_PROFILE") != nullptr;
  auto submitStage = [&](const char* label) {
    if (!profile) return;
    [cmd commit];
    [cmd waitUntilCompleted];
    const double ms = (cmd.GPUEndTime - cmd.GPUStartTime) * 1000.0;
    if (frameIdx == 15u) std::fprintf(stderr, "world-rtpt-prof %-18s %6.2f ms\n", label, ms);
    cmd = [device->queue commandBuffer];
  };

  // Reset indirect tile counters (and SHaRC cache on look switches).
  {
    id<MTLBlitCommandEncoder> blit = [cmd blitCommandEncoder];
    [blit copyFromBuffer:tileIndirectZero sourceOffset:0 toBuffer:tileIndirect destinationOffset:0 size:48];
    if (lookChanged) {
      [blit fillBuffer:sharcAccum range:NSMakeRange(0, sharcAccum.length) value:0];
      [blit fillBuffer:sharcResolved range:NSMakeRange(0, sharcResolved.length) value:0];
    }
    [blit endEncoding];
  }

  // PASS 1: 32-byte/px Bindless PBR G-Buffer + Alpha-Cutout + Glass + Optional Studio Floor.
  {
    MTLRenderPassDescriptor* rp = [MTLRenderPassDescriptor renderPassDescriptor];
    id<MTLTexture> cols[4] = {gPosId[cur], gNorm[cur], gMat, gMotion};
    for (int i = 0; i < 4; i++) {
      rp.colorAttachments[i].texture = cols[i];
      rp.colorAttachments[i].loadAction = MTLLoadActionClear;
      rp.colorAttachments[i].clearColor = MTLClearColorMake(0, 0, 0, 0);
      rp.colorAttachments[i].storeAction = MTLStoreActionStore;
    }
    rp.depthAttachment.texture = gDepth;
    rp.depthAttachment.loadAction = MTLLoadActionClear;
    rp.depthAttachment.clearDepth = 0.0;
    rp.depthAttachment.storeAction = MTLStoreActionDontCare;

    id<MTLRenderCommandEncoder> re = [cmd renderCommandEncoderWithDescriptor:rp];
    [re setDepthStencilState:depthWrite];
    [re setCullMode:MTLCullModeNone];
    [re setVertexBytes:&u length:sizeof(u) atIndex:1];
    [re setFragmentBytes:&u length:sizeof(u) atIndex:1];
    [re setFragmentBuffer:materialTable offset:0 atIndex:2];
    if (!bindlessTextures.empty()) {
      [re useResources:reinterpret_cast<id<MTLResource> const*>(bindlessTextures.data())
                 count:bindlessTextures.size()
                 usage:MTLResourceUsageRead
                stages:MTLRenderStageFragment];
    }

    // 1a. Opaque + Alpha-Cutout meshes
    [re setRenderPipelineState:gbufOpaque];
    for (size_t i = 0; i < hostInstances.size(); i++) {
      if (instanceIsGlass[i] && !options.clay) continue;
      const WrGpuMesh& gm = meshes[hostInstances[i].meshIndex];
      [re setVertexBuffer:gm.vertices offset:0 atIndex:0];
      [re setVertexBuffer:instanceTable offset:i * sizeof(WrInstanceGpuHost) atIndex:2];
      [re drawIndexedPrimitives:MTLPrimitiveTypeTriangle indexCount:gm.indexCount indexType:MTLIndexTypeUInt32 indexBuffer:gm.indices indexBufferOffset:0];
      stats.drawCalls++;
      stats.instances++;
      stats.triangles += gm.indexCount / 3;
    }

    // 1b. Refractive/Volumetric Glass meshes
    if (hasGlass && !options.clay) {
      [re setRenderPipelineState:gbufGlass];
      for (size_t i = 0; i < hostInstances.size(); i++) {
        if (!instanceIsGlass[i]) continue;
        const WrGpuMesh& gm = meshes[hostInstances[i].meshIndex];
        [re setVertexBuffer:gm.vertices offset:0 atIndex:0];
        [re setVertexBuffer:instanceTable offset:i * sizeof(WrInstanceGpuHost) atIndex:2];
        [re drawIndexedPrimitives:MTLPrimitiveTypeTriangle indexCount:gm.indexCount indexType:MTLIndexTypeUInt32 indexBuffer:gm.indices indexBufferOffset:0];
        stats.drawCalls++;
        stats.instances++;
        stats.triangles += gm.indexCount / 3;
      }
    }

    // 1c. Optional Studio Shadow-Catcher Floor
    if (options.floor) {
      [re setRenderPipelineState:gbufFloor];
      [re drawPrimitives:MTLPrimitiveTypeTriangle vertexStart:0 vertexCount:6];
    }
    [re endEncoding];
  }
  submitStage("1. G-Buffer");

  // PASS 2: SHaRC World-Space Radiance Cache Resolve
  {
    id<MTLComputeCommandEncoder> ce = [cmd computeCommandEncoder];
    [ce setComputePipelineState:sharcResolve];
    [ce setBytes:&u length:sizeof(u) atIndex:0];
    [ce setBuffer:sharcAccum offset:0 atIndex:1];
    [ce setBuffer:sharcResolved offset:0 atIndex:2];
    [ce dispatchThreads:MTLSizeMake(kWrSharcCap, 1, 1) threadsPerThreadgroup:MTLSizeMake(256, 1, 1)];
    [ce endEncoding];
  }
  submitStage("2. SHaRC");

  const MTLSize tileGroups = MTLSizeMake(static_cast<NSUInteger>((traceW + 7) / 8),
                                         static_cast<NSUInteger>((traceH + 7) / 8), 1);

  auto bindRayResources = [&](id<MTLComputeCommandEncoder> ce) {
    if (!allRayResources.empty()) {
      [ce useResources:allRayResources.data() count:allRayResources.size() usage:MTLResourceUsageRead];
    }
  };

  // PASS 3: Adaptive Control-Variate Direct Sun / Studio Lighting + 8x8 Tile Compaction
  {
    id<MTLComputeCommandEncoder> ce = [cmd computeCommandEncoder];
    [ce setComputePipelineState:directPass];
    [ce setBytes:&u length:sizeof(u) atIndex:0];
    [ce setAccelerationStructure:tlas atBufferIndex:1];
    [ce setBuffer:rtInstanceTable offset:0 atIndex:2];
    [ce setBuffer:meshTable offset:0 atIndex:3];
    [ce setBuffer:materialTable offset:0 atIndex:4];
    [ce setBuffer:tileIndirect offset:0 atIndex:5];
    [ce setBuffer:glassTiles offset:0 atIndex:6];
    [ce setBuffer:opaqueTiles offset:0 atIndex:7];
    [ce setBuffer:floorTiles offset:0 atIndex:8];
    [ce setBuffer:rtGeomMeshes offset:0 atIndex:9];
    [ce setTexture:gPosId[cur] atIndex:0];
    [ce setTexture:gNorm[cur] atIndex:1];
    [ce setTexture:gMotion atIndex:2];
    [ce setTexture:gPosId[prev] atIndex:3];
    [ce setTexture:gNorm[prev] atIndex:4];
    [ce setTexture:diffHist[prev] atIndex:5];
    [ce setTexture:diTex atIndex:6];
    bindRayResources(ce);
    [ce dispatchThreadgroups:tileGroups threadsPerThreadgroup:tg];
    [ce endEncoding];
  }
  submitStage("3. Direct+Tiles");

  // PASS 4a: Indirect Tile-Compacted Floor Shadow Catcher
  if (options.floor) {
    id<MTLComputeCommandEncoder> ce = [cmd computeCommandEncoder];
    [ce setComputePipelineState:traceFloor];
    [ce setBytes:&u length:sizeof(u) atIndex:0];
    [ce setAccelerationStructure:tlas atBufferIndex:1];
    [ce setBuffer:rtInstanceTable offset:0 atIndex:2];
    [ce setBuffer:meshTable offset:0 atIndex:3];
    [ce setBuffer:materialTable offset:0 atIndex:4];
    [ce setBuffer:floorTiles offset:0 atIndex:5];
    [ce setBuffer:rtGeomMeshes offset:0 atIndex:6];
    [ce setTexture:gPosId[cur] atIndex:0];
    [ce setTexture:gMotion atIndex:1];
    [ce setTexture:gPosId[prev] atIndex:2];
    [ce setTexture:diffHist[prev] atIndex:3];
    [ce setTexture:diffRaw atIndex:4];
    bindRayResources(ce);
    [ce dispatchThreadgroupsWithIndirectBuffer:tileIndirect indirectBufferOffset:32 threadsPerThreadgroup:tg];
    [ce endEncoding];
  }
  submitStage("4a. Floor");

  // PASS 4b-1: 100%-SIMD-Dense Half-Res Rotating 2x2 Diffuse GI + SHaRC Radiance Cache
  {
    id<MTLComputeCommandEncoder> ce = [cmd computeCommandEncoder];
    [ce setComputePipelineState:traceGiQuarter];
    [ce setBytes:&u length:sizeof(u) atIndex:0];
    [ce setAccelerationStructure:tlas atBufferIndex:1];
    [ce setBuffer:rtInstanceTable offset:0 atIndex:2];
    [ce setBuffer:meshTable offset:0 atIndex:3];
    [ce setBuffer:materialTable offset:0 atIndex:4];
    [ce setBuffer:sharcResolved offset:0 atIndex:5];
    [ce setBuffer:sharcAccum offset:0 atIndex:6];
    [ce setBuffer:rtGeomMeshes offset:0 atIndex:7];
    [ce setTexture:gPosId[cur] atIndex:0];
    [ce setTexture:gNorm[cur] atIndex:1];
    [ce setTexture:diTex atIndex:2];
    [ce setTexture:envTex atIndex:3];
    [ce setTexture:giQuarter atIndex:4];
    bindRayResources(ce);
    [ce dispatchThreads:MTLSizeMake(static_cast<NSUInteger>((traceW + 1) / 2),
                                    static_cast<NSUInteger>((traceH + 1) / 2), 1)
        threadsPerThreadgroup:tg];
    [ce endEncoding];
  }
  submitStage("4b1. GIQuarter");

  // PASS 4b-2: Bilateral GI Upsample + Crisp Direct Light + Full-Res Glossy/Clearcoat Specular
  {
    id<MTLComputeCommandEncoder> ce = [cmd computeCommandEncoder];
    [ce setComputePipelineState:traceOpaque];
    [ce setBytes:&u length:sizeof(u) atIndex:0];
    [ce setAccelerationStructure:tlas atBufferIndex:1];
    [ce setBuffer:rtInstanceTable offset:0 atIndex:2];
    [ce setBuffer:meshTable offset:0 atIndex:3];
    [ce setBuffer:materialTable offset:0 atIndex:4];
    [ce setBuffer:sharcResolved offset:0 atIndex:5];
    [ce setBuffer:sharcAccum offset:0 atIndex:6];
    [ce setBuffer:opaqueTiles offset:0 atIndex:7];
    [ce setBuffer:rtGeomMeshes offset:0 atIndex:8];
    [ce setTexture:gPosId[cur] atIndex:0];
    [ce setTexture:gNorm[cur] atIndex:1];
    [ce setTexture:gMat atIndex:2];
    [ce setTexture:diTex atIndex:3];
    [ce setTexture:envTex atIndex:4];
    [ce setTexture:diffRaw atIndex:5];
    [ce setTexture:specRaw atIndex:6];
    [ce setTexture:giQuarter atIndex:7];
    bindRayResources(ce);
    [ce dispatchThreadgroupsWithIndirectBuffer:tileIndirect indirectBufferOffset:16 threadsPerThreadgroup:tg];
    [ce endEncoding];
  }
  submitStage("4b2. OpaqueSpec");

  // PASS 4c: Indirect Tile-Compacted 16-Bounce Beer-Lambert Volume Glass
  if (hasGlass && !options.clay) {
    id<MTLComputeCommandEncoder> ce = [cmd computeCommandEncoder];
    [ce setComputePipelineState:traceGlass];
    [ce setBytes:&u length:sizeof(u) atIndex:0];
    [ce setAccelerationStructure:tlas atBufferIndex:1];
    [ce setBuffer:rtInstanceTable offset:0 atIndex:2];
    [ce setBuffer:meshTable offset:0 atIndex:3];
    [ce setBuffer:materialTable offset:0 atIndex:4];
    [ce setBuffer:sharcResolved offset:0 atIndex:5];
    [ce setBuffer:sharcAccum offset:0 atIndex:6];
    [ce setBuffer:glassTiles offset:0 atIndex:7];
    [ce setBuffer:rtGeomMeshes offset:0 atIndex:8];
    [ce setTexture:gPosId[cur] atIndex:0];
    [ce setTexture:gNorm[cur] atIndex:1];
    [ce setTexture:envTex atIndex:2];
    [ce setTexture:specRaw atIndex:3];
    bindRayResources(ce);
    [ce dispatchThreadgroupsWithIndirectBuffer:tileIndirect indirectBufferOffset:0 threadsPerThreadgroup:tg];
    [ce endEncoding];
  }
  submitStage("4c. Glass");

  // PASS 5a: SVGF Temporal Accumulation
  {
    id<MTLComputeCommandEncoder> ce = [cmd computeCommandEncoder];
    [ce setComputePipelineState:svgfTemporal];
    [ce setBytes:&u length:sizeof(u) atIndex:0];
    [ce setTexture:gPosId[cur] atIndex:0];
    [ce setTexture:gNorm[cur] atIndex:1];
    [ce setTexture:gMotion atIndex:2];
    [ce setTexture:gPosId[prev] atIndex:3];
    [ce setTexture:gNorm[prev] atIndex:4];
    [ce setTexture:diffRaw atIndex:5];
    [ce setTexture:specRaw atIndex:6];
    [ce setTexture:diffHist[prev] atIndex:7];
    [ce setTexture:specHist[prev] atIndex:8];
    [ce setTexture:moments[prev] atIndex:9];
    [ce setTexture:hLen[prev] atIndex:10];
    [ce setTexture:diffHist[cur] atIndex:11];
    [ce setTexture:specHist[cur] atIndex:12];
    [ce setTexture:moments[cur] atIndex:13];
    [ce setTexture:hLen[cur] atIndex:14];
    [ce dispatchThreads:MTLSizeMake(static_cast<NSUInteger>(traceW), static_cast<NSUInteger>(traceH), 1) threadsPerThreadgroup:tg];
    [ce endEncoding];
  }
  submitStage("5a. Temporal");

  // PASS 5b/5c/5d: SVGF 5-Tap A-Trous Spatial Filter
  {
    id<MTLComputeCommandEncoder> ce = [cmd computeCommandEncoder];
    [ce setComputePipelineState:svgfAtrous];
    [ce setBytes:&u length:sizeof(u) atIndex:0];
    [ce setTexture:gPosId[cur] atIndex:0];
    [ce setTexture:gNorm[cur] atIndex:1];
    [ce setTexture:gMat atIndex:2];
    [ce setTexture:diffHist[cur] atIndex:3];
    [ce setTexture:specHist[cur] atIndex:4];
    [ce setTexture:moments[cur] atIndex:5];
    [ce setTexture:hLen[cur] atIndex:6];
    [ce setTexture:diffPing atIndex:7];
    [ce setTexture:specPing atIndex:8];
    [ce dispatchThreads:MTLSizeMake(static_cast<NSUInteger>(traceW), static_cast<NSUInteger>(traceH), 1) threadsPerThreadgroup:tg];
    [ce endEncoding];

    // Step 2 (cross) -> diffPong, Step 4 (diag) -> diffPing
    const uint32_t steps[2] = {2u, 4u};
    id<MTLTexture> inT[2] = {diffPing, diffPong};
    id<MTLTexture> outT[2] = {diffPong, diffPing};
    for (int p = 0; p < 2; p++) {
      WrUniformsGpu upass = u;
      upass.params.y = steps[p] | (static_cast<uint32_t>(p) << 16u);
      id<MTLComputeCommandEncoder> de = [cmd computeCommandEncoder];
      [de setComputePipelineState:svgfAtrousDiff];
      [de setBytes:&upass length:sizeof(upass) atIndex:0];
      [de setTexture:gPosId[cur] atIndex:0];
      [de setTexture:gNorm[cur] atIndex:1];
      [de setTexture:inT[p] atIndex:2];
      [de setTexture:moments[cur] atIndex:3];
      [de setTexture:hLen[cur] atIndex:4];
      [de setTexture:outT[p] atIndex:5];
      [de dispatchThreads:MTLSizeMake(static_cast<NSUInteger>(traceW), static_cast<NSUInteger>(traceH), 1) threadsPerThreadgroup:tg];
      [de endEncoding];
    }
  }
  submitStage("5b. Atrous");

  // PASS 6a: Re-Modulate Trace Color
  {
    id<MTLComputeCommandEncoder> ce = [cmd computeCommandEncoder];
    [ce setComputePipelineState:reModulate];
    [ce setBytes:&u length:sizeof(u) atIndex:0];
    [ce setTexture:gPosId[cur] atIndex:0];
    [ce setTexture:gNorm[cur] atIndex:1];
    [ce setTexture:gMat atIndex:2];
    [ce setTexture:diffPing atIndex:3];
    [ce setTexture:specPing atIndex:4];
    [ce setTexture:envTex atIndex:5];
    [ce setTexture:colorTrace atIndex:6];
    [ce dispatchThreads:MTLSizeMake(static_cast<NSUInteger>(traceW), static_cast<NSUInteger>(traceH), 1) threadsPerThreadgroup:tg];
    [ce endEncoding];
  }

  // PASS 6b: Direct-Hit Sub-Pixel Halton TAAU Resolve
  {
    id<MTLComputeCommandEncoder> ce = [cmd computeCommandEncoder];
    [ce setComputePipelineState:resolveTaau];
    [ce setBytes:&u length:sizeof(u) atIndex:0];
    [ce setTexture:colorTrace atIndex:0];
    [ce setTexture:gMotion atIndex:1];
    [ce setTexture:taa[prev] atIndex:2];
    [ce setTexture:taa[cur] atIndex:3];
    [ce dispatchThreads:MTLSizeMake(static_cast<NSUInteger>(width), static_cast<NSUInteger>(height), 1) threadsPerThreadgroup:tg];
    [ce endEncoding];
  }
  submitStage("6a. TAAU");

  // PASS 6c: ACES Filmic Tone Mapping & Present
  {
    MTLRenderPassDescriptor* rp = [MTLRenderPassDescriptor renderPassDescriptor];
    rp.colorAttachments[0].texture = target;
    rp.colorAttachments[0].loadAction = MTLLoadActionDontCare;
    rp.colorAttachments[0].storeAction = MTLStoreActionStore;
    id<MTLRenderCommandEncoder> re = [cmd renderCommandEncoderWithDescriptor:rp];
    [re setRenderPipelineState:present];
    [re setDepthStencilState:depthNone];
    [re setFragmentBytes:&u length:sizeof(u) atIndex:0];
    [re setFragmentTexture:taa[cur] atIndex:0];
    [re drawPrimitives:MTLPrimitiveTypeTriangle vertexStart:0 vertexCount:3];
    [re endEncoding];
  }

  if (drawable) [cmd presentDrawable:drawable];
  dispatch_semaphore_t sem = inFlight;
  std::atomic<double>* msOut = &gpuMs;
  [cmd addCompletedHandler:^(id<MTLCommandBuffer> done) {
    if (done.GPUEndTime > done.GPUStartTime) {
      msOut->store((done.GPUEndTime - done.GPUStartTime) * 1000.0, std::memory_order_relaxed);
    }
    dispatch_semaphore_signal(sem);
  }];
  [cmd commit];
  if (!drawable) {
    [cmd waitUntilCompleted];
    stats.gpuMs = (cmd.GPUEndTime > cmd.GPUStartTime) ? (cmd.GPUEndTime - cmd.GPUStartTime) * 1000.0 : gpuMs.load(std::memory_order_relaxed);
    drewOffscreen = true;
  } else {
    stats.gpuMs = gpuMs.load(std::memory_order_relaxed);
    drewOffscreen = false;
  }

  prevViewProj = vpUnjittered;
  prevJitter[0] = jx;
  prevJitter[1] = jy;
  hasHistory = true;
  frameIdx++;

  stats.cpuMs = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - started).count();
  stats.submitted = true;
  stats.pathSamples = stillFrames;
  stats.settling = (stillFrames < static_cast<uint32_t>(std::max(1, options.maxSamples)));
  return stats;
}

// ---- Public WorldRenderer API ----

WorldRenderer::WorldRenderer(std::unique_ptr<Impl> impl) : impl_(std::move(impl)) {}

WorldRenderer::~WorldRenderer() {
  if (impl_ && impl_->inFlight) {
    for (int i = 0; i < 3; i++) dispatch_semaphore_wait(impl_->inFlight, DISPATCH_TIME_FOREVER);
    for (int i = 0; i < 3; i++) dispatch_semaphore_signal(impl_->inFlight);
  }
}

std::unique_ptr<WorldRenderer> WorldRenderer::create(const WorldAsset& asset, std::string* error) {
  auto fail = [&](const std::string& msg) {
    if (error) *error = msg;
    return std::unique_ptr<WorldRenderer>();
  };
  Device* dev = sharedDevice();
  if (!dev) return fail("no Metal device or shaders failed to compile");
  @autoreleasepool {
    auto impl = std::make_unique<Impl>();
    impl->device = dev;
    impl->inFlight = dispatch_semaphore_create(3);
    std::string err;
    if (!impl->buildPipelines(err)) return fail(err);
    if (!impl->uploadScene(asset, err)) return fail(err);
    return std::unique_ptr<WorldRenderer>(new WorldRenderer(std::move(impl)));
  }
}

bool WorldRenderer::loadEnvironmentHdr(const std::filesystem::path& hdrPath) {
  int w = 0, h = 0;
  std::vector<uint16_t> rgba16;
  if (!decodeRadianceHdr(hdrPath, w, h, rgba16)) return false;
  @autoreleasepool {
    id<MTLDevice> dev = impl_->device->device;
    MTLTextureDescriptor* d = [MTLTextureDescriptor texture2DDescriptorWithPixelFormat:MTLPixelFormatRGBA16Float
                                                                                 width:static_cast<NSUInteger>(w)
                                                                                height:static_cast<NSUInteger>(h)
                                                                             mipmapped:NO];
    d.usage = MTLTextureUsageShaderRead;
    d.storageMode = MTLStorageModePrivate;
    id<MTLTexture> tex = [dev newTextureWithDescriptor:d];
    if (!tex) return false;
    id<MTLBuffer> staging = [dev newBufferWithBytes:rgba16.data() length:rgba16.size() * sizeof(uint16_t) options:MTLResourceStorageModeShared];
    id<MTLCommandBuffer> cmd = [impl_->device->queue commandBuffer];
    id<MTLBlitCommandEncoder> blit = [cmd blitCommandEncoder];
    [blit copyFromBuffer:staging
               sourceOffset:0
          sourceBytesPerRow:static_cast<NSUInteger>(w) * 8u
        sourceBytesPerImage:static_cast<NSUInteger>(w) * static_cast<NSUInteger>(h) * 8u
                 sourceSize:MTLSizeMake(static_cast<NSUInteger>(w), static_cast<NSUInteger>(h), 1)
                  toTexture:tex
           destinationSlice:0
           destinationLevel:0
          destinationOrigin:MTLOriginMake(0, 0, 0)];
    [blit endEncoding];
    [cmd commit];
    [cmd waitUntilCompleted];
    impl_->envTex = tex;
    impl_->hasHdr = true;
    impl_->hasHistory = false;
    impl_->stillFrames = 0;
  }
  return true;
}

void WorldRenderer::resize(int width, int height) {
  constexpr int kMax = 16384;
  width = std::clamp(width, 1, kMax);
  height = std::clamp(height, 1, kMax);
  if (width == impl_->width && height == impl_->height) return;
  impl_->width = width;
  impl_->height = height;
  impl_->drewOffscreen = false;
  impl_->hasHistory = false;
  impl_->stillFrames = 0;
}

FrameStats WorldRenderer::draw(const Camera& camera, const WorldFrameOptions& options, void* drawable) {
  @autoreleasepool {
    return impl_->drawFrame(camera, options, (__bridge id<CAMetalDrawable>)drawable);
  }
}

Image WorldRenderer::readback() {
  Image out;
  Impl& impl = *impl_;
  if (!impl.drewOffscreen || !impl.finalTex || impl.width < 1 || impl.height < 1) return out;
  out.width = impl.width;
  out.height = impl.height;
  out.rgba.resize(static_cast<size_t>(impl.width) * static_cast<size_t>(impl.height) * 4u);
  [impl.finalTex getBytes:out.rgba.data()
              bytesPerRow:static_cast<NSUInteger>(impl.width) * 4u
               fromRegion:MTLRegionMake2D(0, 0, static_cast<NSUInteger>(impl.width), static_cast<NSUInteger>(impl.height))
              mipmapLevel:0];
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
  for (size_t i = 0; i < out.rgba.size(); i += 4) std::swap(out.rgba[i], out.rgba[i + 2]);
#endif
  return out;
}

double WorldRenderer::lastGpuMs() const { return impl_->gpuMs.load(std::memory_order_relaxed); }
const bm::Box& WorldRenderer::bounds() const { return impl_->bounds; }
uint64_t WorldRenderer::triangleCount() const { return impl_->totalTriangles; }
uint32_t WorldRenderer::meshCount() const { return impl_->numMeshes; }
uint32_t WorldRenderer::textureCount() const { return impl_->numTextures; }
void WorldRenderer::resetHistory() {
  impl_->hasHistory = false;
  impl_->stillFrames = 0;
}

}  // namespace bmr
