#include "bm/kin/gears.h"

#include <algorithm>
#include <cmath>
#include <map>
#include <nlohmann/json.hpp>
#include "bm/kin/tolerances.h"

namespace bm::kin {
namespace {

using nlohmann::json;
constexpr double kPi = 3.14159265358979323846;

bool readVec(const json& j, Vec3& out) {
  if (!j.is_array() || j.size() != 3) return false;
  for (const json& v : j)
    if (!v.is_number()) return false;
  out = {j[0].get<double>(), j[1].get<double>(), j[2].get<double>()};
  return std::isfinite(out.x) && std::isfinite(out.y) && std::isfinite(out.z);
}

bool readToothed(const json& j, Toothed& out) {
  if (!j.is_object() || !j.contains("kind") || !j["kind"].is_string()) return false;
  const std::string kind = j["kind"].get<std::string>();
  if (kind == "spur") out.kind = ToothKind::Spur;
  else if (kind == "bevel") out.kind = ToothKind::Bevel;
  else if (kind == "double-bevel") out.kind = ToothKind::DoubleBevel;
  else if (kind == "worm") out.kind = ToothKind::Worm;
  else if (kind == "rack") out.kind = ToothKind::Rack;
  else return false;
  if (!j.contains("teeth") || !j["teeth"].is_number_integer()) return false;
  out.teeth = j["teeth"].get<int>();
  if (out.teeth <= 0 || out.teeth > 1000) return false;
  if (!j.contains("axis") || !readVec(j["axis"], out.axis) || !j.contains("centre") || !readVec(j["centre"], out.centre)) return false;
  if (length(out.axis) < 1e-9) return false;
  out.axis = normalized(out.axis);
  auto number = [&](const char* key, double& v) {
    if (j.contains(key) && j[key].is_number()) v = j[key].get<double>();
    return std::isfinite(v) && v >= 0;
  };
  if (!number("pitchRadius", out.pitchRadius) || !number("width", out.width) || !number("length", out.length) || !number("lead", out.lead)) return false;
  if (out.kind == ToothKind::Rack) {
    if (!j.contains("face") || !readVec(j["face"], out.face) || length(out.face) < 1e-9 || out.length <= 0) return false;
    out.face = normalized(out.face);
  } else if (out.pitchRadius <= 0) {
    return false;
  }
  if (out.kind == ToothKind::Bevel) {
    if (!j.contains("facing") || !readVec(j["facing"], out.facing) || length(out.facing) < 1e-9) return false;
    out.facing = normalized(out.facing);
  }
  if (out.kind == ToothKind::Worm && out.lead <= 0) return false;
  return true;
}

std::string bare(std::string_view part) {
  std::string s(part);
  std::transform(s.begin(), s.end(), s.begin(), [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
  if (s.size() > 4 && s.compare(s.size() - 4, 4, ".dat") == 0) s.resize(s.size() - 4);
  return s;
}

/// Distance from `p` to the line through `origin` along unit `axis`, and the foot's offset.
Vec3 across(Vec3 p, Vec3 origin, Vec3 axis) {
  const Vec3 v = p - origin;
  return v - axis * dot(v, axis);
}

bool turns(ToothKind k) { return k == ToothKind::Spur || k == ToothKind::DoubleBevel || k == ToothKind::Bevel; }

/// Side by side on parallel shafts.
bool parallelMesh(const Toothed& A, const Toothed& B, GearMesh& m) {
  if (A.kind == ToothKind::Bevel || B.kind == ToothKind::Bevel) return false;  // a single bevel's teeth are on its face
  if (std::abs(dot(A.axis, B.axis)) < kMeshAxis) return false;
  const Vec3 d = B.centre - A.centre;
  const double along = dot(d, A.axis);
  const Vec3 off = d - A.axis * along;
  const double gap = length(off);
  if (std::abs(gap - (A.pitchRadius + B.pitchRadius)) > kPitchSlack) return false;
  const double lo = std::max(-A.width / 2, along - B.width / 2), hi = std::min(A.width / 2, along + B.width / 2);
  if (hi - lo < kMinFaceShare) return false;
  const Vec3 n = off * (1.0 / gap);
  m.kind = MeshKind::Parallel;
  // On the line of centres, dividing it in the ratio of the tooth counts.
  m.point = A.centre + A.axis * ((lo + hi) / 2) + n * (gap * A.teeth / double(A.teeth + B.teeth));
  m.tangent = normalized(cross(A.axis, n));
  m.width = hi - lo;
  return true;
}

/// Bevels on shafts that meet at a right angle.
bool crossedMesh(const Toothed& A, const Toothed& B, GearMesh& m) {
  if (A.kind == ToothKind::Spur || B.kind == ToothKind::Spur) return false;
  if (std::abs(dot(A.axis, B.axis)) > kMeshCross) return false;
  // Where the shafts meet (the closest points of the two lines).
  const Vec3 w = A.centre - B.centre;
  const double b = dot(A.axis, B.axis), dA = dot(A.axis, w), dB = dot(B.axis, w), den = 1 - b * b;
  const double sA = (b * dB - dA) / den, sB = (dB - b * dA) / den;
  const Vec3 onA = A.centre + A.axis * sA, onB = B.centre + B.axis * sB;
  if (length(onA - onB) > kBevelSlack) return false;
  const Vec3 apex = (onA + onB) * 0.5;
  // Each gear's pitch circle, at the point nearest the other gear, must be where the other's is.
  const Vec3 offA = across(B.centre, A.centre, A.axis), offB = across(A.centre, B.centre, B.axis);
  if (length(offA) < 1e-6 || length(offB) < 1e-6) return false;
  const Vec3 rimA = A.centre + normalized(offA) * A.pitchRadius, rimB = B.centre + normalized(offB) * B.pitchRadius;
  if (length(rimA - rimB) > kBevelSlack + (A.width + B.width) / 4) return false;
  // A single bevel's teeth face the apex.
  if (A.kind == ToothKind::Bevel && dot(A.facing, apex - A.centre) <= 0) return false;
  if (B.kind == ToothKind::Bevel && dot(B.facing, apex - B.centre) <= 0) return false;
  const Vec3 uA = normalized(A.centre - apex), uB = normalized(B.centre - apex);
  if (length(uA) == 0 || length(uB) == 0) return false;
  m.kind = MeshKind::Crossed;
  // Distance to A's shaft : distance to B's shaft = teeth A : teeth B.
  const double scale = (A.pitchRadius / A.teeth + B.pitchRadius / B.teeth) / 2;
  m.point = apex + uA * (scale * B.teeth) + uB * (scale * A.teeth);
  m.tangent = normalized(cross(A.axis, B.axis));
  m.width = std::min(A.width, B.width);
  return true;
}

/// A worm (W) driving a gear (G).
bool wormMesh(const Toothed& W, const Toothed& G, GearMesh& m) {
  if (G.kind == ToothKind::Bevel) return false;
  if (std::abs(dot(W.axis, G.axis)) > kMeshCross) return false;
  const Vec3 n = normalized(cross(W.axis, G.axis));
  const Vec3 d = G.centre - W.centre;
  const double gap = std::abs(dot(d, n));
  if (std::abs(gap - (W.pitchRadius + G.pitchRadius)) > kPitchSlack) return false;
  if (std::abs(dot(d, W.axis)) > W.width / 2 + kPitchSlack) return false;       // beside the thread, not past its end
  if (std::abs(dot(d, G.axis)) > G.width / 2 + kPitchSlack) return false;       // the thread runs through the gear's plane
  const Vec3 toWorm = dot(d, n) > 0 ? -n : n;
  m.kind = MeshKind::Worm;
  m.point = G.centre + toWorm * G.pitchRadius;
  m.tangent = W.axis;
  m.travel = W.lead * W.teeth;
  m.width = G.width;
  return true;
}

/// A gear (G) on a rack (R).
bool rackMesh(const Toothed& G, const Toothed& R, GearMesh& m) {
  if (G.kind == ToothKind::Bevel) return false;
  if (std::abs(dot(G.axis, R.axis)) > kMeshCross) return false;  // the shaft lies across the rack
  const Vec3 d = G.centre - R.centre;
  const double along = dot(d, R.axis), side = dot(d, G.axis);
  if (std::abs(along) > R.length / 2) return false;
  const Vec3 apart = d - R.axis * along - G.axis * side;  // from the pitch line to the shaft
  const double distance = length(apart);
  if (distance < 1e-9 || dot(apart, R.face) < kRackTilt * distance) return false;  // on the side the teeth face
  if (std::abs(distance - G.pitchRadius) > kRackSlack) return false;
  const double rackWidth = std::max(R.width, kMinFaceShare);
  if ((G.width + rackWidth) / 2 - std::abs(side) < kMinFaceShare) return false;
  m.kind = MeshKind::Rack;
  m.point = G.centre - apart * (G.pitchRadius / distance);
  m.tangent = R.axis;
  m.travel = 2 * kPi * G.pitchRadius;
  m.width = std::min(G.width, rackWidth);
  return true;
}

}  // namespace

Toothed placed(const Toothed& t, const Xform& xf) {
  Toothed out = t;
  auto dir = [&](Vec3 v) { return normalized(xf.r * v); };
  out.axis = dir(t.axis);
  out.centre = xf.apply(t.centre);
  out.facing = dir(t.facing);
  out.face = dir(t.face);
  return out;
}

size_t GearDb::load(std::string_view text) {
  const json doc = json::parse(text, nullptr, false);
  if (!doc.is_object() || !doc.contains("parts") || !doc["parts"].is_object()) return 0;
  std::map<std::string, std::vector<Toothed>> all(parts_.begin(), parts_.end());
  size_t added = 0;
  for (const auto& [part, rows] : doc["parts"].items()) {
    if (!rows.is_array()) continue;
    std::vector<Toothed> teeth;
    for (const json& row : rows) {
      Toothed t;
      if (readToothed(row, t)) teeth.push_back(t);
    }
    if (teeth.empty()) continue;
    all[bare(part)] = std::move(teeth);
    added++;
  }
  parts_.assign(all.begin(), all.end());
  return added;
}

size_t GearDb::loadScrews(std::string_view text) {
  const json doc = json::parse(text, nullptr, false);
  if (!doc.is_object() || !doc.contains("parts") || !doc["parts"].is_object()) return 0;
  std::map<std::string, Screw> all(screws_.begin(), screws_.end());
  size_t added = 0;
  for (const auto& [part, row] : doc["parts"].items()) {
    if (!row.is_object() || !row.contains("input") || !row["input"].is_string() || !row.contains("piston") || !row["piston"].is_string()) continue;
    if (!row.contains("leadLduPerTurn") || !row["leadLduPerTurn"].is_number()) continue;
    const double lead = row["leadLduPerTurn"].get<double>();
    if (!(lead > 0)) continue;
    all[bare(part)] = Screw{bare(row["input"].get<std::string>()), bare(row["piston"].get<std::string>()), lead};
    added++;
  }
  screws_.assign(all.begin(), all.end());
  return added;
}

const GearDb::Screw* GearDb::screw(std::string_view part) const {
  const std::string key = bare(part);
  const auto it = std::lower_bound(screws_.begin(), screws_.end(), key, [](const auto& row, const std::string& k) { return row.first < k; });
  return it != screws_.end() && it->first == key ? &it->second : nullptr;
}

std::string barePart(std::string_view part) { return bare(part); }

const std::vector<Toothed>& GearDb::get(std::string_view part) const {
  static const std::vector<Toothed> none;
  auto find = [&](const std::string& key) -> const std::vector<Toothed>* {
    const auto it = std::lower_bound(parts_.begin(), parts_.end(), key, [](const auto& row, const std::string& k) { return row.first < k; });
    return it != parts_.end() && it->first == key ? &it->second : nullptr;
  };
  const std::string key = bare(part);
  if (const auto* hit = find(key)) return *hit;
  // "3648a", "32270p01", "92693c01": the base number.
  size_t digits = 0;
  while (digits < key.size() && std::isdigit(static_cast<unsigned char>(key[digits]))) digits++;
  if (digits == 0 || digits == key.size()) return none;
  const auto* hit = find(key.substr(0, digits));
  return hit ? *hit : none;
}

std::vector<GearMesh> findMeshes(const std::vector<PlacedTeeth>& teeth) {
  std::map<std::pair<uint32_t, uint32_t>, GearMesh> found;
  for (size_t i = 0; i < teeth.size(); i++) {
    for (size_t j = i + 1; j < teeth.size(); j++) {
      const PlacedTeeth &P = teeth[i], &Q = teeth[j];
      if (P.piece == Q.piece) continue;
      const Toothed &A = P.teeth, &B = Q.teeth;
      // Nothing meshes from further away than the two reaches added together.
      const double reachA = A.kind == ToothKind::Rack ? A.length / 2 + A.width : A.pitchRadius + A.width;
      const double reachB = B.kind == ToothKind::Rack ? B.length / 2 + B.width : B.pitchRadius + B.width;
      if (length(A.centre - B.centre) > reachA + reachB + 2 * kRackSlack) continue;
      GearMesh m;
      bool swapped = false, ok = false;
      if (turns(A.kind) && turns(B.kind)) {
        ok = parallelMesh(A, B, m) || crossedMesh(A, B, m);
      } else if (A.kind == ToothKind::Worm && turns(B.kind)) {
        ok = wormMesh(A, B, m);
      } else if (B.kind == ToothKind::Worm && turns(A.kind)) {
        ok = wormMesh(B, A, m);
        swapped = true;
      } else if (turns(A.kind) && B.kind == ToothKind::Rack && !Q.besideWorm) {
        ok = rackMesh(A, B, m);
      } else if (turns(B.kind) && A.kind == ToothKind::Rack && !P.besideWorm) {
        ok = rackMesh(B, A, m);
        swapped = true;
      }
      if (!ok) continue;
      const PlacedTeeth &first = swapped ? Q : P, &second = swapped ? P : Q;
      m.a = first.piece;
      m.b = second.piece;
      m.teethA = first.teeth.teeth;
      m.teethB = second.teeth.kind == ToothKind::Rack ? 0 : second.teeth.teeth;
      m.axisA = first.teeth.axis;
      m.pointA = first.teeth.centre;
      m.axisB = second.teeth.axis;
      m.pointB = second.teeth.centre;
      found.emplace(std::minmax(m.a, m.b), m);  // the first mesh found for a pair of pieces stands
    }
  }
  std::vector<GearMesh> out;
  out.reserve(found.size());
  for (auto& [key, m] : found) out.push_back(m);
  return out;
}

std::vector<GearMesh> findMeshes(const Model& model, const GearDb& gears) {
  std::vector<PlacedTeeth> teeth;
  if (gears.size() == 0) return {};
  const auto& pieces = model.pieces();
  for (uint32_t i = 0; i < pieces.size(); i++) {
    const std::vector<Toothed>& rows = gears.get(pieces[i].part);
    if (rows.empty()) continue;
    const bool worm = std::any_of(rows.begin(), rows.end(), [](const Toothed& t) { return t.kind == ToothKind::Worm; });
    for (const Toothed& t : rows) teeth.push_back({i, placed(t, pieces[i].world), worm});
  }
  return findMeshes(teeth);
}

const char* name(MeshKind kind) {
  switch (kind) {
    case MeshKind::Parallel: return "parallel";
    case MeshKind::Crossed: return "crossed";
    case MeshKind::Worm: return "worm";
    case MeshKind::Rack: return "rack";
    case MeshKind::Screw: return "screw";
    case MeshKind::Clutch: return "clutch";
    case MeshKind::Cv: return "cv";
  }
  return "parallel";
}

}  // namespace bm::kin
