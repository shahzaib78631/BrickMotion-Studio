#include "bm/connect/connectors.h"
#include "bm/connect/studio.h"
#include "bm/connect/tolerances.h"

#include <algorithm>
#include <cmath>
#include <mutex>
#include <shared_mutex>
#include <sstream>
#include <unordered_map>
#include <nlohmann/json.hpp>

namespace bm::connect {
namespace {

constexpr size_t kMaxDepth = 64;
constexpr size_t kMaxIncludeDepth = 8;
constexpr size_t kMaxConnectorsPerPart = 20000;  // a runaway reference pattern stops here

/// A unit vector perpendicular to `axis`, as close to `hint` as possible.
Vec3 perpendicular(Vec3 axis, Vec3 hint) {
  Vec3 s = hint - axis * dot(hint, axis);
  if (length(s) < 1e-9) {
    const Vec3 other = std::abs(axis.x) < 0.9 ? Vec3{1, 0, 0} : Vec3{0, 0, 1};
    s = other - axis * dot(other, axis);
  }
  return normalized(s);
}

/// One snap definition at one of its frames, in the file's own space.
Connector place(const SnapDef& def, const Frame& frame) {
  Connector c;
  c.kind = def.kind;
  c.gender = def.gender;
  c.id = def.id;
  c.group = def.group;
  c.match = def.match;
  c.placement = def.placement;
  c.bounding = def.bounding;
  c.slide = def.slide;
  // Sections run along the frame's -Y.
  const Vec3 rawAxis = frame.r * Vec3{0, -1, 0};
  const double along = length(rawAxis);
  const Vec3 rawSide = frame.r * Vec3{1, 0, 0};
  const double across = std::max(length(rawSide), length(frame.r * Vec3{0, 0, 1}));
  c.axis = along > 0 ? rawAxis * (1.0 / along) : Vec3{0, -1, 0};
  c.side = perpendicular(c.axis, rawSide);
  Vec3 origin = frame.t;
  bool centred = def.center;
  switch (def.kind) {
    case SnapKind::Cyl: {
      double cursor = 0;
      for (const Section& s : def.sections) {
        c.profile.push_back({s.shape, s.radius * across, cursor, s.length * along});
        cursor += s.length * along;
        c.radius = std::max(c.radius, s.radius * across);
      }
      c.length = cursor;
      c.openStart = def.caps == "none" || def.caps == "one" || def.caps == "b";
      c.openEnd = def.caps == "none" || def.caps == "a";
      break;
    }
    case SnapKind::Clip:
      c.length = def.length * along;
      c.radius = def.radius * across;
      c.openStart = c.openEnd = true;
      break;
    case SnapKind::Finger:
      for (double w : def.seq) {
        c.seq.push_back(w * along);
        c.length += w * along;
      }
      c.radius = def.radius * across;
      break;
    case SnapKind::Generic: {
      // bounding = "sph r" | "cyl r l" | "box x y z" | "cube s": centred on the position.
      std::istringstream in(def.bounding);
      std::string shape;
      double a = 0, b = 0;
      in >> shape >> a >> b;
      c.radius = a * across;
      c.length = shape == "cyl" ? b * along : 0;
      centred = false;
      break;
    }
  }
  c.start = centred ? origin - c.axis * (c.length / 2) : origin;
  return c;
}

}  // namespace

Connector transformed(const Connector& c, const Xform& xf) {
  Connector out = c;
  const Vec3 rawAxis = xf.r * c.axis;
  const double along = length(rawAxis);
  const Vec3 rawSide = xf.r * c.side;
  const Vec3 third = xf.r * cross(c.axis, c.side);
  const double across = std::max(length(rawSide), length(third));
  out.start = xf.apply(c.start);
  out.axis = along > 0 ? rawAxis * (1.0 / along) : c.axis;
  out.side = perpendicular(out.axis, rawSide);
  out.length = c.length * along;
  out.radius = c.radius * across;
  for (ProfileSection& s : out.profile) {
    s.start *= along;
    s.length *= along;
    s.radius *= across;
  }
  for (double& w : out.seq) w *= along;
  return out;
}

struct ConnectorDb::State {
  const ldraw::Library& library;
  const ShadowLibrary& shadow;
  std::shared_mutex mutex;
  std::unordered_map<std::string, std::shared_ptr<const std::vector<Connector>>> memo;
  std::unordered_map<std::string, std::vector<Connector>> extras;  // from sources other than the shadow library
  const StudioLibrary* studio = nullptr;

