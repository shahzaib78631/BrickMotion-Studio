#include "bm/connect/connectors.h"

#include <algorithm>
#include <cmath>
#include <mutex>
#include <shared_mutex>
#include <sstream>
#include <unordered_map>

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

  /// `cut` is set when a reference loop was skipped: such a result depends on where the walk
  /// started, so it is not kept for other parts to reuse.
  std::shared_ptr<const std::vector<Connector>> compute(const std::string& name, const ldraw::Library& lib, std::vector<std::string>& stack, bool& cut) {
    auto out = std::make_shared<std::vector<Connector>>();
    std::vector<std::string> includeStack;
    own(name, Xform::identity(), includeStack, *out);
    const ldraw::File* file = lib.find(name);
    const ShadowInfo* info = shadow.find(name);
    if (!file || (info && info->clearAll)) return out;
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
        if (info && !inherited.id.empty() && std::find(info->clearIds.begin(), info->clearIds.end(), inherited.id) != info->clearIds.end()) continue;
        if (out->size() >= kMaxConnectorsPerPart) break;
        out->push_back(transformed(inherited, c.xf));
      }
    }
    stack.pop_back();
    return out;
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

ConnectorDb::ConnectorDb(const ldraw::Library& library, const ShadowLibrary& shadow) : state_(new State{library, shadow, {}, {}}) {}
ConnectorDb::~ConnectorDb() = default;

std::shared_ptr<const std::vector<Connector>> ConnectorDb::get(std::string_view partName, const ldraw::Library* modelLibrary) {
  std::string name = ldraw::normalizeName(partName);
  if (name.find('.') == std::string::npos) name += ".dat";
  std::vector<std::string> stack;
  bool cut = false;
  return state_->resolve(name, modelLibrary ? *modelLibrary : state_->library, stack, cut);
}

}  // namespace bm::connect
