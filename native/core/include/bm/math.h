#pragma once
// Engine math. Lengths are LDraw units (LDU), doubles, LDraw axes (-Y is up).
#include <algorithm>
#include <cmath>
#include <limits>

namespace bm {

struct Vec3 {
  double x = 0, y = 0, z = 0;
};
inline Vec3 operator+(Vec3 a, Vec3 b) { return {a.x + b.x, a.y + b.y, a.z + b.z}; }
inline Vec3 operator-(Vec3 a, Vec3 b) { return {a.x - b.x, a.y - b.y, a.z - b.z}; }
inline Vec3 operator-(Vec3 a) { return {-a.x, -a.y, -a.z}; }
inline Vec3 operator*(Vec3 a, double s) { return {a.x * s, a.y * s, a.z * s}; }
inline Vec3 operator*(double s, Vec3 a) { return a * s; }
inline bool operator==(Vec3 a, Vec3 b) { return a.x == b.x && a.y == b.y && a.z == b.z; }
inline double dot(Vec3 a, Vec3 b) { return a.x * b.x + a.y * b.y + a.z * b.z; }
inline Vec3 cross(Vec3 a, Vec3 b) { return {a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x}; }
inline double length(Vec3 a) { return std::sqrt(dot(a, a)); }
/// Unit vector along `a`; the zero vector stays zero.
inline Vec3 normalized(Vec3 a) {
  const double l = length(a);
  return l > 0 ? a * (1.0 / l) : Vec3{};
}

/// Row-major 3x3 (LDraw's a..i): rotation, and for some parts scale, mirror or shear.
struct Mat3 {
  double m[9] = {1, 0, 0, 0, 1, 0, 0, 0, 1};
  static Mat3 identity() { return {}; }
};
inline Vec3 operator*(const Mat3& a, Vec3 p) {
  return {a.m[0] * p.x + a.m[1] * p.y + a.m[2] * p.z, a.m[3] * p.x + a.m[4] * p.y + a.m[5] * p.z, a.m[6] * p.x + a.m[7] * p.y + a.m[8] * p.z};
}
inline Mat3 operator*(const Mat3& a, const Mat3& b) {
  Mat3 r;
  for (int i = 0; i < 3; i++)
    for (int j = 0; j < 3; j++) r.m[i * 3 + j] = a.m[i * 3] * b.m[j] + a.m[i * 3 + 1] * b.m[3 + j] + a.m[i * 3 + 2] * b.m[6 + j];
  return r;
}
inline double determinant(const Mat3& a) {
  const double* m = a.m;
  return m[0] * (m[4] * m[8] - m[5] * m[7]) - m[1] * (m[3] * m[8] - m[5] * m[6]) + m[2] * (m[3] * m[7] - m[4] * m[6]);
}
/// Inverse of a 3x3; a singular matrix gives the zero matrix.
inline Mat3 inverse(const Mat3& a) {
  const double* m = a.m;
  const double d = determinant(a);
  Mat3 r;
  if (d == 0 || !std::isfinite(d)) {
    std::fill(std::begin(r.m), std::end(r.m), 0.0);
    return r;
  }
  const double k = 1.0 / d;
  r.m[0] = (m[4] * m[8] - m[5] * m[7]) * k;
  r.m[1] = (m[2] * m[7] - m[1] * m[8]) * k;
  r.m[2] = (m[1] * m[5] - m[2] * m[4]) * k;
  r.m[3] = (m[5] * m[6] - m[3] * m[8]) * k;
  r.m[4] = (m[0] * m[8] - m[2] * m[6]) * k;
  r.m[5] = (m[2] * m[3] - m[0] * m[5]) * k;
  r.m[6] = (m[3] * m[7] - m[4] * m[6]) * k;
  r.m[7] = (m[1] * m[6] - m[0] * m[7]) * k;
  r.m[8] = (m[0] * m[4] - m[1] * m[3]) * k;
  return r;
}

/// An affine placement: p' = r * p + t.
struct Xform {
  Mat3 r;
  Vec3 t;
  static Xform identity() { return {}; }
  Vec3 apply(Vec3 p) const { return r * p + t; }
  Xform inverse() const {
    const Mat3 ri = bm::inverse(r);
    return {ri, -(ri * t)};
  }
};
/// (a * b).apply(p) == a.apply(b.apply(p)).
inline Xform operator*(const Xform& a, const Xform& b) { return {a.r * b.r, a.r * b.t + a.t}; }

/// Axis-aligned box. Default-constructed it is empty.
struct Box {
  Vec3 min{std::numeric_limits<double>::infinity(), std::numeric_limits<double>::infinity(), std::numeric_limits<double>::infinity()};
  Vec3 max{-std::numeric_limits<double>::infinity(), -std::numeric_limits<double>::infinity(), -std::numeric_limits<double>::infinity()};
  bool empty() const { return min.x > max.x || min.y > max.y || min.z > max.z; }
  void grow(Vec3 p) {
    min = {std::min(min.x, p.x), std::min(min.y, p.y), std::min(min.z, p.z)};
    max = {std::max(max.x, p.x), std::max(max.y, p.y), std::max(max.z, p.z)};
  }
  void merge(const Box& b) {
    if (b.empty()) return;
    grow(b.min);
    grow(b.max);
  }
  /// The box around this box's eight corners after `xf`. An empty box stays empty.
  Box transformed(const Xform& xf) const {
    Box out;
    if (empty()) return out;
    for (int i = 0; i < 8; i++) out.grow(xf.apply({i & 1 ? max.x : min.x, i & 2 ? max.y : min.y, i & 4 ? max.z : min.z}));
    return out;
  }
};

}  // namespace bm
