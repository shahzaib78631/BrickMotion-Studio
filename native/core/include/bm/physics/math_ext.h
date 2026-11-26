#pragma once
// Extended 3D linear algebra, unit quaternions, SO(3) Lie group integration,
// symmetric 3x3 inertia algebra, and Jacobi eigendecomposition for rigid-body dynamics.
#include <algorithm>
#include <array>
#include <cmath>
#include "bm/math.h"
#include "bm/physics/constants.h"

namespace bm::physics {

/// Unit quaternion representing a rotation in SO(3): q = w + x i + y j + z k.
struct Quat {
  double w = 1.0, x = 0.0, y = 0.0, z = 0.0;

  static constexpr Quat identity() { return {1.0, 0.0, 0.0, 0.0}; }

  double normSq() const { return w * w + x * x + y * y + z * z; }
  double norm() const { return std::sqrt(normSq()); }

  Quat normalized() const {
    const double n = norm();
    if (n <= 1e-18 || !std::isfinite(n)) return identity();
    const double inv = 1.0 / n;
    return {w * inv, x * inv, y * inv, z * inv};
  }

  Quat conjugate() const { return {w, -x, -y, -z}; }

  /// Rotate vector `v` by this unit quaternion: q * (0, v) * q^-1.
  Vec3 rotate(Vec3 v) const {
    const Vec3 u{x, y, z};
    const Vec3 t = cross(u, v) * 2.0;
    return v + t * w + cross(u, t);
  }

  /// Inverse-rotate vector `v` by this unit quaternion: q^-1 * (0, v) * q.
  Vec3 invRotate(Vec3 v) const {
    const Vec3 u{-x, -y, -z};
    const Vec3 t = cross(u, v) * 2.0;
    return v + t * w + cross(u, t);
  }

  Mat3 toMat3() const {
    const double xx = x * x, yy = y * y, zz = z * z;
    const double xy = x * y, xz = x * z, yz = y * z;
    const double wx = w * x, wy = w * y, wz = w * z;
    Mat3 r;
    r.m[0] = 1.0 - 2.0 * (yy + zz);
    r.m[1] = 2.0 * (xy - wz);
    r.m[2] = 2.0 * (xz + wy);
    r.m[3] = 2.0 * (xy + wz);
    r.m[4] = 1.0 - 2.0 * (xx + zz);
    r.m[5] = 2.0 * (yz - wx);
    r.m[6] = 2.0 * (xz - wy);
    r.m[7] = 2.0 * (yz + wx);
    r.m[8] = 1.0 - 2.0 * (xx + yy);
    return r;
  }

  /// Construct from axis (need not be unit) and angle in radians.
  static Quat fromAxisAngle(Vec3 axis, double angle) {
    const double len = length(axis);
    if (len <= 1e-18 || std::abs(angle) <= 1e-18) return identity();
    const double half = 0.5 * angle;
    const double s = std::sin(half) / len;
    return Quat{std::cos(half), axis.x * s, axis.y * s, axis.z * s}.normalized();
  }

  /// Exact exponential map on SO(3): exp(0.5 * rotVec), where `rotVec = omega * dt`.
  static Quat fromRotVec(Vec3 rotVec) {
    const double angle = length(rotVec);
    if (angle < 1e-8) {
      // Taylor series avoids 0/0 cancellation: sin(theta/2)/theta = 1/2 - theta^2/48
      const double a2 = angle * angle;
      const double s = 0.5 - a2 / 48.0;
      const double c = 1.0 - a2 / 8.0;
      return Quat{c, rotVec.x * s, rotVec.y * s, rotVec.z * s}.normalized();
    }
    const double half = 0.5 * angle;
    const double s = std::sin(half) / angle;
    return Quat{std::cos(half), rotVec.x * s, rotVec.y * s, rotVec.z * s}.normalized();
  }

  /// Log map on SO(3): rotation vector `theta * axis` in [-pi, pi] such that fromRotVec(v) == q.
  Vec3 toRotVec() const {
    Quat q = w < 0.0 ? Quat{-w, -x, -y, -z} : *this;
    const Vec3 u{q.x, q.y, q.z};
    const double s = length(u);
    if (s < 1e-12) return u * 2.0;
    const double angle = 2.0 * std::atan2(s, q.w);
    return u * (angle / s);
  }

