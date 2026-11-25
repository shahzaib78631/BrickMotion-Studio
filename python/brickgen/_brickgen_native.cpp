// Native C-ABI bridge for BrickGen: exposes libbmcore's exact LDraw/Studio .io loader,
// ConnectorDb, Graph builder, exact triangle-triangle Collision + MateZones, Stability check,
// and an incremental GenWorld with O(1) add/pop and collision-filtered candidate enumeration.
// Zero edits to native/.
#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <memory>
#include <sstream>
#include <string>
#include <unordered_map>
#include <unordered_set>
#include <vector>

#include <nlohmann/json.hpp>

#include "bm/collide/pair.h"
#include "bm/collide/shape.h"
#include "bm/collide/tolerances.h"
#include "bm/collide/world.h"
#include "bm/connect/connectors.h"
#include "bm/connect/graph.h"
#include "bm/connect/mate.h"
#include "bm/connect/shadow.h"
#include "bm/connect/studio.h"
#include "bm/io.h"
#include "bm/kin/gears.h"
#include "bm/ldraw/library.h"
#include "bm/ldraw/part_cache.h"
#include "bm/math.h"
#include "bm/model.h"
#include "bm/stable/stability.h"

namespace {

using bm::Box;
using bm::Mat3;
using bm::Vec3;
using bm::Xform;
using bm::connect::Connector;
using bm::connect::Gender;
using bm::connect::SnapKind;

constexpr double kPi = 3.14159265358979323846;

std::string normPart(const char* name) {
  std::string s = name ? name : "";
  for (char& c : s) {
    if (c == '\\') c = '/';
    c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
  }
  auto pos = s.rfind('/');
  if (pos != std::string::npos) s = s.substr(pos + 1);
  if (s.size() < 4 || s.substr(s.size() - 4) != ".dat") s += ".dat";
  return s;
}

Xform mat16ToXform(const double* m) {
  Xform xf;
  xf.r.m[0] = m[0]; xf.r.m[1] = m[1]; xf.r.m[2] = m[2]; xf.t.x = m[3];
  xf.r.m[3] = m[4]; xf.r.m[4] = m[5]; xf.r.m[5] = m[6]; xf.t.y = m[7];
  xf.r.m[6] = m[8]; xf.r.m[7] = m[9]; xf.r.m[8] = m[10]; xf.t.z = m[11];
  return xf;
}

void xformToMat16(const Xform& xf, double* out) {
  out[0] = xf.r.m[0]; out[1] = xf.r.m[1]; out[2] = xf.r.m[2]; out[3] = xf.t.x;
  out[4] = xf.r.m[3]; out[5] = xf.r.m[4]; out[6] = xf.r.m[5]; out[7] = xf.t.y;
  out[8] = xf.r.m[6]; out[9] = xf.r.m[7]; out[10] = xf.r.m[8]; out[11] = xf.t.z;
  out[12] = 0.0; out[13] = 0.0; out[14] = 0.0; out[15] = 1.0;
}

bool boxesOverlap(const Box& a, const Box& b, double pad = 0.0) {
  if (a.empty() || b.empty()) return false;
  return !(a.max.x + pad < b.min.x || b.max.x + pad < a.min.x ||
           a.max.y + pad < b.min.y || b.max.y + pad < a.min.y ||
           a.max.z + pad < b.min.z || b.max.z + pad < a.min.z);
}

bool compatible(const Connector& a, const Connector& b) {
  if (a.kind == b.kind) {
    if (a.kind == SnapKind::Generic) {
      if (!a.group.empty() && !b.group.empty() && a.group != b.group) return false;
      return a.gender != b.gender || a.match == "same" || b.match == "same";
    }
    return a.gender != b.gender;
  }
  return (a.kind == SnapKind::Cyl && a.gender == Gender::Male && b.kind == SnapKind::Clip) ||
         (b.kind == SnapKind::Cyl && b.gender == Gender::Male && a.kind == SnapKind::Clip);
}

Mat3 basis(Vec3 axis, Vec3 side) {
  Vec3 a = bm::normalized(axis);
  Vec3 s = bm::normalized(side - a * bm::dot(a, side));
  if (bm::length(s) < 0.5) {
    Vec3 fallback = std::abs(a.x) < 0.9 ? Vec3{1, 0, 0} : Vec3{0, 1, 0};
    s = bm::normalized(fallback - a * bm::dot(a, fallback));
  }
  Vec3 across = bm::cross(a, s);
  return {{s.x, across.x, a.x, s.y, across.y, a.y, s.z, across.z, a.z}};
}

Mat3 rotAboutAxis(Vec3 axis, double deg) {
  double rad = deg * (kPi / 180.0);
  double c = std::cos(rad), s = std::sin(rad), t = 1.0 - c;
  double x = axis.x, y = axis.y, z = axis.z;
  return {{
      t * x * x + c, t * x * y - s * z, t * x * z + s * y,
      t * x * y + s * z, t * y * y + c, t * y * z - s * x,
      t * x * z - s * y, t * y * z + s * x, t * z * z + c,
  }};
}

double poseDifference(const Xform& a, const Xform& b) {
  double d = bm::length(a.t - b.t);
  for (int i = 0; i < 9; i++) d += std::abs(a.r.m[i] - b.r.m[i]);
  return d;
}

struct PoseKey {
  int32_t tx, ty, tz;
  int16_t r[9];
  bool operator==(const PoseKey& o) const {
    return tx == o.tx && ty == o.ty && tz == o.tz && std::memcmp(r, o.r, sizeof(r)) == 0;
  }
};

struct PoseKeyHash {
  size_t operator()(const PoseKey& k) const {
    uint64_t h = 1469598103934665603ULL;
    auto mix = [&](uint64_t v) { h ^= v; h *= 1099511628211ULL; };
    mix(static_cast<uint32_t>(k.tx));
    mix(static_cast<uint32_t>(k.ty));
    mix(static_cast<uint32_t>(k.tz));
    for (int i = 0; i < 9; i++) mix(static_cast<uint16_t>(k.r[i]));
    return static_cast<size_t>(h);
  }
};

PoseKey makePoseKey(const Xform& xf) {
  PoseKey k;
  k.tx = static_cast<int32_t>(std::llround(xf.t.x * 4.0));
  k.ty = static_cast<int32_t>(std::llround(xf.t.y * 4.0));
  k.tz = static_cast<int32_t>(std::llround(xf.t.z * 4.0));
  for (int i = 0; i < 9; i++) k.r[i] = static_cast<int16_t>(std::llround(xf.r.m[i] * 100.0));
  return k;
}

bool hasAxleOrTyre(const Connector& c) {
  for (const auto& s : c.profile) {
    if (s.shape == 'A' || s.shape == 'T') return true;
  }
  return false;
}

bool isMaleStud(const Connector& c) {
  if (c.kind != SnapKind::Cyl || c.gender != Gender::Male || c.slide) return false;
  if (c.length > 8.0 || c.radius < 5.5 || c.radius > 8.5) return false;
  return !hasAxleOrTyre(c);
}

bool isFemaleStudCompatible(const Connector& c) {
  if (c.kind != SnapKind::Cyl || c.gender != Gender::Female) return false;
  if (hasAxleOrTyre(c)) return false;
  if (c.profile.empty()) return c.radius >= 5.5 && c.radius <= 8.5;
  for (const auto& s : c.profile) {
    if ((s.shape == 'R' || s.shape == 'S') && s.radius >= 5.5 && s.radius <= 8.5) return true;
  }
  return false;
}

bool isStudPair(const Connector& a, const Connector& b) {
  return (isMaleStud(a) && isFemaleStudCompatible(b)) ||
         (isMaleStud(b) && isFemaleStudCompatible(a));
}

bool isSingleAxisPart(const std::vector<Connector>& conns) {
  auto collinear = [&](auto pred) -> int {
    Vec3 refP{}, refA{};
    int count = 0;
    for (const auto& c : conns) {
      if (!pred(c)) continue;
      if (count == 0) {
        refP = c.start;
        refA = c.axis;
      } else {
        if (std::abs(bm::dot(c.axis, refA)) < 0.98) return -1;
        Vec3 d = c.start - refP;
        Vec3 perp = d - refA * bm::dot(d, refA);
        if (bm::length(perp) > 1.0) return -1;
      }
      count++;
    }
    return count;
  };
  int nf = collinear([](const Connector& c) { return isFemaleStudCompatible(c) && !c.slide; });
  if (nf > 0) return true;
  if (nf < 0) return false;
  int nm = collinear([](const Connector& c) { return isMaleStud(c); });
  return nm > 0;
}

void collectMateZones(const std::vector<Connector>& connsA,
                      const std::vector<Connector>& connsB,
                      std::vector<bm::collide::Zone>& zones) {
  for (const auto& target : connsB) {
    for (const auto& c : connsA) {
      if (!compatible(c, target) || !bm::connect::mate(c, target)) continue;
      auto mz = bm::connect::mateZone(c, target);
      zones.push_back({mz.a, mz.b, mz.radius});
    }
  }
}

struct PlacedPiece {
  std::string part;
  int color = 16;
  Xform pose;
  std::shared_ptr<const bm::collide::Shape> shape;
  Box box;
  std::vector<Connector> conns;
  std::vector<uint16_t> occCount;
  // Connectors on earlier pieces that this piece incremented occCount for (enables O(1) pop)
  std::vector<std::pair<uint32_t, uint32_t>> markedEarlier;
};

struct BgContext {
  bm::ldraw::Library library;
  bm::connect::ShadowLibrary shadow;
  std::unique_ptr<bm::connect::StudioLibrary> studio;
  bm::connect::ConnectorDb db;
  bm::kin::GearDb gears;
  bm::ldraw::PartCache partCache;
  bm::collide::ShapeCache shapeCache;