  /// The snaps a shadow file defines itself, with its includes expanded.
  void own(const std::string& file, const Xform& xf, std::vector<std::string>& includeStack, std::vector<Connector>& out) const {
    const ShadowInfo* info = shadow.find(file);
    if (!info) return;
    for (const SnapDef& def : info->snaps)
      for (const Frame& frame : def.frames) {
        if (out.size() >= kMaxConnectorsPerPart) return;
        out.push_back(transformed(place(def, frame), xf));
      }
    if (includeStack.size() >= kMaxIncludeDepth) return;
    includeStack.push_back(file);
    for (const Include& inc : info->includes) {
      if (std::find(includeStack.begin(), includeStack.end(), inc.ref) != includeStack.end()) continue;  // a loop
      for (const Frame& frame : inc.frames) own(inc.ref, xf * Xform{frame.r, frame.t}, includeStack, out);
    }
    includeStack.pop_back();
  }

  /// Model files embed parts that were not in the library yet as "<set> - <part>.dat". The
  /// connector data is filed under the part's own name.
  static std::string embeddedName(const std::string& name) {
    const size_t at = name.rfind(" - ");
    return at == std::string::npos ? name : name.substr(at + 3);
  }

  void clears(const std::string& file, size_t depth, bool& all, std::vector<std::string>& ids) const {
    const ShadowInfo* info = shadow.find(file);
    if (!info || depth > kMaxIncludeDepth) return;
    all = all || info->clearAll;
    ids.insert(ids.end(), info->clearIds.begin(), info->clearIds.end());
    for (const Include& inc : info->includes) clears(inc.ref, depth + 1, all, ids);
  }

  /// `cut` is set when a reference loop was skipped: such a result depends on where the walk
  /// started, so it is not kept for other parts to reuse.
  std::shared_ptr<const std::vector<Connector>> compute(const std::string& name, const ldraw::Library& lib, std::vector<std::string>& stack, bool& cut) {
    auto out = std::make_shared<std::vector<Connector>>();
    std::vector<std::string> includeStack;
    const std::string dataName = lib.isInline(name) ? embeddedName(name) : name;
    own(dataName, Xform::identity(), includeStack, *out);
    if (const auto it = extras.find(dataName); it != extras.end()) out->insert(out->end(), it->second.begin(), it->second.end());
    const ldraw::File* file = lib.find(name);
    // What this file's shadow, and the shadow files it includes, say to drop from its subfiles.
    bool clearAll = false;
    std::vector<std::string> clearIds;
    clears(dataName, 0, clearAll, clearIds);
    if (!file || clearAll) {
      mergeStudio(dataName, *out);
      return out;
    }
    if (stack.size() >= kMaxDepth) {
      cut = true;
      return out;
    }
    stack.push_back(name);
    for (const ldraw::Command& c : file->cmds) {
      if (c.type != ldraw::Cmd::Ref) continue;
      if (std::find(stack.begin(), stack.end(), c.file) != stack.end()) {
        cut = true;
        continue;
      }
      const auto child = resolve(c.file, lib, stack, cut);
      for (const Connector& inherited : *child) {
        if (!inherited.id.empty() && std::find(clearIds.begin(), clearIds.end(), inherited.id) != clearIds.end()) continue;
        if (out->size() >= kMaxConnectorsPerPart) break;
        out->push_back(transformed(inherited, c.xf));
      }
    }
    stack.pop_back();
    mergeStudio(dataName, *out);
    return out;
  }

