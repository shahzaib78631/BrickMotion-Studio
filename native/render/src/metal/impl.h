// Private to bmrender's Metal half: everything the renderer owns on the GPU.
#pragma once
#import <Metal/Metal.h>
#import <QuartzCore/QuartzCore.h>
#include <array>
#include <atomic>
#include <cmath>
#include <future>
#include <map>
#include <simd/simd.h>
#include <string>
#include <vector>
#include "bmr/cull.h"
#include "bmr/path_scene.h"
#include "bmr/render_mesh.h"
#include "bmr/renderer.h"
#include "bmr/world_gi.h"
#include "metal/device.h"
#include "metal/neural_weights.h"

namespace bmr {

// Must match FrameUniforms in shaders/common.metal field for field.
struct FrameUniforms {
  simd_float4x4 viewProj;
  simd_float4x4 shadowProj;
  simd_float4 eye;
  simd_float4 background;
  simd_float4 viewport;
  simd_float4 switches;
  simd_float4 floorPlane;
  simd_float4 floorCentre;
  simd_float4 lens;
  simd_float4 selection;
  simd_float4 lights[4];  // xyz toward each light (world), w its strength
  simd_float4 rig;        // x world strength, y sin^2 of the lights' radius
  simd_float4x4 heightProj;  // world to the height map (xy, as shadowProj)
  simd_float4 floorLook;     // x: nearest, y: furthest a floor point looks (LDU); z: 1 when the floor's light is worked out; w: the power the sky's share is raised to
  simd_float4 glass;         // x: kGlassAbsorption, y: kFloorThroughGlass, z: kGlassIor
  simd_float4 grid;          // x: spacing, y/z: model origin modulo spacing
  simd_float4 floorCasters;  // min x/z, max x/z of the geometry in the height map
  simd_float4 neuralGlass0;  // neural dielectric glass & floor transport params 0
  simd_float4 neuralGlass1;  // neural dielectric glass & micro-geometry params 1
  simd_float4 plastic;       // x: matched plastic BRDF, y: fill share (0.85), z: mask mode, w: world GI active
};

struct WorldGiUniforms {
  simd_float4 originStep;
  simd_float4 shapeGain;
};
static_assert(sizeof(WorldGiUniforms) == 32);

// How much of each light (index) the floor sees through each of 48 azimuths (each the middle
// of a 30-degree sector, as the floor's 12 directions, turned by quarters, are) and 16
// elevation bins (floor_light.metal); must match FloorBins there.
struct FloorBins {
  uint16_t weights[4][48][5];  // bit planes for the five bits in each bin's weight (0 to 16)
  uint32_t total[4][4];  // each light's weight over the 12 sectors for each sampling rotation
  simd_float4 lit;  // each light's light on a bare white floor (E diskLight / pi)
  simd_float4 rays[48];  // floor direction in x/z and the reciprocals for clipping
};

// Must match DrawUniforms in shaders/common.metal.
struct DrawUniforms {
  simd_float4 base;
  simd_float4 surface;
  simd_float4 edge;
  simd_float4 flip;
  simd_float4 sphere;
};

/// A part's mesh at one level of detail, on the GPU.
struct GpuMesh {
  id<MTLBuffer> vertices = nil, indices = nil, edges = nil;
  uint32_t indexCount = 0, edgeVertices = 0;
  uint32_t topIndexCount = 0;  // the first of the indices: all but the underside (RenderMesh::topIndices)
};

/// A buffer rewritten every frame. Three copies are kept and used in turn, so the GPU can
/// still be reading the one before last while the next is written.
struct FrameBuffer {
  id<MTLBuffer> copies[3] = {nil, nil, nil};
  /// The copy for frame `frame`, at least `bytes` long (grown, never shrunk).
  id<MTLBuffer> get(id<MTLDevice> device, uint64_t frame, size_t bytes);
};

/// The main pass's targets: lit colour (premultiplied, coverage in alpha), then the two
/// transparency sums. Every pipeline drawn in that pass declares all three. The sums are
/// 32-bit while each layer is rounded to 16 (shaders/brick.metal): a sum of a few such
/// numbers is exact, so it does not depend on the order the layers come in.
/// The fourth holds, per pixel, the share of an opaque surface's light that came from the
/// surroundings (r: ambient occlusion dims only that), how much the floor's light counts there
/// (g), the share the key light's shadow dims (b), and how much of the pixel is floor (a).
inline constexpr MTLPixelFormat kColorFormat = MTLPixelFormatRGBA16Float, kAccumFormat = MTLPixelFormatRGBA32Float, kRevealFormat = MTLPixelFormatRGBA32Float,
                                kAmbientFormat = MTLPixelFormatRGBA16Float;

/// A map drawn from what casts (every opaque piece shown, in view or not): the key light's depth
/// map, or the height map over the model. It is kept from frame to frame, and is stale once a
/// piece has moved, appeared or gone since it was begun, or (the key's) the light has turned.
/// A stale map is drawn again whole, at once; or, with FrameOptions::mapTrianglesPerFrame, a
/// share of the groups a frame into `back` while `front` is still shown, what has moved since
/// `front` was begun being drawn each frame over a copy of it (`live`). A light that turned
/// further than kMapTurnLimit, or a detail changed, has it drawn whole at once.
struct CasterMap {
  struct Side {
    id<MTLTexture> texture = nil;
    Mat4 matrix;          // world (less the scene's origin) to the map
    bm::Box bounds;       // the casters when this map was started, in model space
    double texel = 1;     // LDU per texel
    bm::Vec3 toward;      // toward the light it is seen from
    int detail = -1;      // the detail its casters are drawn at; -1: not drawn
    uint64_t cutoff = 0;  // it holds the pieces shown whose Impl::changedAt is before this frame
  };
  Side front, back;
  id<MTLTexture> live = nil;
  bool building = false;       // back is being drawn
  std::vector<uint32_t> ends;  // back's shares: each the group after its last
  size_t done = 0;             // how many shares of back are drawn
};

struct Pipelines {
  id<MTLRenderPipelineState> height = nil, brick = nil, glass = nil, glassDepth = nil, glassPreview = nil, transparent = nil, floor = nil, edges = nil, shadow = nil, composite = nil, mask = nil, ids = nil, ao = nil, aoBlur = nil, sspt = nil, ssptBlur = nil, rmidtFront = nil, rmidtBack = nil, rmidtResolve = nil, pathResolve = nil, lens = nil;
  id<MTLRenderPipelineState> rtptGbufOpaque = nil, rtptGbufGlass = nil, rtptGbufFloor = nil, rtptPresent = nil;
  id<MTLComputePipelineState> pathTrace = nil, hybridRtGlass = nil, hybridRtGiRefl = nil, hybridRtTemporal = nil, neuralFeatures = nil, neuralInfer = nil;
  id<MTLComputePipelineState> rtptSharcResolve = nil, rtptDirectPass = nil, rtptTraceFloor = nil, rtptTraceGiQuarter = nil, rtptUpsampleGi = nil, rtptTraceSpec = nil, rtptTraceGlass = nil, rtptSvgfTemporal = nil, rtptSvgfAtrous = nil, rtptSvgfAtrousDiff = nil, rtptResolveTaa = nil, rtptReModulateTrace = nil, rtptResolveTaau = nil;
  id<MTLDepthStencilState> depthWrite = nil, depthWriteLess = nil, depthRead = nil, depthNone = nil, shadowDepth = nil;
  id<MTLSamplerState> smooth = nil, shadowSampler = nil;
  bool ok = false;
};
/// Builds every pipeline. `error` receives the first failure's text.
Pipelines makePipelines(Device& device, std::string& error);

struct Renderer::Impl {
  Device* device = nullptr;
  const bm::Model* model = nullptr;
  bm::ldraw::PartCache* full = nullptr;
  bm::ldraw::PartCache* low = nullptr;
  std::unique_ptr<MeshLibrary> meshes;
  Rounding rounding;
  Scene scene;
  Pipelines pipelines;