  std::vector<PlacedPiece> placed;
  std::string lastJson;

  BgContext(const std::filesystem::path& ldrawDir,
            const std::filesystem::path& shadowDir,
            const std::filesystem::path& dataDir,
            bool useStudio)
      : library(ldrawDir),
        shadow(shadowDir),
        studio(std::make_unique<bm::connect::StudioLibrary>(
            useStudio ? bm::connect::StudioLibrary::defaultDirectory() : std::filesystem::path())),
        db(library, shadow),
        partCache(library, bm::ldraw::PartCache::defaultDirectory()),
        shapeCache() {
    if (useStudio) db.setStudio(studio.get());
    auto readFile = [&](const char* name) {
      std::ifstream in(dataDir / name);
      if (!in) return std::string();
      std::stringstream ss;
      ss << in.rdbuf();
      return ss.str();
    };
    if (auto s = readFile("wheel-seats.json"); !s.empty()) bm::connect::loadWheelSeats(s, db);
    if (auto s = readFile("bricknet-joints.json"); !s.empty()) bm::connect::loadBricknetJoints(s, db);
    if (auto s = readFile("extra-connectors.json"); !s.empty()) bm::connect::loadExtraConnectors(s, db);
    if (auto s = readFile("gears.json"); !s.empty()) gears.load(s);
    if (auto s = readFile("screws.json"); !s.empty()) gears.loadScrews(s);
  }