  /// Shepperd's numerically stable conversion from a proper rotation matrix (det > 0).
  /// Non-orthonormal input matrices (e.g., slight LDraw rounding) are polar-orthogonalized first.
  static Quat fromMat3(const Mat3& m) {
    // Polar orthonormalization (2 iterations of Gram-Schmidt on columns) for robustness.
    Vec3 c0{m.m[0], m.m[3], m.m[6]};
    Vec3 c1{m.m[1], m.m[4], m.m[7]};
    c0 = bm::normalized(c0);
    c1 = bm::normalized(c1 - c0 * dot(c0, c1));
    Vec3 c2 = cross(c0, c1);
    const double r00 = c0.x, r01 = c1.x, r02 = c2.x;
    const double r10 = c0.y, r11 = c1.y, r12 = c2.y;
    const double r20 = c0.z, r21 = c1.z, r22 = c2.z;
    const double trace = r00 + r11 + r22;
    Quat q;
    if (trace > 0.0) {
      const double s = 2.0 * std::sqrt(trace + 1.0);
      q = {0.25 * s, (r21 - r12) / s, (r02 - r20) / s, (r10 - r01) / s};
    } else if (r00 > r11 && r00 > r22) {
      const double s = 2.0 * std::sqrt(1.0 + r00 - r11 - r22);
      q = {(r21 - r12) / s, 0.25 * s, (r01 + r10) / s, (r02 + r20) / s};
    } else if (r11 > r22) {
      const double s = 2.0 * std::sqrt(1.0 + r11 - r00 - r22);
      q = {(r02 - r20) / s, (r01 + r10) / s, 0.25 * s, (r12 + r21) / s};
    } else {
      const double s = 2.0 * std::sqrt(1.0 + r22 - r00 - r11);
      q = {(r10 - r01) / s, (r02 + r20) / s, (r12 + r21) / s, 0.25 * s};
    }
    return q.normalized();
  }
};

inline Quat operator*(const Quat& a, const Quat& b) {
  return {a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
          a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
          a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
          a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w};
}

/// Integrate orientation by world-space angular velocity `omega` over `dt` (exact exponential map).
inline Quat integrateQuat(const Quat& q, Vec3 omega, double dt) {
  return (Quat::fromRotVec(omega * dt) * q).normalized();
}

/// Shortest-arc quaternion mapping unit vector `from` to unit vector `to`.
inline Quat shortestArc(Vec3 from, Vec3 to) {
  const double d = std::clamp(dot(from, to), -1.0, 1.0);
  if (d > 1.0 - 1e-12) return Quat::identity();
  if (d < -1.0 + 1e-12) {
    Vec3 ortho = cross(from, std::abs(from.x) < 0.9 ? Vec3{1, 0, 0} : Vec3{0, 1, 0});
    return Quat::fromAxisAngle(normalized(ortho), 3.14159265358979323846);
  }
  const Vec3 c = cross(from, to);
  return Quat{1.0 + d, c.x, c.y, c.z}.normalized();
}

/// Construct an orthonormal basis (t1, t2) perpendicular to unit vector `n` (Duff et al. 2017).
inline void orthonormalBasis(Vec3 n, Vec3& t1, Vec3& t2) {
  const double sign = std::copysign(1.0, n.z);
  const double a = -1.0 / (sign + n.z);
  const double b = n.x * n.y * a;
  t1 = {1.0 + sign * n.x * n.x * a, sign * b, -sign * n.x};
  t2 = {b, sign + n.y * n.y * a, -n.y};
}

inline Mat3 transpose(const Mat3& a) {
  Mat3 r;
  r.m[0] = a.m[0]; r.m[1] = a.m[3]; r.m[2] = a.m[6];
  r.m[3] = a.m[1]; r.m[4] = a.m[4]; r.m[5] = a.m[7];
  r.m[6] = a.m[2]; r.m[7] = a.m[5]; r.m[8] = a.m[8];
  return r;
}

inline Mat3 operator+(const Mat3& a, const Mat3& b) {
  Mat3 r;
  for (int i = 0; i < 9; i++) r.m[i] = a.m[i] + b.m[i];
  return r;
}

inline Mat3 operator-(const Mat3& a, const Mat3& b) {
  Mat3 r;
  for (int i = 0; i < 9; i++) r.m[i] = a.m[i] - b.m[i];
  return r;
}

inline Mat3 operator*(const Mat3& a, double s) {
  Mat3 r;
  for (int i = 0; i < 9; i++) r.m[i] = a.m[i] * s;
  return r;
}

/// Skew-symmetric cross-product matrix [r]_x such that skew(r) * v == cross(r, v).
inline Mat3 skew(Vec3 r) {
  Mat3 m;
  m.m[0] = 0.0;  m.m[1] = -r.z; m.m[2] = r.y;
  m.m[3] = r.z;  m.m[4] = 0.0;  m.m[5] = -r.x;
  m.m[6] = -r.y; m.m[7] = r.x;  m.m[8] = 0.0;
  return m;
}

inline Mat3 outer(Vec3 a, Vec3 b) {
  Mat3 m;
  m.m[0] = a.x * b.x; m.m[1] = a.x * b.y; m.m[2] = a.x * b.z;
  m.m[3] = a.y * b.x; m.m[4] = a.y * b.y; m.m[5] = a.y * b.z;
  m.m[6] = a.z * b.x; m.m[7] = a.z * b.y; m.m[8] = a.z * b.z;
  return m;
}

inline Mat3 diagMat3(double x, double y, double z) {
  Mat3 m;
  m.m[0] = x; m.m[1] = 0; m.m[2] = 0;
  m.m[3] = 0; m.m[4] = y; m.m[5] = 0;
  m.m[6] = 0; m.m[7] = 0; m.m[8] = z;
  return m;
}

inline Mat3 zeroMat3() {
  Mat3 m;
  for (double& v : m.m) v = 0.0;
  return m;
}

/// Symmetric 3x3 matrix stored compactly (xx, yy, zz, xy, xz, yz).
struct SymMat3 {
  double xx = 0, yy = 0, zz = 0;
  double xy = 0, xz = 0, yz = 0;

