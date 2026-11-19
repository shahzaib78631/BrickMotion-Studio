#include "bmapp/keys.h"

#include <cmath>

namespace bmapp {

Vec3 arrowAxis(const CameraState& camera, Arrow arrow) {
  // On the floor, from the eye: forward is toward the target, right is forward x up (-y up).
  const double s = std::sin(camera.yaw), c = std::cos(camera.yaw);
  double x = 0, z = 0;
  switch (arrow) {
    case Arrow::Right: x = c, z = -s; break;
    case Arrow::Left: x = -c, z = s; break;
    case Arrow::Up: x = s, z = c; break;
    case Arrow::Down: x = -s, z = -c; break;
  }
  if (std::abs(x) + 1e-9 >= std::abs(z)) return {x < 0 ? -1.0 : 1.0, 0, 0};
  return {0, 0, z < 0 ? -1.0 : 1.0};
}

}  // namespace bmapp
