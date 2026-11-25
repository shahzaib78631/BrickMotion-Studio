// Thin C-ABI bridge exposing BrickMotion's native C++ connector + collision engine (libbmcore.a)
// to Python booklet_mpd.solver via ctypes. Zero edits to native/.
#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <memory>
#include <sstream>
#include <string>
#include <unordered_map>
#include <unordered_set>
#include <vector>

#include "bm/collide/pair.h"
#include "bm/collide/shape.h"
#include "bm/collide/tolerances.h"
#include "bm/collide/world.h"
#include "bm/connect/connectors.h"
#include "bm/connect/graph.h"
#include "bm/connect/mate.h"
#include "bm/connect/shadow.h"
#include "bm/connect/studio.h"
#include "bm/ldraw/library.h"
#include "bm/ldraw/part_cache.h"
#include "bm/math.h"
#include "bm/model.h"

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
      auto elastic = [](const Connector& q) {
        return (!q.profile.empty() && q.profile[0].shape == 'T') || q.group.rfind("studio-wheel-", 0) == 0;
      };
      if (elastic(c) || elastic(target)) {
        zones.push_back({c.start, c.start, bm::collide::kElasticZone});
      } else if (c.kind == SnapKind::Generic || target.kind == SnapKind::Generic) {
        zones.push_back({c.start, target.start, std::max({c.radius, target.radius, bm::collide::kGenericZone}) + bm::collide::kZonePad});
      } else {
        const Connector& shorter = c.length <= target.length ? c : target;
        zones.push_back({shorter.start, shorter.start + shorter.axis * shorter.length, std::max(c.radius, target.radius) + bm::collide::kZonePad});
      }
    }
  }
}

struct Context {
  bm::ldraw::Library library;
  bm::connect::ShadowLibrary shadow;
  std::unique_ptr<bm::connect::StudioLibrary> studio;
  bm::connect::ConnectorDb db;
  bm::ldraw::PartCache partCache;
  bm::collide::ShapeCache shapeCache;

  std::unique_ptr<bm::Model> model;
  std::unique_ptr<bm::collide::World> world;
  std::vector<std::vector<Connector>> worldConns;
  std::vector<std::vector<uint8_t>> occupied;

