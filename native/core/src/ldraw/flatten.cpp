#include "bm/ldraw/mesh.h"

#include <algorithm>
#include <cmath>
#include <map>
#include <unordered_map>

namespace bm::ldraw {
namespace {

constexpr int kMaxDepth = 64;
constexpr double kWeld = 1e4;  // vertices closer than 1e-4 LDU are one vertex

struct Key {
  int64_t x, y, z;
  bool operator==(const Key&) const = default;
};
struct KeyHash {
  size_t operator()(const Key& k) const {
    uint64_t h = static_cast<uint64_t>(k.x) * 0x9E3779B97F4A7C15ull;
    h ^= static_cast<uint64_t>(k.y) * 0xC2B2AE3D27D4EB4Full + (h << 6) + (h >> 2);
    h ^= static_cast<uint64_t>(k.z) * 0x165667B19E3779F9ull + (h << 6) + (h >> 2);
    return static_cast<size_t>(h);
  }
};

/// Curved primitives named like "1-4cyli.dat" have a 48-segment version under p/48.
bool isCurvedPrimitive(std::string_view name) {
  size_t i = 0;
  auto digits = [&] {
    const size_t start = i;
    while (i < name.size() && name[i] >= '0' && name[i] <= '9') i++;
    return i > start;
  };
  return digits() && i < name.size() && name[i++] == '-' && digits() && name.find('/') == std::string_view::npos;
}

/// stud.dat, stud2.dat, stud-logo4.dat, ... in any directory.
bool isStudName(std::string_view name) {
  if (const size_t slash = name.rfind('/'); slash != std::string_view::npos) name.remove_prefix(slash + 1);
  return name.rfind("stud", 0) == 0 && name.size() > 4 && name.substr(name.size() - 4) == ".dat";
}

struct Walker {
  const Library& lib;
  const FlattenOptions& opts;
  Mesh mesh;
  std::unordered_map<Key, uint32_t, KeyHash> welded;
  std::vector<std::string> stack;  // files being expanded, to stop reference loops
  std::map<std::string, uint64_t> deps;

  void miss(const std::string& name) {
    if (std::find(mesh.missing.begin(), mesh.missing.end(), name) == mesh.missing.end()) mesh.missing.push_back(name);
  }

  uint32_t vertex(Vec3 p, bool inStud) {
    if (!inStud) mesh.body.grow(p);
    const Key key{std::llround(p.x * kWeld), std::llround(p.y * kWeld), std::llround(p.z * kWeld)};
    const auto [it, isNew] = welded.emplace(key, static_cast<uint32_t>(mesh.positions.size() / 3));
    if (isNew) {
      mesh.positions.insert(mesh.positions.end(), {static_cast<float>(p.x), static_cast<float>(p.y), static_cast<float>(p.z)});
      mesh.bounds.grow(p);
    }
    return it->second;
  }

  void triangle(Vec3 a, Vec3 b, Vec3 c, int color, bool reverse, bool twoSided, bool inStud) {
    const uint32_t i = vertex(a, inStud), j = vertex(b, inStud), k = vertex(c, inStud);
    if (i == j || j == k || i == k) return;  // collapsed by welding
    auto emit = [&](uint32_t p, uint32_t q, uint32_t r) {
      mesh.triangles.insert(mesh.triangles.end(), {p, q, r});
      mesh.triColor.push_back(color);
    };
    if (twoSided || !reverse) emit(i, j, k);
    if (twoSided || reverse) emit(i, k, j);
  }

  /// The file a reference means, after the logo, low-res and hi-res substitutions.
  std::string substitute(const std::string& name) const {
    if (opts.logoStuds) {
      if (name == "stud.dat" && lib.find("stud-logo4.dat")) return "stud-logo4.dat";
      if (name == "stud2.dat" && lib.find("stud2-logo4.dat")) return "stud2-logo4.dat";
    }
    if (opts.lowResPrimitives) {
      if (name.find('/') == std::string::npos && lib.find("8/" + name)) return "8/" + name;
      return name;
    }
    if (opts.hiResPrimitives && isCurvedPrimitive(name) && lib.find("48/" + name)) return "48/" + name;
    return name;
  }