  struct PlacementPreview {
    Group group;
    bm::Xform pose;
    bool refused = false;
  };
  std::vector<PlacementPreview> preview;
  void drawPreview(id<MTLRenderCommandEncoder> encoder, const PlacementPreview& placing, FrameStats& stats);

  // Per group: its instances on the GPU, three copies used in turn as frames are, so that a
  // change is never written into a copy the GPU may still be reading. A change is queued for
  // each copy and written into it when its turn comes.
  std::vector<std::array<id<MTLBuffer>, 3>> instanceBuffers;
  std::vector<std::pair<uint32_t, uint32_t>> pending[3];
  bm::Box liveBounds;  // world space: where the shown pieces are now (the shadow is fitted to it)
  void updateLiveBounds();
  /// The groups changed (a recolour, a rebuild): every per-group array follows the scene again,
  /// and what was kept of the last frames (maps, picking, glass) is drawn again.
  void groupsChanged(bool castersChanged = true);
  /// Parts, instance buffers and change frames for every group, from the scene.
  void makeGroups(uint64_t madeAt);
  std::vector<PartShape> parts;  // per group: its part's bounds at full detail, and its low-detail error
  std::map<std::pair<std::string, int>, GpuMesh> gpuMeshes;  // (part, detail); a placeholder's part is ""
  const GpuMesh& mesh(const Group& group, Detail detail);
  void upload(const std::vector<std::pair<uint32_t, uint32_t>>& changed, bool moved = true);  // queues them for every copy
  void flush(int slot);                                                       // writes the copy's queue