  Context(const std::filesystem::path& ldrawDir,
          const std::filesystem::path& shadowDir,
          const std::filesystem::path& dataDir,
          bool useStudio)
      : library(ldrawDir),
        shadow(shadowDir),
        studio(std::make_unique<bm::connect::StudioLibrary>(
            useStudio ? bm::connect::StudioLibrary::defaultDirectory() : std::filesystem::path())),
        db(library, shadow),
        partCache(library, std::filesystem::path()),
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
  }

  void setModel(int n, const char* const* partNames, const double* mats16) {
    bm::Model::Data data{{}, {}, {}, library, {}};
    data.pieces.reserve(n);
    for (int i = 0; i < n; i++) {
      bm::Piece p;
      p.id = std::to_string(i);
      p.part = normPart(partNames[i]);
      p.color = 16;
      p.world = mat16ToXform(mats16 + i * 16);
      p.step = 0;
      data.pieces.push_back(std::move(p));
    }
    model = std::make_unique<bm::Model>(std::move(data));
    world = std::make_unique<bm::collide::World>(*model, partCache, shapeCache);

    worldConns.assign(n, {});
    occupied.assign(n, {});
    for (int i = 0; i < n; i++) {
      const auto& piece = model->pieces()[i];
      auto local = db.get(piece.part);
      worldConns[i].reserve(local->size());
      for (const auto& c : *local) {
        worldConns[i].push_back(bm::connect::transformed(c, piece.world));
      }
      occupied[i].assign(worldConns[i].size(), 0);
    }

    // Mark short stud/socket connectors that are already mated so we skip occupied studs
    std::vector<uint32_t> nearby;
    for (int i = 0; i < n; i++) {
      Box b = world->box(i);
      if (b.empty()) continue;
      b.min = b.min - Vec3{4, 4, 4};
      b.max = b.max + Vec3{4, 4, 4};
      nearby.clear();
      world->near(b, nullptr, nearby);
      for (uint32_t j : nearby) {
        if (static_cast<int>(j) <= i) continue;
        for (size_t ci = 0; ci < worldConns[i].size(); ci++) {
          const auto& ca = worldConns[i][ci];
          for (size_t cj = 0; cj < worldConns[j].size(); cj++) {
            const auto& cb = worldConns[j][cj];
            if (!compatible(ca, cb)) continue;
            if (!bm::connect::mate(ca, cb)) continue;
            // Only mark short non-sliding connectors (studs/holes/hinges) as occupied;
            // long bars/axles/pins can hold multiple parts.
            if (!ca.slide && ca.length <= 10.0) occupied[i][ci] = 1;
            if (!cb.slide && cb.length <= 10.0) occupied[j][cj] = 1;
          }
        }
      }
    }
  }

  int hits(const char* partName, const double* mat16) {
    if (!model || !world) return 0;
    std::string pn = normPart(partName);
    Xform pose = mat16ToXform(mat16);
    auto mesh = partCache.get(pn);
    auto shape = mesh ? shapeCache.get(mesh) : nullptr;
    if (!shape || shape->bounds.empty()) return 0;
    auto local = db.get(pn);
    std::vector<Connector> posed;
    posed.reserve(local->size());
    for (const auto& c : *local) posed.push_back(bm::connect::transformed(c, pose));

    std::vector<uint32_t> nearby;
    world->near(shape->bounds.transformed(pose), nullptr, nearby);
    for (uint32_t p : nearby) {
      const auto& other = model->pieces()[p];
      if (other.part == pn && poseDifference(other.world, pose) < 1e-4) return 1;
      std::vector<bm::collide::Zone> zones;
      for (const auto& target : worldConns[p]) {
        for (const auto& c : posed) {
          if (!compatible(c, target) || !bm::connect::mate(c, target)) continue;
          auto elastic = [](const Connector& q) {
            return (!q.profile.empty() && q.profile[0].shape == 'T') || q.group.rfind("studio-wheel-", 0) == 0;
          };
          if (elastic(c) || elastic(target)) {
            zones.push_back({c.start, c.start, bm::collide::kElasticZone});
          } else if (c.kind == SnapKind::Generic || target.kind == SnapKind::Generic) {
            zones.push_back({c.start, target.start, std::max({c.radius, target.radius, bm::collide::kGenericZone}) + bm::collide::kZonePad});
          } else {
            const Connector& shorter = c.length <= target.length ? c : target;
            zones.push_back({shorter.start, shorter.start + shorter.axis * shorter.length, std::max(c.radius, target.radius) + bm::collide::kZonePad});
          }
        }
      }
      const auto depth = zones.empty() ? bm::collide::Depth::Skin : bm::collide::Depth::Joined;
      if (bm::collide::overlap(*shape, pose, world->shape(p), world->pose(p), zones, nullptr, depth)) {
        return 1;
      }
    }
    return 0;
  }

  int mateCount(const char* partName, const double* mat16, double* outGrip) {
    if (outGrip) *outGrip = 0.0;
    if (!model || !world) return 0;
    std::string pn = normPart(partName);
    Xform pose = mat16ToXform(mat16);
    auto mesh = partCache.get(pn);
    auto shape = mesh ? shapeCache.get(mesh) : nullptr;
    auto local = db.get(pn);
    if (local->empty()) return 0;
    std::vector<Connector> posed;
    posed.reserve(local->size());
    Box queryBox;
    if (shape && !shape->bounds.empty()) queryBox = shape->bounds.transformed(pose);
    for (const auto& c : *local) {
      auto wc = bm::connect::transformed(c, pose);
      queryBox.grow(wc.start);
      queryBox.grow(wc.start + wc.axis * wc.length);
      posed.push_back(std::move(wc));
    }
    queryBox.min = queryBox.min - Vec3{6, 6, 6};
    queryBox.max = queryBox.max + Vec3{6, 6, 6};

    std::vector<uint32_t> nearby;
    world->near(queryBox, nullptr, nearby);
    int count = 0;
    double totalGrip = 0.0;
    for (uint32_t p : nearby) {
      for (const auto& target : worldConns[p]) {
        for (const auto& c : posed) {
          if (!compatible(c, target)) continue;
          if (auto m = bm::connect::mate(c, target)) {
            count++;
            totalGrip += m->grip;
          }
        }
      }
    }
    if (outGrip) *outGrip = totalGrip;
    return count;
  }

  bool overlapPair(const std::string& nameA, const bm::collide::Shape& shapeA, const Xform& poseA,
                   const std::vector<Connector>& connsA,
                   const std::string& nameB, const bm::collide::Shape& shapeB, const Xform& poseB,
                   const std::vector<Connector>& connsB) const {
    if (nameA == nameB && poseDifference(poseA, poseB) < 1e-4) return true;
    Box ba = shapeA.bounds.transformed(poseA);
    Box bb = shapeB.bounds.transformed(poseB);
    if (ba.max.x < bb.min.x || bb.max.x < ba.min.x ||
        ba.max.y < bb.min.y || bb.max.y < ba.min.y ||
        ba.max.z < bb.min.z || bb.max.z < ba.min.z) {
      return false;
    }
    std::vector<bm::collide::Zone> zones;
    collectMateZones(connsA, connsB, zones);
    const auto depth = zones.empty() ? bm::collide::Depth::Skin : bm::collide::Depth::Joined;
    return bm::collide::overlap(shapeA, poseA, shapeB, poseB, zones, nullptr, depth);
  }

  int hitsExtra(const char* partName, const double* mat16,
                int nExtra, const char* const* extraNames, const double* extraMats16) {
    if (hits(partName, mat16)) return 1;
    if (nExtra <= 0) return 0;
    std::string pn = normPart(partName);
    Xform pose = mat16ToXform(mat16);
    auto mesh = partCache.get(pn);
    auto shape = mesh ? shapeCache.get(mesh) : nullptr;
    if (!shape || shape->bounds.empty()) return 0;
    auto local = db.get(pn);
    std::vector<Connector> posed;
    posed.reserve(local->size());
    for (const auto& c : *local) posed.push_back(bm::connect::transformed(c, pose));

    for (int i = 0; i < nExtra; i++) {
      std::string en = normPart(extraNames[i]);
      Xform epose = mat16ToXform(extraMats16 + i * 16);
      auto emesh = partCache.get(en);
      auto eshape = emesh ? shapeCache.get(emesh) : nullptr;
      if (!eshape || eshape->bounds.empty()) continue;
      auto elocal = db.get(en);
      std::vector<Connector> eposed;
      eposed.reserve(elocal->size());
      for (const auto& c : *elocal) eposed.push_back(bm::connect::transformed(c, epose));
      if (overlapPair(pn, *shape, pose, posed, en, *eshape, epose, eposed)) return 1;
    }
    return 0;
  }

  void layoutCheck(int nAdded, const char* const* addedNames, const double* addedMats16,
                   int* outCollides, int* outConnected, int* outMates, double* outGrip) {
    int collides = 0;
    int totalMates = 0;
    double totalGrip = 0.0;
    if (nAdded <= 0) {
      if (outCollides) *outCollides = 0;
      if (outConnected) *outConnected = 0;
      if (outMates) *outMates = 0;
      if (outGrip) *outGrip = 0.0;
      return;
    }

    struct Added {
      std::string name;
      Xform pose;
      std::shared_ptr<const bm::collide::Shape> shape;
      Box box;
      std::vector<Connector> conns;
    };
    std::vector<Added> items(nAdded);
    std::vector<uint8_t> connBase(nAdded, 0);
    std::vector<std::vector<int>> adj(nAdded);
    std::vector<uint32_t> nearby;

    for (int i = 0; i < nAdded; i++) {
      items[i].name = normPart(addedNames[i]);
      items[i].pose = mat16ToXform(addedMats16 + i * 16);
      auto mesh = partCache.get(items[i].name);
      items[i].shape = mesh ? shapeCache.get(mesh) : nullptr;
      if (items[i].shape && !items[i].shape->bounds.empty()) {
        items[i].box = items[i].shape->bounds.transformed(items[i].pose);
      }
      auto local = db.get(items[i].name);
      items[i].conns.reserve(local->size());
      Box qbox = items[i].box;
      for (const auto& c : *local) {
        auto wc = bm::connect::transformed(c, items[i].pose);
        qbox.grow(wc.start);
        qbox.grow(wc.start + wc.axis * wc.length);
        items[i].conns.push_back(std::move(wc));
      }
      if (model && world) {
        // Collision vs base
        if (!collides && items[i].shape && !items[i].shape->bounds.empty()) {
          nearby.clear();
          world->near(items[i].box, nullptr, nearby);
          for (uint32_t p : nearby) {
            const auto& other = model->pieces()[p];
            if (other.part == items[i].name && poseDifference(other.world, items[i].pose) < 1e-4) {
              collides = 1;
              break;
            }
            std::vector<bm::collide::Zone> zones;
            collectMateZones(items[i].conns, worldConns[p], zones);
            const auto depth = zones.empty() ? bm::collide::Depth::Skin : bm::collide::Depth::Joined;
            if (bm::collide::overlap(*items[i].shape, items[i].pose, world->shape(p), world->pose(p), zones, nullptr, depth)) {
              collides = 1;
              break;
            }
          }
        }
        // Mates vs base
        qbox.min = qbox.min - Vec3{6, 6, 6};
        qbox.max = qbox.max + Vec3{6, 6, 6};
        nearby.clear();
        world->near(qbox, nullptr, nearby);
        int mcnt = 0;
        for (uint32_t p : nearby) {
          for (const auto& target : worldConns[p]) {
            for (const auto& c : items[i].conns) {
              if (!compatible(c, target)) continue;
              if (auto m = bm::connect::mate(c, target)) {
                mcnt++;
                totalGrip += m->grip;
              }
            }
          }
        }
        if (mcnt > 0) {
          connBase[i] = 1;
          totalMates += std::min(mcnt, 6);
        }
      }
    }

    // Pairwise added-vs-added collision & mates
    for (int i = 0; i < nAdded; i++) {
      for (int j = i + 1; j < nAdded; j++) {
        if (!collides && items[i].shape && items[j].shape &&
            !items[i].shape->bounds.empty() && !items[j].shape->bounds.empty()) {
          if (overlapPair(items[i].name, *items[i].shape, items[i].pose, items[i].conns,
                          items[j].name, *items[j].shape, items[j].pose, items[j].conns)) {
            collides = 1;
          }
        }
        // Check mates between i and j (fast padded box check)
        Box bi = items[i].box, bj = items[j].box;
        if (!bi.empty() && !bj.empty()) {
          if (bi.max.x + 8 < bj.min.x || bj.max.x + 8 < bi.min.x ||
              bi.max.y + 8 < bj.min.y || bj.max.y + 8 < bi.min.y ||
              bi.max.z + 8 < bj.min.z || bj.max.z + 8 < bi.min.z) {
            continue;
          }
        }
        int pm = 0;
        for (const auto& ca : items[i].conns) {
          for (const auto& cb : items[j].conns) {
            if (!compatible(ca, cb)) continue;
            if (auto m = bm::connect::mate(ca, cb)) {
              pm++;
              totalGrip += m->grip;
            }
          }
        }
        if (pm > 0) {
          adj[i].push_back(j);
          adj[j].push_back(i);
          totalMates += std::min(pm, 6);
        }
      }
    }

    // BFS connectivity to base (or largest component if base empty)
    int connected = 0;
    if (model && !model->pieces().empty()) {
      std::vector<int> q;
      for (int i = 0; i < nAdded; i++) if (connBase[i]) q.push_back(i);
      for (size_t qi = 0; qi < q.size(); qi++) {
        int u = q[qi];
        for (int v : adj[u]) {
          if (!connBase[v]) {
            connBase[v] = 1;
            q.push_back(v);
          }
        }
      }
      connected = static_cast<int>(q.size());
    } else {
      std::vector<uint8_t> vis(nAdded, 0);
      for (int i = 0; i < nAdded; i++) {
        if (vis[i]) continue;
        std::vector<int> q{i};
        vis[i] = 1;
        for (size_t qi = 0; qi < q.size(); qi++) {
          for (int v : adj[q[qi]]) if (!vis[v]) { vis[v] = 1; q.push_back(v); }
        }
        connected = std::max(connected, static_cast<int>(q.size()));
      }
    }

    if (outCollides) *outCollides = collides;
    if (outConnected) *outConnected = connected;
    if (outMates) *outMates = totalMates;
    if (outGrip) *outGrip = totalGrip;
  }
};

}  // namespace