  void worldReset() { placed.clear(); }

  int worldAdd(const char* partName, int color, const double* mat16) {
    PlacedPiece pp;
    pp.part = normPart(partName);
    pp.color = color;
    pp.pose = mat16ToXform(mat16);
    auto mesh = partCache.get(pp.part);
    pp.shape = mesh ? shapeCache.get(mesh) : nullptr;
    if (pp.shape && !pp.shape->bounds.empty()) {
      pp.box = pp.shape->bounds.transformed(pp.pose);
    }
    auto local = db.get(pp.part);
    pp.conns.reserve(local->size());
    for (const auto& c : *local) {
      auto wc = bm::connect::transformed(c, pp.pose);
      pp.box.grow(wc.start);
      pp.box.grow(wc.start + wc.axis * wc.length);
      pp.conns.push_back(std::move(wc));
    }
    pp.occCount.assign(pp.conns.size(), 0);

    // Incrementally mark mated short non-sliding connectors against existing nearby pieces
    for (uint32_t j = 0; j < static_cast<uint32_t>(placed.size()); j++) {
      if (!boxesOverlap(pp.box, placed[j].box, 6.0)) continue;
      for (size_t ci = 0; ci < pp.conns.size(); ci++) {
        const auto& ca = pp.conns[ci];
        for (size_t cj = 0; cj < placed[j].conns.size(); cj++) {
          const auto& cb = placed[j].conns[cj];
          if (!compatible(ca, cb)) continue;
          if (!bm::connect::mate(ca, cb)) continue;
          if (!ca.slide && ca.length <= 10.0) pp.occCount[ci]++;
          if (!cb.slide && cb.length <= 10.0) {
            placed[j].occCount[cj]++;
            pp.markedEarlier.emplace_back(j, static_cast<uint32_t>(cj));
          }
        }
      }
    }

    int idx = static_cast<int>(placed.size());
    placed.push_back(std::move(pp));
    return idx;
  }

