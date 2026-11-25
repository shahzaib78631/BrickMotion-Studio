#pragma once
// The Metal viewport of one session: drawing, the camera, and playing the build.
#include <atomic>
#include <cstdint>
#include <memory>
#include <string>
#include <vector>
#include "bmapp/bridging.h"
#include "bmapp/movie_export.h"
#include "bmapp/motion_audit.h"
#include "bmapp/session.h"
#include "bmapp/types.h"

namespace bmapp {
class Viewport;
}  // namespace bmapp
// Swift finds a shared reference's retain and release at global scope.
void bmappRetainViewport(bmapp::Viewport* p);
void bmappReleaseViewport(bmapp::Viewport* p);
namespace bmapp {

/// The camera as the viewport holds it. yaw 0 looks at the model's front (from -z); positive
/// pitch looks down from above. Lengths in LDU.
struct CameraState {
  double yaw = 0, pitch = 0, distance = 0;
  Vec3 target;
  bool orthographic = false;
  double verticalFOV = 0.6;  ///< radians
};

/// A drawn picture, top row first, 8-bit sRGB RGBA.
struct Picture {
  int width = 0, height = 0;
  std::vector<uint8_t> rgba;
  bool copyRGBA(uint8_t* destination, size_t count) const;
};

enum class PlacementState { Inactive, Preparing, Free, Snapped, Reference, Blocked, Unavailable };
enum class AssemblyPreview { Assembled, Separated, LaidOut, Exploded };
enum class ViewStyle { Shaded, Clay, Wireframe };

struct PlacementInput {
  std::string part;
  int color = 71;
  int grip = -1;  ///< Automatically choose a grip until the user cycles it.
  int turns = 0;  ///< Clockwise quarter turns from the part's initial orientation.
  bool mirrored = false;
  bool snap = true;
  bool reference = false;
  bool collision = true;
  uint32_t anchor = UINT32_MAX;  ///< For an existing selection, the piece the pointer picked up.
  Vec2 grab;
  PieceList selection;
};

struct PlacementPreview {
  PlacementState state = PlacementState::Inactive;
  PartPose pose;
  Vec3 contact;
  uint32_t grip = 0, gripCount = 0;
  uint64_t generation = 0, version = 0, request = 0;
  std::string reason;
};

/// What the editor's view may leave out of the project's look (RenderLook), and how it plans.
/// Exports draw the look as saved.
struct ViewportPreferences {
  bool edges = true;
  bool floor = true;
  bool shadows = true;
  bool ambientOcclusion = true;
  bool autoPlan = true;
  bool sceneBackdrop = true;  ///< false: the editor's own backdrop, even with a scene chosen
};

struct BuildFlightRow {
  uint32_t piece = UINT32_MAX;
  int step = 0, depth = 0, color = 16;
  double start = 0, end = 0;
  std::string name, flag, blocker;
  bool independent = false;
};

struct BuildSubmodelRow {
  int flight = -1, depth = 0;
  double start = 0, attach = 0, end = 0;
  StringList path;
  PieceList pieces;
};

struct BuildTimeline {
  uint64_t version = 0;
  double duration = 0, framesPerSecond = 30;
  double buildStart = 0, buildEnd = 0;
  double planningMilliseconds = 0;
  size_t reusedMoves = 0;
  size_t reusedFlightChecks = 0;
  bool reusedSnapshot = false;
  bool standardPreview = false;
  std::vector<BuildFlightRow> flights;
  std::vector<BuildSubmodelRow> submodels;
  std::vector<std::string> notes;
};

enum class PlanStage { Waiting, Solving, CheckingFlights, Preparing, StandardPreview };

struct PlaybackState {
  double seconds = 0, duration = 0;
  bool playing = false, waitingToPlay = false, atRest = true, stale = false;
  PlanState plan = PlanState::Idle;
  uint64_t version = 0;
  PlanStage stage = PlanStage::Waiting;
};

class Viewport {
 public:
  /// For Swift: a viewport of `session`, which it keeps a reference to.
  static Viewport* create(Session* session) SWIFT_RETURNS_RETAINED;
  /// The Metal device every viewport draws with (an id<MTLDevice>), for the view's CAMetalLayer;
  /// null when this Mac cannot draw.
  static void* metalDevice();
  /// Draws `session`'s model; the session must outlive the viewport.
  explicit Viewport(Session& session);
  ~Viewport();
  Viewport(const Viewport&) = delete;
  Viewport& operator=(const Viewport&) = delete;

