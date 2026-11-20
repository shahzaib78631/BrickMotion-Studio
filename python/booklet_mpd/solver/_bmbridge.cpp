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
  k.tx = static_cast<int32_t>(std::llround(xf.t.x * 2.0));
  k.ty = static_cast<int32_t>(std::llround(xf.t.y * 2.0));
  k.tz = static_cast<int32_t>(std::llround(xf.t.z * 2.0));
  for (int i = 0; i < 9; i++) k.r[i] = static_cast<int16_t>(std::llround(xf.r.m[i] * 100.0));
  return k;
}

bool isStudLike(const Connector& c) {
  if (c.kind != SnapKind::Cyl) return false;
  if (c.length <= 8.0 && c.radius >= 5.5 && c.radius <= 8.5) return true;
  return false;
}

bool isSingleAxisPart(const std::vector<Connector>& conns) {
  Vec3 refP{}, refA{};
  bool has = false;
  for (const auto& c : conns) {
    if (!isStudLike(c)) continue;
    if (!has) {
      refP = c.start;
      refA = c.axis;
      has = true;
    } else {
      if (std::abs(bm::dot(c.axis, refA)) < 0.98) return false;
      Vec3 d = c.start - refP;
      Vec3 perp = d - refA * bm::dot(d, refA);
      if (bm::length(perp) > 1.0) return false;
    }
  }
  return has;
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
        const bool isStud = isStudLike(inc) && isStudLike(target);

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
        // Signs: studs mate with parallel axes (+1); pins/bars/clips/hinges try both (+1, -1)
        double signs[2] = {1.0, -1.0};
        int nSigns = isStud ? 1 : 2;

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
            addOff(0.0);
            addOff(target.length - sign * inc.length);
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

}  // extern "C"
