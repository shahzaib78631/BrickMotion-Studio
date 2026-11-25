#pragma once
#include <memory>
#include <string>
#include <unordered_map>
#include <vector>
#include "bm/math.h"

namespace bmapp {

/// Where builders put one part on another, mined from the BrickNet models
/// (python/bricknet/habits.py → public/data/suggest/habits.json).
struct Habit {
  uint32_t part;        ///< index into Habits::parts
  bm::Xform relative;   ///< the other part's pose in the anchor's frame, LDraw units
  uint32_t models;      ///< how many models join them this way
  uint32_t sameColour;  ///< percent of those where the two share a colour
  std::string joint;    ///< BrickNet's joint kind: stud, axle, hinge, …
};

struct Habits {
  uint32_t models = 0;
  std::string source;
  std::vector<std::string> parts;
  std::unordered_map<std::string, std::vector<Habit>> byAnchor;

  /// The habits of a part: its own, or those of the same mould without its variant letter.
  const std::vector<Habit>* of(const std::string& part) const;
};

/// Reads the table once; null when the file is missing or unreadable. Thread-safe.
std::shared_ptr<const Habits> loadHabits(const std::string& file);
/// The bundled table, else the repository's copy for developer builds.
std::string defaultHabitsFile();

}  // namespace bmapp