  /// Whether `list` already has a connector doing `c`'s job where `c` is.
  static bool covered(const Connector& c, const std::vector<Connector>& list) {
    for (const Connector& have : list) {
      if (have.kind != c.kind || have.gender != c.gender) continue;
      if (c.kind == SnapKind::Generic) {
        if (have.group == c.group && length(have.start - c.start) <= kPointMatch) return true;
        continue;
      }
      if (std::abs(dot(have.axis, c.axis)) < kAxisParallel) continue;
      const Vec3 v = c.start - have.start;
      if (length(v - have.axis * dot(v, have.axis)) > kAxisOffset) continue;
      // On the same line: the same connector if they overlap along it.
      const double sign = dot(have.axis, c.axis) > 0 ? 1 : -1, t0 = dot(v, have.axis);
      const double lo = std::min(t0, t0 + sign * c.length), hi = std::max(t0, t0 + sign * c.length);
      if (std::min(hi, have.length) - std::max(lo, 0.0) > -kRadiusSlack) return true;
    }
    return false;
  }

  void mergeStudio(const std::string& dataName, std::vector<Connector>& out) const {
    if (!studio) return;
    const auto extra = studio->find(dataName);
    // Checked against what the part had before, so a Studio grid is taken whole or cell by cell.
    const size_t before = out.size();
    for (const Connector& c : *extra) {
      const std::vector<Connector> existing(out.begin(), out.begin() + static_cast<std::ptrdiff_t>(before));
      if (!covered(c, existing) && out.size() < kMaxConnectorsPerPart) out.push_back(c);
    }
  }