  int worldPop() {
    if (placed.empty()) return 0;
    const auto& last = placed.back();
    for (const auto& [j, cj] : last.markedEarlier) {
      if (j < placed.size() && cj < placed[j].occCount.size() && placed[j].occCount[cj] > 0) {
        placed[j].occCount[cj]--;
      }
    }
    placed.pop_back();
    return 1;
  }

  bool hitsPlaced(const std::string& pn,
                  const bm::collide::Shape* shape,
                  const Xform& pose,
                  const Box& wbox,
                  const std::vector<Connector>& posed) const {
    if (!shape || shape->bounds.empty()) return false;
    for (size_t p = 0; p < placed.size(); p++) {
      const auto& other = placed[p];
      if (!other.shape || other.shape->bounds.empty()) continue;
      if (other.part == pn && poseDifference(other.pose, pose) < 1e-4) return true;
      if (!boxesOverlap(wbox, other.box, 0.05)) continue;
      std::vector<bm::collide::Zone> zones;
      collectMateZones(posed, other.conns, zones);
      const auto depth = zones.empty() ? bm::collide::Depth::Skin : bm::collide::Depth::Joined;
      if (bm::collide::overlap(*shape, pose, *other.shape, other.pose, zones, nullptr, depth)) {
        return true;
      }
    }
    return false;
  }

  void countMatesPlaced(const Box& wbox,
                        const std::vector<Connector>& posed,
                        int& outMates,
                        double& outGrip) const {
    int cnt = 0;
    double grip = 0.0;
    for (size_t p = 0; p < placed.size(); p++) {
      const auto& other = placed[p];
      if (!boxesOverlap(wbox, other.box, 6.0)) continue;
      for (const auto& target : other.conns) {
        for (const auto& c : posed) {
          if (!compatible(c, target)) continue;
          if (auto m = bm::connect::mate(c, target)) {
            cnt++;
            grip += m->grip;
          }
        }
      }
    }
    outMates = cnt;
    outGrip = grip;
  }

  int worldHits(const char* partName, const double* mat16) {
    std::string pn = normPart(partName);
    Xform pose = mat16ToXform(mat16);
    auto mesh = partCache.get(pn);
    auto shape = mesh ? shapeCache.get(mesh) : nullptr;
    if (!shape || shape->bounds.empty()) return 0;
    Box wbox = shape->bounds.transformed(pose);
    auto local = db.get(pn);
    std::vector<Connector> posed;
    posed.reserve(local->size());
    for (const auto& c : *local) posed.push_back(bm::connect::transformed(c, pose));
    return hitsPlaced(pn, shape.get(), pose, wbox, posed) ? 1 : 0;
  }
};

}  // namespace