  // Targets, remade when the size changes.
  int width = 0, height = 0;
  id<MTLTexture> colorMs = nil, depthMs = nil, accumMs = nil, revealMs = nil, ambientMs = nil, color = nil, accum = nil, reveal = nil, ambient = nil, depth = nil, final = nil,
                placeholderShadow = nil;
  id<MTLTexture> lensSource = nil;  // the finished picture before the lens blur; made when first needed
  id<MTLTexture> aoRaw = nil, aoSoft = nil;  // ambient occlusion, half size
  id<MTLTexture> giRaw = nil, giSoft = nil, ssrRaw = nil, ssrSoft = nil;  // screen-space GI + glossy SSR, half size
  int screenDiv = 2;  // ambient occlusion / GI / SSR grid divisor (2: half, 4: quarter)
  id<MTLTexture> giHist[2] = {nil, nil}, ssrHist[2] = {nil, nil}, rtDepthHist[2] = {nil, nil};  // hybrid RT temporal history, half size
  simd_float4x4 hybridPrevViewProj = matrix_identity_float4x4;
  bool hybridHasHistory = false;
  float hybridBg[3] = {1, 1, 1};
  bool hybridFloor = true, hybridLightsFollow = false, hybridShadows = true, hybridAo = true;
  uint32_t hybridFrameIdx = 0;
  uint32_t hybridStillFrames = 0;
  id<MTLTexture> glassFront = nil, glassMat = nil, glassBackNear = nil, glassBackFar = nil, glassDepthTex = nil, glassResolved = nil;  // RMIDT glass, full size
  void makeTargets();
  void makeGlassTargets();
  // The key light's depth map, and the height map over the model (from above: r -(highest
  // top), g lowest underside, above the floor).
  CasterMap shadow, heights;
  // Per group, per instance: the first frame that showed it where it is now (0: where it was
  // made); and the latest of them.
  std::vector<std::vector<uint64_t>> changedAt;
  uint64_t lastChange = 0;
  id<MTLTexture> mask = nil;       // selected pieces, one sample
  id<MTLTexture> ids = nil, idDepth = nil;  // piece + 1 per pixel, for picking; made on the first pick

  // What the last frame drew, kept for picking.
  struct Batch {
    uint32_t group;
    Detail detail;
    bool mirrored;
    uint32_t first, count;  // in `list`
    bool top = false;       // the eye is above these instances' bottoms: their undersides are left out
  };
  bool drewFrame = false, idsReady = false;
  int lastSlot = 0;
  Camera lastCamera;
  std::vector<uint32_t> lastList;
  std::vector<Batch> lastSeen;
  std::vector<Visible> inView;
  std::vector<uint32_t> nextList;
  std::vector<Batch> nextSeen;
  id<MTLBuffer> pickList = nil;
  void drawIds();

  id<MTLAccelerationStructure> glassAcceleration = nil;
  id<MTLBuffer> glassNodes = nil, glassTriangles = nil;
  uint32_t glassNodeCount = 0;
  uint64_t glassRevision = UINT64_MAX;
  void prepareGlass();

  // World-space 6-axis diffuse GI + studio-light & sky visibility cache (async CPU bake).
  id<MTLTexture> worldGiTextures[6] = {nil, nil, nil, nil, nil, nil};
  id<MTLTexture> worldGiStudioTexture = nil;
  WorldGiUniforms worldGiUniforms{};
  uint64_t worldGiEpoch = 1, worldGiBuiltEpoch = 0;
  bool worldGiBuilt = false;
  std::array<float, 17> worldGiLightKey{};
  std::future<WorldGiVolume> worldGiJob;
  bool worldGiPending = false;
  uint64_t worldGiPendingEpoch = 0, worldGiFailedEpoch = 0;
  std::array<float, 17> worldGiPendingKey{};
  id<MTLTexture> worldGiFallback = nil;
  bool uploadWorldGi(const WorldGiVolume& result, uint64_t epoch, const std::array<float, 17>& key);
  bool prepareWorldGi(const LightRig& rig, float worldStrength, bool interactive, bool synchronous);

  // Persistent progressive hardware-RT path-tracing state (exact bmexport quality live in viewport).
  std::unique_ptr<PathScene> ptScene;
  bool ptInitTried = false;
  uint64_t ptSceneRevision = UINT64_MAX;
  id<MTLBuffer> ptAccum = nil, ptCatcher = nil, ptSky = nil, ptAlbedo = nil, ptNormal = nil;
  id<MTLTexture> ptDenoised = nil;
  int ptW = 0, ptH = 0;
  uint32_t ptSamples = 0;
  bool ptHasDenoised = false;
  Camera ptCamera;
  bool ptFloor = true, ptLightsFollow = false;
  float ptBg[3] = {1, 1, 1};
  FrameStats drawPathTraced(const Camera& camera, const FrameOptions& options, id<CAMetalDrawable> drawable);