extern "C" {

struct BmCand {
  double matrix[16];
  double axis[3];
  double grip;
  int32_t host;
  int32_t host_conn;
  int32_t conn;
  int32_t kind;  // 0=stud, 1=clip, 2=hinge, 3=technic, 4=generic
  int32_t bidirectional;
};

void* bm_ctx_create(const char* ldraw_dir, const char* shadow_dir, const char* data_dir, int use_studio) {
  try {
    return new Context(ldraw_dir, shadow_dir, data_dir, use_studio != 0);
  } catch (const std::exception& e) {
    std::fprintf(stderr, "bm_ctx_create error: %s\n", e.what());
    return nullptr;
  }
}

void bm_ctx_destroy(void* ptr) {
  delete static_cast<Context*>(ptr);
}

void bm_set_model(void* ptr, int n, const char* const* part_names, const double* mats16) {
  auto* ctx = static_cast<Context*>(ptr);
  if (!ctx) return;
  ctx->setModel(n, part_names, mats16);
}

int bm_hits(void* ptr, const char* part_name, const double* mat16) {
  auto* ctx = static_cast<Context*>(ptr);
  if (!ctx) return 0;
  return ctx->hits(part_name, mat16);
}

int bm_mates(void* ptr, const char* part_name, const double* mat16, double* out_grip) {
  auto* ctx = static_cast<Context*>(ptr);
  if (!ctx) return 0;
  return ctx->mateCount(part_name, mat16, out_grip);
}

int bm_candidates(void* ptr, const char* part_name, BmCand* out, int max_out, int fine_angles) {
  auto* ctx = static_cast<Context*>(ptr);
  if (!ctx || !ctx->model || !out || max_out <= 0) return 0;

  std::string pn = normPart(part_name);
  auto localPtr = ctx->db.get(pn);
  const auto& local = *localPtr;
  if (local.empty()) return 0;

  const bool singleAxis = isSingleAxisPart(local);
  static const double kQuarter[] = {0.0, 90.0, 180.0, 270.0};
  static const double kEighth[] = {0.0, 45.0, 90.0, 135.0, 180.0, 225.0, 270.0, 315.0};
  static const double kFine[] = {
      0.0, 15.0, 22.5, 30.0, 45.0, 60.0, 67.5, 75.0,
      90.0, 105.0, 112.5, 120.0, 135.0, 150.0, 157.5, 165.0,
      180.0, 195.0, 202.5, 210.0, 225.0, 240.0, 247.5, 255.0,
      270.0, 285.0, 292.5, 300.0, 315.0, 330.0, 337.5, 345.0};

  std::unordered_set<PoseKey, PoseKeyHash> seen;
  seen.reserve(1024);
  int written = 0;

  const size_t nPieces = ctx->worldConns.size();
  for (size_t hi = 0; hi < nPieces && written < max_out; hi++) {
    const auto& hconns = ctx->worldConns[hi];
    for (size_t hci = 0; hci < hconns.size() && written < max_out; hci++) {
      if (ctx->occupied[hi][hci]) continue;
      const Connector& target = hconns[hci];

      for (size_t ci = 0; ci < local.size() && written < max_out; ci++) {
        const Connector& inc = local[ci];
        if (!compatible(inc, target)) continue;

        // Quick radius filter for Cyl-Cyl and Cyl-Clip to avoid hopeless pairs
        if (inc.kind == SnapKind::Cyl && target.kind == SnapKind::Cyl) {
          const Connector& male = inc.gender == Gender::Male ? inc : target;
          const Connector& fem = inc.gender == Gender::Male ? target : inc;
          // At least one section pair could match within 2.5 LDU
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
            (inc.kind == SnapKind::Generic && (inc.group.rfind("hinge", 0) == 0 || inc.group.find("hinge") != std::string::npos || inc.group.find("ball") != std::string::npos)));
        const bool isStud = isStudPair(inc, target);

        // Choose rotation angles
        const double* angles = kQuarter;
        int nAngles = 4;
        if (isClip || isHingeOrFinger) {
          angles = fine_angles ? kFine : kEighth;
          nAngles = fine_angles ? 32 : 8;
        } else if (singleAxis && isStud) {
          angles = kEighth;
          nAngles = 8;
        } else if (singleAxis && inc.kind == SnapKind::Cyl && target.kind == SnapKind::Cyl && !isClip) {
          angles = kEighth;
          nAngles = 8;
        }

        const Mat3 incFrameInv = bm::inverse(basis(inc.axis, inc.side));
        // Signs: blind studs mate parallel (+1); open-both-ends female holes allow either side (+1, -1)
        const Connector& femStud = (inc.gender == Gender::Female) ? inc : target;
        double signs[2] = {1.0, -1.0};
        int nSigns = 2;
        if (isStud) {
          if (femStud.openStart && !femStud.openEnd) {
            signs[0] = 1.0; nSigns = 1;
          } else if (!femStud.openStart && femStud.openEnd) {
            signs[0] = -1.0; nSigns = 1;
          } else {
            signs[0] = 1.0; signs[1] = -1.0; nSigns = 2;
          }
        }

        // Choose slide offsets along target.axis (position of inc.start along target.axis from target.start)
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
              // Entering from the openEnd of a through-hole (e.g. stud in Technic brick hole)
              addOff((&femStud == &target) ? target.length : inc.length);
            }
          } else {
            // Exact alignments of starts, ends, and profile section boundaries!
            addOff(0.0);
            addOff(target.length - sign * inc.length);
            addOff((target.length - sign * inc.length) * 0.5);
            addOff(target.length);
            addOff(-sign * inc.length);
            // Section boundary alignments (catches half-pins like 4274 in 3700, collar stops, 32474 on studs!)
            for (const auto& fs : target.profile) {
              for (const auto& ms : inc.profile) {
                addOff(fs.start - sign * ms.start);
                addOff((fs.start + fs.length) - sign * (ms.start + ms.length));
                addOff(fs.start - sign * (ms.start + ms.length));
                addOff((fs.start + fs.length) - sign * ms.start);
              }
            }
            // Slide grid along bar / sliding axle / clip
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
            // Test mate at angle=0 first (for non-keyed/round connectors, mate depends only on axis+offset!)
            // For keyed axles ('A') or fingers, check each angle.
            bool checkPerAngle = (inc.kind == SnapKind::Finger || inc.kind == SnapKind::Generic);
            if (!checkPerAngle) {
              for (const auto& s : inc.profile) if (s.shape == 'A' || s.shape == 'S') checkPerAngle = true;
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
              double grip = baseGrip;
              if (checkPerAngle) {
                Connector posed = bm::connect::transformed(inc, xf);
                auto m = bm::connect::mate(posed, target);
                if (!m) continue;
                grip = m->grip;
              }
              PoseKey key = makePoseKey(xf);
              if (!seen.insert(key).second) continue;

              BmCand& c = out[written++];
              xformToMat16(xf, c.matrix);
              Vec3 approach = (target.gender == Gender::Male) ? target.axis : -target.axis;
              c.axis[0] = approach.x;
              c.axis[1] = approach.y;
              c.axis[2] = approach.z;
              c.grip = grip;
              c.host = static_cast<int32_t>(hi);
              c.host_conn = static_cast<int32_t>(hci);
              c.conn = static_cast<int32_t>(ci);
              c.kind = isStud ? 0 : (isClip ? 1 : (isHingeOrFinger ? 2 : (inc.kind == SnapKind::Cyl ? 3 : 4)));
              c.bidirectional = isStud ? 0 : 1;
            }
          }
        }
      }
    }
  }
  return written;
}

