#include "bm/physics/inertia.h"

#include <algorithm>
#include <cctype>
#include <cmath>
#include <string>

namespace bm::physics {
namespace {

bool isTransparentLdrawColor(int c) {
  // Standard LDraw transparent colour codes (32..57, 226..295 ranges etc.).
  return (c >= 33 && c <= 57) || c == 32 || c == 114 || c == 117 || c == 129 || c == 143 ||
         c == 182 || c == 231 || c == 234 || c == 284 || c == 285 || c == 293 || c == 294;
}

bool containsCaseInsensitive(std::string_view haystack, std::string_view needle) {
  if (needle.empty() || haystack.size() < needle.size()) return false;
  for (size_t i = 0; i + needle.size() <= haystack.size(); i++) {
    bool ok = true;
    for (size_t j = 0; j < needle.size(); j++) {
      if (std::tolower(static_cast<unsigned char>(haystack[i + j])) !=
          std::tolower(static_cast<unsigned char>(needle[j]))) {
        ok = false;
        break;
      }
    }
    if (ok) return true;
  }
  return false;
}

void finalizePrincipal(MassProperties& mp) {
  // Guarantee strictly positive-definite inertia tensor.
  const Eigen3 eig = eigenSym3(mp.inertiaCom);
  const double maxI = std::max({eig.values.x, eig.values.y, eig.values.z, kMinInertiaKgM2});
  const double floorI = std::max(kMinInertiaKgM2, maxI * 1e-4);
  const Vec3 clamped{std::max(eig.values.x, floorI), std::max(eig.values.y, floorI), std::max(eig.values.z, floorI)};
  mp.principalInertia = clamped;
  mp.principalAxes = Quat::fromMat3(eig.vectors);
  const Mat3 d = diagMat3(clamped.x, clamped.y, clamped.z);
  mp.inertiaCom = SymMat3::fromMat3Sym(eig.vectors * d * transpose(eig.vectors));
}

}  // namespace

Material inferPartMaterial(std::string_view partName, int ldrawColor, bool isTyre) {
  if (isTyre || containsCaseInsensitive(partName, "tyre") || containsCaseInsensitive(partName, "tire") ||
      containsCaseInsensitive(partName, "rubber")) {
    return materials::kRubberTyre;
  }
  if (isTransparentLdrawColor(ldrawColor)) {
    return materials::kPolycarbonate;
  }
  return materials::kAbs;
}

MassProperties computeBoxMass(Vec3 halfExtents, double densityKgM3) {
  const double hx = std::max(std::abs(halfExtents.x), 1e-4);
  const double hy = std::max(std::abs(halfExtents.y), 1e-4);
  const double hz = std::max(std::abs(halfExtents.z), 1e-4);
  const double sx = 2.0 * hx, sy = 2.0 * hy, sz = 2.0 * hz;
  const double mass = std::max(kMinMassKg, sx * sy * sz * densityKgM3);
  const double ix = mass * (sy * sy + sz * sz) / 12.0;
  const double iy = mass * (sx * sx + sz * sz) / 12.0;
  const double iz = mass * (sx * sx + sy * sy) / 12.0;

  MassProperties mp;
  mp.mass = mass;
  mp.com = {};
  mp.inertiaCom = SymMat3::diag(ix, iy, iz);
  mp.principalInertia = {ix, iy, iz};
  mp.principalAxes = Quat::identity();
  mp.fromExactMesh = true;
  return mp;
}

MassProperties computeSphereMass(double radius, double densityKgM3) {
  const double r = std::max(std::abs(radius), 1e-4);
  const double mass = std::max(kMinMassKg, (4.0 / 3.0) * kPi * r * r * r * densityKgM3);
  const double i = 0.4 * mass * r * r;
  MassProperties mp;
  mp.mass = mass;
  mp.com = {};
  mp.inertiaCom = SymMat3::diag(i, i, i);
  mp.principalInertia = {i, i, i};
  mp.principalAxes = Quat::identity();
  mp.fromExactMesh = true;
  return mp;
}

MassProperties computeCylinderMass(double radius, double halfHeight, double densityKgM3) {
  const double r = std::max(std::abs(radius), 1e-4);
  const double h = 2.0 * std::max(std::abs(halfHeight), 1e-4);
  const double mass = std::max(kMinMassKg, kPi * r * r * h * densityKgM3);
  const double iy = 0.5 * mass * r * r;
  const double ixz = mass * (3.0 * r * r + h * h) / 12.0;
  MassProperties mp;
  mp.mass = mass;
  mp.com = {};
  mp.inertiaCom = SymMat3::diag(ixz, iy, ixz);
  mp.principalInertia = {ixz, iy, ixz};
  mp.principalAxes = Quat::identity();
  mp.fromExactMesh = true;
  return mp;
}

MassProperties computeMeshMass(const ldraw::Mesh& mesh, double densityKgM3) {
  const Box& boxLdu = mesh.bounds;
  if (boxLdu.empty()) {
    return computeBoxMass({0.004, 0.0048, 0.004}, densityKgM3);
  }
  const Vec3 bmin = lduToMeters(boxLdu.min);
  const Vec3 bmax = lduToMeters(boxLdu.max);
  const Vec3 mid = (bmin + bmax) * 0.5;
  const Vec3 size = bmax - bmin;
  const double boxVol = std::max(0.0, size.x * size.y * size.z);

  // Blow & Bivar (2004) / Tonon (2004) exact closed-form polyhedral covariance tensor.
  // Canonical tetrahedron (0, e1, e2, e3) has covariance:
  //   C_canon(i,i) = 1/60, C_canon(i,j) = 1/120 for i != j.
  // For tetrahedron (0, a, b, c) with A = [a b c] and det = a . (b x c):
  //   C_tet = det * A * C_canon * A^T
  double signedVol = 0.0;
  Vec3 firstMoment{};
  double cov[3][3] = {};

  auto vertex = [&](uint32_t idx) -> Vec3 {
    return Vec3{mesh.positions[3 * idx], mesh.positions[3 * idx + 1], mesh.positions[3 * idx + 2]} * kMetersPerLdu - mid;
  };

  for (size_t t = 0; t + 2 < mesh.triangles.size(); t += 3) {
    const uint32_t i0 = mesh.triangles[t];
    const uint32_t i1 = mesh.triangles[t + 1];
    const uint32_t i2 = mesh.triangles[t + 2];
    if (3 * i0 + 2 >= mesh.positions.size() || 3 * i1 + 2 >= mesh.positions.size() ||
        3 * i2 + 2 >= mesh.positions.size()) {
      continue;
    }
    const Vec3 a = vertex(i0);
    const Vec3 b = vertex(i1);
    const Vec3 c = vertex(i2);
    const double det = dot(a, cross(b, c));
    const double v = det / 6.0;
    signedVol += v;
    firstMoment = firstMoment + (a + b + c) * (v * 0.25);

    // Exact symmetric second-moment integral over tetrahedron (0, a, b, c):
    //   integral(x_i x_j dV) = (det / 120) * (2*(a_i*a_j + b_i*b_j + c_i*c_j)
    //     + a_i*b_j + b_i*a_j + a_i*c_j + c_i*a_j + b_i*c_j + c_i*b_j)
    const double av[3] = {a.x, a.y, a.z};
    const double bv[3] = {b.x, b.y, b.z};
    const double cv[3] = {c.x, c.y, c.z};
    const double k = det / 120.0;
    for (int i = 0; i < 3; i++) {
      for (int j = i; j < 3; j++) {
        const double s = 2.0 * (av[i] * av[j] + bv[i] * bv[j] + cv[i] * cv[j]) +
                         av[i] * bv[j] + bv[i] * av[j] +
                         av[i] * cv[j] + cv[i] * av[j] +
                         bv[i] * cv[j] + cv[i] * bv[j];
        cov[i][j] += k * s;
      }
    }
  }

  const double enclosedVol = std::abs(signedVol);
  const double sign = signedVol >= 0.0 ? 1.0 : -1.0;

  if (boxVol > 0.0 && enclosedVol >= kMinEnclosedFill * boxVol && enclosedVol <= boxVol * 1.02) {
    const Vec3 localCom = firstMoment * (1.0 / signedVol);
    const Vec3 worldCom = mid + localCom;
    const bool comInBox = worldCom.x >= bmin.x - 1e-4 && worldCom.x <= bmax.x + 1e-4 &&
                          worldCom.y >= bmin.y - 1e-4 && worldCom.y <= bmax.y + 1e-4 &&
                          worldCom.z >= bmin.z - 1e-4 && worldCom.z <= bmax.z + 1e-4;
    if (comInBox) {
      // Flip sign so volume covariance is positive, scale by density, shift from `mid` to `localCom`.
      const double mass = std::max(kMinMassKg, enclosedVol * densityKgM3);
      const double scale = densityKgM3 * sign;
      double cCom[3][3] = {};
      const double lc[3] = {localCom.x, localCom.y, localCom.z};
      for (int i = 0; i < 3; i++) {
        for (int j = i; j < 3; j++) {
          const double val = cov[i][j] * scale - mass * lc[i] * lc[j];
          cCom[i][j] = cCom[j][i] = val;
        }
      }
      // Inertia tensor from covariance: I = trace(C) * E - C.
      const double tr = cCom[0][0] + cCom[1][1] + cCom[2][2];
      SymMat3 inertia{tr - cCom[0][0], tr - cCom[1][1], tr - cCom[2][2],
                      -cCom[0][1], -cCom[0][2], -cCom[1][2]};

      // Verify positive eigenvalues (guards against slightly corrupted non-manifold LDraw parts).
      const Eigen3 eig = eigenSym3(inertia);
      if (eig.values.x > 0.0 && eig.values.y > 0.0 && eig.values.z > 0.0) {
        MassProperties mp;
        mp.mass = mass;
        mp.com = worldCom;
        mp.inertiaCom = inertia;
        mp.fromExactMesh = true;
        finalizePrincipal(mp);
        return mp;
      }
    }
  }

  // Fallback: hollow rectangular brick shell of fill fraction `kHollowBoxFill`.
  // A hollow brick puts more mass near the walls than a solid box, so its inertia factor is
  // slightly higher (~1.25x a solid box of the same mass).
  const double sx = std::max(size.x, 2e-4);
  const double sy = std::max(size.y, 2e-4);
  const double sz = std::max(size.z, 2e-4);
  const double mass = std::max(kMinMassKg, sx * sy * sz * kHollowBoxFill * densityKgM3);
  constexpr double kShellFactor = 1.25;
  const double ix = kShellFactor * mass * (sy * sy + sz * sz) / 12.0;
  const double iy = kShellFactor * mass * (sx * sx + sz * sz) / 12.0;
  const double iz = kShellFactor * mass * (sx * sx + sy * sy) / 12.0;

  MassProperties mp;
  mp.mass = mass;
  mp.com = mid;
  mp.inertiaCom = SymMat3::diag(ix, iy, iz);
  mp.fromExactMesh = false;
  finalizePrincipal(mp);
  return mp;
}

MassProperties combineMassProperties(const std::vector<PartMassEntry>& entries) {
  MassProperties out;
  if (entries.empty()) {
    return computeBoxMass({0.004, 0.0048, 0.004});
  }
  double totalMass = 0.0;
  Vec3 weightedCom{};
  bool allExact = true;
  for (const auto& e : entries) {
    const double m = std::max(e.props.mass, kMinMassKg);
    const Vec3 partComInBody = e.localPose.toWorld(e.props.com);
    totalMass += m;
    weightedCom = weightedCom + partComInBody * m;
    allExact = allExact && e.props.fromExactMesh;
  }
  out.mass = std::max(totalMass, kMinMassKg);
  out.com = weightedCom * (1.0 / out.mass);
  out.fromExactMesh = allExact;

  SymMat3 totalI = SymMat3::zero();
  for (const auto& e : entries) {
    const double m = std::max(e.props.mass, kMinMassKg);
    const Mat3 r = e.localPose.rot.toMat3();
    const SymMat3 rotatedI = e.props.inertiaCom.rotated(r);
    const Vec3 d = e.localPose.toWorld(e.props.com) - out.com;
    const double d2 = dot(d, d);
    // Parallel Axis Theorem: I_shift = m * (|d|^2 * E - d * d^T)
    const SymMat3 parallel{m * (d2 - d.x * d.x), m * (d2 - d.y * d.y), m * (d2 - d.z * d.z),
                           -m * d.x * d.y, -m * d.x * d.z, -m * d.y * d.z};
    totalI = totalI + rotatedI + parallel;
  }
  out.inertiaCom = totalI;
  finalizePrincipal(out);
  return out;
}

}  // namespace bm::physics
