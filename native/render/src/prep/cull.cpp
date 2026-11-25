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

double pixelsPerLdu(double distance, double fovY, int viewportHeight) {
  if (viewportHeight < 1) return 0;
  return viewportHeight / (2 * std::max(distance, kNearest) * std::tan(fovY / 2));
}

std::vector<Visible> cull(const Scene& scene, const std::vector<PartShape>& parts, const Camera& camera, int viewportHeight, int forceDetail, bool frustum, bm::JobPool* pool) {
  std::vector<Visible> out;
  cullInto(out, scene, parts, camera, viewportHeight, forceDetail, frustum, true, pool);
  return out;
}

void cullInto(std::vector<Visible>& out, const Scene& scene, const std::vector<PartShape>& parts,
              const Camera& camera, int viewportHeight, int forceDetail, bool frustum, bool showEdges,
              bm::JobPool* pool) {
  out.resize(scene.groups.size());
  const Frustum planes = frustumOf(camera, scene.origin);
  const bool inViewOnly = frustum;
  const bm::Vec3 eye = camera.eye - scene.origin;
  const bool forced = forceDetail >= 0 && forceDetail <= 2;
  const double lens = std::tan(camera.fovY / 2);
  const bool orthographic = camera.orthoHalfHeight > 0;
  const double orthoScale = orthographic ? viewportHeight / (2 * camera.orthoHalfHeight) : 0;
  // A group at a time: each writes only its own Visible, in instance order.
  (pool ? *pool : bm::JobPool::shared()).parallelFor(scene.groups.size(), [&](size_t g) {
    const Group& group = scene.groups[g];
    Visible& v = out[g];
    v.culled = 0;
    for (auto& list : v.byDetail) list.clear();
    for (auto& list : v.edges) list.clear();
    for (auto& list : v.above) list.clear();
    for (auto& list : v.below) list.clear();
    const bm::Box part = g < parts.size() ? parts[g].bounds : bm::Box{};
    const double lowError = g < parts.size() ? parts[g].lowError : 0.0;
    // A transparent piece's underside shows through its walls: it is always drawn whole.
    const double bottom = g < parts.size() && !group.material.transparent() ? parts[g].bottom : -1e300;
    const bool none = part.empty();
    const bm::Vec3 centre = none ? bm::Vec3{} : (part.min + part.max) * 0.5, half = none ? bm::Vec3{} : (part.max - part.min) * 0.5;
    for (uint32_t i = 0; i < group.instances.size(); i++) {
      const Instance& in = group.instances[i];
      if (in.flags & kNotShown) continue;
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
      bool edges = true;
      if (!none) {
        const double radius = length(h), distance = length(c - eye);
        const double perLdu = orthographic ? orthoScale : viewportHeight < 1 ? 0 :
            viewportHeight / (2 * std::max(distance - radius, kNearest) * lens);
        edges = kStudLdu * perLdu >= kEdgeStudPixels;
        if (forced) detail = forceDetail;
        else if (group.material.transparent() || lowError * perLdu >= kLowErrorPixels) detail = 0;
        else {
          const double pixels = viewportHeight < 1 || !(radius > 0) ? 0 :
              distance > radius ? radius / (distance * lens) * viewportHeight : viewportHeight;
          detail = pixels >= kLowPixels ? 1 : 2;
        }
      } else if (forced) {
        detail = forceDetail;
      }
      v.byDetail[detail].push_back(i);
      if (showEdges && edges && detail < 2) v.edges[detail].push_back(i);
      if (detail < 2) {
        if (!inViewOnly || bottom == -1e300) {
          v.below[detail].push_back(i);
          continue;
        }
        // The eye's height in the part's own space: by the inverse matrix's second row (the
        // cross product of the third and first columns, over the determinant). An eye less
        // than kUndersideSlack above the bottom still gets the underside.
        const bm::Vec3 c0{m[0], m[4], m[8]}, c1{m[1], m[5], m[9]}, c2{m[2], m[6], m[10]};
        const double det = dot(c0, cross(c1, c2));
        const bm::Vec3 offset = eye - bm::Vec3{m[3], m[7], m[11]};
        const double y = std::abs(det) > 1e-12 ? dot(cross(c2, c0), offset) / det : 1e300;
        (y < bottom - kUndersideSlack ? v.above : v.below)[detail].push_back(i);
      }
    }
  });
}

}  // namespace bmr