int bm_hits_extra(void* ptr, const char* part_name, const double* mat16,
                  int n_extra, const char* const* extra_names, const double* extra_mats16) {
  auto* ctx = static_cast<Context*>(ptr);
  if (!ctx) return 0;
  return ctx->hitsExtra(part_name, mat16, n_extra, extra_names, extra_mats16);
}

void bm_layout_check(void* ptr, int n_added, const char* const* added_names, const double* added_mats16,
                     int* out_collides, int* out_connected, int* out_mates, double* out_grip) {
  auto* ctx = static_cast<Context*>(ptr);
  if (!ctx) {
    if (out_collides) *out_collides = 0;
    if (out_connected) *out_connected = n_added;
    if (out_mates) *out_mates = 0;
    if (out_grip) *out_grip = 0.0;
    return;
  }
  ctx->layoutCheck(n_added, added_names, added_mats16, out_collides, out_connected, out_mates, out_grip);
}

void bm_rasterize_tris(int n_tris, const double* tris_uvd, const int64_t* labels,
                       int h, int w, double* depth_io, int64_t* label_io) {
  if (n_tris <= 0 || h <= 0 || w <= 0) return;
  for (int t = 0; t < n_tris; t++) {
    const double* p = tris_uvd + static_cast<size_t>(t) * 9;
    const double u0 = p[0], v0 = p[1], d0 = p[2];
    const double u1 = p[3], v1 = p[4], d1 = p[5];
    const double u2 = p[6], v2 = p[7], d2 = p[8];
    const double area = (u1 - u0) * (v2 - v0) - (u2 - u0) * (v1 - v0);
    if (std::abs(area) <= 1e-9) continue;
    const double inv_a = 1.0 / area;

    const double umin = std::min({u0, u1, u2});
    const double umax = std::max({u0, u1, u2});
    const double vmin = std::min({v0, v1, v2});
    const double vmax = std::max({v0, v1, v2});

    const int x0 = std::max(0, static_cast<int>(std::ceil(umin)));
    const int x1 = std::min(w - 1, static_cast<int>(std::floor(umax)));
    const int y0 = std::max(0, static_cast<int>(std::ceil(vmin)));
    const int y1 = std::min(h - 1, static_cast<int>(std::floor(vmax)));
    if (x0 > x1 || y0 > y1) continue;

    const int64_t lab = labels[t];
    // w0(px, py) = ((u1 - px)*(v2 - py) - (u2 - px)*(v1 - py)) * inv_a
    //            = (-(v2 - v1)*px + (u2 - u1)*py + (u1*v2 - u2*v1)) * inv_a
    // w1(px, py) = ((u2 - px)*(v0 - py) - (u0 - px)*(v2 - py)) * inv_a
    //            = (-(v0 - v2)*px + (u0 - u2)*py + (u2*v0 - u0*v2)) * inv_a
    const double dw0_dx = (v1 - v2) * inv_a;
    const double dw0_dy = (u2 - u1) * inv_a;
    const double dw1_dx = (v2 - v0) * inv_a;
    const double dw1_dy = (u0 - u2) * inv_a;
    const double w0_base = ((u1 - x0) * (v2 - y0) - (u2 - x0) * (v1 - y0)) * inv_a;
    const double w1_base = ((u2 - x0) * (v0 - y0) - (u0 - x0) * (v2 - y0)) * inv_a;

    for (int py = y0; py <= y1; py++) {
      const double dy = static_cast<double>(py - y0);
      double w0 = w0_base + dy * dw0_dy;
      double w1 = w1_base + dy * dw1_dy;
      double* drow = depth_io + static_cast<size_t>(py) * w;
      int64_t* lrow = label_io + static_cast<size_t>(py) * w;
      for (int px = x0; px <= x1; px++) {
        const double w2 = 1.0 - w0 - w1;
        if (w0 >= -1e-9 && w1 >= -1e-9 && w2 >= -1e-9) {
          const double z = w0 * d0 + w1 * d1 + w2 * d2;
          if (z < drow[px]) {
            drow[px] = z;
            lrow[px] = lab;
          }
        }
        w0 += dw0_dx;
        w1 += dw1_dx;
      }
    }
  }
}

