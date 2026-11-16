#include "bm/plan/constraints.h"

#include <cmath>
#include <unordered_map>

namespace bm::plan {
namespace {

bool numbers(const nlohmann::ordered_json& j, size_t count) {
  if (!j.is_array() || j.size() != count) return false;
  for (const auto& v : j)
    if (!v.is_number()) return false;
  return true;
}

Xform inverseOf(const Xform& x) {
  Xform out;
  out.r = bm::inverse(x.r);
  out.t = -(out.r * x.t);
  return out;
}

/// A unit quaternion (x, y, z, w) as a rotation.
Mat3 rotationOf(double x, double y, double z, double w) {
  const double n = std::sqrt(x * x + y * y + z * z + w * w);
  if (!(n > 0)) return Mat3::identity();
  x /= n, y /= n, z /= n, w /= n;
  return Mat3{{1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w), 2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w), 2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)}};
}

}  // namespace

Constraints readConstraints(const io::PlanDoc& doc, const Model& model) {
  Constraints out;
  const auto& pieces = model.pieces();
  const uint32_t n = static_cast<uint32_t>(pieces.size());
  out.insertionAxis.assign(n, Vec3{});
  out.flight.resize(n);
  std::unordered_map<std::string, uint32_t> byId;
  for (uint32_t i = 0; i < n; i++) byId.emplace(pieces[i].id, i);
  auto find = [&](const nlohmann::ordered_json& id) -> uint32_t {
    if (!id.is_string()) return UINT32_MAX;
    const auto it = byId.find(id.get<std::string>());
    return it == byId.end() ? UINT32_MAX : it->second;
  };
  if (!doc.json.is_object() || !doc.json.contains("steps") || !doc.json["steps"].is_array()) return out;
  for (const auto& step : doc.json["steps"]) {
    if (!step.is_object() || !step.contains("pieces") || !step["pieces"].is_array()) continue;
    std::vector<uint32_t> listed;
    for (const auto& item : step["pieces"]) {
      if (!item.is_object() || !item.contains("part") || !item.contains("id")) continue;
      const uint32_t piece = find(item["id"]);
      if (piece == UINT32_MAX) continue;
      listed.push_back(piece);
      if (!item.contains("assembly") || !item["assembly"].is_object()) continue;
      const auto& hints = item["assembly"];
      if (hints.contains("after") && hints["after"].is_array())
        for (const auto& id : hints["after"])
          if (const uint32_t first = find(id); first != UINT32_MAX && first != piece) out.after.emplace_back(first, piece);
      if (hints.contains("attachTo"))
        if (const uint32_t first = find(hints["attachTo"]); first != UINT32_MAX && first != piece) out.after.emplace_back(first, piece);
      if (hints.contains("insertionAxis") && numbers(hints["insertionAxis"], 3)) {
        const Vec3 axis{hints["insertionAxis"][0].get<double>(), hints["insertionAxis"][1].get<double>(), hints["insertionAxis"][2].get<double>()};
        if (length(axis) > 0) out.insertionAxis[piece] = normalized(axis);
      }
      if (hints.contains("flight") && hints["flight"].is_array()) {
        std::vector<Xform> flight;
        const Xform seat = pieces[piece].world, back = inverseOf(seat);
        for (const auto& pose : hints["flight"]) {
          if (!numbers(pose, 7)) {
            flight.clear();
            break;
          }
          Xform local;
          local.t = {pose[0].get<double>(), pose[1].get<double>(), pose[2].get<double>()};
          local.r = rotationOf(pose[3].get<double>(), pose[4].get<double>(), pose[5].get<double>(), pose[6].get<double>());
          flight.push_back(seat * local * back);  // a motion of the model, from the seat
        }
        if (flight.size() >= 2) out.flight[piece] = std::move(flight);
      }
    }
    if (step.contains("pinOrder") && step["pinOrder"].is_boolean() && step["pinOrder"].get<bool>() && listed.size() > 1) out.pinned.push_back(std::move(listed));
  }
  return out;
}

}  // namespace bm::plan
