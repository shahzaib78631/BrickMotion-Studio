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
  uint32_t culled = 0;                ///< shown instances left out because they are out of view
};

/// How tall, in pixels, a sphere of `radius` at `distance` from the eye looks in a view
/// `viewportHeight` pixels tall. Inside the sphere it is as tall as the view gets.
double projectedPixels(double radius, double distance, double fovY, int viewportHeight);

/// For each group, which of its shown (not hidden) instances are in view and at which detail.
/// An instance's box is its group's mesh bounds (`meshBounds[group]`, part space) under its
/// current matrix. Detail goes by how tall that box's sphere looks: Full at kFullPixels or more,
/// Low at kLowPixels or more, Box below; nothing is dropped for being small. `forceDetail` 0..2
/// puts every kept instance at that detail. With `frustum` false nothing is left out for being
/// out of view. Runs on `pool` (the shared pool when null); the answer is the same on any
/// number of threads.
std::vector<Visible> cull(const Scene& scene, const std::vector<bm::Box>& meshBounds, const Camera& camera, int viewportHeight, int forceDetail = -1, bool frustum = true,
                          bm::JobPool* pool = nullptr);

}  // namespace bmr
