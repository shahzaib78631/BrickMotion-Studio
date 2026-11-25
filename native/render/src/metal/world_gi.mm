// CPU-only scene bake and immutable Metal 3D texture upload for camera-independent,
// finite-radius, two-bounce LEGO plastic GI. There is no per-frame ray tracing.
#import "metal/impl.h"

#include <algorithm>
#include <array>
#include <cmath>
#include <chrono>
#include <future>
#include <memory>
#include <utility>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <vector>
#include "bmr/material.h"
#include "bmr/tolerances.h"
#include "bmr/world_gi.h"

namespace bmr {
namespace {

WorldGiVec3 transform(const Instance& in, const Vertex& v) {
  const float* a=in.model;
  return {a[0]*v.px+a[1]*v.py+a[2]*v.pz+a[3],
          a[4]*v.px+a[5]*v.py+a[6]*v.pz+a[7],
          a[8]*v.px+a[9]*v.py+a[10]*v.pz+a[11]};
}
WorldGiVec3 add(WorldGiVec3 a,WorldGiVec3 b) {return {a.x+b.x,a.y+b.y,a.z+b.z};}
WorldGiVec3 sub(WorldGiVec3 a,WorldGiVec3 b) {return {a.x-b.x,a.y-b.y,a.z-b.z};}
WorldGiVec3 mul(WorldGiVec3 a,float w) {return {a.x*w,a.y*w,a.z*w};}
WorldGiVec3 cross(WorldGiVec3 a,WorldGiVec3 b) {return {a.y*b.z-a.z*b.y,a.z*b.x-a.x*b.z,a.x*b.y-a.y*b.x};}
float len(WorldGiVec3 a) {return std::sqrt(a.x*a.x+a.y*a.y+a.z*a.z);}

WorldGiVec3 vertexAlbedo(const Vertex& v,const Material& m) {
  if (!v.color) return {m.base[0],m.base[1],m.base[2]};
  return {linearFromSrgb((v.color>>16)&255u),linearFromSrgb((v.color>>8)&255u),linearFromSrgb(v.color&255u)};
}
float setting(const char* name,float def,float lo,float hi) {
  const char* raw=std::getenv(name);
  if (!raw || !*raw) return def;
  char* end=nullptr;
  float f=std::strtof(raw,&end);
  return end!=raw && std::isfinite(f) ? std::clamp(f,lo,hi) : def;
}

// IEEE 754 binary16 with round-to-nearest-even; no private Metal headers needed.
uint16_t floatToHalf(float f) {
  uint32_t u;
  std::memcpy(&u,&f,4);
  const uint32_t sign=(u>>16)&0x8000u;
  const int e=int((u>>23)&255)-127+15;
  const uint32_t m=u&0x7fffffu;
  if (e>=31) return static_cast<uint16_t>(sign|0x7bffu); // finite light radiance saturation
  if (e<=0) {
    if (e< -10) return static_cast<uint16_t>(sign);
    const uint32_t v=(m|0x800000u)>> (1-e);
    return static_cast<uint16_t>(sign|((v+0x0fffu+((v>>13)&1))>>13));
  }
  uint32_t rounded=m+0xfffu+((m>>13)&1);
  return static_cast<uint16_t>(sign|(static_cast<uint32_t>(e)<<10)|(rounded>>13));
}

// All triangle processing is performed by the worker. These immutable snapshots
// keep part meshes and instance transforms alive after a scene edit/rebuild.
struct WorldGiChunk {
  std::shared_ptr<const RenderMesh> mesh;
  Material material;
  std::vector<Instance> instances;
};
std::vector<WorldGiSurfel> extractWorldGiSurfels(const std::vector<WorldGiChunk>& chunks) {
  std::vector<WorldGiSurfel> surfels;
  // Cap triangle processing for massive Studio scenes. This sacrifices fine studs
  // before it sacrifices *whole pieces*; world-space grouping handles the rest.
  size_t pieceCount=0;
  for (const auto& group : chunks) if (group.mesh && !group.mesh->indices.empty())
    for (const Instance& in : group.instances) if (!(in.flags&kNotShown)) ++pieceCount;
  const size_t perPiece=std::clamp<size_t>(220000/std::max<size_t>(1,pieceCount),32,1500);
  surfels.reserve(std::min<size_t>(300000,pieceCount*std::min<size_t>(perPiece,384)));

  for (const auto& group : chunks) {
    const auto& mesh=group.mesh;
    if (!mesh || mesh->indices.empty()) continue;
    const size_t triangles=mesh->indices.size()/3;
    const size_t stride=std::max<size_t>(1,(triangles+perPiece-1)/perPiece);
    for (const Instance& inst : group.instances) {
      if (inst.flags&kNotShown) continue;
      for (size_t ti=0;ti<triangles;ti+=stride) {
        const Vertex& a=mesh->vertices[mesh->indices[ti*3]];
        const Vertex& b=mesh->vertices[mesh->indices[ti*3+1]];
        const Vertex& c=mesh->vertices[mesh->indices[ti*3+2]];
        const WorldGiVec3 pa=transform(inst,a),pb=transform(inst,b),pc=transform(inst,c);
        WorldGiVec3 geometric=cross(sub(pb,pa),sub(pc,pa));
        const float twiceArea=len(geometric);
        if (!(twiceArea>1e-5f) || !std::isfinite(twiceArea)) continue;
        // Preserve the renderer's mirrored-face convention.
        const WorldGiVec3 normal=mul(geometric,(inst.flags&kMirrored ? -1.f : 1.f)/twiceArea);
        const WorldGiVec3 ca=vertexAlbedo(a,group.material),cb=vertexAlbedo(b,group.material),cc=vertexAlbedo(c,group.material);
        const WorldGiVec3 albedo=mul(add(add(ca,cb),cc),1.f/3.f);
        // Split large flat LDraw triangles so long helicopter rotors and large
        // plates occupy every intervening cache voxel, not only their centroids.
        const float representedArea=0.5f*twiceArea*float(std::min(stride,triangles-ti));
        const int count=std::clamp(int(std::ceil(representedArea/192.f)),1,12);
        for (int k=0;k<count;++k) {
          const float u=std::sqrt((float(k)+0.5f)/count);
          const float v=std::fmod((float(k)+1.f)*0.6180339887f,1.f);
          const float wa=1.f-u,wb=u*(1.f-v),wc=u*v;
          const WorldGiVec3 p=add(add(mul(pa,wa),mul(pb,wb)),mul(pc,wc));
          surfels.push_back({p,normal,albedo,representedArea/count,0.0f});
        }
      }
    }
  }

  return surfels;
}

} // namespace

// The cache changes when a *piece* changes, not when the camera moves. This function
// returns false if geometry is dirty during a gesture: it is safer to use the
// direct-only preview until a stable world-space cache has been rebuilt.
bool Renderer::Impl::prepareWorldGi(const LightRig& rig, float worldStrength, bool interactive, bool synchronous) {
  std::array<float,17> lightKey{};
  for (int i=0;i<4;++i) {
    lightKey[i*4]=static_cast<float>(rig.toward[i].x);
    lightKey[i*4+1]=static_cast<float>(rig.toward[i].y);
    lightKey[i*4+2]=static_cast<float>(rig.toward[i].z);
    lightKey[i*4+3]=rig.strength[i];
  }
  lightKey[16]=worldStrength;
  const bool sameRig=worldGiBuilt && [&] {
    for (size_t i=0;i<lightKey.size();++i) if (std::abs(lightKey[i]-worldGiLightKey[i])>0.0001f) return false;
    return true;
  }();
  if (worldGiPending && worldGiJob.valid() &&
      (synchronous || worldGiJob.wait_for(std::chrono::seconds(0)) == std::future_status::ready)) {
    // Only the render thread ever touches Metal. The worker owns a copy of all
    // geometry it needs and returns an immutable CPU volume.
    const WorldGiVolume result=worldGiJob.get();
    worldGiPending=false;
    bool matches=worldGiPendingEpoch==worldGiEpoch;
    for (size_t i=0;i<lightKey.size();++i)
      matches &= std::abs(lightKey[i]-worldGiPendingKey[i])<=0.0001f;
    if (matches) {
      if (result.empty()) worldGiFailedEpoch=worldGiEpoch;
      else return uploadWorldGi(result,worldGiEpoch,lightKey);
    }
  }
  if (worldGiBuilt && worldGiBuiltEpoch==worldGiEpoch && sameRig) return true;
  if (worldGiFailedEpoch==worldGiEpoch) return false;
  // Defer mesh extraction when moving geometry is still being edited/animated.
  if (interactive || worldGiPending) return false;

  // Snapshot immutable mesh handles, material values and instance transforms.
  // A potentially expensive surface extraction and the lighting bake BOTH run
  // on the worker; frame rendering never iterates the triangles to make surfels.
  std::vector<WorldGiChunk> chunks;
  chunks.reserve(scene.groups.size());
  for (const auto& group : scene.groups) {
    if (group.placeholder || group.material.transparent() || group.material.metalness>=0.2f) continue;
    WorldGiChunk chunk;
    chunk.mesh=meshes->get(group.part,Detail::Low);
    if (!chunk.mesh || chunk.mesh->indices.empty()) continue;
    chunk.material=group.material;
    chunk.instances.reserve(group.instances.size());
    for (const Instance& in : group.instances) if (!(in.flags&kNotShown)) chunk.instances.push_back(in);
    if (!chunk.instances.empty()) chunks.push_back(std::move(chunk));
  }
  if (chunks.empty()) return false;

  bm::Box bounds=scene.bounds;
  bounds.merge(liveBounds);
  if (bounds.empty()) return false;
  const WorldGiVec3 low{static_cast<float>(bounds.min.x-scene.origin.x),
                        static_cast<float>(bounds.min.y-scene.origin.y),
                        static_cast<float>(bounds.min.z-scene.origin.z)};
  const WorldGiVec3 high{static_cast<float>(bounds.max.x-scene.origin.x),
                         static_cast<float>(bounds.max.y-scene.origin.y),
                         static_cast<float>(bounds.max.z-scene.origin.z)};
  std::array<WorldGiLight,4> lights{};
  for (int i=0;i<4;++i)
    lights[i]={{lightKey[i*4],lightKey[i*4+1],lightKey[i*4+2]},lightKey[i*4+3]};
  WorldGiConfig config;
  config.desiredCell=setting("BM_WORLD_GI_CELL",12.0f,6.0f,40.0f);
  config.reachCells=setting("BM_WORLD_GI_REACH",5.0f,2.0f,7.0f);
  config.bounceStrength=setting("BM_WORLD_GI_GAIN",0.75f,0.0f,1.2f);
  config.secondBounce=setting("BM_WORLD_GI_SECOND",1.0f,0.0f,1.0f)>=0.5f;
  config.voxelVisibility=setting("BM_WORLD_GI_VISIBILITY",1.0f,0.0f,1.0f)>=0.5f;
  config.studioVisibility=setting("BM_WORLD_GI_BAKE_VIS",1.0f,0.0f,1.0f)>=0.5f;
  if (!synchronous) {
    // The first viewport frame stays responsive and uses direct lighting only.
    // The display link is kept alive with FrameStats::settling until ready.
    worldGiPending=true;
    worldGiPendingEpoch=worldGiEpoch;
    worldGiPendingKey=lightKey;
    worldGiJob=std::async(std::launch::async,
      [chunks=std::move(chunks),low,high,lights,worldStrength,config]() mutable {
        return bakeWorldGi(extractWorldGiSurfels(chunks),low,high,lights,worldStrength,config);
      });
    return false;
  }
  const WorldGiVolume result=bakeWorldGi(extractWorldGiSurfels(chunks),low,high,lights,worldStrength,config);
  return uploadWorldGi(result,worldGiEpoch,lightKey);
}

bool Renderer::Impl::uploadWorldGi(const WorldGiVolume& result, uint64_t epoch,
                                   const std::array<float,17>& lightKey) {
  if (result.empty()) {
    worldGiFailedEpoch=epoch;
    return false;
  }
  std::array<id<MTLTexture>,6> newTextures{};
  for (int axis=0;axis<6;++axis) {
    MTLTextureDescriptor* d = [MTLTextureDescriptor new];
    d.textureType = MTLTextureType3D;
    d.pixelFormat = MTLPixelFormatRGBA16Float;
    d.width = result.nx;
    d.height = result.ny;
    d.depth = result.nz;
    d.mipmapLevelCount = 1;
    d.storageMode=MTLStorageModeShared;
    d.usage=MTLTextureUsageShaderRead;
    id<MTLTexture> t=[device->device newTextureWithDescriptor:d];
    if (!t) { worldGiFailedEpoch=epoch; return false; }
    std::vector<uint16_t> pixels(result.count()*4,0);
    for (size_t k=0;k<result.count();++k) {
      pixels[4*k]=floatToHalf(result.rgb[axis][3*k]);
      pixels[4*k+1]=floatToHalf(result.rgb[axis][3*k+1]);
      pixels[4*k+2]=floatToHalf(result.rgb[axis][3*k+2]);
      pixels[4*k+3]=floatToHalf(result.sky[axis][k]);
    }
    [t replaceRegion:MTLRegionMake3D(0,0,0,result.nx,result.ny,result.nz)
         mipmapLevel:0 slice:0 withBytes:pixels.data()
         bytesPerRow:static_cast<NSUInteger>(result.nx)*8
         bytesPerImage:static_cast<NSUInteger>(result.nx)*result.ny*8];
    newTextures[axis]=t;
  }
  // Studio visibility is unorm rather than floating-point radiance: one extra
  // trilinear 3D sample per plastic fragment, <= 0.57 MiB on the M1.
  MTLTextureDescriptor* vd = [MTLTextureDescriptor new];
  vd.textureType = MTLTextureType3D;
  vd.pixelFormat = MTLPixelFormatRGBA8Unorm;
  vd.width = result.nx;
  vd.height = result.ny;
  vd.depth = result.nz;
  vd.mipmapLevelCount = 1;
  vd.storageMode=MTLStorageModeShared;
  vd.usage=MTLTextureUsageShaderRead;
  id<MTLTexture> visTexture=[device->device newTextureWithDescriptor:vd];
  if (!visTexture) { worldGiFailedEpoch=epoch; return false; }
  std::vector<uint8_t> visibilityBytes(result.count()*4);
  for (size_t k=0;k<result.count()*4;++k)
    visibilityBytes[k]=static_cast<uint8_t>(std::lround(std::clamp(result.studio[k],0.f,1.f)*255.f));
  [visTexture replaceRegion:MTLRegionMake3D(0,0,0,result.nx,result.ny,result.nz)
        mipmapLevel:0 slice:0 withBytes:visibilityBytes.data()
        bytesPerRow:static_cast<NSUInteger>(result.nx)*4
        bytesPerImage:static_cast<NSUInteger>(result.nx)*result.ny*4];
  for (int i=0;i<6;++i) worldGiTextures[i]=newTextures[i];
  worldGiStudioTexture=visTexture;
  worldGiUniforms.originStep=simd_make_float4(result.origin.x,result.origin.y,result.origin.z,1.f/result.step);
  worldGiUniforms.shapeGain=simd_make_float4(float(result.nx),float(result.ny),float(result.nz),1.0f);
  worldGiBuiltEpoch=epoch;
  worldGiLightKey=lightKey;
  worldGiBuilt=true;
  std::fprintf(stderr,"bmrender: baked world GI: %u surfels, %ux%ux%u probes, %.1f LDU/cell, %.1f MiB textures\n",
               result.surfelCount,result.nx,result.ny,result.nz,result.step,
               (6.0*8.0+4.0)*result.count()/1048576.0);
  return true;
}

} // namespace bmr
