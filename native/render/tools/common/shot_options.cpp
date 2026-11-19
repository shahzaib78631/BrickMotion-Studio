#include "shot_options.h"

#include <algorithm>
#include <cstdio>
#include <cstdlib>
#include "bmr/material.h"

namespace bmtools {

int parseShotOption(ShotOptions& o, const std::vector<std::string_view>& args, size_t& i) {
  const std::string_view a = args[i];
  size_t at = i;
  auto value = [&]() -> std::string {
    if (at + 1 >= args.size()) return {};
    return std::string(args[++at]);
  };
  int result = 1;
  if (a == "--out") o.out = value();
  else if (a == "--size") {
    const std::string v = value();
    if (std::sscanf(v.c_str(), "%dx%d", &o.width, &o.height) != 2 || o.width < 1 || o.height < 1) result = -1;
  } else if (a == "--eye" || a == "--target") {
    bm::Vec3& v = a == "--eye" ? o.eye : o.target;
    if (std::sscanf(value().c_str(), "%lf,%lf,%lf", &v.x, &v.y, &v.z) != 3) result = -1;
    o.explicitCamera = true;
  } else if (a == "--fov") o.fovDegrees = std::atof(value().c_str());
  else if (a == "--azimuth") o.azimuth = std::atof(value().c_str());
  else if (a == "--elevation") o.elevation = std::atof(value().c_str());
  else if (a == "--lights-fixed") o.lightsFollow = false;
  else if (a == "--correct") o.correct = true;
  else if (a == "--flight") {
    if (!bm::plan::parse(value(), o.flight)) result = -1;
  }
  else if (a == "--lights-follow") o.lightsFollow = true;
  else if (a == "--background") {
    unsigned r = 0, g = 0, b = 0;
    if (std::sscanf(value().c_str(), "%u,%u,%u", &r, &g, &b) != 3) result = -1;
    o.background[0] = bmr::linearFromSrgb(r), o.background[1] = bmr::linearFromSrgb(g), o.background[2] = bmr::linearFromSrgb(b);
    o.backgroundSet = true;
  } else if (a == "--repeat") {
    const std::string v = value();
    if (std::sscanf(v.c_str(), "%dx%d", &o.columns, &o.rows) != 2 || o.columns < 1 || o.rows < 1) result = -1;
  } else if (a == "--frame") {
    o.frame = std::atoi(value().c_str());
    if (o.frame < 0) result = -1;
  } else return 0;
  i = at;
  return result;
}

bool shotCamera(const ShotOptions& o, const bm::Box& bounds, const bm::plan::Timeline* timeline, bmr::OrbitCamera& orbit) {
  const double aspect = double(o.width) / o.height;
  const bmr::OrbitCamera defaults;
  orbit = bmr::OrbitCamera::fitted(bounds, 0.6, aspect, std::isnan(o.azimuth) ? defaults.azimuth : o.azimuth, std::isnan(o.elevation) ? defaults.elevation : o.elevation);
  if (o.explicitCamera) {
    const bm::Vec3 from = o.eye - o.target;
    orbit.target = o.target, orbit.distance = bm::length(from);
    if (!(orbit.distance > 0)) return false;
    orbit.elevation = std::asin(std::clamp(-from.y / orbit.distance, -1.0, 1.0));
    orbit.azimuth = std::atan2(-from.x, -from.z);
  }
  if (std::isfinite(o.fovDegrees)) orbit.fovY = o.fovDegrees * M_PI / 180;
  if (o.frame >= 0 && timeline && !timeline->camera.empty() && std::isnan(o.azimuth) && std::isnan(o.elevation)) orbit = bmr::OrbitCamera::along(*timeline, o.frame);
  return true;
}

}  // namespace bmtools
