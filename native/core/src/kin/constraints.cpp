#include "bm/kin/constraints.h"

#include <algorithm>
#include <cmath>
#include "bm/kin/tolerances.h"

namespace bm::kin {
namespace {

using connect::JointKind;
constexpr double kPi = 3.14159265358979323846;

Vec3 perpendicular(Vec3 u) {
  const Vec3 other = std::abs(u.x) < 0.9 ? Vec3{1, 0, 0} : Vec3{0, 1, 0};
  return normalized(cross(u, other));
}
double offLine(Vec3 p, Vec3 origin, Vec3 axis) {
  const Vec3 v = p - origin;
  return length(v - axis * dot(v, axis));
}

/// Builds rows. An equation is a sum of terms over the two bodies of a link.
struct Builder {
  const std::vector<int>& column;
  size_t columns;
  std::vector<double> rows, residual;
  size_t count = 0;
  double* row() {
    rows.resize((count + 1) * columns, 0.0);
    residual.push_back(0);
    return &rows[count++ * columns];
  }
  /// `sign` * (the body's turning) . e
  void turning(double* r, uint32_t body, Vec3 e, double sign) const {
    const int c = column[body];
    if (c < 0) return;
    r[c] += sign * e.x, r[c + 1] += sign * e.y, r[c + 2] += sign * e.z;
  }
  /// `sign` * (the velocity of the body's point now at `p`, scaled) . d
  void moving(double* r, uint32_t body, Vec3 p, Vec3 d, double sign) const {
    const int c = column[body];
    if (c < 0) return;
    const Vec3 lever = cross(p * (1 / kLengthUnit), d);  // (w x p) . d = w . (p x d)
    r[c] += sign * lever.x, r[c + 1] += sign * lever.y, r[c + 2] += sign * lever.z;
    r[c + 3] += sign * d.x, r[c + 4] += sign * d.y, r[c + 5] += sign * d.z;
  }
};

}  // namespace

std::vector<uint32_t> carriers(const System& sys) {
  std::vector<uint32_t> out(sys.gearings.size(), UINT32_MAX);
  if (sys.gearings.empty()) return out;
  // The bodies each body turns against, about which line.
  std::vector<std::vector<uint32_t>> linksOf(sys.bodies);
  for (uint32_t i = 0; i < sys.links.size(); i++) {
    const Link& l = sys.links[i];
    if (l.kind != JointKind::Revolute && l.kind != JointKind::Cylindrical) continue;
    if (l.a < sys.bodies && l.b < sys.bodies) linksOf[l.a].push_back(i), linksOf[l.b].push_back(i);
  }
  auto holders = [&](uint32_t body, Vec3 point, Vec3 axis) {
    std::vector<uint32_t> found;
    if (body >= sys.bodies) return found;
    for (uint32_t li : linksOf[body]) {
      const Link& l = sys.links[li];
      if (std::abs(dot(l.axis, axis)) < kMeshAxis || offLine(point, l.point, l.axis) > kShaftMatch) continue;
      found.push_back(l.a == body ? l.b : l.a);
    }
    return found;
  };
  for (size_t i = 0; i < sys.gearings.size(); i++) {
    const Gearing& g = sys.gearings[i];
    const std::vector<uint32_t> ofA = holders(g.a, g.mesh.pointA, g.mesh.axisA);
    if (g.mesh.kind == MeshKind::Rack) {
      // A rack needs only the gear's holder; prefer one the rack is linked to.
      for (uint32_t c : ofA) {
        if (c == g.b) continue;
        const bool linked = std::any_of(sys.links.begin(), sys.links.end(), [&](const Link& l) { return (l.a == c && l.b == g.b) || (l.a == g.b && l.b == c); });
        if (out[i] == UINT32_MAX || linked) out[i] = c;
        if (linked) break;
      }
      continue;
    }
    const std::vector<uint32_t> ofB = holders(g.b, g.mesh.pointB, g.mesh.axisB);
    for (uint32_t c : ofA)
      if (c != g.b && std::find(ofB.begin(), ofB.end(), c) != ofB.end()) {
        out[i] = c;
        break;
      }
  }
  return out;
}

void meshAt(const GearMesh& m, const Xform& poseA, const Xform& poseB, Vec3& point, Vec3& tangent) {
  const Vec3 axisA = normalized(poseA.r * m.axisA), axisB = normalized(poseB.r * m.axisB);
  const Vec3 pointA = poseA.apply(m.pointA), pointB = poseB.apply(m.pointB);
  if (m.kind == MeshKind::Crossed) {
    // Where the shafts met at rest, and how far along each the point was from there.
    const Vec3 w = m.pointA - m.pointB;
    const double b = dot(m.axisA, m.axisB), dA = dot(m.axisA, w), dB = dot(m.axisB, w), den = 1 - b * b;
    const double sA = (b * dB - dA) / den, sB = (dB - b * dA) / den;
    const Vec3 apex = (m.pointA + m.axisA * sA + m.pointB + m.axisB * sB) * 0.5;
    const double alongA = dot(m.point - apex, m.axisA), alongB = dot(m.point - apex, m.axisB);
    const Vec3 apexNow = (pointA + axisA * sA + pointB + axisB * sB) * 0.5;
    point = apexNow + axisA * alongA + axisB * alongB;
    const Vec3 t = normalized(cross(axisA, axisB));
    tangent = dot(cross(m.axisA, m.axisB), m.tangent) < 0 ? -t : t;
    return;
  }
  // On A's shaft at the same height, out towards B's shaft (or the rack's line) by A's radius.
  const double height = dot(m.point - m.pointA, m.axisA), radius = offLine(m.point, m.pointA, m.axisA);
  const Vec3 centre = pointA + axisA * height;
  const Vec3 onB = pointB + axisB * dot(centre - pointB, axisB);
  Vec3 out = onB - centre;
  out = out - axisA * dot(out, axisA);
  if (length(out) < 1e-9) {  // degenerate: keep the rest direction, carried by A
    out = poseA.r * (m.point - (m.pointA + m.axisA * height));
  }
  const Vec3 n = normalized(out);
  point = centre + n * radius;
  if (m.kind == MeshKind::Rack) {
    tangent = axisB;
  } else if (m.kind == MeshKind::Worm) {
    tangent = axisA;
  } else {
    const Vec3 restN = normalized(m.point - (m.pointA + m.axisA * height));
    const Vec3 t = normalized(cross(axisA, n));
    tangent = dot(cross(m.axisA, restN), m.tangent) < 0 ? -t : t;
  }
}

Equations equations(const System& sys, const std::vector<int>& column, size_t columns, const std::vector<uint32_t>& links, const std::vector<uint32_t>& gearings, const std::vector<Xform>* poses) {
  Builder b{column, columns, {}, {}};
  const Xform rest;
  auto pose = [&](uint32_t body) -> const Xform& { return poses && body < poses->size() ? (*poses)[body] : rest; };
  for (uint32_t li : links) {
    const Link& l = sys.links[li];
    const Xform &A = pose(l.a), &B = pose(l.b);
    const Vec3 pa = A.apply(l.point), pb = B.apply(l.point);
    const Vec3 ua = normalized(A.r * l.axis), ub = normalized(B.r * l.axis);
    const Vec3 e1 = perpendicular(ua), e2 = cross(ua, e1);
    const Vec3 gap = (pb - pa) * (1 / kLengthUnit);
    const Vec3 lean = cross(ua, ub);
    auto along = [&](Vec3 d) {  // the two bodies' points at the joint stay together along d
      double* r = b.row();
      b.moving(r, l.b, pb, d, 1);
      b.moving(r, l.a, pa, d, -1);
      b.residual.back() = dot(gap, d);
    };
    auto aligned = [&](Vec3 e) {  // the two axes stay parallel
      double* r = b.row();
      b.turning(r, l.b, e, 1);
      b.turning(r, l.a, e, -1);
      b.residual.back() = dot(lean, e);
    };
    switch (l.kind) {
      case JointKind::Revolute:
        along({1, 0, 0}), along({0, 1, 0}), along({0, 0, 1});
        aligned(e1), aligned(e2);
        break;
      case JointKind::Cylindrical:
        along(e1), along(e2);
        aligned(e1), aligned(e2);
        break;
      case JointKind::Prismatic: {
        along(e1), along(e2);
        // No turning at all: the rotation of B against A, as a small vector.
        Vec3 twist{};
        for (Vec3 k : {Vec3{1, 0, 0}, Vec3{0, 1, 0}, Vec3{0, 0, 1}}) twist = twist + cross(A.r * k, B.r * k) * 0.5;
        for (Vec3 k : {Vec3{1, 0, 0}, Vec3{0, 1, 0}, Vec3{0, 0, 1}}) {
          double* r = b.row();
          b.turning(r, l.b, k, 1);
          b.turning(r, l.a, k, -1);
          b.residual.back() = dot(twist, k);
        }
        break;
      }
      case JointKind::Spherical:
        along({1, 0, 0}), along({0, 1, 0}), along({0, 0, 1});
        break;
      default: break;
    }
  }
  const std::vector<uint32_t> carrier = carriers(sys);
  for (uint32_t gi : gearings) {
    const Gearing& g = sys.gearings[gi];
    const GearMesh& m = g.mesh;
    double* r = b.row();
    const Vec3 axisA = normalized(pose(g.a).r * m.axisA), axisB = normalized(pose(g.b).r * m.axisB);
    // Which way each gear's teeth go past the meeting point when it turns about its own shaft.
    const double leverA = dot(cross(m.axisA, m.point - m.pointA), m.tangent), leverB = dot(cross(m.axisB, m.point - m.pointB), m.tangent);
    const double signA = leverA < 0 ? -1 : 1, signB = leverB < 0 ? -1 : 1;
    const uint32_t c = carrier[gi];
    if (c != UINT32_MAX && m.kind != MeshKind::Rack) {
      // Both shafts are carried by one body: the gears' turns against it are as their teeth,
      // exactly, wherever the file put them.
      double countA = m.teethA, countB = m.teethB;
      double wayA = signA, wayB = signB;
      if (m.kind == MeshKind::Worm) {
        // The thread carries the gear's teeth along the worm: `starts` teeth per turn.
        wayA = 1;
        wayB = dot(cross(m.axisB, m.point - m.pointB), m.axisA) < 0 ? -1 : 1;
      }
      const double scale = 1 / std::max(countA, countB);
      b.turning(r, g.a, axisA, wayA * countA * scale);
      b.turning(r, c, axisA, -wayA * countA * scale);
      b.turning(r, g.b, axisB, -wayB * countB * scale);
      b.turning(r, c, axisB, wayB * countB * scale);
      continue;
    }
    Vec3 p, t;
    meshAt(m, pose(g.a), pose(g.b), p, t);
    if (c != UINT32_MAX) {
      // A rack: it passes the gear's carrier at the gear's rim speed, the pitch radius being
      // the gear's own (travel per turn / 2 pi), not its measured distance.
      const double radius = m.travel / (2 * kPi) / kLengthUnit;
      b.moving(r, g.b, p, t, 1);
      b.moving(r, c, p, t, -1);
      b.turning(r, g.a, axisA, -signA * radius);
      b.turning(r, c, axisA, signA * radius);
    } else if (m.kind == MeshKind::Worm) {
      const double advance = m.travel / (2 * kPi) / kLengthUnit;
      b.moving(r, g.b, p, axisA, 1);
      b.moving(r, g.a, p, axisA, -1);
      b.turning(r, g.a, axisA, -advance);
      b.turning(r, g.b, axisA, advance);
    } else {
      // No common carrier found: the two tooth surfaces move together along the tangent.
      b.moving(r, g.a, p, t, 1);
      b.moving(r, g.b, p, t, -1);
    }
  }
  Equations out;
  out.jacobian.rows = b.count;
  out.jacobian.cols = columns;
  b.rows.resize(b.count * columns, 0.0);
  out.jacobian.v = std::move(b.rows);
  out.residual = std::move(b.residual);
  return out;
}

}  // namespace bm::kin