extern "C" {

struct BgCand {
  double matrix[16];
  double bbox[6];  // world min_x, min_y, min_z, max_x, max_y, max_z
  double grip;
  int32_t host;
  int32_t host_conn;
  int32_t conn;
  int32_t kind;        // 0=stud, 1=clip, 2=hinge, 3=technic, 4=generic
  int32_t mate_count;  // total mated connector pairs across all placed pieces
};

struct BgCheck {
  int32_t pieces;
  int32_t overlaps;
  int32_t groups;
  int32_t largest_group;
  int32_t attached;
  int32_t stands;
  int32_t unsupported;
  int32_t tipping;
  double margin;
  double mass;
};

struct BgPartInfo {
  double bbox[6];  // local min_x, min_y, min_z, max_x, max_y, max_z
  int32_t has_mesh;
  int32_t num_conns;
};

void* bg_ctx_create(const char* ldraw_dir, const char* shadow_dir, const char* data_dir, int use_studio) {
  try {
    return new BgContext(ldraw_dir, shadow_dir, data_dir, use_studio != 0);
  } catch (const std::exception& e) {
    std::fprintf(stderr, "bg_ctx_create error: %s\n", e.what());
    return nullptr;
  }
}

void bg_ctx_destroy(void* ptr) {
  delete static_cast<BgContext*>(ptr);
}

int bg_part_info(void* ptr, const char* part_name, BgPartInfo* out) {
  auto* ctx = static_cast<BgContext*>(ptr);
  if (!ctx || !out) return 0;
  std::string pn = normPart(part_name);
  auto mesh = ctx->partCache.get(pn);
  auto local = ctx->db.get(pn);
  out->num_conns = static_cast<int32_t>(local ? local->size() : 0);
  if (mesh && !mesh->bounds.empty()) {
    out->has_mesh = 1;
    out->bbox[0] = mesh->bounds.min.x;
    out->bbox[1] = mesh->bounds.min.y;
    out->bbox[2] = mesh->bounds.min.z;
    out->bbox[3] = mesh->bounds.max.x;
    out->bbox[4] = mesh->bounds.max.y;
    out->bbox[5] = mesh->bounds.max.z;
    return 1;
  }
  out->has_mesh = 0;
  for (int i = 0; i < 6; i++) out->bbox[i] = 0.0;
  return 0;
}

void bg_world_reset(void* ptr) {
  if (auto* ctx = static_cast<BgContext*>(ptr)) ctx->worldReset();
}

int bg_world_add(void* ptr, const char* part_name, int color, const double* mat16) {
  auto* ctx = static_cast<BgContext*>(ptr);
  if (!ctx) return -1;
  return ctx->worldAdd(part_name, color, mat16);
}

int bg_world_pop(void* ptr) {
  auto* ctx = static_cast<BgContext*>(ptr);
  if (!ctx) return 0;
  return ctx->worldPop();
}

int bg_world_size(void* ptr) {
  auto* ctx = static_cast<BgContext*>(ptr);
  return ctx ? static_cast<int>(ctx->placed.size()) : 0;
}

int bg_world_hits(void* ptr, const char* part_name, const double* mat16) {
  auto* ctx = static_cast<BgContext*>(ptr);
  if (!ctx) return 0;
  return ctx->worldHits(part_name, mat16);
}

int bg_world_candidates(void* ptr,
                        const char* part_name,
                        const int32_t* host_indices,
                        int n_hosts,
                        BgCand* out,
                        int max_out,
                        int fine_angles,
                        int filter_collisions) {
  auto* ctx = static_cast<BgContext*>(ptr);
  if (!ctx || ctx->placed.empty() || !out || max_out <= 0) return 0;

  std::string pn = normPart(part_name);
  auto localPtr = ctx->db.get(pn);
  const auto& local = *localPtr;
  if (local.empty()) return 0;

  auto mesh = ctx->partCache.get(pn);
  auto shape = mesh ? ctx->shapeCache.get(mesh) : nullptr;
  const bool hasShape = shape && !shape->bounds.empty();
  const bool singleAxis = isSingleAxisPart(local);

  static const double kQuarter[] = {0.0, 90.0, 180.0, 270.0};
  static const double kEighth[] = {0.0, 45.0, 90.0, 135.0, 180.0, 225.0, 270.0, 315.0};
  static const double kFine[] = {
      0.0, 15.0, 22.5, 30.0, 45.0, 60.0, 67.5, 75.0,
      90.0, 105.0, 112.5, 120.0, 135.0, 150.0, 157.5, 165.0,
      180.0, 195.0, 202.5, 210.0, 225.0, 240.0, 247.5, 255.0,
      270.0, 285.0, 292.5, 300.0, 315.0, 330.0, 337.5, 345.0};

  std::vector<size_t> hosts;
  if (host_indices && n_hosts > 0) {
    hosts.reserve(n_hosts);
    for (int i = 0; i < n_hosts; i++) {
      int h = host_indices[i];
      if (h >= 0 && static_cast<size_t>(h) < ctx->placed.size()) hosts.push_back(static_cast<size_t>(h));
    }
  } else {
    hosts.resize(ctx->placed.size());
    for (size_t i = 0; i < ctx->placed.size(); i++) hosts[i] = i;
  }

  std::unordered_set<PoseKey, PoseKeyHash> seen;
  seen.reserve(1024);
  int written = 0;
  std::vector<Connector> posed;
  posed.reserve(local.size());

  for (size_t hi : hosts) {
    if (written >= max_out) break;
    const auto& hp = ctx->placed[hi];
    for (size_t hci = 0; hci < hp.conns.size() && written < max_out; hci++) {
      if (hp.occCount[hci] > 0) continue;
      const Connector& target = hp.conns[hci];

      for (size_t ci = 0; ci < local.size() && written < max_out; ci++) {
        const Connector& inc = local[ci];
        if (!compatible(inc, target)) continue;

        if (inc.kind == SnapKind::Cyl && target.kind == SnapKind::Cyl) {
          const Connector& male = inc.gender == Gender::Male ? inc : target;
          const Connector& fem = inc.gender == Gender::Male ? target : inc;
          bool radiusOk = false;
          for (const auto& ms : male.profile) {
            for (const auto& fs : fem.profile) {
              if (std::abs(ms.radius - fs.radius) <= 2.5 ||
                  (fs.shape == 'A' && std::abs(ms.radius - fs.radius * 0.6) <= 2.5)) {
                radiusOk = true;
                break;
              }
            }
            if (radiusOk) break;
          }
          if (!radiusOk && !male.profile.empty() && !fem.profile.empty()) continue;
        }

        const bool isClip = (inc.kind == SnapKind::Clip || target.kind == SnapKind::Clip);
        const bool isHingeOrFinger = (inc.kind == SnapKind::Finger ||
            (inc.kind == SnapKind::Generic &&
             (inc.group.find("hinge") != std::string::npos || inc.group.find("ball") != std::string::npos)));
        const bool isStud = isStudPair(inc, target);

        const double* angles = kQuarter;
        int nAngles = 4;
        if (isClip || isHingeOrFinger) {
          angles = fine_angles ? kFine : kEighth;
          nAngles = fine_angles ? 32 : 8;
        } else if (singleAxis && (isStud || (inc.kind == SnapKind::Cyl && target.kind == SnapKind::Cyl))) {
          angles = kEighth;
          nAngles = 8;
        }

        const Mat3 incFrameInv = bm::inverse(basis(inc.axis, inc.side));
        const Connector& femStud = (inc.gender == Gender::Female) ? inc : target;
        double signs[2] = {1.0, -1.0};
        int nSigns = 2;
        if (isStud) {
          if (femStud.openStart && !femStud.openEnd) {
            signs[0] = 1.0; nSigns = 1;
          } else if (!femStud.openStart && femStud.openEnd) {
            signs[0] = -1.0; nSigns = 1;
          }
        }

        std::vector<double> offsets;
        auto addOff = [&](double v) {
          for (double e : offsets) {
            if (std::abs(e - v) < 0.25) return;
          }
          offsets.push_back(v);
        };

        for (int si = 0; si < nSigns && written < max_out; si++) {
          double sign = signs[si];
          Vec3 desiredAxis = target.axis * sign;
          offsets.clear();

          if (inc.kind == SnapKind::Generic) {
            addOff(0.0);
          } else if (isStud) {
            if (sign > 0) {
              addOff(0.0);
              for (const auto& fs : femStud.profile) {
                if ((fs.shape == 'R' || fs.shape == 'S') && fs.radius >= 5.5 && fs.radius <= 8.5 && fs.start > 0.1) {
                  addOff((&femStud == &target) ? fs.start : -fs.start);
                }
              }
            } else {
              addOff((&femStud == &target) ? target.length : inc.length);
            }
          } else {
            addOff(0.0);
            addOff(target.length - sign * inc.length);
            addOff((target.length - sign * inc.length) * 0.5);
            addOff(target.length);
            addOff(-sign * inc.length);
            for (const auto& fs : target.profile) {
              for (const auto& ms : inc.profile) {
                addOff(fs.start - sign * ms.start);
                addOff((fs.start + fs.length) - sign * (ms.start + ms.length));
                addOff(fs.start - sign * (ms.start + ms.length));
                addOff((fs.start + fs.length) - sign * ms.start);
              }
            }
            if (isClip || inc.slide || target.slide || target.length >= 16.0 || inc.length >= 16.0) {
              double lo = std::min(0.0, -sign * inc.length);
              double hi = std::max(target.length, target.length - sign * inc.length);
              double step = isClip ? 4.0 : 10.0;
              for (double s = std::ceil(lo / step) * step; s <= hi + 0.1; s += step) {
                addOff(s);
              }
            }
          }

          const Mat3 targetBase = basis(desiredAxis, target.side);
          for (double off : offsets) {
            bool checkPerAngle = (inc.kind == SnapKind::Finger || inc.kind == SnapKind::Generic);
            if (!checkPerAngle) {
              for (const auto& s : inc.profile) {
                if (s.shape == 'A' || s.shape == 'S') checkPerAngle = true;
              }
            }
            double baseGrip = 0.0;
            if (!checkPerAngle) {
              Mat3 R0 = targetBase * incFrameInv;
              Vec3 t0 = (target.start + target.axis * off) - R0 * inc.start;
              Xform xf0{R0, t0};
              Connector posed0 = bm::connect::transformed(inc, xf0);
              auto m0 = bm::connect::mate(posed0, target);
              if (!m0) continue;
              baseGrip = m0->grip;
            }

            for (int ai = 0; ai < nAngles && written < max_out; ai++) {
              Mat3 R = rotAboutAxis(desiredAxis, angles[ai]) * targetBase * incFrameInv;
              Vec3 t = (target.start + target.axis * off) - R * inc.start;
              Xform xf{R, t};
              PoseKey key = makePoseKey(xf);
              if (!seen.insert(key).second) continue;

              double grip = baseGrip;
              if (checkPerAngle) {
                Connector posed1 = bm::connect::transformed(inc, xf);
                auto m1 = bm::connect::mate(posed1, target);
                if (!m1) continue;
                grip = m1->grip;
              }

              Box wbox = hasShape ? shape->bounds.transformed(xf) : Box{};
              posed.clear();
              for (const auto& c : local) {
                auto wc = bm::connect::transformed(c, xf);
                if (!hasShape) {
                  wbox.grow(wc.start);
                  wbox.grow(wc.start + wc.axis * wc.length);
                }
                posed.push_back(std::move(wc));
              }

              if (filter_collisions && hasShape) {
                if (ctx->hitsPlaced(pn, shape.get(), xf, wbox, posed)) continue;
              }

              int totalMates = 1;
              double totalGrip = grip;
              ctx->countMatesPlaced(wbox, posed, totalMates, totalGrip);

              BgCand& dst = out[written++];
              xformToMat16(xf, dst.matrix);
              if (!wbox.empty()) {
                dst.bbox[0] = wbox.min.x; dst.bbox[1] = wbox.min.y; dst.bbox[2] = wbox.min.z;
                dst.bbox[3] = wbox.max.x; dst.bbox[4] = wbox.max.y; dst.bbox[5] = wbox.max.z;
              } else {
                for (int k = 0; k < 6; k++) dst.bbox[k] = 0.0;
              }
              dst.grip = totalGrip;
              dst.host = static_cast<int32_t>(hi);
              dst.host_conn = static_cast<int32_t>(hci);
              dst.conn = static_cast<int32_t>(ci);
              dst.kind = isStud ? 0 : (isClip ? 1 : (isHingeOrFinger ? 2 : (inc.kind == SnapKind::Cyl ? 3 : 4)));
              dst.mate_count = totalMates;
            }
          }
        }
      }
    }
  }
  return written;
}

int bg_world_check(void* ptr, BgCheck* out) {
  auto* ctx = static_cast<BgContext*>(ptr);
  if (!ctx || !out) return 0;
  std::memset(out, 0, sizeof(*out));
  if (ctx->placed.empty()) {
    out->stands = 1;
    return 1;
  }
  bm::Model::Data data{{}, {}, {}, ctx->library, {}};
  data.pieces.reserve(ctx->placed.size());
  for (size_t i = 0; i < ctx->placed.size(); i++) {
    bm::Piece p;
    p.id = std::to_string(i);
    p.part = ctx->placed[i].part;
    p.color = ctx->placed[i].color;
    p.world = ctx->placed[i].pose;
    p.step = static_cast<int>(i);
    data.pieces.push_back(std::move(p));
  }
  bm::Model model(std::move(data));
  auto graph = bm::connect::buildGraph(model, ctx->db, &ctx->gears);
  auto ov = bm::collide::findOverlaps(model, graph, ctx->partCache, ctx->shapeCache);
  auto st = bm::stable::check(model, graph, ctx->partCache);

  out->pieces = static_cast<int32_t>(model.pieces().size());
  out->overlaps = static_cast<int32_t>(ov.overlaps.size());
  out->groups = static_cast<int32_t>(graph.groups);
  out->largest_group = static_cast<int32_t>(graph.largestGroup);
  out->attached = static_cast<int32_t>(graph.attached);
  out->stands = st.stands ? 1 : 0;
  out->unsupported = static_cast<int32_t>(st.unsupported.size());
  out->tipping = static_cast<int32_t>(st.tipping.size());
  out->margin = st.margin;
  out->mass = st.mass;
  return 1;
}

// Load any LDraw/MPD/Studio .io file via libbmcore, extract pieces, exact graph edges,
// per-piece world bboxes, submodel paths, and optional overlap & stability checks as JSON.
const char* bg_load_model_json(void* ptr, const char* file_path, int check_overlaps, int check_stability) {
  auto* ctx = static_cast<BgContext*>(ptr);
  if (!ctx || !file_path) return nullptr;
  try {
    const bm::Model model = bm::io::load(std::filesystem::path(file_path), ctx->library, &ctx->partCache);
    const auto graph = bm::connect::buildGraph(model, ctx->db, &ctx->gears);
    nlohmann::json j;
    j["ok"] = true;
    j["file"] = file_path;
    j["n_pieces"] = model.pieces().size();
    j["groups"] = graph.groups;
    j["largest_group"] = graph.largestGroup;
    j["attached"] = graph.attached;
    j["submodels"] = model.submodels();

    auto pieces = nlohmann::json::array();
    for (size_t i = 0; i < model.pieces().size(); i++) {
      const auto& p = model.pieces()[i];
      auto mesh = model.mesh(p.part, ctx->partCache);
      Box lb = (mesh && !mesh->bounds.empty()) ? mesh->bounds : bm::kPlaceholderBox;
      Box wb = lb.transformed(p.world);
      double m16[16];
      xformToMat16(p.world, m16);
      pieces.push_back({
          {"part", p.part},
          {"color", p.color},
          {"step", p.step},
          {"group", i < graph.group.size() ? graph.group[i] : 0},
          {"path", p.path},
          {"matrix", std::vector<double>(m16, m16 + 16)},
          {"bbox", {wb.min.x, wb.min.y, wb.min.z, wb.max.x, wb.max.y, wb.max.z}},
          {"local_bbox", {lb.min.x, lb.min.y, lb.min.z, lb.max.x, lb.max.y, lb.max.z}},
      });
    }
    j["pieces"] = std::move(pieces);

    auto edges = nlohmann::json::array();
    for (const auto& c : graph.connections) {
      edges.push_back({c.a, c.b, c.mates, c.grip});
    }
    j["edges"] = std::move(edges);

    if (check_overlaps) {
      auto ov = bm::collide::findOverlaps(model, graph, ctx->partCache, ctx->shapeCache);
      j["overlaps"] = ov.overlaps.size();
    }
    if (check_stability) {
      auto st = bm::stable::check(model, graph, ctx->partCache);
      j["stands"] = st.stands;
      j["unsupported"] = st.unsupported.size();
      j["tipping"] = st.tipping.size();
      j["margin"] = st.margin;
    }
    ctx->lastJson = j.dump();
    return ctx->lastJson.c_str();
  } catch (const std::exception& e) {
    nlohmann::json err = {{"ok", false}, {"error", e.what()}, {"file", file_path}};
    ctx->lastJson = err.dump();
    return ctx->lastJson.c_str();
  }
}

}  // extern "C"
