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

enum class ModelCheckKind { Overlap, Unsupported, Tipping, SingleConnector, MissingDefinition, UnknownColour, SubmodelLoop };
struct ModelCheck {
  ModelCheckKind kind;
  std::string title, detail;
  PieceList pieces;
};
struct ModelChecks {
  std::vector<ModelCheck> findings;
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

/// A part builders attach to the target, at the pose they use (BrickNet).
struct HabitFit {
  std::string name;   ///< e.g. "3023.dat"
  std::string description;
  int color = 16;
  PartPose pose;
  uint32_t models = 0;  ///< models in the survey that join the two this way
  uint32_t total = 0;   ///< models in the survey
  uint32_t links = 0;   ///< connectors the suggestion mates on the target
  std::string joint;
};

/// A piece the file places a little off what holds it, and where it belongs (bm plan --correct).
struct LoosePiece {
  uint32_t piece = UINT32_MAX, onto = UINT32_MAX;
  PartPose pose;          ///< seated exactly
  double offset = 0;      ///< LDU its connector is off the line it belongs on
  double angle = 0;       ///< degrees it turns
  bool safe = false;      ///< seating it crosses nothing it does not cross already
  std::string note;       ///< why it is not safe
};
struct LoosePieces {
  std::vector<LoosePiece> pieces;
  std::string error;
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
  ModelChecks checkModel();
  PieceList body(uint32_t piece);
  std::vector<FitPose> fits(uint32_t moving, uint32_t target);
  std::vector<FittingPart> fittingParts(uint32_t target, const std::vector<std::string>& candidates, size_t limit);
  /// Where builders put parts on `target`, one per part, most common first. Each one mates the
  /// target and overlaps nothing. Empty when the habits table is missing.
  std::vector<HabitFit> habitFits(uint32_t target, size_t limit);
  /// Every piece set a little off its connector, with the pose that seats it.
  LoosePieces loosePieces();
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
