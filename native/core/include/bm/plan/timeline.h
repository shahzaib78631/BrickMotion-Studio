#pragma once
// From a plan to an animation: where each unit waits, how it flies in, when, and a camera.
#include <nlohmann/json.hpp>
#include "bm/plan/certify.h"
#include "bm/plan/plan.h"

namespace bm::plan {

struct Style {
  double fps = 30;
  double piecesPerSecond = 2;  ///< how fast the build goes
  double time = 1;             ///< multiplies every flight's length (2 = twice as slow)
  double landing = 0.25;       ///< share of a flight spent on the last leg, into the seat
  double hover = 0.1;          ///< share spent holding still at the start of that leg
  double corner = 20;          ///< LDU: the largest radius its own corners in open air are rounded to (under kExitMargin)
};

/// One unit's flight. Every pose is a motion from the unit's seat, as in Move::path.
struct Flight {
  uint32_t move = 0;             ///< index into Plan::moves
  int startFrame = 0, frames = 0;  ///< frames == 0: the unit appears at its seat (a flagged move does not fly)
  Xform staging;                 ///< where it waits on the floor
  std::vector<Xform> waypoints;  ///< staging first, seat (identity) last
  std::vector<double> at;        ///< 0..1 for each waypoint; the last leg takes Style::landing
  /// The open-air part as flown, from staging to where the hover begins, its corners rounded:
  /// one ease in, one ease out, no stop between. Empty: every leg eases on its own.
  std::vector<Vec3> air;
  std::vector<double> airAt;     ///< distance along `air` to each point
  std::vector<uint32_t> airLeg;  ///< the waypoint whose pose each point of `air` takes its rotation from
  uint32_t hoverAt = 0;          ///< the waypoint `air` ends at
};

struct CameraKey {
  int frame = 0;
  Vec3 target;
  double distance = 0, azimuth = 0, elevation = 0;  ///< radians
};

struct Timeline {
  std::vector<Flight> flights;  ///< in build order, one per top-level move
  std::vector<CameraKey> camera;  ///< one per second
  int frames = 0;
};

/// Staging is a row of spots on the floor beside the model, in build order, each as wide as its
/// unit plus a stud. A flight lifts off, crosses above everything built, and follows the plan's
/// path into the seat. The legs before the plan's path are not swept: only the path is certified.
Timeline buildTimeline(const Model& model, ldraw::PartCache& parts, const Plan& plan, const Style& style = {}, Vec3 down = {0, 1, 0});

/// The unit's motion from its seat at a frame: staging before its flight, the seat after it.
Xform poseAt(const Flight& flight, int frame);

/// Where the unit's flight takes it, start to seat, as straight segments: the corners of its
/// straight legs, and points at most `spacing` LDU apart along anything curved. What poseAt plays
/// lies on these segments.
std::vector<Vec3> playedPath(const Flight& flight, double spacing);

/// The plan for tools and tests: every move with its pieces' ids, axis, path, flag and, when a
/// certificate is given, whether it is certified.
nlohmann::json toJson(const Plan& plan, const Certificate* certificate, const Model& model);
nlohmann::json toJson(const Timeline& timeline);

}  // namespace bm::plan