  /// False when this Mac cannot draw (no Metal device) or the session has no model.
  bool ok() const;
  /// The address of the session it was made against.
  uintptr_t sessionAddress() const;

  /// The picture's size in pixels, and pixels per point (2 on a Retina screen).
  void resize(int pixelsWide, int pixelsHigh, double backingScale);
  /// Draws a frame into `metalDrawable` (an id<CAMetalDrawable>), or into the viewport's own
  /// picture when null (see readback). True when another frame is wanted soon: playing, a map
  /// still being drawn over frames, or a frame that could not be sent.
  bool draw(void* metalDrawable);
  /// The last frame drawn with no drawable.
  Picture readback();
  /// A fresh picture of the current view. The visible window still receives its next frame.
  Picture capture();
  /// Renders and encodes on a private headless viewport. Blocks the export helper process.
  /// Returns an error suitable for display, or an empty string after completing the movie.
  std::string exportMovie(const MovieSettings& settings, const std::string& destination);
  /// The snap track of the planned Build with the project's mix, as the Build video exports it,
  /// on the editor's Build clock (second 0 is the timeline's start), panned for the current view.
  /// Empty when written; otherwise why not, fit to show a person.
  std::string writeSnapTrack(const std::string& file, const std::string& recordings);

  /// Behind the model, as sRGB 0..1 (the view follows light and dark mode).
  void setBackground(double r, double g, double b);
  void setPreferences(const ViewportPreferences& preferences);
  /// True when something has changed since the last frame drawn.
  bool needsDraw() const;

  /// Turns the view as if the pointer had hold of the model's near side: a drag of this many
  /// points, right and down positive.
  void orbit(double dxPoints, double dyPoints);
  /// Slides the view by a drag of this many points, right and down positive.
  void pan(double dxPoints, double dyPoints);
  /// Distance is divided by `factor` (above 1 comes closer), within the renderer's limits.
  void zoom(double factor);
  /// As zoom, keeping the point under (xPoints, yPoints), from the top left, where it is.
  void zoomToward(double factor, double xPoints, double yPoints);
  /// A trackpad rotation, counterclockwise positive, turns the view about the vertical.
  void rotateGesture(double degrees);
  /// Everything in view, from where the camera is looking now.
  void fitAll();
  /// Looks from that side, straight on, with everything in view.
  void view(ViewPreset preset);
  CameraState camera() const;
  SceneCamera captureSceneCamera() const;
  /// True when the Camera track of the clock shown (the Build's, or the Keyframes timeline's on
  /// the Keyframes tab) has keys and a scene to follow: with Follow Camera on it films that video
  /// (viewport and export) in place of the director.
  bool followsCameraTrack();
  /// That track's view at `seconds` of its video (LDraw units); the current view if the track
  /// has no keys or nothing is planned.
  SceneCamera cameraTrackView(double seconds);
  /// The planned Build, for Session::autoDirectCamera; not ok until it is planned.
  CameraDirectorInput cameraDirectorInput();
  bool recallSceneCamera(const std::string& id);
  void setOrthographic(bool enabled);
  void centerOnFloor();
  void setViewStyle(ViewStyle style);
  void setGridSpacing(double ldu);
  double zoomPercent() const;

