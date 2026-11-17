#include "bmr/camera.h"

#include <algorithm>
#include <cmath>
#include "bmr/tolerances.h"

namespace bmr {
namespace {
using bm::Vec3;

/// The camera's right, up and forward, unit and square to each other, whatever it was given.
void basis(const Camera& c, Vec3& right, Vec3& up, Vec3& forward) {
  forward = c.target - c.eye;
  forward = length(forward) > 1e-12 ? normalized(forward) : Vec3{0, 0, -1};
  right = cross(forward, c.up);
  if (!(length(right) > 1e-9)) right = cross(forward, std::abs(forward.x) < 0.9 ? Vec3{1, 0, 0} : Vec3{0, 0, 1});  // looking straight along up
  right = normalized(right);
  up = cross(right, forward);
}
}  // namespace

Mat4 multiply(const Mat4& a, const Mat4& b) {
  Mat4 out;
  for (int c = 0; c < 4; c++)
    for (int r = 0; r < 4; r++) {
      float v = 0;
      for (int k = 0; k < 4; k++) v += a.m[k * 4 + r] * b.m[c * 4 + k];
      out.m[c * 4 + r] = v;
    }
  return out;
}

void transform(const Mat4& m, Vec3 p, float out[4]) {
  const double v[4] = {p.x, p.y, p.z, 1};
  for (int r = 0; r < 4; r++) {
    double sum = 0;
    for (int c = 0; c < 4; c++) sum += m.m[c * 4 + r] * v[c];
    out[r] = static_cast<float>(sum);
  }
}

Mat4 viewMatrix(const Camera& camera, Vec3 origin) {
  Vec3 right, up, forward;
  basis(camera, right, up, forward);
  const Vec3 eye = camera.eye - origin;
  const Vec3 rows[3] = {right, up, -forward};
  Mat4 out{};
  for (int r = 0; r < 3; r++) {
    out.m[0 * 4 + r] = static_cast<float>(rows[r].x);
    out.m[1 * 4 + r] = static_cast<float>(rows[r].y);
    out.m[2 * 4 + r] = static_cast<float>(rows[r].z);
    out.m[3 * 4 + r] = static_cast<float>(-dot(rows[r], eye));
  }
  out.m[15] = 1;
  return out;
}

Mat4 projectionMatrix(const Camera& camera) {
  const double fov = std::min(3.0, std::max(0.01, std::isfinite(camera.fovY) ? camera.fovY : 0.6));
  const double aspect = camera.aspect > 1e-6 && std::isfinite(camera.aspect) ? camera.aspect : 1;
  const double n = std::max(1e-3, camera.near), f = std::max(n * 1.001, camera.far);
  const double t = 1 / std::tan(fov / 2);
  Mat4 out{};
  out.m[0] = static_cast<float>(t / aspect);
  out.m[5] = static_cast<float>(t);
  // Depth n -> 1, f -> 0: clip z = a * zv + b with w = -zv.
  out.m[10] = static_cast<float>(n / (f - n));
  out.m[14] = static_cast<float>(n * f / (f - n));
  out.m[11] = -1;
  return out;
}

Frustum frustumOf(const Camera& camera, Vec3 origin) {
  const Mat4 m = multiply(projectionMatrix(camera), viewMatrix(camera, origin));
  auto row = [&](int r, float out[4]) {
    for (int c = 0; c < 4; c++) out[c] = m.m[c * 4 + r];
  };
  float x[4], y[4], z[4], w[4];
  row(0, x), row(1, y), row(2, z), row(3, w);
  Frustum f;
  for (int c = 0; c < 4; c++) {
    f.planes[0][c] = w[c] + x[c];  // left
    f.planes[1][c] = w[c] - x[c];  // right
    f.planes[2][c] = w[c] + y[c];  // bottom
    f.planes[3][c] = w[c] - y[c];  // top
    f.planes[4][c] = w[c] - z[c];  // near (depth 1)
    f.planes[5][c] = z[c];         // far (depth 0)
  }
  for (auto& p : f.planes) {
    const float len = std::sqrt(p[0] * p[0] + p[1] * p[1] + p[2] * p[2]);
    if (len > 0)
      for (float& v : p) v /= len;
  }
  return f;
}

bool outside(const Frustum& frustum, const bm::Box& box, Vec3 origin) {
  if (box.empty()) return true;
  const Vec3 lo = box.min - origin, hi = box.max - origin;
  for (const auto& p : frustum.planes) {
    // The corner furthest along the plane's normal: if even that is behind the plane, all of it is.
    const double x = p[0] >= 0 ? hi.x : lo.x, y = p[1] >= 0 ? hi.y : lo.y, z = p[2] >= 0 ? hi.z : lo.z;
    if (p[0] * x + p[1] * y + p[2] * z + p[3] < 0) return true;
  }
  return false;
}

void OrbitCamera::orbit(double dAzimuth, double dElevation) {
  if (std::isfinite(dAzimuth)) azimuth = std::remainder(azimuth + dAzimuth, 2 * 3.14159265358979323846);
  if (std::isfinite(dElevation)) elevation = std::min(kMaxElevation, std::max(-kMaxElevation, elevation + dElevation));
}

void OrbitCamera::zoom(double factor) {
  if (!(factor > 0) || !std::isfinite(factor)) return;
  distance = std::min(kMaxDistance, std::max(kMinDistance, distance * factor));
}

Vec3 OrbitCamera::eye() const {
  const double ce = std::cos(elevation);
  // Azimuth 0 is the front view: LDraw models face -z, so the eye is on the -z side and +x is to the right.
  return target + Vec3{-ce * std::sin(azimuth), -std::sin(elevation), -ce * std::cos(azimuth)} * distance;
}

void OrbitCamera::pan(double dxPixels, double dyPixels, double viewportHeight) {
  if (!(viewportHeight > 0) || !std::isfinite(dxPixels) || !std::isfinite(dyPixels)) return;
  Camera c;
  c.eye = eye(), c.target = target;
  Vec3 right, up, forward;
  basis(c, right, up, forward);
  // One pixel at the target's distance is this many LDU.
  const double perPixel = 2 * distance * std::tan(fovY / 2) / viewportHeight;
  target = target - right * (dxPixels * perPixel) + up * (dyPixels * perPixel);
}

Camera OrbitCamera::camera(double aspect, const bm::Box& sceneBounds) const {
  Camera c;
  c.eye = eye(), c.target = target, c.fovY = fovY, c.aspect = aspect > 0 && std::isfinite(aspect) ? aspect : 1;
  if (!sceneBounds.empty()) {
    const Vec3 centre = (sceneBounds.min + sceneBounds.max) * 0.5;
    const double radius = 0.5 * length(sceneBounds.max - sceneBounds.min), away = length(centre - c.eye);
    c.far = std::max(away + radius, distance) * 1.5 + 100;
    c.near = std::max(kNearest, std::min((away - radius) * 0.5, c.far / 1e4 * 10));
    c.near = std::max(kNearest, std::min(c.near, distance * 0.05));
  }
  return c;
}

OrbitCamera OrbitCamera::framing(const bm::Box& bounds, double fovY, double aspect) {
  OrbitCamera o;
  o.fovY = fovY > 0.01 && fovY < 3 ? fovY : 0.6;
  if (bounds.empty()) return o;
  o.target = (bounds.min + bounds.max) * 0.5;
  // The sphere around the box fits in the narrower of the two angles of view.
  const double radius = std::max(1.0, 0.5 * length(bounds.max - bounds.min));
  const double half = o.fovY / 2, halfAcross = std::atan(std::tan(half) * (aspect > 0 && std::isfinite(aspect) ? aspect : 1));
  o.distance = std::min(kMaxDistance, std::max(kMinDistance, kFrameMargin * radius / std::sin(std::min(half, halfAcross))));
  return o;
}

OrbitCamera OrbitCamera::fitted(const bm::Box& bounds, double fovY, double aspect, double azimuth, double elevation) {
  OrbitCamera o = framing(bounds, fovY, aspect);
  o.azimuth = azimuth;
  o.elevation = std::min(kMaxElevation, std::max(-kMaxElevation, elevation));
  if (bounds.empty()) return o;
  // The view's axes: f from the eye toward the target, r to the right, u up on the screen.
  const bm::Vec3 f = normalized(o.target - o.eye());
  const bm::Vec3 r = normalized(cross(f, bm::Vec3{0, -1, 0}));
  const bm::Vec3 u = cross(r, f);
  const double tanY = std::tan(o.fovY / 2), tanX = tanY * (aspect > 0 && std::isfinite(aspect) ? aspect : 1);
  // A corner c (from the target) is at depth distance + c.f; it is in view across when
  // |c.r| * margin <= tanX * depth, and the same up the screen. The nearest such distance:
  double need = kMinDistance;
  for (int i = 0; i < 8; i++) {
    const bm::Vec3 corner{i & 1 ? bounds.max.x : bounds.min.x, i & 2 ? bounds.max.y : bounds.min.y, i & 4 ? bounds.max.z : bounds.min.z};
    const bm::Vec3 c = corner - o.target;
    need = std::max(need, kFrameMargin * std::abs(dot(c, r)) / tanX - dot(c, f));
    need = std::max(need, kFrameMargin * std::abs(dot(c, u)) / tanY - dot(c, f));
    need = std::max(need, kNearest - dot(c, f) + 1);  // every corner in front of the eye
  }
  o.distance = std::min(kMaxDistance, need);
  return o;
}

OrbitCamera OrbitCamera::from(const bm::plan::CameraKey& key) {
  OrbitCamera o;
  o.target = key.target;
  o.distance = std::min(kMaxDistance, std::max(kMinDistance, key.distance));
  o.azimuth = key.azimuth;
  o.elevation = std::min(kMaxElevation, std::max(-kMaxElevation, key.elevation));
  return o;
}

}  // namespace bmr
