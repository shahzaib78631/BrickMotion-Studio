#include "bm/collide/pair.h"

#include <array>

namespace bm::collide {
namespace {

using Triangle = std::array<Vec3, 3>;

double squared(Vec3 v) { return dot(v, v); }

double pointEdge(Vec3 point, Vec3 a, Vec3 b) {
  const Vec3 edge = b - a;
  const double length2 = squared(edge);
  if (length2 < 1e-20) return squared(point - a);
  const double t = std::clamp(dot(point - a, edge) / length2, 0.0, 1.0);
  return squared(point - (a + edge * t));
}

double pointTriangle(Vec3 p, const Triangle& triangle) {
  const auto& [a, b, c] = triangle;
  const Vec3 normal = normalized(cross(b - a, c - a));
  const double distance = dot(normal, p - a);
  const Vec3 onPlane = p - normal * distance;
  if (squared(normal) > 0 && dot(normal, cross(b - a, onPlane - a)) >= 0 &&
      dot(normal, cross(c - b, onPlane - b)) >= 0 && dot(normal, cross(a - c, onPlane - c)) >= 0)
    return distance * distance;
  return std::min({pointEdge(p, a, b), pointEdge(p, b, c), pointEdge(p, c, a)});
}

bool edgesMeet(Vec3 a, Vec3 b, Vec3 c, Vec3 d, double limit) {
  // Endpoints against the opposite edge are covered by pointTriangle(). The two interior
  // points at minimum distance matter only for nonparallel edges.
  const Vec3 u = b - a, v = d - c, w = a - c;
  const double uu = squared(u), vv = squared(v), uv = dot(u, v);
  const double uw = dot(u, w), vw = dot(v, w), denominator = uu * vv - uv * uv;
  if (denominator <= 1e-16 * uu * vv) return false;
  const double s = (uv * vw - vv * uw) / denominator;
  const double t = (uu * vw - uv * uw) / denominator;
  return s >= 0 && s <= 1 && t >= 0 && t <= 1 && squared(w + u * s - v * t) <= limit;
}

bool segmentHitsTriangle(Vec3 a, Vec3 b, const Triangle& tri) {
  const auto& [p, q, r] = tri;
  const Vec3 n = cross(q - p, r - p);
  const double d = dot(n, b - a);
  if (std::abs(d) < 1e-16) return false;
  const double t = dot(n, p - a) / d;
  if (t < 0 || t > 1) return false;
  const Vec3 x = a + (b - a) * t;
  return dot(n, cross(q - p, x - p)) >= 0 && dot(n, cross(r - q, x - q)) >= 0 &&
         dot(n, cross(p - r, x - r)) >= 0;
}

bool trianglesTouch(const Triangle& a, const Triangle& b, double limit) {
  for (int i = 0; i < 3; i++) {
    if (pointTriangle(a[i], b) <= limit || pointTriangle(b[i], a) <= limit) return true;
    if (segmentHitsTriangle(a[i], a[(i + 1) % 3], b) || segmentHitsTriangle(b[i], b[(i + 1) % 3], a)) return true;
  }
  for (int i = 0; i < 3; i++)
    for (int j = 0; j < 3; j++)
      if (edgesMeet(a[i], a[(i + 1) % 3], b[j], b[(j + 1) % 3], limit)) return true;
  return false;
}

Box nodeBox(const Node& n, const Xform& xf) {
  return Box{{n.min[0], n.min[1], n.min[2]}, {n.max[0], n.max[1], n.max[2]}}.transformed(xf);
}

bool boxNear(const Box& a, const Box& b, double tolerance) {
  return a.min.x <= b.max.x + tolerance && b.min.x <= a.max.x + tolerance &&
         a.min.y <= b.max.y + tolerance && b.min.y <= a.max.y + tolerance &&
         a.min.z <= b.max.z + tolerance && b.min.z <= a.max.z + tolerance;
}

Triangle triangleAt(const Shape& s, uint32_t at, const Xform& xf) {
  Triangle out;
  for (uint32_t i = 0; i < 3; i++) {
    const auto& v = s.outer[s.triangles[3 * at + i]];
    out[i] = xf.apply({v.x, v.y, v.z});
  }
  return out;
}

}  // namespace

bool touching(const Shape& a, const Xform& xa, const Shape& b, const Xform& xb, double distance) {
  if (a.nodes.empty() || b.nodes.empty() || !std::isfinite(distance) || distance < 0) return false;
  const double limit = distance * distance;
  auto visit = [&](auto& self, uint32_t i, uint32_t j) -> bool {
    const Node& left = a.nodes[i];
    const Node& right = b.nodes[j];
    if (!boxNear(nodeBox(left, xa), nodeBox(right, xb), distance)) return false;
    if (!left.count) return self(self, left.left, j) || self(self, left.left + 1, j);
    if (!right.count) return self(self, i, right.left) || self(self, i, right.left + 1);
    for (uint32_t t = left.left; t < left.left + left.count; t++) {
      const auto first = triangleAt(a, t, xa);
      for (uint32_t u = right.left; u < right.left + right.count; u++)
        if (trianglesTouch(first, triangleAt(b, u, xb), limit)) return true;
    }
    return false;
  };
  return visit(visit, 0, 0);
}

}  // namespace bm::collide