  /// Space: plans the build the first time (in the background), then plays or pauses it.
  void play(bool on);
  void requestPlan();
  void regeneratePlan(bool standardPreview = false);
  /// Selects a time range (seconds) and plays it. An end of zero means through to the end.
  void playRange(double start, double end);
  void setPlaybackRate(double rate);
  void setPlaybackLoop(bool loop);
  void setDirectorPreview(bool directed);
  void useKeyframes(bool enabled);
  KeyList bakeFlight(uint32_t piece);
  KeyList bakeFlightInScene(uint32_t piece, const KeyScene& scene);
  FlightBake* captureFlightBake(const PieceList& pieces, bool detach) SWIFT_RETURNS_RETAINED;
  FlightPoseList editedFlightRoute(uint32_t piece);
  /// The path a piece's flight, open as keys on the Keyframes timeline, flies (empty otherwise).
  FlightPath flightPath(uint32_t piece);
  /// How far a point at `through` (LDU) moves when dragged from (x0, y0) to (x1, y1) (points, top
  /// left) in the plane facing the camera through it: a path point's drag. Zero when the pointer
  /// leaves that plane.
  Vec3 dragFacingView(Vec3 through, double x0, double y0, double x1, double y1) const;
  MotionAudit* auditMotion(uint32_t piece) SWIFT_RETURNS_RETAINED;
  /// Temporarily previews a build step or the full inventory (-1) without editing it.
  void arrange(int step, AssemblyPreview mode);
  PlaybackState playbackState() const;
  /// The plan's presentation rows. Only read after observing a new ready version.
  BuildTimeline buildTimeline() const;
  PieceList buildOrder() const;
  bool canTurnWaitingPart(uint32_t piece) const;
  double waitingTurnToMatch(uint32_t piece) const;
  /// Whether `piece` waits on the floor alone at the frame shown, so it can be dragged there.
  bool canMoveWaitingPart(uint32_t piece) const;
  /// Dragging a waiting piece across the floor (the web's staging drag): it follows the pointer
  /// (points, top left) in the level plane it waits in, shown live; nothing is saved. `end`
  /// gives the drag (LDU, level) for Session::shiftWaitingPart, and puts the piece back; with
  /// nothing begun, or a pointer off the plane, the drag is zero.
  bool beginWaitingDrag(uint32_t piece, double x, double y);
  Vec3 dragWaitingPart(double x, double y);
  Vec3 endWaitingDrag();
  /// Pauses playback and shows every piece at its edited position.
  void showRest();
  bool playing() const;
  /// Where playback is, and how long the build is, in seconds (0 until planned).
  double seconds() const;
  double length() const;
  void seek(double seconds);
  PlanState planState() const;
  /// Why planning failed, fit to show; empty otherwise.
  std::string planError() const;
  /// The session's version the current plan was made from; 0 when there is none. An edit drops
  /// the plan (and stops a planning run), so playing again plans the edited model.
  uint64_t plannedVersion() const;

  // Points are from the top left of the view.

  /// The piece drawn at that point in the last frame; UINT32_MAX for none. Hidden pieces are
  /// never picked.
  uint32_t pick(double xPoints, double yPoints);
  /// The pieces shown in the rectangle between two corners, in either order: wholly inside it,
  /// or with `touching` any that reach into it. Sorted.
  std::vector<uint32_t> marquee(double x0, double y0, double x1, double y1, bool touching);
  /// Outlines the session's selection now (a frame drawn does so too).
  void showSelection();
  /// Brings the selection into view from the same side; everything when nothing shown is selected.
  void frameSelection();
  /// The middle of the selection's box as shown, the pivot R turns about; the view's target when
  /// nothing shown is selected.
  Vec3 selectionCenter();

  /// Preview a library part at this point in the viewport. The worker coalesces pointer moves.
  /// The returned request identifies the pose a click or Return may commit.
  uint64_t previewPart(const PlacementInput& input, Vec2 point);
  PlacementPreview placementPreview() const;
  void previewFit(uint32_t piece, const PartPose& pose);
  void clearPlacementPreview();

  struct Impl;

 private:
  bool drawFrame(void* metalDrawable, bool& submitted);
  friend void ::bmappRetainViewport(Viewport*);
  friend void ::bmappReleaseViewport(Viewport*);
  std::atomic<int> refs_{1};
  std::unique_ptr<Impl> impl_;
} SWIFT_SHARED_REFERENCE(bmappRetainViewport, bmappReleaseViewport);

}  // namespace bmapp