  // Real-Time Path Tracing (Adaptive Control-Variate Studio RT + SHaRC + Dual-Lobe VNDF + Demodulated SVGF + Halton TAA/Progressive).
  id<MTLTexture> rtptDepth = nil;
  id<MTLTexture> rtptPosId[2] = {nil, nil}, rtptNorm[2] = {nil, nil};
  id<MTLTexture> rtptMat = nil, rtptMotion = nil;
  id<MTLTexture> rtptDi[2] = {nil, nil}, rtptGiQuarter = nil;
  id<MTLTexture> rtptDiffRaw = nil, rtptSpecRaw = nil;
  id<MTLTexture> rtptDiffHist[2] = {nil, nil}, rtptSpecHist[2] = {nil, nil};
  id<MTLTexture> rtptMoments[2] = {nil, nil}, rtptHLen[2] = {nil, nil};
  id<MTLTexture> rtptDiffPing = nil, rtptSpecPing = nil, rtptDiffPong = nil;
  id<MTLTexture> rtptTaa[2] = {nil, nil};
  id<MTLBuffer> rtptSharcAccum = nil, rtptSharcResolved = nil;
  id<MTLBuffer> rtptTileIndirect = nil, rtptTileIndirectZero = nil;
  id<MTLBuffer> rtptGlassTiles = nil, rtptOpaqueTiles = nil, rtptFloorTiles = nil, rtptSpecTiles = nil;
  id<MTLBuffer> rtptPoses[3] = {nil, nil, nil};
  uint32_t rtptPoseCapacity = 0;
  int rtptPrevPoseSlot = -1;
  bool rtptHasPrevPose = false;
  int rtptW = 0, rtptH = 0;
  int rtptTraceW = 0, rtptTraceH = 0;
  uint32_t rtptFrameIdx = 0;
  uint32_t rtptStillFrames = 0;
  bool rtptHasHistory = false;
  uint64_t rtptLastChange = UINT64_MAX;
  simd_float4x4 rtptPrevViewProj = matrix_identity_float4x4;
  float rtptPrevJitter[2] = {0, 0};
  Camera rtptLastCamera;
  bool rtptLastFloor = true, rtptLastLightsFollow = false, rtptLastClay = false;
  float rtptLastBg[3] = {1, 1, 1};
  FrameStats drawRealtimePathTraced(const Camera& camera, const FrameOptions& options, id<CAMetalDrawable> drawable);

  FrameBuffer frameUniforms, drawUniforms, visible, floorBins;
  id<MTLBuffer> neuralWeightsBuffer = nil;
  NeuralWeights neuralWeightsCpu = defaultNeuralWeights();
  std::string neuralWeightsPath;
  // The floor's table of light per direction and elevation, for the lights it was made for.
  std::unique_ptr<FloorBins> floorTable;
  bm::Vec3 floorTableToward[4];
  uint64_t frame = 0;
  dispatch_semaphore_t inFlight = nil;
  std::atomic<double> gpuMs{0};  // written when a frame finishes, on Metal's thread
  bool drewOffscreen = false;

  FrameStats draw(const Camera& camera, const FrameOptions& options, id<CAMetalDrawable> drawable);
};

/// World space: a part's box (part space) under an instance's placement, as an axis-aligned box.
inline bm::Box placedBox(const Instance& in, const bm::Box& part, bm::Vec3 origin) {
  const bm::Vec3 c = (part.min + part.max) * 0.5, h = (part.max - part.min) * 0.5;
  const float* m = in.model;
  const bm::Vec3 at{m[0] * c.x + m[1] * c.y + m[2] * c.z + m[3], m[4] * c.x + m[5] * c.y + m[6] * c.z + m[7], m[8] * c.x + m[9] * c.y + m[10] * c.z + m[11]};
  const bm::Vec3 half{std::abs(m[0]) * h.x + std::abs(m[1]) * h.y + std::abs(m[2]) * h.z, std::abs(m[4]) * h.x + std::abs(m[5]) * h.y + std::abs(m[6]) * h.z,
                      std::abs(m[8]) * h.x + std::abs(m[9]) * h.y + std::abs(m[10]) * h.z};
  return bm::Box{at - half + origin, at + half + origin};
}

inline simd_float4x4 simdFrom(const Mat4& m) {
  simd_float4x4 out;
  for (int c = 0; c < 4; c++) out.columns[c] = simd_make_float4(m.m[c * 4], m.m[c * 4 + 1], m.m[c * 4 + 2], m.m[c * 4 + 3]);
  return out;
}

}  // namespace bmr