void bm_rasterize_edges(int n_segs, const double* segs_uvd, const double* depth_ptr,
                        int h, int w, double depth_tol, double spacing,
                        uint8_t* edge_out, double* edge_depth_io) {
  if (n_segs <= 0 || h <= 0 || w <= 0) return;
  const double inv_sp = 1.0 / std::max(spacing, 0.1);
  for (int s = 0; s < n_segs; s++) {
    const double* p = segs_uvd + static_cast<size_t>(s) * 6;
    const double u0 = p[0], v0 = p[1], d0 = p[2];
    const double u1 = p[3], v1 = p[4], d1 = p[5];
    const double du = u1 - u0, dv = v1 - v0, dd = d1 - d0;
    const double len = std::hypot(du, dv);
    const int steps = std::max(1, static_cast<int>(std::ceil(len * inv_sp)));
    const double inv_n = 1.0 / static_cast<double>(steps);
    for (int k = 0; k <= steps; k++) {
      const double t = static_cast<double>(k) * inv_n;
      const int col = static_cast<int>(std::llround(u0 + du * t));
      const int row = static_cast<int>(std::llround(v0 + dv * t));
      if (row < 0 || row >= h || col < 0 || col >= w) continue;
      const size_t idx = static_cast<size_t>(row) * w + col;
      const double d = d0 + dd * t;
      const double z = depth_ptr[idx];
      if (d <= z + depth_tol) {
        if (edge_out) edge_out[idx] = 1;
        if (edge_depth_io) edge_depth_io[idx] = z;
      }
    }
  }
}