  static constexpr SymMat3 zero() { return {}; }
  static constexpr SymMat3 diag(double a, double b, double c) { return {a, b, c, 0, 0, 0}; }

  Vec3 operator*(Vec3 v) const {
    return {xx * v.x + xy * v.y + xz * v.z,
            xy * v.x + yy * v.y + yz * v.z,
            xz * v.x + yz * v.y + zz * v.z};
  }

  Mat3 toMat3() const {
    Mat3 m;
    m.m[0] = xx; m.m[1] = xy; m.m[2] = xz;
    m.m[3] = xy; m.m[4] = yy; m.m[5] = yz;
    m.m[6] = xz; m.m[7] = yz; m.m[8] = zz;
    return m;
  }

  static SymMat3 fromMat3Sym(const Mat3& m) {
    return {m.m[0], m.m[4], m.m[8], 0.5 * (m.m[1] + m.m[3]), 0.5 * (m.m[2] + m.m[6]), 0.5 * (m.m[5] + m.m[7])};
  }

  /// Similarity transform R * S * R^T (always symmetric).
  SymMat3 rotated(const Mat3& r) const {
    const Mat3 s = toMat3();
    return fromMat3Sym(r * s * transpose(r));
  }

  /// Solve S * x = b for symmetric positive-definite S using LDL^T / Cholesky with safe Tikhonov fallback.
  Vec3 solveSpd(Vec3 b, double reg = 1e-12) const {
    const double d0 = xx + reg;
    if (d0 <= 0.0) return {};
    const double l10 = xy / d0;
    const double l20 = xz / d0;
    const double d1 = (yy + reg) - l10 * l10 * d0;
    if (d1 <= 1e-18) {
      // Fallback to general 3x3 inverse with regularization
      Mat3 m = toMat3();
      m.m[0] += reg; m.m[4] += reg; m.m[8] += reg;
      return bm::inverse(m) * b;
    }
    const double l21 = (yz - l20 * l10 * d0) / d1;
    const double d2 = (zz + reg) - l20 * l20 * d0 - l21 * l21 * d1;
    if (d2 <= 1e-18) {
      Mat3 m = toMat3();
      m.m[0] += reg; m.m[4] += reg; m.m[8] += reg;
      return bm::inverse(m) * b;
    }
    // Forward solve L y = b
    const double y0 = b.x;
    const double y1 = b.y - l10 * y0;
    const double y2 = b.z - l20 * y0 - l21 * y1;
    // Diagonal + backward solve L^T x = D^-1 y
    const double x2 = y2 / d2;
    const double x1 = y1 / d1 - l21 * x2;
    const double x0 = y0 / d0 - l10 * x1 - l20 * x2;
    return {x0, x1, x2};
  }

