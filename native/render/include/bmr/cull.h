#pragma once
// What is in view this frame, and how much of each piece to draw.
#include <cstdint>
#include <vector>
#include "bm/jobs.h"
#include "bm/math.h"
#include "bmr/camera.h"
#include "bmr/scene.h"

namespace bmr {

/// One group's instances that are in view, by the detail to draw them at.
struct Visible {
  std::vector<uint32_t> byDetail[3];  ///< instance numbers, rising, at Full, Low, Box
  std::vector<uint32_t> edges[2];     ///< those of byDetail[0] and [1] whose outlines show (studs at least kEdgeStudPixels wide)
  /// byDetail[0] and [1] split by where the eye is: above[d] those it sees from above their
  /// bottom (PartShape::bottom), drawn without their underside; below[d] the rest, drawn whole,
  /// as is every transparent piece (its underside shows through it).
  std::vector<uint32_t> above[2], below[2];
  uint32_t culled = 0;                ///< shown instances left out because they are out of view
};

/// What culling needs of a group's part: its bounds (part space), how far its low-detail
/// mesh may be from the full one (LDU), and the height (part space, +y down) an eye must be
/// below to see its underside (RenderMesh::bottom; infinite for a part with none).
struct PartShape {
  bm::Box bounds;
  float lowError = 0;
  double bottom = -1e300;
};

/// How tall, in pixels, a sphere of `radius` at `distance` from the eye looks in a view
/// `viewportHeight` pixels tall. Inside the sphere it is as tall as the view gets.
double projectedPixels(double radius, double distance, double fovY, int viewportHeight);
/// How many pixels one LDU looks at `distance` (never nearer than kNearest).
double pixelsPerLdu(double distance, double fovY, int viewportHeight);

/// For each group, which of its shown (not hidden) instances are in view and at which detail.
/// An instance's box is its part's bounds under its current matrix. Full where the part's
/// lowError looks kLowErrorPixels or more at the near side of the box's sphere, Box where the
/// sphere looks under kLowPixels tall, Low otherwise; nothing is dropped for being small.
/// `forceDetail` 0..2 puts every kept instance at that detail. With `frustum` false nothing
/// is left out: not for being out of view, nor an underside the eye is above. Runs on `pool` (the shared pool when null); the answer
/// is the same on any number of threads.
std::vector<Visible> cull(const Scene& scene, const std::vector<PartShape>& parts, const Camera& camera, int viewportHeight, int forceDetail = -1, bool frustum = true,
                          bm::JobPool* pool = nullptr);
void cullInto(std::vector<Visible>& result, const Scene& scene, const std::vector<PartShape>& parts,
              const Camera& camera, int viewportHeight, int forceDetail, bool frustum, bool edges,
              bm::JobPool* pool = nullptr);

}  // namespace bmr
