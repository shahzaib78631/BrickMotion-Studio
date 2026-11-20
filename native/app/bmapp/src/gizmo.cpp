#include "bmapp/gizmo.h"

#include <algorithm>
#include <cmath>
#include <limits>
#include "bm/math.h"
#include "bmr/camera.h"

namespace bmapp {

namespace {
constexpr double kPi = 3.14159265358979323846;
using bm::cross;
using bm::dot;

bm::Vec3 eng(Vec3 v) { return {v.x, v.y, v.z}; }
Vec3 app(bm::Vec3 v) { return {v.x, v.y, v.z}; }

/// The renderer's camera for this state (the viewport's orbit camera, at its default lens).
bmr::Camera cameraOf(const CameraState& state, Vec2 view) {
  bmr::OrbitCamera o;
  o.azimuth = state.yaw, o.elevation = state.pitch, o.distance = state.distance;
  o.target = eng(state.target);
  o.fovY = state.verticalFOV;
  auto camera = o.camera(view.y > 0 ? view.x / view.y : 1, bm::Box{});
  if (state.orthographic) camera.orthoHalfHeight = state.distance * std::tan(camera.fovY / 2);
  return camera;
}

bm::Vec3 column(const Mat3& m, int i) { return {m.m[i], m.m[3 + i], m.m[6 + i]}; }

/// The eye's ray through a point of the view: from the eye, unit direction.
using Ray = bmr::ScreenRay;
Ray rayAt(const bmr::Camera& c, Vec2 view, Vec2 p) {
  const double nx = 2 * p.x / view.x - 1, ny = 1 - 2 * p.y / view.y;
  return bmr::screenRay(c, nx, ny);
}

/// Where a ray meets the plane through `o` with normal `n`; false when it runs along it or away.
bool meet(const Ray& ray, bm::Vec3 o, bm::Vec3 n, bm::Vec3& at) {
  const double d = dot(ray.dir, n);
  if (std::abs(d) < 1e-3) return false;  // edge-on
  const double t = dot(o - ray.from, n) / d;
  if (!(t > 0) || !std::isfinite(t)) return false;
  at = ray.from + ray.dir * t;
  return true;
}

double snapTo(double v, double step) { return step > 0 ? std::round(v / step) * step : v; }

/// World length that shows as kGizmoPoints at `origin`.
double armLength(const bmr::Camera& c, Vec2 view, bm::Vec3 origin) {
  if (c.orthoHalfHeight > 0) return kGizmoPoints * 2 * c.orthoHalfHeight / std::max(1.0, view.y);
  const double away = std::max(1e-6, dot(origin - c.eye, bm::normalized(c.target - c.eye)));
  return kGizmoPoints * 2 * away * std::tan(c.fovY / 2) / std::max(1.0, view.y);
}

double toSegment(Vec2 p, Vec2 a, Vec2 b) {
  const double dx = b.x - a.x, dy = b.y - a.y, len = dx * dx + dy * dy;
  const double t = len > 0 ? std::clamp(((p.x - a.x) * dx + (p.y - a.y) * dy) / len, 0.0, 1.0) : 0;
  return std::hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

bool inside(const std::vector<Vec2>& poly, Vec2 p) {
  bool in = false;
  for (size_t i = 0, j = poly.size() - 1; i < poly.size(); j = i++)
    if ((poly[i].y > p.y) != (poly[j].y > p.y) && p.x < (poly[j].x - poly[i].x) * (p.y - poly[i].y) / (poly[j].y - poly[i].y) + poly[i].x) in = !in;
  return in;
}
}  // namespace

Vec2 projectPoint(const CameraState& camera, Vec2 view, Vec3 p) {
  const bmr::Camera c = cameraOf(camera, view);
  const bmr::Mat4 m = bmr::multiply(bmr::projectionMatrix(c), bmr::viewMatrix(c, {}));
  float clip[4];
  bmr::transform(m, eng(p), clip);
  if (clip[3] <= 1e-6f) return {std::numeric_limits<double>::quiet_NaN(), std::numeric_limits<double>::quiet_NaN()};
  return {(clip[0] / clip[3] + 1) / 2 * view.x, (1 - clip[1] / clip[3]) / 2 * view.y};
}

GizmoShape gizmoShape(const CameraState& camera, Vec2 view, Vec3 origin, Mat3 axes, GizmoKind kind) {
  GizmoShape s;
  if (kind == GizmoKind::None) return s;
  const bmr::Camera c = cameraOf(camera, view);
  const bm::Vec3 o = eng(origin);
  const double len = armLength(c, view, o);
  auto at = [&](bm::Vec3 p) { return projectPoint(camera, view, app(p)); };
  const Handle axisHandles[3] = {Handle::X, Handle::Y, Handle::Z};
  if (kind == GizmoKind::Move) {
    // The Y arm is drawn toward -y, LDraw's up; dragging it works along the axis either way.
    auto arm = [&](int i) { return column(axes, i) * (i == 1 ? -len : len); };
    for (int i = 0; i < 3; i++) s.lines.push_back({at(o), at(o + arm(i)), axisHandles[i]});
    // A small square in each plane, a third of the way out.
    const std::pair<int, int> planes[3] = {{0, 1}, {1, 2}, {0, 2}};
    const Handle planeHandles[3] = {Handle::XY, Handle::YZ, Handle::XZ};
    for (int k = 0; k < 3; k++) {
      const bm::Vec3 u = arm(planes[k].first), v = arm(planes[k].second);
      s.rings.push_back({at(o + u * 0.22 + v * 0.22), at(o + u * 0.42 + v * 0.22), at(o + u * 0.42 + v * 0.42), at(o + u * 0.22 + v * 0.42)});
      s.ringHandles.push_back(planeHandles[k]);
    }
    return s;
  }
  constexpr int kSides = 64;
  for (int i = 0; i < 3; i++) {
    const bm::Vec3 u = column(axes, (i + 1) % 3) * len, v = column(axes, (i + 2) % 3) * len;
    std::vector<Vec2> ring;
    for (int k = 0; k < kSides; k++) {
      const double t = 2 * kPi * k / kSides;
      ring.push_back(at(o + u * std::cos(t) + v * std::sin(t)));
    }
    s.rings.push_back(std::move(ring));
    s.ringHandles.push_back(axisHandles[i]);
  }
  // The screen ring, a little larger, round on screen.
  const Vec2 centre = at(o);
  std::vector<Vec2> ring;
  for (int k = 0; k < kSides; k++) {
    const double t = 2 * kPi * k / kSides;
    ring.push_back({centre.x + 1.2 * kGizmoPoints * std::cos(t), centre.y + 1.2 * kGizmoPoints * std::sin(t)});
  }
  s.rings.push_back(std::move(ring));
  s.ringHandles.push_back(Handle::View);
  return s;
}

Handle hitGizmo(const GizmoShape& shape, Vec2 p, double tolerance) {
  Handle best = Handle::None;
  double nearest = tolerance;
  for (const GizmoSeg& l : shape.lines) {
    const double d = toSegment(p, l.a, l.b);
    if (d <= nearest) nearest = d, best = l.h;
  }
  for (size_t i = 0; i < shape.rings.size(); i++) {
    const auto& ring = shape.rings[i];
    if (ring.empty()) continue;
    const Handle h = shape.ringHandles[i];
    const bool plane = h == Handle::XY || h == Handle::YZ || h == Handle::XZ;
    double d = plane && inside(ring, p) ? 0 : std::numeric_limits<double>::infinity();
    for (size_t k = 0; k < ring.size(); k++) d = std::min(d, toSegment(p, ring[k], ring[(k + 1) % ring.size()]));
    if (d <= nearest) nearest = d, best = h;
  }
  return best;
}

Vec3 handleAxis(const CameraState& camera, Mat3 axes, Handle h) {
  switch (h) {
    case Handle::X: return app(column(axes, 0));
    case Handle::Y: return app(column(axes, 1));
    case Handle::Z: return app(column(axes, 2));
    case Handle::View: {
      const bmr::Camera c = cameraOf(camera, {1, 1});
      return app(bm::normalized(c.eye - c.target));
    }
    default: return {};
  }
}

Vec3 dragMove(const CameraState& camera, Vec2 view, Vec3 origin, Mat3 axes, Handle h, Vec2 a, Vec2 b, Vec3 snap) {
  const bmr::Camera c = cameraOf(camera, view);
  const bm::Vec3 o = eng(origin);
  const Ray ra = rayAt(c, view, a), rb = rayAt(c, view, b);
  bm::Vec3 delta{};
  bm::Vec3 pa, pb;
  if (h == Handle::X || h == Handle::Y || h == Handle::Z) {
    const bm::Vec3 axis = bm::normalized(eng(handleAxis(camera, axes, h)));
    // The plane holding the axis that faces the eye most.
    const bm::Vec3 n = cross(axis, cross(ra.dir, axis));
    if (bm::length(n) < 1e-3) return {};  // the axis points at the eye
    if (!meet(ra, o, bm::normalized(n), pa) || !meet(rb, o, bm::normalized(n), pb)) return {};
    delta = axis * dot(pb - pa, axis);
  } else if (h == Handle::XY || h == Handle::YZ || h == Handle::XZ) {
    const int normal = h == Handle::XY ? 2 : h == Handle::YZ ? 0 : 1;
    const bm::Vec3 n = column(axes, normal);
    if (!meet(ra, o, n, pa) || !meet(rb, o, n, pb)) return {};
    delta = pb - pa;
    delta = delta - n * dot(delta, n);
  } else {
    return {};
  }
  // Snapped on each of the axes.
  const double steps[3] = {snap.x, snap.y, snap.z};
  bm::Vec3 out{};
  for (int i = 0; i < 3; i++) {
    const bm::Vec3 e = column(axes, i);
    out = out + e * snapTo(dot(delta, e), steps[i]);
  }
  // A world axis gives exact zeros elsewhere (no -0 noise from turning back).
  for (double* v : {&out.x, &out.y, &out.z})
    if (std::abs(*v) < 1e-9) *v = 0;
  return app(out);
}

double dragRotate(const CameraState& camera, Vec2 view, Vec3 origin, Mat3 axes, Handle h, Vec2 a, Vec2 b, bool free) {
  const bm::Vec3 axis = eng(handleAxis(camera, axes, h));
  if (bm::length(axis) == 0) return 0;
  const Vec2 o = projectPoint(camera, view, origin);
  if (!std::isfinite(o.x)) return 0;
  // Counterclockwise on screen (y down) is a right-handed turn about an axis toward the eye.
  double turn = -(std::atan2(b.y - o.y, b.x - o.x) - std::atan2(a.y - o.y, a.x - o.x));
  while (turn > kPi) turn -= 2 * kPi;
  while (turn < -kPi) turn += 2 * kPi;
  const bmr::Camera c = cameraOf(camera, view);
  if (dot(axis, c.eye - eng(origin)) < 0) turn = -turn;
  const double degrees = turn * 180 / kPi;
  return free ? degrees : snapTo(degrees, 15);
}

}  // namespace bmapp