void bm_score_sprites(
    int H, int W,
    const float* col_plane,      // H*W (or nullptr)
    const float* old_score,      // H*W
    const double* cur_depth,     // H*W
    const uint8_t* base_edge,    // H*W
    const float* edge_prec_map,  // H*W
    const float* chg_plane,      // H*W (or nullptr)
    float paper_penalty,
    float edge_prec_weight,
    int sh, int sw,
    const uint8_t* sp_mask,      // sh*sw
    const double* sp_depth,      // sh*sw
    const uint8_t* sp_edge,      // sh*sw
    int sp_total,
    int K,
    const int32_t* rows0,        // K
    const int32_t* cols0,        // K
    const double* dds,           // K
    double* out_val,             // K
    double* out_col,             // K
    double* out_edge,            // K
    int32_t* out_changed) {      // K
  // Compact non-zero sprite pixels once so inner loop skips all empty mask pixels!
  std::vector<int32_t> sy, sx;
  std::vector<double> sd;
  std::vector<uint8_t> se;
  sy.reserve(sp_total);
  sx.reserve(sp_total);
  sd.reserve(sp_total);
  se.reserve(sp_total);
  for (int r = 0; r < sh; r++) {
    const int base_off = r * sw;
    for (int c = 0; c < sw; c++) {
      if (sp_mask[base_off + c]) {
        sy.push_back(r);
        sx.push_back(c);
        sd.push_back(sp_depth[base_off + c]);
        se.push_back(sp_edge[base_off + c]);
      }
    }
  }
  const int n_pix = static_cast<int>(sy.size());

  for (int k = 0; k < K; k++) {
    const int row0 = rows0[k];
    const int col0 = cols0[k];
    const double dd = dds[k];
    if (row0 + sh <= 0 || row0 >= H || col0 + sw <= 0 || col0 >= W || n_pix == 0) {
      const double pen = -static_cast<double>(paper_penalty) * static_cast<double>(sp_total);
      out_val[k] = pen;
      out_col[k] = pen;
      out_edge[k] = 0.0;
      out_changed[k] = sp_total;
      continue;
    }

    int inside = 0;
    int n_vis = 0;
    double col_sum = 0.0;
    double edge_sum = 0.0;
    double chg_sum = 0.0;

    for (int i = 0; i < n_pix; i++) {
      const int gy = row0 + sy[i];
      const int gx = col0 + sx[i];
      if (gy < 0 || gy >= H || gx < 0 || gx >= W) continue;
      inside++;
      const size_t idx = static_cast<size_t>(gy) * W + gx;
      if (sd[i] + dd < cur_depth[idx]) {
        n_vis++;
        const double nc = col_plane ? static_cast<double>(col_plane[idx]) : 0.0;
        col_sum += nc - static_cast<double>(old_score[idx]);
        if (se[i]) edge_sum += static_cast<double>(edge_prec_map[idx]);
        if (base_edge[idx]) edge_sum -= static_cast<double>(edge_prec_map[idx]);
        if (chg_plane) chg_sum += static_cast<double>(chg_plane[idx]);
      }
    }

    const int outside = sp_total - inside;
    const double col_gain = col_sum - static_cast<double>(paper_penalty) * static_cast<double>(outside);
    const double edge_gain = static_cast<double>(edge_prec_weight) * edge_sum;
    if (n_vis == 0) {
      const double pen = -static_cast<double>(paper_penalty) * static_cast<double>(outside);
      out_val[k] = pen;
      out_col[k] = pen;
      out_edge[k] = 0.0;
      out_changed[k] = outside;
    } else {
      out_val[k] = col_gain + edge_gain + chg_sum;
      out_col[k] = col_gain;
      out_edge[k] = edge_gain;
      out_changed[k] = n_vis + outside;
    }
  }
}

}  // extern "C"