  SymMat3 inverseSpd(double reg = 0.0) const {
    const Vec3 c0 = solveSpd({1, 0, 0}, reg);
    const Vec3 c1 = solveSpd({0, 1, 0}, reg);
    const Vec3 c2 = solveSpd({0, 0, 1}, reg);
    return {c0.x, c1.y, c2.z, 0.5 * (c0.y + c1.x), 0.5 * (c0.z + c2.x), 0.5 * (c1.z + c2.y)};
  }
};

inline SymMat3 operator+(const SymMat3& a, const SymMat3& b) {
  return {a.xx + b.xx, a.yy + b.yy, a.zz + b.zz, a.xy + b.xy, a.xz + b.xz, a.yz + b.yz};
}

inline SymMat3 operator*(const SymMat3& a, double s) {
  return {a.xx * s, a.yy * s, a.zz * s, a.xy * s, a.xz * s, a.yz * s};
}

/// Jacobi eigendecomposition of a 3x3 symmetric matrix: S = V * diag(evals) * V^T, with det(V) = +1.
struct Eigen3 {
  Vec3 values;   ///< eigenvalues
  Mat3 vectors;  ///< columns are orthonormal eigenvectors (proper rotation matrix)
};

inline Eigen3 eigenSym3(const SymMat3& s) {
  double a[3][3] = {{s.xx, s.xy, s.xz}, {s.xy, s.yy, s.yz}, {s.xz, s.yz, s.zz}};
  double v[3][3] = {{1, 0, 0}, {0, 1, 0}, {0, 0, 1}};
  for (int iter = 0; iter < 32; iter++) {
    int p = 0, q = 1;
    double maxOff = std::abs(a[0][1]);
    if (std::abs(a[0][2]) > maxOff) { p = 0; q = 2; maxOff = std::abs(a[0][2]); }
    if (std::abs(a[1][2]) > maxOff) { p = 1; q = 2; maxOff = std::abs(a[1][2]); }
    if (maxOff <= 1e-15 * (std::abs(a[0][0]) + std::abs(a[1][1]) + std::abs(a[2][2]) + 1e-30)) break;

    const double app = a[p][p], aqq = a[q][q], apq = a[p][q];
    const double tau = (aqq - app) / (2.0 * apq);
    const double t = (tau >= 0.0 ? 1.0 : -1.0) / (std::abs(tau) + std::sqrt(1.0 + tau * tau));
    const double c = 1.0 / std::sqrt(1.0 + t * t);
    const double sn = t * c;

    a[p][p] = app - t * apq;
    a[q][q] = aqq + t * apq;
    a[p][q] = a[q][p] = 0.0;
    const int r = 3 - p - q;
    const double arp = a[r][p], arq = a[r][q];
    a[r][p] = a[p][r] = c * arp - sn * arq;
    a[r][q] = a[q][r] = sn * arp + c * arq;

    for (int i = 0; i < 3; i++) {
      const double vip = v[i][p], viq = v[i][q];
      v[i][p] = c * vip - sn * viq;
      v[i][q] = sn * vip + c * viq;
    }
  }
  Eigen3 out;
  out.values = {a[0][0], a[1][1], a[2][2]};
  for (int i = 0; i < 3; i++)
    for (int j = 0; j < 3; j++) out.vectors.m[i * 3 + j] = v[i][j];
  if (determinant(out.vectors) < 0.0) {
    out.vectors.m[2] = -out.vectors.m[2];
    out.vectors.m[5] = -out.vectors.m[5];
    out.vectors.m[8] = -out.vectors.m[8];
  }
  return out;
}

/// Solve 2x2 symmetric linear system [a b; b c] * [x; y] = [rhs0; rhs1].
inline void solveSym2(double a, double b, double c, double rhs0, double rhs1, double& x, double& y) {
  const double det = a * c - b * b;
  if (std::abs(det) <= 1e-18) {
    x = a > 1e-18 ? rhs0 / a : 0.0;
    y = c > 1e-18 ? rhs1 / c : 0.0;
    return;
  }
  const double inv = 1.0 / det;
  x = (c * rhs0 - b * rhs1) * inv;
  y = (a * rhs1 - b * rhs0) * inv;
}

/// Rigid-body SE(3) pose in SI units (metres + unit quaternion).
struct Pose {
  Vec3 pos{};
  Quat rot = Quat::identity();

  static constexpr Pose identity() { return {}; }

  Vec3 toWorld(Vec3 local) const { return pos + rot.rotate(local); }
  Vec3 toLocal(Vec3 world) const { return rot.invRotate(world - pos); }
  Vec3 dirToWorld(Vec3 localDir) const { return rot.rotate(localDir); }
  Vec3 dirToLocal(Vec3 worldDir) const { return rot.invRotate(worldDir); }

  Pose inverse() const {
    const Quat ri = rot.conjugate();
    return {-(ri.rotate(pos)), ri};
  }

  /// Convert from an LDraw Xform (LDU) to SI Pose (metres).
  static Pose fromLduXform(const Xform& xf) {
    return {lduToMeters(xf.t), Quat::fromMat3(xf.r)};
  }

  /// Convert to an LDraw Xform (LDU).
  Xform toLduXform() const {
    return {rot.toMat3(), metersToLdu(pos)};
  }
};

inline Pose operator*(const Pose& a, const Pose& b) {
  return {a.pos + a.rot.rotate(b.pos), (a.rot * b.rot).normalized()};
}

}  // namespace bm::physics
