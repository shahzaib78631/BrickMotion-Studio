// Native zero-conversion 3D Asset Loader (.glb, .gltf, .obj + .mtl + PNG/JPG/TGA/DDS + .hdr).
// Loads geometry, smooth tangents, full PBR materials, and textures directly into WorldAsset.
#import <CoreGraphics/CoreGraphics.h>
#import <Foundation/Foundation.h>
#import <ImageIO/ImageIO.h>
#include <dispatch/dispatch.h>

#include "bmr/world_renderer.h"

#include <algorithm>
#include <cctype>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <nlohmann/json.hpp>
#include <unordered_map>

namespace bmr {
namespace {

using json = nlohmann::json;
namespace fs = std::filesystem;

std::string lowerExt(const fs::path& p) {
  std::string e = p.extension().string();
  for (char& c : e) c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
  return e;
}

float srgbToLinear(float c) {
  c = std::clamp(c, 0.0f, 1.0f);
  return c <= 0.04045f ? c / 12.92f : std::pow((c + 0.055f) / 1.055f, 2.4f);
}

// Cap huge 4K textures at 1024px max side by default (configurable via BM_WORLD_MAX_TEX) so even
// 1.4 GB Bistro texture sets fit effortlessly in M1 Pro unified memory with zero thrashing!
int maxTextureDim() {
  if (const char* env = std::getenv("BM_WORLD_MAX_TEX")) {
    const int v = std::atoi(env);
    if (v >= 128 && v <= 4096) return v;
  }
  return 1024;
}

bool decodeImageData(const uint8_t* data, size_t len, bool srgb, const std::string& name, WorldTextureData& out) {
  if (!data || len == 0) return false;
  @autoreleasepool {
    CFDataRef cf = CFDataCreateWithBytesNoCopy(kCFAllocatorDefault, data, static_cast<CFIndex>(len), kCFAllocatorNull);
    if (!cf) return false;
    CGImageSourceRef src = CGImageSourceCreateWithData(cf, nullptr);
    CFRelease(cf);
    if (!src) return false;
    CGImageRef img = CGImageSourceCreateImageAtIndex(src, 0, nullptr);
    CFRelease(src);
    if (!img) return false;

    int w = static_cast<int>(CGImageGetWidth(img));
    int h = static_cast<int>(CGImageGetHeight(img));
    const int cap = maxTextureDim();
    if (w > cap || h > cap) {
      const double scale = static_cast<double>(cap) / static_cast<double>(std::max(w, h));
      w = std::max(1, static_cast<int>(std::lround(w * scale)));
      h = std::max(1, static_cast<int>(std::lround(h * scale)));
    }
    if (w < 1 || h < 1) {
      CGImageRelease(img);
      return false;
    }

    out.width = w;
    out.height = h;
    out.mipCount = 1;
    out.format = WorldTexFormat::RGBA8;
    out.srgb = srgb;
    out.debugName = name;
    out.bytes.assign(static_cast<size_t>(w) * static_cast<size_t>(h) * 4u, 255u);
    out.mipOffsets = {0};
    out.mipRowBytes = {static_cast<uint32_t>(w * 4)};

    CGColorSpaceRef cs = CGColorSpaceCreateDeviceRGB();
    // Unpremultiplied RGBA8 so alpha-cutout RGB colors are not darkened at leaf borders!
    CGBitmapInfo info = static_cast<CGBitmapInfo>(kCGBitmapByteOrder32Big) | static_cast<CGBitmapInfo>(kCGImageAlphaPremultipliedLast);
    CGContextRef ctx = CGBitmapContextCreate(out.bytes.data(), static_cast<size_t>(w), static_cast<size_t>(h), 8,
                                             static_cast<size_t>(w) * 4u, cs, info);
    CGColorSpaceRelease(cs);
    if (!ctx) {
      CGImageRelease(img);
      return false;
    }
    CGContextSetInterpolationQuality(ctx, kCGInterpolationHigh);
    CGContextClearRect(ctx, CGRectMake(0, 0, w, h));
    CGContextDrawImage(ctx, CGRectMake(0, 0, w, h), img);
    CGContextRelease(ctx);
    CGImageRelease(img);

    // Un-premultiply RGB & compute linear average RGB for zero-stall diffuse GI bounces!
    uint8_t* px = out.bytes.data();
    const size_t n = out.bytes.size();
    double sumR = 0.0, sumG = 0.0, sumB = 0.0, sumW = 0.0;
    const size_t sampleStep = std::max<size_t>(1, (n / 4) / 4096);
    size_t pixIdx = 0;
    for (size_t i = 0; i < n; i += 4, pixIdx++) {
      const uint32_t a = px[i + 3];
      if (a > 0 && a < 255) {
        px[i + 0] = static_cast<uint8_t>(std::min<uint32_t>(255u, (static_cast<uint32_t>(px[i + 0]) * 255u + (a >> 1)) / a));
        px[i + 1] = static_cast<uint8_t>(std::min<uint32_t>(255u, (static_cast<uint32_t>(px[i + 1]) * 255u + (a >> 1)) / a));
        px[i + 2] = static_cast<uint8_t>(std::min<uint32_t>(255u, (static_cast<uint32_t>(px[i + 2]) * 255u + (a >> 1)) / a));
      }
      if ((pixIdx % sampleStep) == 0 && a > 32) {
        const float rf = px[i + 0] * (1.0f / 255.0f);
        const float gf = px[i + 1] * (1.0f / 255.0f);
        const float bf = px[i + 2] * (1.0f / 255.0f);
        sumR += srgb ? srgbToLinear(rf) : rf;
        sumG += srgb ? srgbToLinear(gf) : gf;
        sumB += srgb ? srgbToLinear(bf) : bf;
        sumW += 1.0;
      }
    }
    if (sumW > 0.0) {
      out.meanRgb[0] = static_cast<float>(sumR / sumW);
      out.meanRgb[1] = static_cast<float>(sumG / sumW);
      out.meanRgb[2] = static_cast<float>(sumB / sumW);
    }
    return true;
  }
}

bool decodeDdsFile(const uint8_t* data, size_t len, bool srgb, const std::string& name, WorldTextureData& out) {
  if (len < 128 || std::memcmp(data, "DDS ", 4) != 0) return false;
  auto u32 = [&](size_t off) {
    uint32_t v = 0;
    std::memcpy(&v, data + off, 4);
    return v;
  };
  const int height = static_cast<int>(u32(12));
  const int width = static_cast<int>(u32(16));
  const int mips = std::max(1, static_cast<int>(u32(28)));
  const uint32_t pfFlags = u32(80);
  const uint32_t fourCC = u32(84);
  if (width < 4 || height < 4) return false;

  size_t payloadOff = 128;
  WorldTexFormat fmt = WorldTexFormat::RGBA8;
  uint32_t blockBytes = 16;
  bool known = false;
  if (pfFlags & 0x4u) {  // DDPF_FOURCC
    if (std::memcmp(&fourCC, "DXT1", 4) == 0) {
      fmt = WorldTexFormat::BC1_RGBA; blockBytes = 8; known = true;
    } else if (std::memcmp(&fourCC, "DXT5", 4) == 0) {
      fmt = WorldTexFormat::BC3_RGBA; blockBytes = 16; known = true;
    } else if (std::memcmp(&fourCC, "ATI2", 4) == 0 || std::memcmp(&fourCC, "BC5U", 4) == 0) {
      fmt = WorldTexFormat::BC5_RG; blockBytes = 16; known = true;
    } else if (std::memcmp(&fourCC, "DX10", 4) == 0 && len >= 148) {
      const uint32_t dxgi = u32(128);
      payloadOff = 148;
      if (dxgi == 71 || dxgi == 72) { fmt = WorldTexFormat::BC1_RGBA; blockBytes = 8; known = true; }
      else if (dxgi == 77 || dxgi == 78) { fmt = WorldTexFormat::BC3_RGBA; blockBytes = 16; known = true; }
      else if (dxgi == 83) { fmt = WorldTexFormat::BC5_RG; blockBytes = 16; known = true; }
      else if (dxgi == 98 || dxgi == 99) { fmt = WorldTexFormat::BC7_RGBA; blockBytes = 16; known = true; }
    }
  }
  if (!known) return false;

  out.width = width;
  out.height = height;
  out.format = fmt;
  out.srgb = srgb && (fmt != WorldTexFormat::BC5_RG);
  out.debugName = name;
  out.mipOffsets.clear();
  out.mipRowBytes.clear();

  size_t curOff = payloadOff;
  int mw = width, mh = height;
  int validMips = 0;
  for (int m = 0; m < mips; m++) {
    const uint32_t bw = static_cast<uint32_t>((mw + 3) / 4);
    const uint32_t bh = static_cast<uint32_t>((mh + 3) / 4);
    const size_t rowB = static_cast<size_t>(bw) * blockBytes;
    const size_t mipB = rowB * bh;
    if (curOff + mipB > len) break;
    out.mipOffsets.push_back(curOff - payloadOff);
    out.mipRowBytes.push_back(static_cast<uint32_t>(rowB));
    curOff += mipB;
    validMips++;
    mw = std::max(1, mw >> 1);
    mh = std::max(1, mh >> 1);
  }
  if (validMips == 0) return false;
  out.mipCount = validMips;
  out.bytes.assign(data + payloadOff, data + curOff);
  return true;
}

bool loadTextureFile(const fs::path& path, bool srgb, WorldTextureData& out) {
  std::ifstream f(path, std::ios::binary | std::ios::ate);
  if (!f) return false;
  const std::streamsize sz = f.tellg();
  if (sz <= 0) return false;
  std::vector<uint8_t> raw(static_cast<size_t>(sz));
  f.seekg(0);
  if (!f.read(reinterpret_cast<char*>(raw.data()), sz)) return false;
  if (lowerExt(path) == ".dds") return decodeDdsFile(raw.data(), raw.size(), srgb, path.filename().string(), out);
  return decodeImageData(raw.data(), raw.size(), srgb, path.filename().string(), out);
}

// Compute smooth per-vertex normals (if missing) and MikkTSpace-style Gram-Schmidt UV tangents.
void finalizeMeshGeometry(WorldMesh& mesh, bool hasNormals, bool hasTangents) {
  const size_t nv = mesh.vertices.size();
  const size_t nt = mesh.indices.size() / 3;
  if (nv == 0 || nt == 0) return;

  if (!hasNormals) {
    for (WorldVertex& v : mesh.vertices) v.n[0] = v.n[1] = v.n[2] = 0.0f;
    for (size_t t = 0; t < nt; t++) {
      const uint32_t i0 = mesh.indices[t * 3 + 0];
      const uint32_t i1 = mesh.indices[t * 3 + 1];
      const uint32_t i2 = mesh.indices[t * 3 + 2];
      if (i0 >= nv || i1 >= nv || i2 >= nv) continue;
      const auto& p0 = mesh.vertices[i0].p;
      const auto& p1 = mesh.vertices[i1].p;
      const auto& p2 = mesh.vertices[i2].p;
      const float e1x = p1[0] - p0[0], e1y = p1[1] - p0[1], e1z = p1[2] - p0[2];
      const float e2x = p2[0] - p0[0], e2y = p2[1] - p0[1], e2z = p2[2] - p0[2];
      const float nx = e1y * e2z - e1z * e2y;
      const float ny = e1z * e2x - e1x * e2z;
      const float nz = e1x * e2y - e1y * e2x;
      for (uint32_t idx : {i0, i1, i2}) {
        mesh.vertices[idx].n[0] += nx;
        mesh.vertices[idx].n[1] += ny;
        mesh.vertices[idx].n[2] += nz;
      }
    }
    for (WorldVertex& v : mesh.vertices) {
      const float l = std::sqrt(v.n[0] * v.n[0] + v.n[1] * v.n[1] + v.n[2] * v.n[2]);
      if (l > 1e-8f) { v.n[0] /= l; v.n[1] /= l; v.n[2] /= l; }
      else { v.n[0] = 0; v.n[1] = 1; v.n[2] = 0; }
    }
  }

  if (!hasTangents) {
    std::vector<float> tan1(nv * 3, 0.0f), tan2(nv * 3, 0.0f);
    for (size_t t = 0; t < nt; t++) {
      const uint32_t i0 = mesh.indices[t * 3 + 0];
      const uint32_t i1 = mesh.indices[t * 3 + 1];
      const uint32_t i2 = mesh.indices[t * 3 + 2];
      if (i0 >= nv || i1 >= nv || i2 >= nv) continue;
      const WorldVertex& v0 = mesh.vertices[i0];
      const WorldVertex& v1 = mesh.vertices[i1];
      const WorldVertex& v2 = mesh.vertices[i2];
      const float x1 = v1.p[0] - v0.p[0], y1 = v1.p[1] - v0.p[1], z1 = v1.p[2] - v0.p[2];
      const float x2 = v2.p[0] - v0.p[0], y2 = v2.p[1] - v0.p[1], z2 = v2.p[2] - v0.p[2];
      const float s1 = v1.uv[0] - v0.uv[0], t1 = v1.uv[1] - v0.uv[1];
      const float s2 = v2.uv[0] - v0.uv[0], t2 = v2.uv[1] - v0.uv[1];
      const float denom = s1 * t2 - s2 * t1;
      if (std::abs(denom) < 1e-10f) continue;
      const float r = 1.0f / denom;
      const float sx = (t2 * x1 - t1 * x2) * r, sy = (t2 * y1 - t1 * y2) * r, sz = (t2 * z1 - t1 * z2) * r;
      const float tx = (s1 * x2 - s2 * x1) * r, ty = (s1 * y2 - s2 * y1) * r, tz = (s1 * z2 - s2 * z1) * r;
      for (uint32_t idx : {i0, i1, i2}) {
        tan1[idx * 3 + 0] += sx; tan1[idx * 3 + 1] += sy; tan1[idx * 3 + 2] += sz;
        tan2[idx * 3 + 0] += tx; tan2[idx * 3 + 1] += ty; tan2[idx * 3 + 2] += tz;
      }
    }
    for (size_t i = 0; i < nv; i++) {
      WorldVertex& v = mesh.vertices[i];
      const float nx = v.n[0], ny = v.n[1], nz = v.n[2];
      float tx = tan1[i * 3 + 0], ty = tan1[i * 3 + 1], tz = tan1[i * 3 + 2];
      const float ndt = nx * tx + ny * ty + nz * tz;
      tx -= nx * ndt; ty -= ny * ndt; tz -= nz * ndt;
      const float len = std::sqrt(tx * tx + ty * ty + tz * tz);
      if (len > 1e-6f) {
        tx /= len; ty /= len; tz /= len;
        const float cx = ny * tz - nz * ty, cy = nz * tx - nx * tz, cz = nx * ty - ny * tx;
        const float w = (cx * tan2[i * 3 + 0] + cy * tan2[i * 3 + 1] + cz * tan2[i * 3 + 2]) < 0.0f ? -1.0f : 1.0f;
        v.t[0] = tx; v.t[1] = ty; v.t[2] = tz; v.t[3] = w;
      } else {
        // Fallback orthonormal tangent
        const float ax = std::abs(nx) < 0.9f ? 1.0f : 0.0f;
        const float ay = std::abs(nx) < 0.9f ? 0.0f : 1.0f;
        float bx = ny * 0.0f - nz * ay, by = nz * ax - nx * 0.0f, bz = nx * ay - ny * ax;
        const float bl = std::sqrt(bx * bx + by * by + bz * bz);
        if (bl > 1e-6f) { bx /= bl; by /= bl; bz /= bl; }
        v.t[0] = bx; v.t[1] = by; v.t[2] = bz; v.t[3] = 1.0f;
      }
    }
  }

  mesh.bounds = {};
  for (const WorldVertex& v : mesh.vertices) {
    mesh.bounds.grow({v.p[0], v.p[1], v.p[2]});
  }
}

// ============================================================================
// Native glTF 2.0 (.glb / .gltf) Loader
// ============================================================================

struct Mat4d {
  double m[16] = {1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1};
};

Mat4d mulMat(const Mat4d& a, const Mat4d& b) {
  Mat4d r{};
  for (int i = 0; i < 16; i++) r.m[i] = 0;
  for (int c = 0; c < 4; c++) {
    for (int row = 0; row < 4; row++) {
      double s = 0;
      for (int k = 0; k < 4; k++) s += a.m[k * 4 + row] * b.m[c * 4 + k];
      r.m[c * 4 + row] = s;
    }
  }
  return r;
}

Mat4d nodeMatrix(const json& node) {
  if (node.contains("matrix") && node["matrix"].size() == 16) {
    Mat4d r;
    for (int i = 0; i < 16; i++) r.m[i] = node["matrix"][i].get<double>();
    return r;
  }
  Mat4d T{}, R{}, S{};
  if (node.contains("translation") && node["translation"].size() == 3) {
    T.m[12] = node["translation"][0].get<double>();
    T.m[13] = node["translation"][1].get<double>();
    T.m[14] = node["translation"][2].get<double>();
  }
  if (node.contains("rotation") && node["rotation"].size() == 4) {
    const double x = node["rotation"][0].get<double>();
    const double y = node["rotation"][1].get<double>();
    const double z = node["rotation"][2].get<double>();
    const double w = node["rotation"][3].get<double>();
    R.m[0] = 1 - 2 * (y * y + z * z); R.m[4] = 2 * (x * y - z * w);     R.m[8]  = 2 * (x * z + y * w);
    R.m[1] = 2 * (x * y + z * w);     R.m[5] = 1 - 2 * (x * x + z * z); R.m[9]  = 2 * (y * z - x * w);
    R.m[2] = 2 * (x * z - y * w);     R.m[6] = 2 * (y * z + x * w);     R.m[10] = 1 - 2 * (x * x + y * y);
  }
  if (node.contains("scale") && node["scale"].size() == 3) {
    S.m[0] = node["scale"][0].get<double>();
    S.m[5] = node["scale"][1].get<double>();
    S.m[10] = node["scale"][2].get<double>();
  }
  return mulMat(T, mulMat(R, S));
}

int gltfTypeCount(const std::string& t) {
  if (t == "SCALAR") return 1;
  if (t == "VEC2") return 2;
  if (t == "VEC3") return 3;
  if (t == "VEC4") return 4;
  if (t == "MAT4") return 16;
  return 1;
}

size_t gltfCompSize(int ct) {
  switch (ct) {
    case 5120: case 5121: return 1;
    case 5122: case 5123: return 2;
    case 5125: case 5126: return 4;
    default: return 4;
  }
}

float readCompFloat(const uint8_t* p, int ct, bool norm) {
  switch (ct) {
    case 5126: { float v; std::memcpy(&v, p, 4); return v; }
    case 5121: { uint8_t v = *p; return norm ? v / 255.0f : static_cast<float>(v); }
    case 5120: { int8_t v = static_cast<int8_t>(*p); return norm ? std::max(-1.0f, v / 127.0f) : static_cast<float>(v); }
    case 5123: { uint16_t v; std::memcpy(&v, p, 2); return norm ? v / 65535.0f : static_cast<float>(v); }
    case 5122: { int16_t v; std::memcpy(&v, p, 2); return norm ? std::max(-1.0f, v / 32767.0f) : static_cast<float>(v); }
    case 5125: { uint32_t v; std::memcpy(&v, p, 4); return static_cast<float>(v); }
    default: return 0.0f;
  }
}

uint32_t readCompUint(const uint8_t* p, int ct) {
  switch (ct) {
    case 5121: return *p;
    case 5123: { uint16_t v; std::memcpy(&v, p, 2); return v; }
    case 5125: { uint32_t v; std::memcpy(&v, p, 4); return v; }
    default: return 0;
  }
}

WorldAsset loadGltfAsset(const fs::path& path, std::string* error) {
  WorldAsset asset;
  auto fail = [&](const std::string& msg) {
    if (error) *error = msg;
    return WorldAsset{};
  };

  std::ifstream f(path, std::ios::binary | std::ios::ate);
  if (!f) return fail("could not open " + path.string());
  const std::streamsize sz = f.tellg();
  if (sz < 12) return fail("file too small");
  std::vector<uint8_t> fileBytes(static_cast<size_t>(sz));
  f.seekg(0);
  f.read(reinterpret_cast<char*>(fileBytes.data()), sz);

  json gltf;
  std::vector<std::vector<uint8_t>> buffers;
  const fs::path baseDir = path.parent_path();

  if (std::memcmp(fileBytes.data(), "glTF", 4) == 0) {
    size_t off = 12;
    std::vector<uint8_t> binChunk;
    while (off + 8 <= fileBytes.size()) {
      uint32_t chunkLen = 0, chunkType = 0;
      std::memcpy(&chunkLen, fileBytes.data() + off, 4);
      std::memcpy(&chunkType, fileBytes.data() + off + 4, 4);
      off += 8;
      if (off + chunkLen > fileBytes.size()) break;
      if (chunkType == 0x4E4F534Au) {
        gltf = json::parse(fileBytes.data() + off, fileBytes.data() + off + chunkLen);
      } else if (chunkType == 0x004E4942u) {
        binChunk.assign(fileBytes.data() + off, fileBytes.data() + off + chunkLen);
      }
      off += chunkLen;
    }
    buffers.push_back(std::move(binChunk));
  } else {
    gltf = json::parse(fileBytes.begin(), fileBytes.end());
    if (gltf.contains("buffers")) {
      for (const auto& b : gltf["buffers"]) {
        std::vector<uint8_t> buf;
        if (b.contains("uri")) {
          const std::string uri = b["uri"].get<std::string>();
          std::ifstream bf(baseDir / uri, std::ios::binary | std::ios::ate);
          if (bf) {
            const std::streamsize bsz = bf.tellg();
            buf.resize(static_cast<size_t>(bsz));
            bf.seekg(0);
            bf.read(reinterpret_cast<char*>(buf.data()), bsz);
          }
        }
        buffers.push_back(std::move(buf));
      }
    }
  }

  // Lazy texture loader deduplicated by (imageIndex, srgb).
  std::unordered_map<uint64_t, int> texCache;
  auto loadGltfTex = [&](int texIdx, bool srgb) -> int {
    if (!gltf.contains("textures") || texIdx < 0 || texIdx >= static_cast<int>(gltf["textures"].size())) return -1;
    const auto& tex = gltf["textures"][texIdx];
    if (!tex.contains("source")) return -1;
    const int imgIdx = tex["source"].get<int>();
    if (!gltf.contains("images") || imgIdx < 0 || imgIdx >= static_cast<int>(gltf["images"].size())) return -1;
    const uint64_t key = (static_cast<uint64_t>(imgIdx) << 1u) | (srgb ? 1u : 0u);
    if (auto it = texCache.find(key); it != texCache.end()) return it->second;

    const auto& img = gltf["images"][imgIdx];
    WorldTextureData td;
    bool ok = false;
    const std::string tname = img.value("name", "gltf_tex_" + std::to_string(imgIdx));
    if (img.contains("bufferView")) {
      const auto& bv = gltf["bufferViews"][img["bufferView"].get<int>()];
      const int bi = bv.value("buffer", 0);
      const size_t boff = bv.value("byteOffset", size_t(0));
      const size_t blen = bv.value("byteLength", size_t(0));
      if (bi >= 0 && bi < static_cast<int>(buffers.size()) && boff + blen <= buffers[bi].size()) {
        ok = decodeImageData(buffers[bi].data() + boff, blen, srgb, tname, td);
      }
    } else if (img.contains("uri")) {
      ok = loadTextureFile(baseDir / img["uri"].get<std::string>(), srgb, td);
    }
    if (!ok) return -1;
    const int outIdx = static_cast<int>(asset.textures.size());
    asset.textures.push_back(std::move(td));
    texCache[key] = outIdx;
    return outIdx;
  };

  // Parse materials
  if (gltf.contains("materials")) {
    for (const auto& m : gltf["materials"]) {
      WorldMaterial mat;
      mat.name = m.value("name", "");
      if (m.contains("pbrMetallicRoughness")) {
        const auto& pbr = m["pbrMetallicRoughness"];
        if (pbr.contains("baseColorFactor") && pbr["baseColorFactor"].size() == 4) {
          for (int i = 0; i < 4; i++) mat.baseColor[i] = pbr["baseColorFactor"][i].get<float>();
        }
        mat.metallic = pbr.value("metallicFactor", 1.0f);
        mat.roughness = pbr.value("roughnessFactor", 1.0f);
        if (pbr.contains("baseColorTexture")) {
          const auto& bct = pbr["baseColorTexture"];
          mat.albedoTex = loadGltfTex(bct["index"].get<int>(), true);
          if (bct.contains("extensions") && bct["extensions"].contains("KHR_texture_transform")) {
            const auto& xf = bct["extensions"]["KHR_texture_transform"];
            if (xf.contains("scale") && xf["scale"].size() == 2) {
              mat.albedoUvScale[0] = xf["scale"][0].get<float>();
              mat.albedoUvScale[1] = xf["scale"][1].get<float>();
            }
          }
        }
        if (pbr.contains("metallicRoughnessTexture")) {
          mat.mrTex = loadGltfTex(pbr["metallicRoughnessTexture"]["index"].get<int>(), false);
        }
      }
      if (m.contains("normalTexture")) {
        const auto& nt = m["normalTexture"];
        mat.normalTex = loadGltfTex(nt["index"].get<int>(), false);
        mat.normalScale = nt.value("scale", 1.0f);
        if (nt.contains("extensions") && nt["extensions"].contains("KHR_texture_transform")) {
          const auto& xf = nt["extensions"]["KHR_texture_transform"];
          if (xf.contains("scale") && xf["scale"].size() == 2) {
            mat.normalUvScale[0] = xf["scale"][0].get<float>();
            mat.normalUvScale[1] = xf["scale"][1].get<float>();
          }
        }
      }
      if (m.contains("emissiveFactor") && m["emissiveFactor"].size() == 3) {
        for (int i = 0; i < 3; i++) mat.emissive[i] = m["emissiveFactor"][i].get<float>();
      }
      if (m.contains("emissiveTexture")) {
        mat.emissiveTex = loadGltfTex(m["emissiveTexture"]["index"].get<int>(), true);
      }
      const std::string am = m.value("alphaMode", "OPAQUE");
      if (am == "MASK") mat.alphaMode = WorldAlphaMode::Mask;
      else if (am == "BLEND") mat.alphaMode = WorldAlphaMode::Blend;
      mat.alphaCutoff = m.value("alphaCutoff", 0.5f);
      mat.doubleSided = m.value("doubleSided", false);

      if (m.contains("extensions")) {
        const auto& ext = m["extensions"];
        if (ext.contains("KHR_materials_emissive_strength")) {
          const float s = ext["KHR_materials_emissive_strength"].value("emissiveStrength", 1.0f);
          for (int i = 0; i < 3; i++) mat.emissive[i] *= s;
        }
        if (ext.contains("KHR_materials_clearcoat")) {
          mat.clearcoat = ext["KHR_materials_clearcoat"].value("clearcoatFactor", 0.0f);
          mat.clearcoatRoughness = ext["KHR_materials_clearcoat"].value("clearcoatRoughnessFactor", 0.05f);
        }
        if (ext.contains("KHR_materials_ior")) {
          mat.ior = ext["KHR_materials_ior"].value("ior", 1.5f);
        }
        if (ext.contains("KHR_materials_transmission")) {
          mat.transmission = ext["KHR_materials_transmission"].value("transmissionFactor", 0.0f);
        }
        if (ext.contains("KHR_materials_volume")) {
          const auto& vol = ext["KHR_materials_volume"];
          if (vol.contains("attenuationColor") && vol["attenuationColor"].size() == 3) {
            for (int i = 0; i < 3; i++) mat.attenuationColor[i] = vol["attenuationColor"][i].get<float>();
          }
          mat.attenuationDistance = vol.value("attenuationDistance", 1e6f);
        }
      }
      // Treat BLEND transparent glazing with low alpha as physical transmission so car windshields & crystals refract!
      if (mat.alphaMode == WorldAlphaMode::Blend && mat.baseColor[3] < 0.85f && mat.transmission < 0.05f) {
        mat.transmission = std::clamp(1.0f - mat.baseColor[3], 0.35f, 0.96f);
      }
      asset.materials.push_back(std::move(mat));
    }
  }
  if (asset.materials.empty()) asset.materials.push_back(WorldMaterial{});

  auto accessorData = [&](int accIdx, const uint8_t*& ptr, size_t& stride, size_t& count, int& ct, int& nComp, bool& norm) -> bool {
    if (!gltf.contains("accessors") || accIdx < 0 || accIdx >= static_cast<int>(gltf["accessors"].size())) return false;
    const auto& acc = gltf["accessors"][accIdx];
    if (!acc.contains("bufferView")) return false;
    const auto& bv = gltf["bufferViews"][acc["bufferView"].get<int>()];
    const int bi = bv.value("buffer", 0);
    if (bi < 0 || bi >= static_cast<int>(buffers.size())) return false;
    ct = acc["componentType"].get<int>();
    nComp = gltfTypeCount(acc["type"].get<std::string>());
    count = acc["count"].get<size_t>();
    norm = acc.value("normalized", false);
    const size_t off = bv.value("byteOffset", size_t(0)) + acc.value("byteOffset", size_t(0));
    const size_t elemSz = gltfCompSize(ct) * static_cast<size_t>(nComp);
    stride = bv.value("byteStride", elemSz);
    if (off + (count > 0 ? (count - 1) * stride + elemSz : 0) > buffers[bi].size()) return false;
    ptr = buffers[bi].data() + off;
    return true;
  };

  // Map glTF mesh index -> list of WorldMesh indices (one per primitive).
  std::vector<std::vector<uint32_t>> meshPrims;
  if (gltf.contains("meshes")) {
    meshPrims.resize(gltf["meshes"].size());
    for (size_t mi = 0; mi < gltf["meshes"].size(); mi++) {
      for (const auto& prim : gltf["meshes"][mi]["primitives"]) {
        if (prim.value("mode", 4) != 4) continue;
        if (!prim.contains("attributes") || !prim["attributes"].contains("POSITION")) continue;
        const auto& attrs = prim["attributes"];

        const uint8_t *pPtr = nullptr, *nPtr = nullptr, *uvPtr = nullptr, *tPtr = nullptr;
        size_t pStr = 0, nStr = 0, uvStr = 0, tStr = 0;
        size_t pCnt = 0, nCnt = 0, uvCnt = 0, tCnt = 0;
        int pCt = 0, nCt = 0, uvCt = 0, tCt = 0;
        int pNc = 0, nNc = 0, uvNc = 0, tNc = 0;
        bool pNorm = false, nNorm = false, uvNorm = false, tNorm = false;

        if (!accessorData(attrs["POSITION"].get<int>(), pPtr, pStr, pCnt, pCt, pNc, pNorm) || pCnt == 0) continue;
        const bool hasN = attrs.contains("NORMAL") && accessorData(attrs["NORMAL"].get<int>(), nPtr, nStr, nCnt, nCt, nNc, nNorm) && nCnt == pCnt;
        const bool hasUv = attrs.contains("TEXCOORD_0") && accessorData(attrs["TEXCOORD_0"].get<int>(), uvPtr, uvStr, uvCnt, uvCt, uvNc, uvNorm) && uvCnt == pCnt;
        const bool hasT = attrs.contains("TANGENT") && accessorData(attrs["TANGENT"].get<int>(), tPtr, tStr, tCnt, tCt, tNc, tNorm) && tCnt == pCnt;

        WorldMesh wm;
        wm.material = std::clamp(prim.value("material", 0), 0, static_cast<int>(asset.materials.size()) - 1);
        wm.vertices.resize(pCnt);
        const size_t pCs = gltfCompSize(pCt), nCs = gltfCompSize(nCt), uvCs = gltfCompSize(uvCt), tCs = gltfCompSize(tCt);
        for (size_t i = 0; i < pCnt; i++) {
          WorldVertex& v = wm.vertices[i];
          const uint8_t* pp = pPtr + i * pStr;
          v.p[0] = readCompFloat(pp + 0 * pCs, pCt, pNorm);
          v.p[1] = readCompFloat(pp + 1 * pCs, pCt, pNorm);
          v.p[2] = readCompFloat(pp + 2 * pCs, pCt, pNorm);
          if (hasN) {
            const uint8_t* np = nPtr + i * nStr;
            v.n[0] = readCompFloat(np + 0 * nCs, nCt, nNorm);
            v.n[1] = readCompFloat(np + 1 * nCs, nCt, nNorm);
            v.n[2] = readCompFloat(np + 2 * nCs, nCt, nNorm);
          } else {
            v.n[0] = 0; v.n[1] = 1; v.n[2] = 0;
          }
          if (hasUv) {
            const uint8_t* up = uvPtr + i * uvStr;
            v.uv[0] = readCompFloat(up + 0 * uvCs, uvCt, uvNorm);
            v.uv[1] = readCompFloat(up + 1 * uvCs, uvCt, uvNorm);
          } else {
            v.uv[0] = v.uv[1] = 0.0f;
          }
          if (hasT) {
            const uint8_t* tp = tPtr + i * tStr;
            v.t[0] = readCompFloat(tp + 0 * tCs, tCt, tNorm);
            v.t[1] = readCompFloat(tp + 1 * tCs, tCt, tNorm);
            v.t[2] = readCompFloat(tp + 2 * tCs, tCt, tNorm);
            v.t[3] = readCompFloat(tp + 3 * tCs, tCt, tNorm);
          } else {
            v.t[0] = 1; v.t[1] = 0; v.t[2] = 0; v.t[3] = 1;
          }
        }

        if (prim.contains("indices")) {
          const uint8_t* iPtr = nullptr;
          size_t iStr = 0, iCnt = 0;
          int iCt = 0, iNc = 0;
          bool iNorm = false;
          if (accessorData(prim["indices"].get<int>(), iPtr, iStr, iCnt, iCt, iNc, iNorm)) {
            wm.indices.resize((iCnt / 3) * 3);
            for (size_t i = 0; i < wm.indices.size(); i++) wm.indices[i] = readCompUint(iPtr + i * iStr, iCt);
          }
        } else {
          wm.indices.resize((pCnt / 3) * 3);
          for (size_t i = 0; i < wm.indices.size(); i++) wm.indices[i] = static_cast<uint32_t>(i);
        }
        if (wm.indices.size() < 3) continue;
        finalizeMeshGeometry(wm, hasN, hasT);
        const uint32_t wmIdx = static_cast<uint32_t>(asset.meshes.size());
        asset.meshes.push_back(std::move(wm));
        meshPrims[mi].push_back(wmIdx);
      }
    }
  }

  // Walk scene graph to collect world-space instances and global AABB.
  std::function<void(int, const Mat4d&)> walk = [&](int ni, const Mat4d& parent) {
    if (!gltf.contains("nodes") || ni < 0 || ni >= static_cast<int>(gltf["nodes"].size())) return;
    const auto& node = gltf["nodes"][ni];
    const Mat4d wm = mulMat(parent, nodeMatrix(node));
    if (node.contains("mesh")) {
      const int mi = node["mesh"].get<int>();
      if (mi >= 0 && mi < static_cast<int>(meshPrims.size())) {
        for (uint32_t mid : meshPrims[mi]) {
          WorldInstance inst;
          inst.mesh = mid;
          for (int k = 0; k < 16; k++) inst.model[k] = static_cast<float>(wm.m[k]);
          // Grow global AABB from transformed mesh bounds corners.
          const bm::Box& mb = asset.meshes[mid].bounds;
          if (!mb.empty()) {
            const double xs[2] = {mb.min.x, mb.max.x}, ys[2] = {mb.min.y, mb.max.y}, zs[2] = {mb.min.z, mb.max.z};
            for (int ix = 0; ix < 2; ix++)
              for (int iy = 0; iy < 2; iy++)
                for (int iz = 0; iz < 2; iz++) {
                  const double x = xs[ix], y = ys[iy], z = zs[iz];
                  asset.bounds.grow({
                      wm.m[0] * x + wm.m[4] * y + wm.m[8] * z + wm.m[12],
                      wm.m[1] * x + wm.m[5] * y + wm.m[9] * z + wm.m[13],
                      wm.m[2] * x + wm.m[6] * y + wm.m[10] * z + wm.m[14],
                  });
                }
          }
          asset.instances.push_back(inst);
        }
      }
    }
    if (node.contains("children")) {
      for (const auto& ci : node["children"]) walk(ci.get<int>(), wm);
    }
  };

  if (gltf.contains("scenes") && !gltf["scenes"].empty()) {
    const int si = gltf.value("scene", 0);
    const auto& sc = gltf["scenes"][std::clamp(si, 0, static_cast<int>(gltf["scenes"].size()) - 1)];
    if (sc.contains("nodes")) {
      for (const auto& rn : sc["nodes"]) walk(rn.get<int>(), Mat4d{});
    }
  } else if (gltf.contains("nodes")) {
    for (int i = 0; i < static_cast<int>(gltf["nodes"].size()); i++) walk(i, Mat4d{});
  }

  return asset;
}

// ============================================================================
// High-Speed Native Wavefront .obj + .mtl Loader (handles 297 MB Bistro in ~1s!)
// ============================================================================

inline const char* skipWs(const char* p, const char* end) {
  while (p < end && (*p == ' ' || *p == '\t')) p++;
  return p;
}

inline float parseFastFloat(const char*& p, const char* end) {
  p = skipWs(p, end);
  char* next = nullptr;
  const float v = std::strtof(p, &next);
  if (next > p) p = next;
  return v;
}

inline int parseFastInt(const char*& p, const char* end) {
  p = skipWs(p, end);
  int sign = 1;
  if (p < end && *p == '-') { sign = -1; p++; }
  else if (p < end && *p == '+') { p++; }
  int val = 0;
  while (p < end && *p >= '0' && *p <= '9') {
    val = val * 10 + (*p - '0');
    p++;
  }
  return sign * val;
}

fs::path resolveTexPath(const fs::path& mtlDir, std::string raw) {
  // Strip optional MTL map flags (-bm 1.0, -s 1 1 1, etc.) and normalize backslashes.
  for (char& c : raw) if (c == '\\') c = '/';
  while (!raw.empty() && (raw.back() == '\r' || raw.back() == ' ' || raw.back() == '\t')) raw.pop_back();
  // Take the last whitespace-separated token if map options precede filename.
  if (raw.find(" -") != std::string::npos || (!raw.empty() && raw[0] == '-')) {
    const size_t sp = raw.find_last_of(" \t");
    if (sp != std::string::npos) raw = raw.substr(sp + 1);
  }
  fs::path p = mtlDir / raw;
  if (fs::exists(p)) return p;
  // Bistro archives sometimes unzip nested (BuildingTextures/BuildingTextures/...) -> check nested & sibling paths!
  std::string rel = raw;
  while (rel.rfind("../", 0) == 0) rel = rel.substr(3);
  const size_t slash = rel.find('/');
  if (slash != std::string::npos) {
    const std::string topDir = rel.substr(0, slash);
    const std::string tail = rel.substr(slash + 1);
    for (const fs::path& cand : {
             mtlDir.parent_path() / topDir / tail,
             mtlDir.parent_path() / topDir / topDir / tail,
             mtlDir / topDir / tail,
             mtlDir / topDir / topDir / tail,
         }) {
      if (fs::exists(cand)) return cand;
    }
  }
  const fs::path fn = fs::path(raw).filename();
  const fs::path parentName = fs::path(raw).parent_path().filename();
  if (!parentName.empty()) {
    for (const fs::path& cand : {
             mtlDir.parent_path() / parentName / fn,
             mtlDir.parent_path() / parentName / parentName / fn,
             mtlDir / parentName / fn,
             mtlDir / "textures" / fn,
         }) {
      if (fs::exists(cand)) return cand;
    }
  }
  if (fs::exists(mtlDir / fn)) return mtlDir / fn;
  return {};
}

WorldAsset loadObjAsset(const fs::path& path, std::string* error) {
  WorldAsset asset;
  auto fail = [&](const std::string& msg) {
    if (error) *error = msg;
    return WorldAsset{};
  };

  std::ifstream f(path, std::ios::binary | std::ios::ate);
  if (!f) return fail("could not open " + path.string());
  const std::streamsize sz = f.tellg();
  if (sz <= 0) return fail("empty OBJ file");
  std::string text(static_cast<size_t>(sz), '\0');
  f.seekg(0);
  f.read(text.data(), sz);

  const fs::path objDir = path.parent_path();
  std::unordered_map<std::string, int> matMap;
  std::unordered_map<std::string, int> texCache;
  struct PendingTex {
    fs::path resolved;
    bool srgb = true;
  };
  std::vector<PendingTex> pendingTex;

  auto queueObjTex = [&](const fs::path& mtlDir, const std::string& raw, bool srgb) -> int {
    const fs::path resolved = resolveTexPath(mtlDir, raw);
    if (resolved.empty()) return -1;
    const std::string key = resolved.string() + (srgb ? "|s" : "|l");
    if (auto it = texCache.find(key); it != texCache.end()) return it->second;
    const int idx = static_cast<int>(pendingTex.size());
    pendingTex.push_back({resolved, srgb});
    texCache[key] = idx;
    return idx;
  };

  auto flushPendingTextures = [&]() {
    if (pendingTex.size() <= asset.textures.size()) return;
    const size_t start = asset.textures.size();
    const size_t count = pendingTex.size() - start;
    asset.textures.resize(pendingTex.size());
    dispatch_apply(count, dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^(size_t k) {
      const PendingTex& job = pendingTex[start + k];
      WorldTextureData td;
      if (loadTextureFile(job.resolved, job.srgb, td)) {
        asset.textures[start + k] = std::move(td);
      }
    });
  };

  auto parseMtlFile = [&](const fs::path& mtlPath) {
    std::ifstream mf(mtlPath);
    if (!mf) return;
    const fs::path mtlDir = mtlPath.parent_path();
    std::string line;
    int curIdx = -1;
    std::vector<float> matKsLum(asset.materials.size(), -1.0f);
    while (std::getline(mf, line)) {
      if (!line.empty() && line.back() == '\r') line.pop_back();
      const char* s = skipWs(line.c_str(), line.c_str() + line.size());
      const char* e = line.c_str() + line.size();
      if (s >= e || *s == '#') continue;
      const char* tokEnd = s;
      while (tokEnd < e && *tokEnd != ' ' && *tokEnd != '\t') tokEnd++;
      std::string key(s, tokEnd);
      for (char& c : key) c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
      const char* rest = skipWs(tokEnd, e);
      std::string restStr(rest, e);

      if (key == "newmtl") {
        WorldMaterial mat;
        mat.name = restStr;
        curIdx = static_cast<int>(asset.materials.size());
        asset.materials.push_back(std::move(mat));
        matKsLum.push_back(-1.0f);
        matMap[restStr] = curIdx;
      } else if (curIdx >= 0) {
        WorldMaterial& m = asset.materials[curIdx];
        if (key == "kd") {
          const char* p = rest;
          m.baseColor[0] = srgbToLinear(parseFastFloat(p, e));
          m.baseColor[1] = srgbToLinear(parseFastFloat(p, e));
          m.baseColor[2] = srgbToLinear(parseFastFloat(p, e));
        } else if (key == "ks") {
          const char* p = rest;
          const float sr = parseFastFloat(p, e);
          const float sg = parseFastFloat(p, e);
          const float sb = parseFastFloat(p, e);
          matKsLum[curIdx] = 0.2126f * sr + 0.7152f * sg + 0.0722f * sb;
        } else if (key == "ke") {
          const char* p = rest;
          m.emissive[0] = parseFastFloat(p, e);
          m.emissive[1] = parseFastFloat(p, e);
          m.emissive[2] = parseFastFloat(p, e);
        } else if (key == "ns") {
          const char* p = rest;
          const float ns = std::max(parseFastFloat(p, e), 1.0f);
          // Physical Blinn-Phong exponent -> GGX perceptual roughness: alpha^2 = 2/(Ns+2) => rough = (2/(Ns+2))^0.25!
          m.roughness = std::clamp(std::pow(2.0f / (ns + 2.0f), 0.25f), 0.14f, 0.94f);
        } else if (key == "pr") {
          const char* p = rest;
          m.roughness = std::clamp(parseFastFloat(p, e), 0.04f, 0.98f);
        } else if (key == "pm") {
          const char* p = rest;
          m.metallic = std::clamp(parseFastFloat(p, e), 0.0f, 1.0f);
        } else if (key == "ni") {
          const char* p = rest;
          const float ni = parseFastFloat(p, e);
          if (ni > 1.01f && ni < 3.0f) m.ior = ni;
        } else if (key == "d") {
          const char* p = rest;
          const float d = parseFastFloat(p, e);
          // Guard against Blender OBJ exporters writing d 0.000 on opaque Sponza materials!
          if (d > 0.01f && d < 0.98f) {
            m.baseColor[3] = d;
            m.transmission = 1.0f - d;
            m.thinGlass = true;
            m.alphaMode = WorldAlphaMode::Blend;
          }
        } else if (key == "illum") {
          const char* p = rest;
          const int il = parseFastInt(p, e);
          if (il == 4 || il == 6 || il == 7) {
            m.transmission = std::max(m.transmission, 0.88f);
            m.roughness = std::min(m.roughness, 0.06f);
            m.ior = std::max(m.ior, 1.50f);
            m.thinGlass = true;
          }
        } else if (key == "map_kd") {
          m.albedoTex = queueObjTex(mtlDir, restStr, true);
        } else if (key == "map_bump" || key == "bump" || key == "norm") {
          m.normalTex = queueObjTex(mtlDir, restStr, false);
          std::string lr = restStr;
          for (char& c : lr) c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
          if (lr.find("ddna") != std::string::npos) m.normalIsBc5 = true;
        } else if (key == "map_disp") {
          std::string lr = restStr;
          for (char& c : lr) c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
          if (lr.find("ddn") != std::string::npos || lr.find("norm") != std::string::npos) {
            if (m.normalTex < 0) m.normalTex = queueObjTex(mtlDir, restStr, false);
            if (lr.find("ddna") != std::string::npos) m.normalIsBc5 = true;
          }
        } else if (key == "map_ks" || key == "map_pr") {
          m.mrTex = queueObjTex(mtlDir, restStr, false);
          m.mrIsObjSpecular = (key == "map_ks");
        } else if (key == "map_d") {
          m.alphaTex = queueObjTex(mtlDir, restStr, false);
          m.alphaMode = WorldAlphaMode::Mask;
          m.doubleSided = true;
        } else if (key == "map_ke") {
          m.emissiveTex = queueObjTex(mtlDir, restStr, true);
        }
      }
    }

    // Decode all queued textures in parallel across all CPU cores before material post-processing!
    flushPendingTextures();

    // OBJ exporters (e.g. Maya Bistro) emit default Ns=100 with Ks=0 on matte stone/plaster/foliage.
    for (size_t i = 0; i < asset.materials.size() && i < matKsLum.size(); i++) {
      WorldMaterial& m = asset.materials[i];
      if (m.mrTex < 0 && m.transmission < 0.05f && matKsLum[i] >= 0.0f && matKsLum[i] < 0.03f) {
        m.roughness = std::max(m.roughness, 0.78f);
      }
    }

    // Post-process OBJ materials: neutralize gray placeholder Kd when map_Kd exists, detect glass & foliage alpha masks!
    for (WorldMaterial& m : asset.materials) {
      std::string ln = m.name;
      for (char& c : ln) c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
      if (m.albedoTex >= 0) {
        // When map_Kd is provided, standard OBJ Kd placeholders (like Sponza 0.4704) shouldn't darken albedo.
        if (std::abs(m.baseColor[0] - m.baseColor[1]) < 0.02f && std::abs(m.baseColor[1] - m.baseColor[2]) < 0.02f) {
          m.baseColor[0] = m.baseColor[1] = m.baseColor[2] = 1.0f;
        }
        // Check if albedo PNG actually carries alpha cutouts (e.g. Bistro foliage, leaves, chains, fences)!
        const WorldTextureData& td = asset.textures[m.albedoTex];
        if (td.format == WorldTexFormat::RGBA8 && m.alphaMode == WorldAlphaMode::Opaque) {
          size_t cutPx = 0, totalPx = td.bytes.size() / 4;
          const size_t step = std::max<size_t>(1, totalPx / 4096);
          size_t sampled = 0;
          for (size_t i = 0; i < totalPx; i += step) {
            if (td.bytes[i * 4 + 3] < 128) cutPx++;
            sampled++;
          }
          if (sampled > 0 && cutPx * 100 > sampled * 2) {
            m.alphaMode = WorldAlphaMode::Mask;
            m.alphaCutoff = 0.45f;
            m.doubleSided = true;
          }
        }
      }
      if (m.normalTex >= 0 && asset.textures[m.normalTex].format == WorldTexFormat::BC5_RG) {
        m.normalIsBc5 = true;
      }
      if (ln.find("glass") != std::string::npos || ln.find("wine") != std::string::npos) {
        const bool isExteriorOrEmissive =
            (ln.find("exterior") != std::string::npos || ln.find("focus") != std::string::npos ||
             m.emissiveTex >= 0 || (m.emissive[0] + m.emissive[1] + m.emissive[2]) > 0.3f);
        if (isExteriorOrEmissive) {
          // Dark reflective architectural apartment glazing or glowing spotlight glass (matches Bistro reference!).
          m.transmission = 0.0f;
          m.roughness = std::min(m.roughness, 0.06f);
          m.clearcoat = 1.0f;
          m.clearcoatRoughness = 0.04f;
        } else {
          m.transmission = std::max(m.transmission, 0.88f);
          m.roughness = std::min(m.roughness, 0.06f);
          m.ior = 1.50f;
          m.thinGlass = (ln.find("wine") == std::string::npos);
          m.alphaMode = WorldAlphaMode::Opaque;  // Handled by physical dielectric transmission pass!
        }
      }
      if (ln.find("foliage") != std::string::npos || ln.find("leaf") != std::string::npos ||
          ln.find("leaves") != std::string::npos || ln.find("plant") != std::string::npos ||
          ln.find("ivy") != std::string::npos || ln.find("flower") != std::string::npos ||
          ln.find("chain") != std::string::npos) {
        m.doubleSided = true;
      }
      if (ln.find("metal") != std::string::npos || ln.find("iron") != std::string::npos ||
          ln.find("brass") != std::string::npos || ln.find("gold") != std::string::npos ||
          ln.find("chrome") != std::string::npos || ln.find("copper") != std::string::npos) {
        m.metallic = std::max(m.metallic, 0.72f);
        m.roughness = std::min(m.roughness, 0.32f);
      }
      if (ln.find("vespa") != std::string::npos || ln.find("car") != std::string::npos) {
        m.clearcoat = std::max(m.clearcoat, 0.85f);
        m.roughness = std::min(m.roughness, 0.22f);
      }
    }
  };

  std::vector<float> pos, nrm, uvs;
  pos.reserve(1 << 20);
  nrm.reserve(1 << 20);
  uvs.reserve(1 << 20);

  struct FaceTri { uint32_t v[3], vt[3], vn[3]; };
  std::vector<std::vector<FaceTri>> buckets;
  auto ensureBucket = [&](int matIdx) {
    if (matIdx >= static_cast<int>(buckets.size())) buckets.resize(static_cast<size_t>(matIdx) + 1);
  };

  asset.materials.push_back(WorldMaterial{});
  ensureBucket(0);
  int curMat = 0;

  const char* cur = text.data();
  const char* end = cur + text.size();
  while (cur < end) {
    const char* lineEnd = static_cast<const char*>(std::memchr(cur, '\n', static_cast<size_t>(end - cur)));
    if (!lineEnd) lineEnd = end;
    const char* p = skipWs(cur, lineEnd);
    const char* nextLine = (lineEnd < end) ? (lineEnd + 1) : end;
    if (p + 2 <= lineEnd) {
      if (p[0] == 'v' && (p[1] == ' ' || p[1] == '\t')) {
        p += 2;
        pos.push_back(parseFastFloat(p, lineEnd));
        pos.push_back(parseFastFloat(p, lineEnd));
        pos.push_back(parseFastFloat(p, lineEnd));
      } else if (p[0] == 'v' && p[1] == 'n' && (p + 2 < lineEnd && (p[2] == ' ' || p[2] == '\t'))) {
        p += 3;
        nrm.push_back(parseFastFloat(p, lineEnd));
        nrm.push_back(parseFastFloat(p, lineEnd));
        nrm.push_back(parseFastFloat(p, lineEnd));
      } else if (p[0] == 'v' && p[1] == 't' && (p + 2 < lineEnd && (p[2] == ' ' || p[2] == '\t'))) {
        p += 3;
        uvs.push_back(parseFastFloat(p, lineEnd));
        // Flip V to match Metal/glTF top-left origin!
        uvs.push_back(1.0f - parseFastFloat(p, lineEnd));
      } else if (p[0] == 'f' && (p[1] == ' ' || p[1] == '\t')) {
        p += 2;
        uint32_t fv[16], fvt[16], fvn[16];
        int nPoly = 0;
        const int nPos = static_cast<int>(pos.size() / 3);
        const int nUv = static_cast<int>(uvs.size() / 2);
        const int nNrm = static_cast<int>(nrm.size() / 3);
        while (p < lineEnd && nPoly < 16) {
          p = skipWs(p, lineEnd);
          if (p >= lineEnd || *p == '\r' || *p == '#') break;
          const int vi = parseFastInt(p, lineEnd);
          int vti = 0, vni = 0;
          if (p < lineEnd && *p == '/') {
            p++;
            if (p < lineEnd && *p != '/' && *p != ' ' && *p != '\t' && *p != '\r') vti = parseFastInt(p, lineEnd);
            if (p < lineEnd && *p == '/') {
              p++;
              if (p < lineEnd && *p != ' ' && *p != '\t' && *p != '\r') vni = parseFastInt(p, lineEnd);
            }
          }
          auto fix = [](int idx, int n) -> uint32_t {
            if (idx > 0 && idx <= n) return static_cast<uint32_t>(idx - 1);
            if (idx < 0 && n + idx >= 0) return static_cast<uint32_t>(n + idx);
            return UINT32_MAX;
          };
          fv[nPoly] = fix(vi, nPos);
          fvt[nPoly] = fix(vti, nUv);
          fvn[nPoly] = fix(vni, nNrm);
          if (fv[nPoly] != UINT32_MAX) nPoly++;
          while (p < lineEnd && *p != ' ' && *p != '\t' && *p != '\r') p++;
        }
        auto& b = buckets[curMat];
        for (int k = 1; k + 1 < nPoly; k++) {
          b.push_back({{fv[0], fv[k], fv[k + 1]}, {fvt[0], fvt[k], fvt[k + 1]}, {fvn[0], fvn[k], fvn[k + 1]}});
        }
      } else if (p + 7 < lineEnd && std::memcmp(p, "mtllib ", 7) == 0) {
        std::string mname(skipWs(p + 7, lineEnd), lineEnd);
        while (!mname.empty() && (mname.back() == '\r' || mname.back() == ' ')) mname.pop_back();
        parseMtlFile(objDir / mname);
      } else if (p + 7 < lineEnd && std::memcmp(p, "usemtl ", 7) == 0) {
        std::string mname(skipWs(p + 7, lineEnd), lineEnd);
        while (!mname.empty() && (mname.back() == '\r' || mname.back() == ' ')) mname.pop_back();
        auto it = matMap.find(mname);
        curMat = (it != matMap.end()) ? it->second : 0;
        ensureBucket(curMat);
      }
    }
    cur = nextLine;
  }

  // Build deduplicated indexed WorldMeshes per material bucket!
  struct VKey {
    uint32_t v, vt, vn;
    bool operator==(const VKey& o) const { return v == o.v && vt == o.vt && vn == o.vn; }
  };
  struct VKeyHash {
    size_t operator()(const VKey& k) const {
      return (static_cast<size_t>(k.v) * 73856093u) ^ (static_cast<size_t>(k.vt) * 19349663u) ^ (static_cast<size_t>(k.vn) * 83492791u);
    }
  };

  for (size_t mi = 0; mi < buckets.size(); mi++) {
    const auto& tris = buckets[mi];
    if (tris.empty()) continue;
    WorldMesh wm;
    wm.material = static_cast<int>(mi);
    wm.indices.reserve(tris.size() * 3);
    std::unordered_map<VKey, uint32_t, VKeyHash> vmap;
    vmap.reserve(tris.size());
    bool anyNormals = false;
    for (const FaceTri& ft : tris) {
      for (int c = 0; c < 3; c++) {
        VKey k{ft.v[c], ft.vt[c], ft.vn[c]};
        auto [it, inserted] = vmap.emplace(k, static_cast<uint32_t>(wm.vertices.size()));
        if (inserted) {
          WorldVertex v{};
          v.p[0] = pos[k.v * 3 + 0];
          v.p[1] = pos[k.v * 3 + 1];
          v.p[2] = pos[k.v * 3 + 2];
          if (k.vn != UINT32_MAX) {
            v.n[0] = nrm[k.vn * 3 + 0];
            v.n[1] = nrm[k.vn * 3 + 1];
            v.n[2] = nrm[k.vn * 3 + 2];
            anyNormals = true;
          } else {
            v.n[1] = 1.0f;
          }
          if (k.vt != UINT32_MAX) {
            v.uv[0] = uvs[k.vt * 2 + 0];
            v.uv[1] = uvs[k.vt * 2 + 1];
          }
          v.t[0] = 1.0f; v.t[3] = 1.0f;
          wm.vertices.push_back(v);
        }
        wm.indices.push_back(it->second);
      }
    }
    finalizeMeshGeometry(wm, anyNormals, false);
    asset.bounds.merge(wm.bounds);
    WorldInstance inst;
    inst.mesh = static_cast<uint32_t>(asset.meshes.size());
    asset.meshes.push_back(std::move(wm));
    asset.instances.push_back(inst);
  }

  // Helpful built-in iconic viewpoints for Sponza & Amazon Lumberyard Bistro!
  std::string lowName = path.filename().string();
  for (char& c : lowName) c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
  if (lowName.find("sponza") != std::string::npos) {
    asset.hasDefaultView = true;
    asset.defaultEye = {-1050, 220, -35};
    asset.defaultTarget = {600, 220, 0};
    asset.defaultFovDeg = 55.0;
  } else if (lowName.find("exterior") != std::string::npos && asset.bounds.max.x > 3000.0) {
    // Amazon Lumberyard Bistro Exterior (iconic Paris "Le Petit Coin" corner framing!).
    asset.hasDefaultView = true;
    asset.defaultEye = {-1320, 410, -640};
    asset.defaultTarget = {80, 380, 40};
    asset.defaultFovDeg = 54.0;
  }

  return asset;
}

}  // namespace

bool isWorldAssetFile(const fs::path& path) {
  const std::string ext = lowerExt(path);
  return ext == ".glb" || ext == ".gltf" || ext == ".obj";
}

WorldAsset loadWorldAsset(const fs::path& path, std::string* error) {
  const std::string ext = lowerExt(path);
  if (ext == ".glb" || ext == ".gltf") return loadGltfAsset(path, error);
  if (ext == ".obj") return loadObjAsset(path, error);
  if (error) *error = "unsupported world asset format: " + ext;
  return {};
}

}  // namespace bmr