  std::shared_ptr<const std::vector<Connector>> resolve(const std::string& name, const ldraw::Library& lib, std::vector<std::string>& stack, bool& cut) {
    // A file from the model itself may differ from model to model, so it is never shared.
    if (lib.isInline(name)) return compute(name, lib, stack, cut);
    {
      std::shared_lock lock(mutex);
      if (const auto it = memo.find(name); it != memo.end()) return it->second;
    }
    bool ownCut = false;
    auto result = compute(name, lib, stack, ownCut);
    if (ownCut) {
      cut = true;
      if (!stack.empty()) return result;  // only a walk from the top is kept
    }
    std::unique_lock lock(mutex);
    return memo.emplace(name, std::move(result)).first->second;
  }
};

ConnectorDb::ConnectorDb(const ldraw::Library& library, const ShadowLibrary& shadow) : state_(new State{library, shadow, {}, {}, {}, nullptr}) {}
ConnectorDb::~ConnectorDb() = default;

std::shared_ptr<const std::vector<Connector>> ConnectorDb::get(std::string_view partName, const ldraw::Library* modelLibrary) {
  std::string name = ldraw::normalizeName(partName);
  if (name.find('.') == std::string::npos) name += ".dat";
  std::vector<std::string> stack;
  bool cut = false;
  return state_->resolve(name, modelLibrary ? *modelLibrary : state_->library, stack, cut);
}

void ConnectorDb::setStudio(const StudioLibrary* studio) {
  std::unique_lock lock(state_->mutex);
  state_->studio = studio;
  state_->memo.clear();
}

void ConnectorDb::add(std::string_view partName, std::vector<Connector> connectors) {
  std::string name = ldraw::normalizeName(partName);
  if (name.find('.') == std::string::npos) name += ".dat";
  std::unique_lock lock(state_->mutex);
  auto& list = state_->extras[name];
  list.insert(list.end(), std::make_move_iterator(connectors.begin()), std::make_move_iterator(connectors.end()));
  state_->memo.clear();
}

size_t loadWheelSeats(std::string_view json, ConnectorDb& db) {
  const nlohmann::json doc = nlohmann::json::parse(json.begin(), json.end(), nullptr, false);
  if (!doc.is_object() || !doc.contains("seats") || !doc["seats"].is_array()) return 0;
  size_t added = 0;
  for (const nlohmann::json& s : doc["seats"]) {
    if (!s.is_object() || !s.contains("part") || !s["part"].is_string() || !s.contains("role") || !s["role"].is_string()) continue;
    const std::string role = s["role"].get<std::string>();
    if (role != "tyre" && role != "rim") continue;
    if (!s.contains("axis") || !s["axis"].is_array() || s["axis"].size() != 3 || !s["axis"][0].is_number() || !s["axis"][1].is_number() || !s["axis"][2].is_number()) continue;
    if (!s.contains("radius") || !s["radius"].is_number() || !s.contains("width") || !s["width"].is_number()) continue;
    const Vec3 axis{s["axis"][0].get<double>(), s["axis"][1].get<double>(), s["axis"][2].get<double>()};
    const double radius = s["radius"].get<double>(), width = s["width"].get<double>();
    if (length(axis) < 1e-9 || radius <= 0 || width <= 0) continue;
    Connector c;
    c.kind = SnapKind::Cyl;
    c.gender = role == "tyre" ? Gender::Female : Gender::Male;
    c.source = Source::Geometry;
    c.axis = normalized(axis);
    c.side = perpendicular(c.axis, {1, 0, 0});
    c.length = width;
    c.radius = radius;
    c.start = c.axis * (-width / 2);
    c.profile = {{'T', radius, 0, width}};
    c.openStart = c.openEnd = true;
    c.id = "wheelseat";
    db.add(s["part"].get<std::string>(), {std::move(c)});
    added++;
  }
  return added;
}

size_t loadBricknetJoints(std::string_view json, ConnectorDb& db) {
  const nlohmann::json doc = nlohmann::json::parse(json.begin(), json.end(), nullptr, false);
  if (!doc.is_object() || !doc.contains("parts") || !doc["parts"].is_object()) return 0;
  size_t added = 0;
  for (const auto& [part, rows] : doc["parts"].items()) {
    if (!rows.is_array()) continue;
    std::vector<Connector> list;
    for (const nlohmann::json& row : rows) {
      if (!row.is_array() || row.size() < 6 || !row[0].is_string()) continue;
      bool numbers = true;
      for (size_t i = 1; i < row.size(); i++) numbers = numbers && row[i].is_number();
      if (!numbers) continue;
      const std::string family = row[0].get<std::string>();
      const bool hinge = family == "hinge";
      if ((!hinge && family != "ball") || (hinge && row.size() < 8)) continue;
      Connector c;
      c.kind = SnapKind::Generic;
      c.source = Source::BrickNet;
      c.gender = row[2].get<int>() == 0 ? Gender::Male : Gender::Female;  // "in" is the male half
      c.start = {row[3].get<double>(), row[4].get<double>(), row[5].get<double>()};
      c.group = "bricknet-" + family + "-" + std::to_string(row[1].get<int>());
      c.axis = {0, -1, 0};
      if (hinge) {
        // The frame is pitch about x then roll about z; the hinge line is its -Y.
        const double rad = 3.14159265358979323846 / 180.0, pitch = row[6].get<double>() * rad, roll = row[7].get<double>() * rad;
        c.axis = normalized(Vec3{std::sin(roll), -std::cos(pitch) * std::cos(roll), -std::sin(pitch) * std::cos(roll)});
        c.placement = "hinge";
      } else {
        c.placement = "free";
        c.bounding = "sph";
      }
      c.side = perpendicular(c.axis, {1, 0, 0});
      list.push_back(std::move(c));
    }
    added += list.size();
    if (!list.empty()) db.add(part, std::move(list));
  }
  return added;
}

size_t loadExtraConnectors(std::string_view json, ConnectorDb& db) {
  const nlohmann::json doc = nlohmann::json::parse(json.begin(), json.end(), nullptr, false);
  if (!doc.is_object() || !doc.contains("parts") || !doc["parts"].is_object()) return 0;
  size_t added = 0;
  for (const auto& [part, rows] : doc["parts"].items()) {
    if (!rows.is_array()) continue;
    std::vector<Connector> list;
    for (const nlohmann::json& row : rows) {
      if (!row.is_object() || !row.contains("kind") || !row["kind"].is_string() || !row.contains("at") || !row["at"].is_array() || row["at"].size() != 3) continue;
      const std::string kind = row["kind"].get<std::string>();
      const bool cv = kind == "cv-ball" || kind == "cv-cup";
      const bool round = kind == "ball" || kind == "socket" || cv, shaft = kind == "rod" || kind == "bore";
      if (!round && !shaft) continue;
      // A rod or bore given as stretches ("secs") takes its radius and length from them.
      const bool stretches = shaft && row.contains("secs");
      if (stretches) {
        if (!row["secs"].is_string() || row.contains("radius") || row.contains("length")) continue;
      } else if (!row.contains("radius") || !row["radius"].is_number() || !(row["radius"].get<double>() > 0)) {
        continue;
      }
      bool numbers = true;
      for (const nlohmann::json& v : row["at"]) numbers = numbers && v.is_number();
      if (!numbers) continue;
      Connector c;
      c.source = Source::Override;
      c.gender = kind == "ball" || kind == "rod" || kind == "cv-ball" ? Gender::Male : Gender::Female;
      c.start = {row["at"][0].get<double>(), row["at"][1].get<double>(), row["at"][2].get<double>()};
      c.radius = stretches ? 0 : row["radius"].get<double>();
      c.axis = {0, -1, 0};
      if (round) {
        c.kind = SnapKind::Generic;
        c.group = "ball";
        c.match = "size";
        c.placement = "free";
        c.bounding = "sph";
        if (cv) {
          // A constant-velocity joint: a ball in a cup that also passes turning about the shaft.
          if (!row.contains("axis") || !row["axis"].is_array() || row["axis"].size() != 3 || !row["axis"][0].is_number() || !row["axis"][1].is_number() || !row["axis"][2].is_number()) continue;
          const Vec3 shaftAxis{row["axis"][0].get<double>(), row["axis"][1].get<double>(), row["axis"][2].get<double>()};
          if (!(length(shaftAxis) > 0)) continue;
          c.group = kCvGroup;
          c.axis = normalized(shaftAxis);
        }
      } else {
        // A smooth rod sliding and turning in a smooth bore that is open at both ends. Or, with
        // "secs", one made of stretches in the shadow library's notation, from `at` along
        // `axis`: "R 6 16  R 8 2" is a pin hole with its counterbore at the far end, "A 6 20"
        // an axle hole. "caps" closes ends as the shadow library's does: "one" (or "b") the
        // far end, "a" the near one, "two" both; "none", the default, neither. "slide": false
        // holds what is in it from sliding, as a wheel's hole on its holder's pin.
        if (!row.contains("axis") || !row["axis"].is_array() || row["axis"].size() != 3) continue;
        bool axisOk = true;
        for (const nlohmann::json& v : row["axis"]) axisOk = axisOk && v.is_number();
        if (!axisOk) continue;
        const Vec3 axis{row["axis"][0].get<double>(), row["axis"][1].get<double>(), row["axis"][2].get<double>()};
        if (!(length(axis) > 0)) continue;
        c.kind = SnapKind::Cyl;
        c.axis = normalized(axis);
        if (stretches) {
          const std::vector<Section> parsed = parseSections(row["secs"].get<std::string>());
          double cursor = 0;
          for (const Section& s : parsed) {
            c.profile.push_back({s.shape, s.radius, cursor, s.length});
            cursor += s.length;
            c.radius = std::max(c.radius, s.radius);
          }
          c.length = cursor;
          if (!(c.length > 0)) continue;
        } else {
          if (!row.contains("length") || !row["length"].is_number() || !(row["length"].get<double>() > 0)) continue;
          c.length = row["length"].get<double>();
          c.profile = {{'R', c.radius, 0, c.length}};
        }
        c.slide = true;
        if (row.contains("slide")) {
          if (!row["slide"].is_boolean()) continue;
          c.slide = row["slide"].get<bool>();
        }
        std::string caps = "none";
        if (row.contains("caps")) {
          if (!row["caps"].is_string()) continue;
          caps = row["caps"].get<std::string>();
        }
        if (caps != "none" && caps != "one" && caps != "two" && caps != "a" && caps != "b") continue;
        c.openStart = caps == "none" || caps == "one" || caps == "b";
        c.openEnd = caps == "none" || caps == "a";
      }
      c.side = perpendicular(c.axis, {1, 0, 0});
      list.push_back(std::move(c));
    }
    added += list.size();
    if (!list.empty()) db.add(part, std::move(list));
  }
  return added;
}

}  // namespace bm::connect
