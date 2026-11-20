#pragma once

#include <atomic>
#include <memory>
#include "bmapp/types.h"
#include "bmapp/bridging.h"

namespace bmapp { class Session; class AssemblyInspection; }
void bmappRetainAssemblyInspection(bmapp::AssemblyInspection*);
void bmappReleaseAssemblyInspection(bmapp::AssemblyInspection*);

namespace bmapp {

enum class JointType { Fixed, Hinge, Slider, Cylindrical, Ball, Flexible };

struct JointRow {
  uint32_t a = 0, b = 0;
  JointType type = JointType::Fixed;
  Vec3 point, axis, release;
  double angle = 0, clearance = 0;
  size_t mateCount = 0;
};

struct OverlapRow {
  uint32_t a = 0, b = 0;
  bool duplicate = false;
};

struct AssemblyReport {
  std::vector<JointRow> joints;
  PieceList connected, rigid, touching, withoutConnectors;
  std::vector<OverlapRow> overlaps;
  std::string error;
};

struct FitPose {
  PartPose pose;
  Vec3 contact;
  double travel = 0;
};
struct FittingPart {
  std::string name;
  Vec3 contact;
};

struct JointEdit {
  PieceList pieces;
  uint32_t pivot = UINT32_MAX;
  PartPose pose;
  std::string error;
};

/// Captured on the session's owner thread. Query it on a single background executor. Its
/// captured model and library stay valid across document edits, reopens and closing windows.
class AssemblyInspection {
 public:
  static AssemblyInspection* capture(const Session* session) SWIFT_RETURNS_RETAINED;
  ~AssemblyInspection();
  AssemblyReport inspect(const PieceList& selection, bool showAllJoints, bool checkGeometry);
  PieceList body(uint32_t piece);
  std::vector<FitPose> fits(uint32_t moving, uint32_t target);
  std::vector<FittingPart> fittingParts(uint32_t target, const std::vector<std::string>& candidates, size_t limit);
  /// Degrees signed about the joint axis. Zero separates the moving branch along its release.
  JointEdit changeJoint(uint32_t fixed, uint32_t moving, double degrees, bool collision);

 private:
  friend void ::bmappRetainAssemblyInspection(bmapp::AssemblyInspection*);
  friend void ::bmappReleaseAssemblyInspection(bmapp::AssemblyInspection*);
  struct Impl;
  explicit AssemblyInspection(std::unique_ptr<Impl>);
  std::atomic<int> refs_{1};
  std::unique_ptr<Impl> impl_;
} SWIFT_SHARED_REFERENCE(bmappRetainAssemblyInspection, bmappReleaseAssemblyInspection);

}  // namespace bmapp
