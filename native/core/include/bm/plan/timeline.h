#pragma once
// From a plan to an animation: where each unit waits, how it flies in, when, and a camera.
#include <filesystem>
#include <nlohmann/json.hpp>
#include "bm/plan/certify.h"
#include "bm/plan/plan.h"
#include "bm/plan/staging.h"

namespace bm::plan {

/// How each leg of a flight is eased, as in the web app: minimum jerk, cosine, quintic, none.
enum class Ease : uint8_t { Smooth, Gentle, Soft, Linear };
double eased(Ease ease, double u);
bool parse(const std::string& name, Ease& out);

struct Style {
  double fps = 30;
  double piecesPerSecond = 2;  ///< how fast the build goes: a flight lasts at least 0.85 of a piece's slot, 0.35 s to 0.9 s, as the web's one by one
  double time = 1;             ///< multiplies every flight's length (2 = twice as slow)
  double gap = 0.05;           ///< seconds between one piece landing and the next leaving
  double stepPause = 0.25;     ///< seconds held where the build moves to its next step (at most a fifth of the build in all)
  /// The floor, as in the web app.
  staging::Style floorStyle = staging::Style::Packed;
  staging::Sort floorSort = staging::Sort::Step;
  staging::Sides floorSides = staging::Sides::FrontBack;
  staging::Match floorMatch = staging::Match::Fill;
  double floorAspect = 1;
  Ease ease = Ease::Smooth;
  /// The way through the air: never closer than `clearance` above anything in the way (a brick),
  /// never faster than `speed`, and into the seat no faster than `seatSpeed` (LDU a second).
  double clearance = 24, speed = 6000, seatSpeed = 400;
  double landing = 0.25;       ///< share of a flight spent on the last leg, into the seat
  double hover = 0.1;          ///< share spent holding still at the start of that leg
  double corner = 20;          ///< LDU: the largest radius its own corners in open air are rounded to (under kExitMargin)
};

/// One unit's flight. Every pose is a motion from the unit's seat, as in Move::path.
struct Flight {
  uint32_t move = 0;             ///< index into Plan::moves: the top-level move it is, or helps build
  /// What it moves, and the flight of the unit it helps build (-1: none): a unit with moves of its
  /// own (Move::sub) is built piece by piece on its spot on the floor before it flies in, and
  /// its flight carries theirs (motionAt). Empty `pieces`: Plan::moves[move]'s.
  std::vector<uint32_t> pieces;
  int parent = -1;
  int depth = 0;                 ///< how many units it is inside
  Flag flag = Flag::None;
  Vec3 insertion;
  double seatTravel = 0;
  int startFrame = 0, frames = 0;  ///< frames == 0: the unit appears at its seat (a flagged move does not fly)
  int appearFrame = 0;           ///< when its pieces are first shown, waiting on the floor (a flight that does not fly: startFrame)
  /// Frames from startFrame to where the plan's own path begins, and to where the last leg, into
  /// the seat, begins (it ends at rest at startFrame + frames).
  double pathAt = 0, seatAt = 0;
  Xform staging;                 ///< where it waits on the floor
  std::vector<Xform> waypoints;  ///< staging first, seat (identity) last
  std::vector<double> at;        ///< 0..1 for each waypoint; the last leg takes Style::landing
  /// The open-air part as flown, from staging to where the hover begins, its corners rounded:
  /// one ease in, one ease out, no stop between. Empty: every leg eases on its own.
  std::vector<Vec3> air;
  std::vector<double> airAt;     ///< distance along `air` to each point
  std::vector<uint32_t> airLeg;  ///< the waypoint whose pose each point of `air` takes its rotation from
  uint32_t hoverAt = 0;          ///< the waypoint `air` ends at
  /// The flight as flown (empty `route`: the waypoints above). The unit turns about `pivot` (where
  /// its middle is at its seat) and the pivot follows `route` (the unit's frame, as motions are):
  /// motion = [R, c - R * pivot]. It waits turned by `turnFrom` and turns to its seat's way
  /// between `turnStart` and `turnEnd` (distances along the route).
  std::vector<Vec3> route;
  std::vector<double> routeAt;  ///< distance along route to each point
  Vec3 pivot;
  Mat3 turnFrom;
  double turnStart = 0, turnEnd = 0;
  std::vector<double> routeTurn;  ///< how much of its turn is done at each point of route (0..1), eased; empty: by turnStart/turnEnd
  /// The legs as timed: each eased from rest to rest, `frames` long from `start` (frames from
  /// startFrame), over route distances `from` to `to`. The last leg is the one into the seat.
  struct Phase {
    double start = 0, frames = 0, from = 0, to = 0;
  };
  std::vector<Phase> phases;
  Ease ease = Ease::Smooth;
  double liftAt = 0;      ///< frames from startFrame when it has lifted clear of the floor
  double seatFrames = 0;  ///< how long the last leg, into the seat, takes
  bool fallback = false;  ///< no way through the air was found clear: it flies above everything
};

struct CameraKey {
  int frame = 0;
  Vec3 target;
  double distance = 0, azimuth = 0, elevation = 0;  ///< radians
};

struct Timeline {
  std::vector<Flight> flights;  ///< in the order played: one per move, a unit's own build before it
  std::vector<CameraKey> camera;  ///< one per second
  int frames = 0;
};

/// Staging is the web app's floor: bands round the model, each unit built on a spot of its own
/// beside it with bands of its own. A piece waits turned as it is drawn (its part's own way up);
/// it lifts, turns on the way, crosses just above what is in its way (built, waiting, on a
/// spot), joins the plan's path as low as it can, and follows it into the seat.
/// The floor and easing a project (.brickmotion) was saved with in the web app; defaults for
/// anything else, or anything it does not say.
Style styleOf(const std::filesystem::path& project);

Timeline buildTimeline(const Model& model, ldraw::PartCache& parts, const Plan& plan, const Style& style = {}, Vec3 down = {0, 1, 0});

/// The unit's motion from its seat at a frame: staging before its flight, the seat after it.
Xform poseAt(const Flight& flight, int frame);
/// The same between frames.
Xform poseAt(const Flight& flight, double frame);
/// Whether a flight's pieces are shown at a frame.
bool shownAt(const Flight& flight, double frame);
/// Each piece's innermost flight (-1: none), indexed like Model::pieces().
std::vector<int> owners(const Timeline& timeline, const Plan& plan, size_t pieces);

/// A flight's motion in the model at a frame: its own (poseAt), carried by the flights of the
/// units it helps build.
Xform motionAt(const Timeline& timeline, size_t flight, double frame);

/// The pieces a flight moves (Flight::pieces, or its move's).
const std::vector<uint32_t>& piecesOf(const Flight& flight, const Plan& plan);

/// Where the unit's flight takes it, start to seat, as straight segments: the corners of its
/// straight legs, and points at most `spacing` LDU apart along anything curved. What poseAt plays
/// lies on these segments.
std::vector<Vec3> playedPath(const Flight& flight, double spacing);

/// The plan for tools and tests: every move with its pieces' ids, axis, path, flag and, when a
/// certificate is given, whether it is certified.
nlohmann::json toJson(const Plan& plan, const Certificate* certificate, const Model& model);
nlohmann::json toJson(const Timeline& timeline);

}  // namespace bm::plan
