#include "habits.h"

#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <map>
#include <mutex>
#include <nlohmann/json.hpp>

namespace bmapp {

const std::vector<Habit>* Habits::of(const std::string& part) const {
  std::string id = part;
  if (id.ends_with(".dat")) id.resize(id.size() - 4);
  for (const auto& key : {id, id.empty() || id.back() < 'a' || id.back() > 'z' ? id : id.substr(0, id.size() - 1),
                          id + "b", id + "a"}) {
    const auto found = byAnchor.find(key);
    if (found != byAnchor.end()) return &found->second;
  }
  return nullptr;
}

std::shared_ptr<const Habits> loadHabits(const std::string& file) {
  static std::mutex lock;
  static std::map<std::string, std::shared_ptr<const Habits>> loaded;
  const std::lock_guard guard(lock);
  if (const auto found = loaded.find(file); found != loaded.end()) return found->second;
  std::shared_ptr<const Habits> result;
  try {
    std::ifstream input(file, std::ios::binary);
    if (input) {
      const auto json = nlohmann::json::parse(input);
      auto table = std::make_shared<Habits>();
      table->models = json.at("models").get<uint32_t>();
      table->source = json.value("source", "");
      table->parts = json.at("parts").get<std::vector<std::string>>();
      std::vector<bm::Mat3> rotations;
      for (const auto& r : json.at("rots")) {
        bm::Mat3 m;
        for (int i = 0; i < 9; ++i) m.m[i] = r.at(i).get<double>();
        rotations.push_back(m);
      }
      for (const auto& [anchor, rows] : json.at("habits").items()) {
        auto& list = table->byAnchor[anchor];
        for (const auto& row : rows) {
          const auto part = row.at(0).get<uint32_t>(), rotation = row.at(1).get<uint32_t>();
          if (part >= table->parts.size() || rotation >= rotations.size()) continue;
          list.push_back({part, bm::Xform{rotations[rotation], {row.at(2).get<double>(), row.at(3).get<double>(), row.at(4).get<double>()}},
                          row.at(5).get<uint32_t>(), row.at(6).get<uint32_t>(), row.at(7).get<std::string>()});
        }
      }
      result = std::move(table);
    }
  } catch (const std::exception&) {
    result = nullptr;
  }
  loaded[file] = result;
  return result;
}

std::string defaultHabitsFile() {
  if (const char* env = std::getenv("BM_HABITS")) return env;
  return BM_DEFAULT_HABITS;
}

}  // namespace bmapp
