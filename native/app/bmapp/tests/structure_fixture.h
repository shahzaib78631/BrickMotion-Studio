#pragma once
// The plan the structure tests share, and helpers to find pieces by their plan ids.
#include <filesystem>
#include <fstream>
#include <string>
#include <vector>
#include <nlohmann/json.hpp>
#include "bmapp/session.h"
#include "session_impl.h"

namespace fs = std::filesystem;
using Json = nlohmann::ordered_json;

namespace structure {
/// Root: step 0 a, b; step 1 u1, u2 (uses of Pair), c. Pair: step 0 p1; step 1 p2.
inline fs::path fixture() {
  const fs::path p = fs::temp_directory_path() / "bmapp_structure.json";
  std::ofstream f(p);
  f << R"({"format":"brickmotion-plan","version":1,"name":"Structure",
  "steps":[
    {"title":"First","notes":"one","pieces":[
      {"id":"a","part":"3001.dat","color":4,"x":0,"y":0,"z":0,"rot":0},
      {"id":"b","part":"3001.dat","color":1,"x":6,"y":0,"z":0,"rot":0}]},
    {"notes":"two","pauseAfter":2,"pieces":[
      {"id":"u1","submodel":"Pair","x":0,"y":0,"z":10,"rot":0},
      {"id":"u2","submodel":"Pair","x":10,"y":0,"z":10,"rot":0},
      {"id":"c","part":"3001.dat","color":14,"x":12,"y":0,"z":0,"rot":0}]}],
  "submodels":{"Pair":{"steps":[
    {"pieces":[{"id":"p1","part":"3001.dat","color":2,"x":0,"y":0,"z":0,"rot":0}]},
    {"pieces":[{"id":"p2","part":"3003.dat","color":14,"x":0,"y":3,"z":0,"rot":0}]}]}}})";
  return p;
}

/// The plan id of the item a piece is made of, at `level` of its chain (last = its own part).
inline std::string idOf(const bmapp::Session& s, uint32_t piece, size_t level) {
  const auto& chain = s.impl().refs[piece].chain;
  const auto find = [&](const bm::doc::Def& def) -> std::string {
    for (const auto& step : def.steps)
      for (const auto& item : step.items)
        if (item.id == chain[level]) return item.extra.value("id", std::string());
    return {};
  };
  if (std::string id = find(s.impl().source.root); !id.empty()) return id;
  for (const auto& [name, def] : s.impl().source.submodels)
    if (std::string id = find(def); !id.empty()) return id;
  return {};
}

/// The pieces whose own part item has plan id `id` (more than one for a shared submodel).
inline std::vector<uint32_t> pieces(const bmapp::Session& s, const std::string& id) {
  std::vector<uint32_t> out;
  for (uint32_t p = 0; p < s.pieceCount(); p++)
    if (idOf(s, p, s.impl().refs[p].chain.size() - 1) == id) out.push_back(p);
  return out;
}

inline Json plan(const bmapp::Session& s) { return Json::parse(s.projectBytes())["plan"]; }

inline std::vector<std::string> ids(const Json& step) {
  std::vector<std::string> out;
  for (const Json& i : step["pieces"]) out.push_back(i.value("id", ""));
  return out;
}


}  // namespace structure
