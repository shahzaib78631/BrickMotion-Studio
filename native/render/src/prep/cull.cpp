#include "bmr/cull.h"

#include <algorithm>
#include <cmath>
#include "bmr/tolerances.h"

namespace bmr {

double projectedPixels(double radius, double distance, double fovY, int viewportHeight) {
  if (viewportHeight < 1 || !(radius > 0)) return 0;
  if (!(distance > radius)) return viewportHeight;
  return radius / (distance * std::tan(fovY / 2)) * viewportHeight;
}

std::vector<Visible> cull(const Scene& scene, const std::vector<bm::Box>& meshBounds, const Camera& camera, int viewportHeight, int forceDetail, bool frustum, bm::JobPool* pool) {
  std::vector<Visible> out(scene.groups.size());
  const Frustum planes = frustumOf(camera, scene.origin);
  const bool inViewOnly = frustum;
  const bm::Vec3 eye = camera.eye - scene.origin;
  const bool forced = forceDetail >= 0 && forceDetail <= 2;
  // A group at a time: each writes only its own Visible, in instance order.
  (pool ? *pool : bm::JobPool::shared()).parallelFor(scene.groups.size(), [&](size_t g) {
    const Group& group = scene.groups[g];
    Visible& v = out[g];
    const bm::Box part = g < meshBounds.size() ? meshBounds[g] : bm::Box{};
    const bool none = part.empty();
    const bm::Vec3 centre = none ? bm::Vec3{} : (part.min + part.max) * 0.5, half = none ? bm::Vec3{} : (part.max - part.min) * 0.5;
    for (uint32_t i = 0; i < group.instances.size(); i++) {
      const Instance& in = group.instances[i];
      if (in.flags & kHidden) continue;
      const float* m = in.model;
      // The box under the matrix: its centre carried, its half-size by the matrix's absolute values.
      const bm::Vec3 c{m[0] * centre.x + m[1] * centre.y + m[2] * centre.z + m[3], m[4] * centre.x + m[5] * centre.y + m[6] * centre.z + m[7],
                       m[8] * centre.x + m[9] * centre.y + m[10] * centre.z + m[11]};
      const bm::Vec3 h{std::abs(m[0]) * half.x + std::abs(m[1]) * half.y + std::abs(m[2]) * half.z, std::abs(m[4]) * half.x + std::abs(m[5]) * half.y + std::abs(m[6]) * half.z,
                       std::abs(m[8]) * half.x + std::abs(m[9]) * half.y + std::abs(m[10]) * half.z};
      if (inViewOnly && !none && outside(planes, bm::Box{c - h, c + h}, {})) {
        v.culled++;
        continue;
      }
      int detail = 0;
      if (forced) {
        detail = forceDetail;
      } else if (!none) {
        const double pixels = 2 * projectedPixels(length(h), length(c - eye), camera.fovY, viewportHeight);
        detail = pixels >= kFullPixels ? 0 : pixels >= kLowPixels ? 1 : 2;
      }
      v.byDetail[detail].push_back(i);
    }
  });
  return out;
}

}  // namespace bmr
