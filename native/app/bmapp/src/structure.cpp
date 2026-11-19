#include "structure.h"

#include <map>

namespace bmapp {

namespace {
using Json = nlohmann::ordered_json;

std::string idOf(const bm::doc::Item& item) {
  return item.extra.is_object() && item.extra.contains("id") && item.extra["id"].is_string() ? item.extra["id"].get<std::string>() : "";
}

Json* assembly(bm::doc::Item& item) {
  if (!item.extra.is_object() || !item.extra.contains("assembly") || !item.extra["assembly"].is_object()) return nullptr;
  return &item.extra["assembly"];
}

/// Calls `f` with every id an item's references name; `f` returns the id to keep, "" to drop it.
template <typename F>
void mapRefs(bm::doc::Item& item, F f) {
  Json* a = assembly(item);
  if (!a) return;
  if (a->contains("attachTo") && (*a)["attachTo"].is_string()) {
    const std::string to = f((*a)["attachTo"].get<std::string>());
    if (to.empty()) a->erase("attachTo");
    else (*a)["attachTo"] = to;
  }
  if (a->contains("after") && (*a)["after"].is_array()) {
    Json kept = Json::array();
    for (const Json& id : (*a)["after"]) {
      if (!id.is_string()) continue;
      const std::string to = f(id.get<std::string>());
      if (!to.empty()) kept.push_back(to);
    }
    if (kept.empty()) a->erase("after");
    else (*a)["after"] = std::move(kept);
  }
  if (a->empty()) item.extra.erase("assembly");
}
}  // namespace

std::set<std::string> planIds(const bm::doc::Def& def) {
  std::set<std::string> out;
  for (const auto& step : def.steps)
    for (const auto& item : step.items)
      if (std::string id = idOf(item); !id.empty()) out.insert(id);
  return out;
}

void repairIds(std::vector<bm::doc::Item>& moving, const std::set<std::string>& taken) {
  std::set<std::string> used = taken;
  std::map<std::string, std::string> renamed;
  for (bm::doc::Item& item : moving) {
    const std::string id = idOf(item);
    if (id.empty()) continue;
    if (!used.count(id)) {
      used.insert(id);
      continue;
    }
    std::string fresh;
    for (int n = 2;; n++) {
      fresh = id + "-" + std::to_string(n);
      if (!used.count(fresh)) break;
    }
    used.insert(fresh);
    item.extra["id"] = fresh;
    renamed.emplace(id, fresh);
  }
  if (renamed.empty()) return;
  for (bm::doc::Item& item : moving)
    mapRefs(item, [&](const std::string& id) {
      const auto found = renamed.find(id);
      return found == renamed.end() ? id : found->second;
    });
}

void keepRefsInside(bm::doc::Def& def) {
  const std::set<std::string> here = planIds(def);
  for (auto& step : def.steps)
    for (auto& item : step.items) mapRefs(item, [&](const std::string& id) { return here.count(id) ? id : std::string(); });
}

std::vector<std::pair<size_t, size_t>> referencing(const bm::doc::Def& def, const std::set<std::string>& ids) {
  std::vector<std::pair<size_t, size_t>> out;
  for (size_t si = 0; si < def.steps.size(); si++)
    for (size_t ii = 0; ii < def.steps[si].items.size(); ii++) {
      bm::doc::Item copy = def.steps[si].items[ii];
      bool hit = false;
      mapRefs(copy, [&](const std::string& id) {
        hit = hit || ids.count(id);
        return id;
      });
      if (hit) out.emplace_back(si, ii);
    }
  return out;
}

}  // namespace bmapp
