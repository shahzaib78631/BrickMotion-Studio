#pragma once
// The equations a system's links and gearings put on the motion of its bodies.
#include <vector>
#include "bm/kin/linalg.h"
#include "bm/kin/system.h"

namespace bm::kin {

/// Lengths are divided by this inside the equations, so that turning and moving are of
/// comparable size (a stud is 20 LDU).
inline constexpr double kLengthUnit = 20.0;

struct Equations {
  Matrix jacobian;               ///< one row per equation; 6 columns per free body: turning x y z, then moving x y z (in kLengthUnit)
  std::vector<double> residual;  ///< how far each equation is from holding in the given poses (0 for gearings)
};

/// Where a mesh's teeth meet, and the direction they move in there, when the two gears'
/// bodies have moved by `poseA` and `poseB`. The point is carried by the two shaft lines, not
/// by either gear's own turning.
void meshAt(const GearMesh& mesh, const Xform& poseA, const Xform& poseB, Vec3& point, Vec3& tangent);

/// For each gearing, the body that carries both its shafts (each gear turns against it about
/// its own shaft line), or UINT32_MAX if there is none. With a carrier the gearing's equation
/// is in tooth counts alone, so its ratio is exact however the file placed the gears; without
/// one it is the equality of the two tooth speeds where they meet. For a rack it is the body
/// the gear turns on.
std::vector<uint32_t> carriers(const System& sys);

/// The equations of `links` and `gearings` (indices into `sys`). `column[body]` is the body's
/// first column, or -1 for a body that is held still. `poses`, if given, is each body's
/// motion from rest (a model-space transform); otherwise everything is at rest.
Equations equations(const System& sys, const std::vector<int>& column, size_t columns, const std::vector<uint32_t>& links, const std::vector<uint32_t>& gearings, const std::vector<Xform>* poses = nullptr);

}  // namespace bm::kin
