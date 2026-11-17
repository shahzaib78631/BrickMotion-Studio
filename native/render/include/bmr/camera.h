#pragma once
// Where the picture is taken from, and what is in view.
#include "bm/math.h"
#include "bm/plan/timeline.h"

namespace bmr {

/// Looks from `eye` at `target`. LDraw space: lengths in LDU, -y is up.
struct Camera {
  bm::Vec3 eye{0, -200, -400}, target{};
  bm::Vec3 up{0, -1, 0};
  double fovY = 0.6;           ///< radians, top to bottom (about 34 degrees: a 70 mm lens on full frame)
  double near = 1, far = 1e5;  ///< LDU
  double aspect = 1;           ///< width over height
};

/// Column-major, as Metal shaders read a float4x4: m[column * 4 + row].
struct Mat4 {
  float m[16];
};
Mat4 multiply(const Mat4& a, const Mat4& b);  ///< a after b
/// `m` applied to (p, 1): x, y, z, w.
void transform(const Mat4& m, bm::Vec3 p, float out[4]);

/// World space less `origin` to view space (x right, y up, looking down -z). A camera whose
/// eye is at its target, or whose up is along its line of sight, still gives a finite matrix.
Mat4 viewMatrix(const Camera& camera, bm::Vec3 origin);
/// View space to Metal clip space with depth reversed: `near` maps to depth 1 and `far` to 0,
/// which keeps precision far from the eye in large scenes.
Mat4 projectionMatrix(const Camera& camera);

/// Six planes with inward normals, in world space less the origin given to frustumOf.
struct Frustum {
  float planes[6][4];  ///< a point p is inside a plane when dot(n, p) + d >= 0
};
Frustum frustumOf(const Camera& camera, bm::Vec3 origin);
/// True only if the whole box is outside one of the planes: a box that is reported outside
/// is certainly not in view; one near a corner of the view may be reported inside when it is not.
bool outside(const Frustum& frustum, const bm::Box& box, bm::Vec3 origin);

/// The key light's view: world space less `origin` to the shadow map's clip space (x, y in
/// -1..1, depth 0..1, nearer the light is less), fitted to `bounds` seen along the light and
/// reaching `beyond` further from the light (for the floor under the model). The map's side
/// is rounded up in steps of an eighth of a power of two and its corner snapped to whole
/// texels, so a model that moves a little does not make its shadow crawl.
struct KeyLight {
  Mat4 matrix;
  double texel = 1;  ///< LDU per texel
};
KeyLight keyLight(const bm::Box& bounds, bm::Vec3 origin, bm::Vec3 towardLight, int mapSize, double beyond);

/// A camera on a sphere around a target: what the window's mouse and the timeline drive.
struct OrbitCamera {
  bm::Vec3 target;
  double distance = 400;
  double azimuth = 0.6;     ///< radians about the vertical; 0 is the front view (from -z, with +x to the right)
  double elevation = 0.45;  ///< radians; above 0 the eye is above the target, looking down
  double fovY = 0.6;

  void orbit(double dAzimuth, double dElevation);  ///< elevation is held within +-kMaxElevation
  void zoom(double factor);                        ///< distance is multiplied, held within [kMinDistance, kMaxDistance]
  /// Slides the target across the view by a drag of this many pixels in a view this tall.
  void pan(double dxPixels, double dyPixels, double viewportHeight);
  bm::Vec3 eye() const;
  /// Near and far are fitted to `sceneBounds` (or left wide if it is empty).
  Camera camera(double aspect, const bm::Box& sceneBounds) const;
  /// Looking at the middle of `bounds` from far enough to have all of it in view, with kFrameMargin to spare.
  static OrbitCamera framing(const bm::Box& bounds, double fovY, double aspect);
  /// Looking at `bounds` from this azimuth and elevation, as close as keeps its eight corners in
  /// view with kFrameMargin to spare. Tighter than framing, but only for this one view: for
  /// still pictures, and for "frame the model" from where the user is looking.
  static OrbitCamera fitted(const bm::Box& bounds, double fovY, double aspect, double azimuth, double elevation);
  static OrbitCamera from(const bm::plan::CameraKey& key);
};

}  // namespace bmr
