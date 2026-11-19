#pragma once
// The editing rules a shot list keeps: shots long enough to take in, cuts no faster than a viewer
// can follow, no jump cuts, and no cut across a flight's line of action.
#include <string>
#include <vector>
#include "bmf/beats.h"
#include "bmf/shots.h"

namespace bm::film {

struct RuleMiss {
  std::string rule;  ///< "min-length", "cut-rate", "jump-cut", "line"
  std::string shot;  ///< the shot's id
  double at = 0;     ///< seconds
  std::string detail;
};

/// Angles a shot starts and ends on (radians, from the front), its moves included.
std::pair<double, double> startAngles(const Shot& shot);
std::pair<double, double> endAngles(const Shot& shot);

/// `front`: the model's front azimuth, which shot angles are measured from.
std::vector<RuleMiss> checkEditing(const std::vector<Shot>& shots, const Beats& beats, double fps, double front = 0);

}  // namespace bm::film
