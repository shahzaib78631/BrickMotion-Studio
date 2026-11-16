#include "bm/plan/truth.h"

#include <algorithm>
#include <cmath>
#include <cstdio>
#include "bm/plan/tolerances.h"

namespace bm::plan {
namespace {
constexpr double kNear = 12.0;  // as the mechanism truth lists: how close a named position must be

const Move* moveOf(const Plan& plan, uint32_t piece) {
  for (const Move& m : plan.moves) {
    if (!std::binary_search(m.unit.pieces.begin(), m.unit.pieces.end(), piece)) continue;
    if (m.unit.pieces.size() > 1 && m.sub >= 0 && static_cast<size_t>(m.sub) < plan.subs.size())
      if (const Move* inner = moveOf(plan.subs[static_cast<size_t>(m.sub)], piece); inner && inner->unit.pieces.size() == 1 && inner->path.size() >= 2) return inner;
    return &m;
  }
  return nullptr;
}
}  // namespace

InsertionScore scoreInsertion(const Model& model, ldraw::PartCache& parts, const Plan& plan, const nlohmann::json& cases) {
  InsertionScore out;
  if (!cases.is_array()) return out;
  for (const nlohmann::json& c : cases) {
    InsertionLine line;
    auto done = [&](InsertionLine::Result r, std::string detail = "") {
      line.result = r;
      line.detail = std::move(detail);
      (r == InsertionLine::Result::Hit ? out.hit : r == InsertionLine::Result::Missing ? out.missing : out.unresolved)++;
      out.lines.push_back(line);
    };
    if (!c.is_object()) {
      done(InsertionLine::Result::Unresolved, "not a case");
      continue;
    }
    line.id = c.value("id", "");
    line.why = c.value("why", "");
    auto vec = [](const nlohmann::json& j, Vec3& v) {
      if (!j.is_array() || j.size() != 3 || !j[0].is_number() || !j[1].is_number() || !j[2].is_number()) return false;
      v = {j[0].get<double>(), j[1].get<double>(), j[2].get<double>()};
      return true;
    };
    Vec3 at, axis;
    if (!c.contains("piece") || !c["piece"].is_object() || !c["piece"].contains("part") || !c["piece"]["part"].is_string() || !c["piece"].contains("at") || !vec(c["piece"]["at"], at) || !c.contains("axis") || !vec(c["axis"], axis) || !(length(axis) > 0)) {
      done(InsertionLine::Result::Unresolved, "piece or axis not given");
      continue;
    }
    std::string part = c["piece"]["part"].get<std::string>();
    std::transform(part.begin(), part.end(), part.begin(), [](unsigned char ch) { return static_cast<char>(std::tolower(ch)); });
    if (part.size() < 4 || part.compare(part.size() - 4, 4, ".dat") != 0) part += ".dat";
    int piece = -1;
    double best = kNear;
    for (size_t i = 0; i < model.pieces().size(); i++) {
      if (model.pieces()[i].part != part) continue;
      const Box box = model.mesh(part, parts)->bounds.transformed(model.pieces()[i].world);
      const double d = length((box.empty() ? model.pieces()[i].world.t : (box.min + box.max) * 0.5) - at);
      if (d <= best) best = d, piece = static_cast<int>(i);
    }
    if (piece < 0) {
      done(InsertionLine::Result::Unresolved, "no such piece there");
      continue;
    }
    const Move* m = moveOf(plan, static_cast<uint32_t>(piece));
    if (!m) {
      done(InsertionLine::Result::Unresolved, "the plan does not place it");
      continue;
    }
    if (m->flag != Flag::None) {
      done(InsertionLine::Result::Missing, std::string("flagged ") + name(m->flag));
      continue;
    }
    const double along = dot(normalized(axis), m->insertion);
    const bool either = c.value("either", false);
    if (along >= kReleaseAgree || (either && -along >= kReleaseAgree)) {
      done(InsertionLine::Result::Hit);
      continue;
    }
    char buf[96];
    std::snprintf(buf, sizeof buf, "goes in along %.2f %.2f %.2f, %.0f degrees off", m->insertion.x, m->insertion.y, m->insertion.z, std::acos(std::clamp(along, -1.0, 1.0)) * 57.29578);
    done(InsertionLine::Result::Missing, buf);
  }
  return out;
}

}  // namespace bm::plan
