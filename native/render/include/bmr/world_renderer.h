#pragma once
// General-purpose New-Era Metal 3.1 Bindless Real-Time Path Tracing Renderer for native 3D scenes
// (.glb / .gltf / .obj + .mtl + DDS/PNG/JPG/TGA textures + .hdr skyboxes).
// No Apple headers appear here; drawables cross as void* (matching renderer.h).
#include <cstdint>
#include <filesystem>
#include <memory>
#include <string>
#include <vector>
#include "bm/math.h"
#include "bmr/camera.h"
#include "bmr/image.h"
#include "bmr/renderer.h"

namespace bmr {

/// Full PBR mesh vertex (48 bytes): position, smooth normal, UV0, tangent (xyz) + bitangent sign (w).
struct WorldVertex {
  float p[3];
  float n[3];
  float uv[2];
  float t[4];
};
static_assert(sizeof(WorldVertex) == 48);

enum class WorldTexFormat : uint32_t {
  RGBA8 = 0,
  BC1_RGBA = 1,
  BC3_RGBA = 2,
  BC5_RG = 3,
  BC7_RGBA = 4,
};

struct WorldTextureData {
  int width = 0, height = 0, mipCount = 1;
  WorldTexFormat format = WorldTexFormat::RGBA8;
  bool srgb = true;
  float meanRgb[3] = {1.0f, 1.0f, 1.0f};  // Linear average RGB for fast zero-stall diffuse GI bounces
  std::vector<uint8_t> bytes;
  std::vector<size_t> mipOffsets;
  std::vector<uint32_t> mipRowBytes;
  std::string debugName;
};

enum class WorldAlphaMode : int {
  Opaque = 0,
  Mask = 1,
  Blend = 2,
};

struct WorldMaterial {
  float baseColor[4] = {1.0f, 1.0f, 1.0f, 1.0f};  // linear RGB + alpha
  float emissive[3] = {0.0f, 0.0f, 0.0f};         // linear HDR emissive
  float metallic = 0.0f;
  float roughness = 0.55f;
  float clearcoat = 0.0f;
  float clearcoatRoughness = 0.05f;
  float transmission = 0.0f;
  float ior = 1.5f;
  float attenuationColor[3] = {1.0f, 1.0f, 1.0f};
  float attenuationDistance = 1e6f;
  float normalScale = 1.0f;
  float normalUvScale[2] = {1.0f, 1.0f};
  float albedoUvScale[2] = {1.0f, 1.0f};
  float alphaCutoff = 0.5f;
  WorldAlphaMode alphaMode = WorldAlphaMode::Opaque;
  bool doubleSided = false;
  bool normalIsBc5 = false;
  bool mrIsObjSpecular = false;  // OBJ map_Ks/Ns heuristic vs glTF G=roughness B=metallic
  bool thinGlass = false;        // Single-sheet architectural window (Fresnel refl + straight transmission)
  int albedoTex = -1;
  int normalTex = -1;
  int mrTex = -1;
  int emissiveTex = -1;
  int alphaTex = -1;
  std::string name;
};

struct WorldMesh {
  std::vector<WorldVertex> vertices;
  std::vector<uint32_t> indices;
  int material = 0;
  bm::Box bounds;
};

struct WorldInstance {
  uint32_t mesh = 0;
  // Column-major 4x4 local->world matrix.
  float model[16] = {1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1};
};

struct WorldAsset {
  std::vector<WorldMesh> meshes;
  std::vector<WorldInstance> instances;
  std::vector<WorldMaterial> materials;
  std::vector<WorldTextureData> textures;
  bm::Box bounds;
  // Recommended initial view if known from scene layout, else invalid (hasDefaultView == false).
  bool hasDefaultView = false;
  bm::Vec3 defaultEye{0, 0, 0};
  bm::Vec3 defaultTarget{0, 0, 0};
  double defaultFovDeg = 45.0;
};

/// True for native 3D scene formats (.glb, .gltf, .obj) handled directly without LDraw conversion.
bool isWorldAssetFile(const std::filesystem::path& path);

/// Loads .glb, .gltf, or .obj (+ .mtl + PNG/JPG/TGA/BC1-BC7 DDS textures) directly into a WorldAsset.
/// Coordinates are normalized to right-handed +Y UP (standard 3D/glTF/OBJ convention).
WorldAsset loadWorldAsset(const std::filesystem::path& path, std::string* error = nullptr);

struct WorldFrameOptions {
  bool clay = false;       ///< Architectural clay / white-model GI + RT shadow mode
  bool studioRig = false;  ///< White studio 4-softbox rig instead of outdoor sun + HDRI/physical sky
  bool floor = false;      ///< Infinite studio shadow-catcher floor under bounds.min.y
  float sunDir[3] = {0.22f, 0.82f, 0.52f};  ///< Unit vector toward the sun (+Y up)
  float sunIntensity = 6.8f;
  float sunAngularRadius = 0.022f;  ///< Soft sun disk half-angle (radians)
  float skyIntensity = 1.65f;
  float exposure = 1.25f;
  float background[3] = {0.96f, 0.96f, 0.96f};
  int maxSamples = 64;
};

class WorldRenderer {
 public:
  static std::unique_ptr<WorldRenderer> create(const WorldAsset& asset, std::string* error = nullptr);
  ~WorldRenderer();
  WorldRenderer(const WorldRenderer&) = delete;
  WorldRenderer& operator=(const WorldRenderer&) = delete;

  /// Loads an equirectangular Radiance .hdr environment map for realistic skybox & IBL reflections.
  bool loadEnvironmentHdr(const std::filesystem::path& hdrPath);

  void resize(int width, int height);
  FrameStats draw(const Camera& camera, const WorldFrameOptions& options = {}, void* drawable = nullptr);
  Image readback();
  double lastGpuMs() const;
  const bm::Box& bounds() const;
  uint64_t triangleCount() const;
  uint32_t meshCount() const;
  uint32_t textureCount() const;
  void resetHistory();

 private:
  struct Impl;
  explicit WorldRenderer(std::unique_ptr<Impl> impl);
  std::unique_ptr<Impl> impl_;
};

}  // namespace bmr
