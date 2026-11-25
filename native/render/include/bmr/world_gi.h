#pragma once
// Camera-independent, bounded near-field diffuse transport for opaque LEGO plastic.
// A scene's coarse mesh supplies the surfels; this portable CPU baker produces six
// axis-irradiance volumes. There are NO per-pixel rays, BVHs or temporal histories.
// Coordinates are scene-local LDraw units (origin already subtracted), +Y points down.
#include <array>
#include <cstddef>
#include <cstdint>
#include <vector>

namespace bmr {

struct WorldGiVec3 {
  float x = 0, y = 0, z = 0;
};

struct WorldGiSurfel {
  WorldGiVec3 point;   // world position, less Scene::origin
  WorldGiVec3 normal;  // outward facing, unit
  WorldGiVec3 albedo;  // linear RGB diffuse reflectance
  float area = 0;     // represented world-space area in LDU^2
  float emission = 0; // radiance multiplier of the LDraw material
};

struct WorldGiLight {
  WorldGiVec3 toward; // direction from surface toward light
  float strength = 0;
};

struct WorldGiConfig {
  float desiredCell = 12.0f;    // ~1.5 plate heights; adaptive for large models
  float reachCells = 5.0f;     // near-field bleed only
  uint32_t maxCells = 150000;  // cap memory and bake work on original M1
  uint32_t maxAxis = 104;
  float bounceStrength = 0.75f; // controllable energy-conservative-ish approximation
  bool secondBounce = true;
  bool voxelVisibility = true;
  // Deterministic soft visibility from a world-space occupancy volume.
  // This is baked when geometry/lights change; no viewport rays or temporal history.
  bool studioVisibility = true;
};

struct WorldGiVolume {
  WorldGiVec3 origin;           // center of grid's first texel (NOT the edge)
  float step = 1.0f;
  uint32_t nx = 0, ny = 0, nz = 0;
  // Each axis stores the RGB *diffuse incident radiance/pi* for a unit receiver
  // normal in one of +X,-X,+Y,-Y,+Z,-Z. Values are linear (not tonemapped).
  std::array<std::vector<float>, 6> rgb;
  // Each axis receives a cosine-weighted approximation to its open sky fraction.
  std::array<std::vector<float>, 6> sky;
  // Four RGBA channels per probe: the visibility of the four studio disks.
  // The live renderer packs these into one RGBA8Unorm 3D texture.
  std::vector<float> studio;
  uint32_t surfelCount = 0;
  size_t count() const { return static_cast<size_t>(nx) * ny * nz; }
  bool empty() const { return !nx || !ny || !nz || rgb[0].empty(); }
};

WorldGiVolume bakeWorldGi(const std::vector<WorldGiSurfel>& surfaces,
                          WorldGiVec3 low, WorldGiVec3 high,
                          const std::array<WorldGiLight, 4>& lights,
                          float whiteWorldStrength,
                          const WorldGiConfig& config = {});

// Deterministic normal-weighted trilinear lookup; used by the portable tests and
// by the secondary-bounce source update. The Metal shader mirrors this equation.
WorldGiVec3 sampleWorldGi(const WorldGiVolume& volume, WorldGiVec3 at, WorldGiVec3 normal);
float sampleWorldSky(const WorldGiVolume& volume, WorldGiVec3 at, WorldGiVec3 normal);
std::array<float, 4> sampleWorldStudio(const WorldGiVolume& volume, WorldGiVec3 at);

} // namespace bmr