  void file(const std::string& name, const Xform& xf, int color, bool flip, bool cullable, bool inStud) {
    const File* f = lib.find(name);
    deps.emplace(name, f ? lib.stamp(name) : 0);
    if (!f || stack.size() >= static_cast<size_t>(kMaxDepth) || std::find(stack.begin(), stack.end(), name) != stack.end()) {
      miss(name);
      return;
    }
    stack.push_back(name);
    bool certified = false, refused = false, clip = true, clockwise = false;
    auto point = [&](const double* p) { return xf.apply({p[0], p[1], p[2]}); };
    for (const Command& c : f->cmds) {
      const int own = c.color == 16 ? color : c.color;
      const bool twoSided = !(cullable && certified && clip);
      const bool reverse = flip != clockwise;
      switch (c.type) {
        case Cmd::Bfc:
          if (c.cert == Command::Cert::NoCertify) {
            refused = true;
            certified = false;
          } else if (!refused) {
            certified = true;  // any other BFC statement certifies the file
          }
          if (c.cert == Command::Cert::CW || c.winding == Command::Wind::CW) clockwise = true;
          if (c.cert == Command::Cert::CCW || c.winding == Command::Wind::CCW) clockwise = false;
          if (c.clip >= 0) clip = c.clip == 1;
          break;
        case Cmd::Tri:
          triangle(point(c.pts), point(c.pts + 3), point(c.pts + 6), own, reverse, twoSided, inStud);
          break;
        case Cmd::Quad:
          triangle(point(c.pts), point(c.pts + 3), point(c.pts + 6), own, reverse, twoSided, inStud);
          triangle(point(c.pts), point(c.pts + 6), point(c.pts + 9), own, reverse, twoSided, inStud);
          break;
        case Cmd::Line: {
          const Vec3 a = point(c.pts), b = point(c.pts + 3);
          mesh.edges.insert(mesh.edges.end(), {static_cast<float>(a.x), static_cast<float>(a.y), static_cast<float>(a.z), static_cast<float>(b.x), static_cast<float>(b.y), static_cast<float>(b.z)});
          mesh.bounds.grow(a);
          mesh.bounds.grow(b);
          if (!inStud) {
            mesh.body.grow(a);
            mesh.body.grow(b);
          }
          break;
        }
        case Cmd::Ref: {
          // A mirroring placement turns the subfile's faces inside out, as INVERTNEXT does.
          const Xform placed = xf * c.xf;
          // A stud standing on top of the part is not part of its body.
          const bool stud = inStud || (isStudName(c.file) && placed.r.m[4] > 0);
          file(substitute(c.file), placed, own, flip != (c.invert != (determinant(c.xf.r) < 0)), !twoSided, stud);
          break;
        }
        case Cmd::Step:
          break;
      }
    }
    stack.pop_back();
  }
};

}  // namespace

uint64_t hashDeps(const std::vector<std::pair<std::string, uint64_t>>& deps) {
  uint64_t h = 1469598103934665603ull;
  auto mix = [&](uint64_t v) {
    for (int i = 0; i < 8; i++) h = (h ^ ((v >> (i * 8)) & 0xFF)) * 1099511628211ull;
  };
  for (const auto& [name, hash] : deps) {
    for (unsigned char c : name) h = (h ^ c) * 1099511628211ull;
    mix(hash);
  }
  return h ? h : 1;
}

Mesh flatten(std::string_view partName, const Library& library, const FlattenOptions& options) {
  std::string name = normalizeName(partName);
  if (name.find('.') == std::string::npos) name += ".dat";
  Walker w{library, options, {}, {}, {}, {}};
  w.file(name, Xform::identity(), 16, false, true, false);
  if (w.mesh.body.empty()) w.mesh.body = w.mesh.bounds;
  w.mesh.deps.assign(w.deps.begin(), w.deps.end());
  w.mesh.sourceHash = hashDeps(w.mesh.deps);
  return std::move(w.mesh);
}

}  // namespace bm::ldraw
