#include "bmr/world_gi.h"

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <limits>
#include <unordered_map>
#include <utility>
#include <vector>

namespace bmr {
namespace {

using V = WorldGiVec3;
V add(V a, V b) { return {a.x+b.x, a.y+b.y, a.z+b.z}; }
V sub(V a, V b) { return {a.x-b.x, a.y-b.y, a.z-b.z}; }
V mul(V a, float k) { return {a.x*k, a.y*k, a.z*k}; }
V times(V a, V b) { return {a.x*b.x, a.y*b.y, a.z*b.z}; }
float dot3(V a, V b) { return a.x*b.x + a.y*b.y + a.z*b.z; }
float length3(V a) { return std::sqrt(std::max(dot3(a,a), 0.0f)); }
V unit(V a) { return mul(a, 1.0f/std::max(length3(a), 1e-8f)); }
float max3(V v) { return std::max({v.x,v.y,v.z}); }
float clamp01(float x) { return std::clamp(x, 0.f, 1.f); }
constexpr float pi = 3.14159265358979323846f;
constexpr V axes[6] = {{1,0,0},{-1,0,0},{0,1,0},{0,-1,0},{0,0,1},{0,0,-1}};

struct Accum {
  V p{}, n{}, a{};
  double area = 0;
  double emissionArea = 0;
};
struct Source { V p{}, n{}, albedo{}, radiance{}; float area=0, emission=0; int x=0,y=0,z=0; };

size_t voxel(const WorldGiVolume& v, int x, int y, int z) {
  return (static_cast<size_t>(z)*v.ny + static_cast<size_t>(y))*v.nx + static_cast<size_t>(x);
}
int cell(float world, float origin, float step, int maxCell) {
  return std::clamp(static_cast<int>(std::floor((world-origin)/step+0.5f)), 0, maxCell-1);
}
V texel(const WorldGiVolume& v, int x, int y, int z) {
  return {v.origin.x + x*v.step, v.origin.y+y*v.step, v.origin.z+z*v.step};
}
int face(V n) {
  const float x=std::abs(n.x), y=std::abs(n.y), z=std::abs(n.z);
  return x>=y && x>=z ? (n.x>=0 ? 0 : 1) : y>=z ? (n.y>=0 ? 2 : 3) : (n.z>=0 ? 4 : 5);
}

// Conservative voxel visibility between two patches. This is a coarse geometry
// test during CACHE BAKING, not a ray traced query for every shaded pixel.
// The endpoint cells are ignored so closely facing LEGO faces can exchange light.
bool unblocked(const std::vector<uint8_t>& occupied, const WorldGiVolume& v,
               V from, V to, int ax, int ay, int az, int bx, int by, int bz) {
  const V delta=sub(to,from);
  const int steps=std::min(28, static_cast<int>(std::ceil(length3(delta)/v.step*2.0f)));
  if (steps<=2) return true;
  for (int i=1; i<steps; ++i) {
    const V q=add(from,mul(delta,float(i)/steps));
    const int x=cell(q.x,v.origin.x,v.step,int(v.nx));
    const int y=cell(q.y,v.origin.y,v.step,int(v.ny));
    const int z=cell(q.z,v.origin.z,v.step,int(v.nz));
    if ((x==ax && y==ay && z==az) || (x==bx && y==by && z==bz)) continue;
    if (occupied[voxel(v,x,y,z)]) return false;
  }
  return true;
}

// Approximate the part of a large studio source covered by nearby LEGO geometry.
// This is a handful of occupancy lookups per surfel *at cache build time*, not
// ray tracing or shadow sampling during viewport rendering. The disks are wide,
// so blocked central directions retain a soft penumbra instead of going black.
float studioVisibility(const WorldGiVolume& v, const std::vector<uint8_t>& occupied,
                       const Source& source, V toward) {
  const V start=add(source.p,mul(source.n,0.4f*v.step));
  for (int k=1;k<=10;++k) {
    const V p=add(start,mul(toward,k*0.7f*v.step));
    const float gx=(p.x-v.origin.x)/v.step, gy=(p.y-v.origin.y)/v.step, gz=(p.z-v.origin.z)/v.step;
    if (gx<0 || gy<0 || gz<0 || gx>=v.nx || gy>=v.ny || gz>=v.nz) break;
    const int x=cell(p.x,v.origin.x,v.step,int(v.nx));
    const int y=cell(p.y,v.origin.y,v.step,int(v.ny));
    const int z=cell(p.z,v.origin.z,v.step,int(v.nz));
    if (x==source.x && y==source.y && z==source.z) continue;
    if (occupied[voxel(v,x,y,z)]) return 0.30f;
  }
  return 1.0f;
}

// Deterministic short-range ray tests are executed only while BAKING the CPU
// cache, never by the Metal viewport shader. This is intentionally a coarse
// occupancy approximation of Studio's 45-degree emitter disks, not triangle RT.
// Skip the origin voxel so a point at a brick boundary does not shadow itself.
bool probeRayOpen(const std::vector<uint8_t>& occupied, const WorldGiVolume& v,
                  V at, V dir, int maxSteps) {
  for (int k=0; k<maxSteps; ++k) {
    const V q=add(at,mul(dir,(1.05f+float(k)*0.85f)*v.step));
    const V f=mul(sub(q,v.origin),1.0f/v.step);
    if (f.x< -0.5f || f.y< -0.5f || f.z< -0.5f ||
        f.x>float(v.nx)-0.5f || f.y>float(v.ny)-0.5f || f.z>float(v.nz)-0.5f)
      return true;  // outside the model's volume: visible studio/environment
    const int x=cell(q.x,v.origin.x,v.step,int(v.nx));
    const int y=cell(q.y,v.origin.y,v.step,int(v.ny));
    const int z=cell(q.z,v.origin.z,v.step,int(v.nz));
    if (occupied[voxel(v,x,y,z)]) return false;
  }
  return true;
}

std::array<V,5> diskDirections(V main, float rim) {
  const V n=unit(main);
  const V helper=std::abs(n.y)<0.85f ? V{0,1,0} : V{1,0,0};
  const V t=unit({n.y*helper.z-n.z*helper.y,
                  n.z*helper.x-n.x*helper.z,n.x*helper.y-n.y*helper.x});
  const V b={n.y*t.z-n.z*t.y,n.z*t.x-n.x*t.z,n.x*t.y-n.y*t.x};
  const float forward=std::sqrt(1.0f-rim*rim);
  return {n,unit(add(mul(n,forward),mul(t,rim))),
            unit(sub(mul(n,forward),mul(t,rim))),
            unit(add(mul(n,forward),mul(b,rim))),
            unit(sub(mul(n,forward),mul(b,rim)))};
}

void bakeStudioOcclusion(WorldGiVolume& v, const std::vector<uint8_t>& occupied,
                         const std::array<WorldGiLight,4>& lights, bool enabled) {
  for (auto& a:v.sky) a.assign(v.count(),1.f);
  v.studio.assign(v.count()*4,1.f);
  if (!enabled) return;
  // Only probes within two voxels of an actual surface can ever be sampled by
  // the plastic fragment. Leave distant empty space at full visibility. This
  // substantially reduces bake time on models with long, thin rotor blades.
  std::vector<uint8_t> relevant(v.count(),0);
  for (uint32_t z=0;z<v.nz;++z) for (uint32_t y=0;y<v.ny;++y) for (uint32_t x=0;x<v.nx;++x) {
    if (!occupied[voxel(v,int(x),int(y),int(z))]) continue;
    for (int dz=-2;dz<=2;++dz)for(int dy=-2;dy<=2;++dy)for(int dx=-2;dx<=2;++dx){
      const int nx=int(x)+dx,ny=int(y)+dy,nz=int(z)+dz;
      if(nx>=0 && ny>=0 && nz>=0 && nx<int(v.nx) && ny<int(v.ny) && nz<int(v.nz))
        relevant[voxel(v,nx,ny,nz)]=1;
    }
  }
  std::array<std::array<V,5>,6> skyDirs{};
  for (int i=0;i<6;++i) skyDirs[i]=diskDirections(axes[i],0.80f);
  std::array<std::array<V,5>,4> lightDirs{};
  for (int i=0;i<4;++i) if (lights[i].strength>0)
    lightDirs[i]=diskDirections(lights[i].toward,0.56f);
  const int maxDistance=std::min(28,int(std::max({v.nx,v.ny,v.nz})));
  // Precompute 4 soft-disk visibilities and six oriented sky visibilities per
  // probe. No per-fragment rays, no MSAA texture or temporal-frame dependency.
  for (uint32_t z=0; z<v.nz; ++z) for (uint32_t y=0; y<v.ny; ++y) for (uint32_t x=0; x<v.nx; ++x) {
    const size_t at=voxel(v,int(x),int(y),int(z));
    if (!relevant[at]) continue;
    const V p=texel(v,int(x),int(y),int(z));
    for (int li=0; li<4; ++li) {
      if (lights[li].strength<=0) continue;
      int visible=0;
      for (const V dir:lightDirs[li]) visible+=probeRayOpen(occupied,v,p,dir,maxDistance) ? 1:0;
      v.studio[4*at+li]=float(visible)*0.2f;
    }
    for (int axis=0; axis<6; ++axis) {
      int visible=0;
      for (const V dir:skyDirs[axis]) visible+=probeRayOpen(occupied,v,p,dir,maxDistance) ? 1:0;
      v.sky[axis][at]=float(visible)*0.2f;
    }
  }
}

float sampleScalar(const WorldGiVolume& v, const std::vector<float>& values, V p, int offset, int stride) {
  const V f=mul(sub(p,v.origin),1.0f/v.step);
  const float xx=std::clamp(f.x,0.0f,float(v.nx-1)), yy=std::clamp(f.y,0.0f,float(v.ny-1)), zz=std::clamp(f.z,0.0f,float(v.nz-1));
  const int x=int(xx), y=int(yy), z=int(zz);
  const int x1=std::min(x+1,int(v.nx-1)), y1=std::min(y+1,int(v.ny-1)), z1=std::min(z+1,int(v.nz-1));
  float sum=0;
  for (int i=0;i<8;++i) {
    const int ix=i&1 ? x1:x, iy=i&2 ? y1:y, iz=i&4 ? z1:z;
    const float w=(i&1 ? xx-x:1-(xx-x))*(i&2 ? yy-y:1-(yy-y))*(i&4 ? zz-z:1-(zz-z));
    sum+=values[voxel(v,ix,iy,iz)*stride+offset]*w;
  }
  return sum;
}

V readTrilinear(const WorldGiVolume& v, int axis, V p) {
  if (v.empty()) return {};
  const V f=mul(sub(p,v.origin),1.0f/v.step);
  const float xx=std::clamp(f.x,0.0f,float(v.nx-1)), yy=std::clamp(f.y,0.0f,float(v.ny-1)), zz=std::clamp(f.z,0.0f,float(v.nz-1));
  const int x=int(xx), y=int(yy), z=int(zz);
  const int x1=std::min(x+1,int(v.nx-1)), y1=std::min(y+1,int(v.ny-1)), z1=std::min(z+1,int(v.nz-1));
  V sum{};
  for (int i=0;i<8;++i) {
    const int ix=i&1 ? x1:x, iy=i&2 ? y1:y, iz=i&4 ? z1:z;
    const float w=(i&1 ? xx-x:1-(xx-x))*(i&2 ? yy-y:1-(yy-y))*(i&4 ? zz-z:1-(zz-z));
    const size_t k=voxel(v,ix,iy,iz)*3;
    sum=add(sum,mul({v.rgb[axis][k],v.rgb[axis][k+1],v.rgb[axis][k+2]},w));
  }
  return sum;
}

void scatter(WorldGiVolume& v, const std::vector<Source>& sources,
             const std::vector<uint8_t>& occupied, bool checkVisibility,
             float influence, float energyScale) {
  const float reach = v.step * influence;
  const int radius=int(std::ceil(influence));
  for (const Source& s : sources) {
    if (max3(s.radiance)<=1e-5f || s.area<=0) continue;
    const int x0=std::max(0,s.x-radius), x1=std::min(int(v.nx)-1,s.x+radius);
    const int y0=std::max(0,s.y-radius), y1=std::min(int(v.ny)-1,s.y+radius);
    const int z0=std::max(0,s.z-radius), z1=std::min(int(v.nz)-1,s.z+radius);
    for (int z=z0;z<=z1;++z) for (int y=y0;y<=y1;++y) for (int x=x0;x<=x1;++x) {
      if (x==s.x && y==s.y && z==s.z) continue;  // avoid self-illumination
      const V receiver=texel(v,x,y,z), toward=sub(s.p,receiver);
      const float d2=dot3(toward,toward);
      if (d2<0.16f*v.step*v.step || d2>reach*reach) continue;
      const float inv=1.0f/std::sqrt(d2);
      const V dir=mul(toward,inv);
      const float sourceCos=std::max(0.0f, -dot3(s.n,dir));
      if (sourceCos<1e-4f) continue;
      if (checkVisibility && !unblocked(occupied,v,receiver,s.p,x,y,z,s.x,s.y,s.z)) continue;
      // The Lambertian patch form factor is (cos_i cos_j A_j)/(pi r^2).
      // A finite-area softening bounds near-field exchange; the fade suppresses
      // abrupt cutoff at the edge of the cache's finite neighborhood.
      const float geometric=std::min(0.8f,s.area/(pi*(d2+0.25f*s.area))) * sourceCos;
      const float fade=clamp01((reach-std::sqrt(d2))/(0.65f*reach));
      const float scale=geometric*fade*energyScale;
      const size_t k=voxel(v,x,y,z)*3;
      for (int dirIndex=0;dirIndex<6;++dirIndex) {
        const float normalCos=std::max(dot3(axes[dirIndex],dir),0.0f);
        if (normalCos<=0.0f) continue;
        v.rgb[dirIndex][k]   += s.radiance.x*scale*normalCos;
        v.rgb[dirIndex][k+1] += s.radiance.y*scale*normalCos;
        v.rgb[dirIndex][k+2] += s.radiance.z*scale*normalCos;
      }
    }
  }
}

} // namespace

WorldGiVec3 sampleWorldGi(const WorldGiVolume& volume, WorldGiVec3 at, WorldGiVec3 normal) {
  if (volume.empty()) return {};
  const V n=unit(normal);
  const float w[6]={std::max(n.x,0.f),std::max(-n.x,0.f),std::max(n.y,0.f),
                    std::max(-n.y,0.f),std::max(n.z,0.f),std::max(-n.z,0.f)};
  const float denom=std::max(w[0]+w[1]+w[2]+w[3]+w[4]+w[5],1e-5f);
  V result{};
  for (int i=0;i<6;++i) if (w[i]>0) result=add(result,mul(readTrilinear(volume,i,at),w[i]/denom));
  return result;
}

float sampleWorldSky(const WorldGiVolume& volume, WorldGiVec3 at, WorldGiVec3 normal) {
  if (volume.empty() || volume.sky[0].empty()) return 1.f;
  const V n=unit(normal);
  const float weights[6]={std::max(n.x,0.f),std::max(-n.x,0.f),std::max(n.y,0.f),
                          std::max(-n.y,0.f),std::max(n.z,0.f),std::max(-n.z,0.f)};
  float sum=0,weight=0;
  for (int i=0;i<6;++i) if (weights[i]>0) {
    sum+=weights[i]*sampleScalar(volume,volume.sky[i],at,0,1);
    weight+=weights[i];
  }
  return weight>0 ? std::clamp(sum/weight,0.f,1.f) : 1.f;
}

std::array<float,4> sampleWorldStudio(const WorldGiVolume& volume,WorldGiVec3 at) {
  std::array<float,4> result{1.f,1.f,1.f,1.f};
  if (volume.empty() || volume.studio.empty()) return result;
  for (int i=0;i<4;++i) result[i]=std::clamp(sampleScalar(volume,volume.studio,at,i,4),0.f,1.f);
  return result;
}

WorldGiVolume bakeWorldGi(const std::vector<WorldGiSurfel>& surfaces,
                          WorldGiVec3 low, WorldGiVec3 high,
                          const std::array<WorldGiLight,4>& lights,
                          float whiteWorldStrength,
                          const WorldGiConfig& config) {
  WorldGiVolume v;
  if (surfaces.empty() || config.maxCells<64 || config.maxAxis<4) return v;
  float step=std::max(config.desiredCell,2.0f);
  const V span={std::max(high.x-low.x,1.0f),std::max(high.y-low.y,1.0f),std::max(high.z-low.z,1.0f)};
  // Grow the cell size uniformly on large models; no 3D texture can exceed the
  // M1-friendly limits. The cell volume always encloses the full scene.
  for (int tries=0;tries<64;++tries) {
    v.nx=static_cast<uint32_t>(std::ceil(span.x/step))+5;
    v.ny=static_cast<uint32_t>(std::ceil(span.y/step))+5;
    v.nz=static_cast<uint32_t>(std::ceil(span.z/step))+5;
    if (v.nx<=config.maxAxis && v.ny<=config.maxAxis && v.nz<=config.maxAxis &&
        v.count()<=config.maxCells) break;
    step*=1.18f;
  }
  if (v.nx>config.maxAxis || v.ny>config.maxAxis || v.nz>config.maxAxis || v.count()>config.maxCells) return {};
  v.step=step;
  v.origin={low.x-2*step,low.y-2*step,low.z-2*step};
  for (auto& a : v.rgb) a.assign(v.count()*3,0.f);

  // Merge many triangles/studs into one outgoing patch per occupied voxel and
  // principal normal. Distinct sides of a thin plate do NOT cancel each other.
  std::unordered_map<uint64_t,Accum> cells;
  cells.reserve(std::min<size_t>(surfaces.size(),v.count()*2));
  for (const auto& s : surfaces) {
    if (!(s.area>1e-6f) || !std::isfinite(s.area) ||
        !std::isfinite(s.point.x) || !std::isfinite(s.point.y) || !std::isfinite(s.point.z)) continue;
    const int x=cell(s.point.x,v.origin.x,step,int(v.nx));
    const int y=cell(s.point.y,v.origin.y,step,int(v.ny));
    const int z=cell(s.point.z,v.origin.z,step,int(v.nz));
    const V n=unit(s.normal);
    if (length3(n)<0.5f) continue;
    const uint64_t key=static_cast<uint64_t>(voxel(v,x,y,z))*6 + face(n);
    Accum& a=cells[key];
    const float weight=std::min(s.area,step*step*12.0f);
    a.p=add(a.p,mul(s.point,weight));
    a.n=add(a.n,mul(n,weight));
    a.a=add(a.a,mul(s.albedo,weight));
    a.emissionArea+=static_cast<double>(s.emission)*weight;
    a.area+=weight;
  }
  std::vector<Source> sources;
  sources.reserve(cells.size());
  std::vector<uint8_t> occupied(v.count(),0);
  for (const auto& [key,a] : cells) {
    if (!(a.area>0)) continue;
    const uint64_t slot=key/6;
    const int x=int(slot%v.nx), y=int((slot/v.nx)%v.ny), z=int(slot/(static_cast<uint64_t>(v.nx)*v.ny));
    const float inv=1.f/static_cast<float>(a.area);
    Source s;
    s.p=mul(a.p,inv),s.n=unit(a.n),s.albedo=mul(a.a,inv);
    s.area=std::min(static_cast<float>(a.area),3.f*step*step);
    s.emission=static_cast<float>(a.emissionArea*inv);
    s.x=x,s.y=y,s.z=z;
    sources.push_back(s);
    occupied[slot]=1;
  }
  // Stable iteration order even if unordered_map rehashing changes. This also
  // makes numerical comparisons repeatable on macOS and portable C++ tests.
  std::sort(sources.begin(),sources.end(),[](const Source& a,const Source& b) {
    if (a.z!=b.z) return a.z<b.z;
    if (a.y!=b.y) return a.y<b.y;
    if (a.x!=b.x) return a.x<b.x;
    return face(a.n)<face(b.n);
  });
  v.surfelCount=static_cast<uint32_t>(sources.size());

  // Cache soft visibility for direct studio lighting and environment fill. This
  // is independent of the camera and updated alongside the diffuse GI volume.
  bakeStudioOcclusion(v,occupied,lights,config.studioVisibility);

  const float world=std::max(0.f,whiteWorldStrength);
  for (Source& s : sources) {
    // Match the plastic PT's diffuse world + four studio disks to first order.
    // Near-field occlusion is accounted for by the cache; exact source-light
    // shadows are not (a higher-quality bake would use the key shadow map).
    float direct=world;
    for (int i=0;i<4;++i) {
      const float lambert=std::max(0.f,dot3(s.n,unit(lights[i].toward)));
      if (lambert>0.f) {
        const float visibility=config.voxelVisibility ? studioVisibility(v,occupied,s,unit(lights[i].toward)) : 1.f;
        direct+=std::max(0.f,lights[i].strength)*(i==0 ? 1.f : 0.85f)*lambert*visibility/pi;
      }
    }
    s.radiance=add(mul(times(s.albedo,{direct,direct,direct}),0.94f),mul(s.albedo,s.emission));
  }
  scatter(v,sources,occupied,config.voxelVisibility,config.reachCells,1.f);
  if (config.secondBounce) {
    // Jacobi-style second diffuse interaction. Evaluate the first-order field
    // without modifying it until all second-order outgoing radiances are known.
    for (Source& s : sources) {
      const V at=add(s.p,mul(s.n,step*0.4f));
      const V incoming=sampleWorldGi(v,at,s.n);
      s.radiance=mul(times(incoming,s.albedo),0.88f);
    }
    scatter(v,sources,occupied,config.voxelVisibility,config.reachCells,1.f);
  }
  for (auto& axis : v.rgb) for (float& c : axis) {
    c=std::clamp(c*config.bounceStrength,0.0f,6.0f);
  }
  return v;
}

} // namespace bmr
