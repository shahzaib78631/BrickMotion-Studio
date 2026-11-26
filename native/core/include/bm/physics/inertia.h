#pragma once
// Exact rigid-body mass, centre of mass, and full 3x3 inertia tensor computation
// from LDraw polyhedral meshes and compound multi-piece rigid assemblies.
#include <vector>
#include "bm/ldraw/mesh.h"
#include "bm/physics/constants.h"
#include "bm/physics/math_ext.h"

namespace bm::physics {

/// Complete rigid-body mass properties in SI units (kg, metres, kg·m^2).
struct MassProperties {
  double mass = 0.0;               ///< kg
  Vec3 com{};                      ///< centre of mass in local frame (m)
  SymMat3 inertiaCom{};            ///< 3x3 inertia tensor about `com` in local frame (kg·m^2)
  Vec3 principalInertia{};         ///< principal moments (I1, I2, I3) (kg·m^2)
  Quat principalAxes = Quat::identity();  ///< orientation of principal axes in local frame
  bool fromExactMesh = false;      ///< true if derived from exact signed-tetrahedron mesh volume
};

/// Exact closed-form polyhedral mass properties from an LDraw mesh (Blow & Bivar 2004 / Tonon 2004).
///
/// Computes exact volume, centroid, and 3x3 covariance tensor over signed tetrahedra.
/// Falls back to a hollow rectangular-shell prism (`kHollowBoxFill`) when the mesh is open,
/// non-manifold, or encloses an implausible volume. Guarantees strictly positive-definite inertia.
MassProperties computeMeshMass(const ldraw::Mesh& mesh, double densityKgM3 = materials::kAbs.density);

/// Analytical solid box mass properties (extents in metres, centred at origin).
MassProperties computeBoxMass(Vec3 halfExtentsMeters, double densityKgM3 = materials::kAbs.density);

/// Analytical solid sphere mass properties (radius in metres).
MassProperties computeSphereMass(double radiusMeters, double densityKgM3 = materials::kAbs.density);

/// Analytical solid cylinder mass properties along local Y axis (radius, half-height in metres).
MassProperties computeCylinderMass(double radiusMeters, double halfHeightMeters, double densityKgM3 = materials::kAbs.density);

/// One sub-piece contribution to a compound rigid body.
struct PartMassEntry {
  MassProperties props;  ///< part's mass properties in part space (SI)
  Pose localPose;        ///< part's pose in the compound body's frame (SI)
};

/// Combine multiple rigidly-joined pieces using Steiner's Parallel Axis Theorem:
///   I_total = sum_k ( R_k I_k R_k^T + m_k (|r_k|^2 E - r_k r_k^T) )
/// Returns total mass, combined CoM, inertia tensor about combined CoM, and principal axes.
MassProperties combineMassProperties(const std::vector<PartMassEntry>& entries);

}  // namespace bm::physics
