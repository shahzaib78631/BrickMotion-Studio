#pragma once
// Plain types Swift sees. No engine header, template of ours or std::function may appear in a
// bmapp header: Swift's C++ interop reads these directly.
#include <cstdint>
#include <string>
#include <vector>

namespace bmapp {

struct Vec2 {
  double x = 0, y = 0;
};
struct Vec3 {
  double x = 0, y = 0, z = 0;
};
/// Row-major 3x3.
struct Mat3 {
  double m[9] = {1, 0, 0, 0, 1, 0, 0, 0, 1};
};

struct PartPose {
  Mat3 rotation;
  Vec3 position;
};

enum class ViewPreset { Front, Back, Right, Left, Top, Bottom };
enum class PlanState { Idle, Planning, Ready, Failed };
enum class SelectMode { Replace, Add, Toggle };
enum class Arrow { Left, Right, Up, Down };

/// The undoable edits.
enum class Edit {
  Move, Rotate, Recolor, Delete, Duplicate, Paste, ReplacePart, MakeUnique,
  AddStep, DeleteStep, MoveStep, SplitStep, MergeSteps, StepFields, MoveToStep, ReorderInStep,
  NewSubmodel, MakeSubmodel, Extract, MoveToModel, RenameSubmodel, DeleteSubmodel, PlacePart, SetGroup, ImportModel,
  Motion, InsertionDirection, Scale, Keyframes,
  Staging, SceneCamera, SnapSound, Look, BuildSettings, CameraTrack, WaitingSpot,
};

/// A step's editorial fields, as a person edits them.
struct StepFields {
  std::string title, notes;  ///< title at most 80 characters, notes 1000, both trimmed
  double pauseAfter = 0;     ///< seconds held after the step, 0–10, one decimal
  bool pinOrder = false;     ///< its pieces keep their order and stop waiting on what they rest on
};

using PieceList = std::vector<uint32_t>;

struct StagingSettings {
  std::string layout = "packed", group = "step", sides = "front-back", match = "fill";
  double aspect = 1;
};

/// A saved scene camera. Positions are in LDraw coordinates, lens angle in degrees.
struct SceneCamera {
  std::string id, name;
  Vec3 position, target;
  double fieldOfView = 42, nearClip = 1, farClip = 100000;
  bool orthographic = false;
};

/// Which video a Camera track films: the Build (plan.cameraTracks[model].build, seconds from
/// the Build video's start) or the Keyframes timeline (….timeline, seconds from its first frame).
enum class CameraClock { Build, Timeline };

/// A key of a Camera track (the web's CameraKey), as the lane and the inspector show it.
struct CameraTrackKey {
  std::string id;
  double seconds = 0;
  std::string target = "point";  ///< "model", "build", "piece" or "point"
  std::string preset;            ///< the move leaving this key; "" for the last key
  double azimuth = 0, elevation = 0, lensMm = 50;  ///< degrees, web angles; mm
  bool fitted = false;           ///< distance fitted to what it looks at
  bool user = true;              ///< made or edited by hand (false: made by Auto-direct)
  double margin = 1.15;          ///< fitted: how much room is left round what it frames
  double distance = 10;          ///< not fitted: studs from what it looks at
  double roll = 0;               ///< Dutch roll, degrees
  bool focusTarget = true;       ///< focused on what it looks at (else at `focus`)
  double focus = 0.5;            ///< focus depth, 0 near … 1 far
  double blur = 0;               ///< background blur, 0–1
  Vec3 point;                    ///< "point": where it looks, LDU
  Vec3 eye;                      ///< "point", not fitted: where the camera stands, LDU
};

/// The move from one key to the next (the web's CameraTransition and its settings).
struct CameraMove {
  std::string from, to, preset;
  bool user = true;
  bool cut = false, flowThrough = false;
  std::string curve = "easeInOut";  ///< easeInOut, easeIn, easeOut, linear, holdThenMove, snap
  double strength = 0.5;
  bool straight = false;            ///< a straight line (truck, dolly) rather than an arc round the target
  std::string orbit = "shortest";   ///< shortest, cw, ccw
  int extraTurns = 0;
  double overshoot = 0, motionBlur = 0.5, shake = 0, shakeFrequency = 0.6;
  double turnLast = 0;              ///< turn in the last seconds of the move; 0 the whole move
};

/// Where and when a Build's flight lands (LDU, seconds on the Build clock), for Auto-direct.
struct CameraLanding {
  double start = 0, end = 0;
  Vec3 min, max;
};
/// What Auto-direct reads of the planned Build. `ok` is false until the Build is planned.
struct CameraDirectorInput {
  bool ok = false;
  std::vector<CameraLanding> lands;
  Vec3 modelMin, modelMax;
  double intro = 0, buildEnd = 0, duration = 0;
};

/// A named camera move (web BUILT_IN_PRESETS).
struct CameraPreset {
  std::string id, label, hint;
};

struct SceneCameras {
  std::vector<SceneCamera> cameras;
  std::string activeId;
  bool useForVideo = true;
};

/// How the picture is shaded. One at a time, as bmview's keys: each is a different renderer path.
/// Ray-traced glass and path tracing are drawn while the view is still, and in every export.
enum class Shading { Standard, Studio, Neural, HybridRT, ScreenSpaceGI, PathTraced };

/// How the project looks, in the editor and every export. Saved in the project: the scene
/// (`settings.video.studioLook`), edges (`edgeLines`) and AO and floor (`materials`) with the
/// web's keys; the native renderer's own choices under `settings.native.look`.
struct RenderLook {
  std::string scene;            ///< a web scene id (scenePresets); "" follows the editor's appearance
  Shading shading = Shading::Standard;
  bool edges = true, shadows = true, ambientOcclusion = true, floor = true;
  bool raytracedGlass = false;
  bool worldGiOcclusion = true; ///< Studio: baked studio visibility
  bool lightsFollowCamera = false;
  int pathSamples = 64;         ///< path tracing: samples a pixel, 8–1024
  /// How parts are rounded for display (bmr::Rounding), all on by default.
  bool smoothCurves = true;     ///< 48-sided studs and curves
  bool roundedEdges = true;     ///< shading fillets on convex edges
  bool softStudRoots = true;    ///< a soft base where a stud meets the deck
};

/// A piece and where it goes, in the world.
struct PieceMove {
  uint32_t piece = UINT32_MAX;
  PartPose pose;
};
using PieceMoves = std::vector<PieceMove>;

enum class SceneCollection { Photo, Render, Classic };
/// A web scene's backdrop as the native renderer draws it: one colour (the web gradient's middle).
struct ScenePreset {
  std::string id, label, hint;
  SceneCollection collection = SceneCollection::Classic;
  Vec3 background;  ///< sRGB 0–1
  bool floor = true;
};
using ScenePresets = std::vector<ScenePreset>;

enum class BuildOrder { TakeApart, BottomUp };
enum class FlightShape { Automatic, Web, Arc };
/// How the native planner orders the build and flies each part in (bmview's --order, --flight,
/// --clean-grown, and the plan Style's pacing). Saved under `settings.native.build`.
struct BuildSettings {
  /// The web's planner: the authored step order, flights not checked (bmview --planner legacy).
  bool standardPlanner = false;
  BuildOrder order = BuildOrder::TakeApart;
  FlightShape flight = FlightShape::Automatic;
  bool cleanGrownUnits = false;
  /// 0.25–12. A flight lasts 0.85 / piecesPerSecond seconds, held to 0.35–0.9 s.
  double piecesPerSecond = 2;
  double gap = 0.05;            ///< seconds between one landing and the next leaving, 0–2
  double stepPause = 0.25;      ///< seconds held at each new step, 0–5; at most a fifth of the flying time
  double clearance = 24;        ///< LDU a lifted flight keeps above what is in the way, 4–200
  double corner = 20;           ///< LDU: largest rounding of an Arc flight's corner, 0–80
  /// Read only: the project's video length (`settings.video.targetSeconds`), which, when set,
  /// decides the flights and pauses instead of the pacing above (as the web's pacing).
  double videoSeconds = 0;
};

enum class MotionScope { Project, Step, Parts };
enum class SequenceSegment { Intro, Build, Hero };
struct MotionFields {
  double time = -1, landing = -1, hover = -1;  ///< Negative fields use the enclosing value.
  int ease = -1;                             ///< -1 inherited, then smooth, gentle, soft, linear.
};

enum class KeyInterpolation { Smooth, Linear, Hold };
enum class KeyChannel { PositionX, PositionY, PositionZ, RotationX, RotationY, RotationZ, ScaleX, ScaleY, ScaleZ, Visibility };
struct Keyframe {
  KeyChannel channel = KeyChannel::PositionX;
  int frame = 1;
  double value = 0;
  KeyInterpolation interpolation = KeyInterpolation::Smooth;
};
struct KeyScene {
  int fps = 24, first = 1, last = 250;
  bool buildLinked = false;
  int buildStart = 1;
  double buildSpeed = 1;
};
using KeyList = std::vector<Keyframe>;
struct KeyRowPick {
  uint32_t piece = UINT32_MAX;
  int frame = 1;
  bool submodel = false;
};
using KeyRowPicks = std::vector<KeyRowPick>;
struct FlightPose {
  Vec3 position;
  double qx = 0, qy = 0, qz = 0, qw = 1;
};
using FlightPoseList = std::vector<FlightPose>;
struct KeyTrack {
  uint32_t object = UINT32_MAX;
  std::string name;
  bool baked = false;
  KeyList keys;
  PieceList members;
};
using StringList = std::vector<std::string>;

/// A point of a flight path: where the piece's middle is (LDU) at a frame of the Keyframes
/// timeline (its scene frames).
struct FlightPathPoint {
  int32_t frame = 0;
  Vec3 at;
};
using FlightPathPoints = std::vector<FlightPathPoint>;
/// A piece's baked flight as a path through the air (the web's flightPath): `line` a point a
/// frame from its first moving key to its last, `keys` one at each frame it has a position key.
/// Empty for a piece whose flight is not open as keys.
struct FlightPath {
  uint32_t piece = UINT32_MAX;
  FlightPathPoints line, keys;
  bool empty() const { return line.size() < 2; }
};

/// What opening a file gave.
struct OpenResult {
  bool ok = false;
  std::string error;     ///< why it could not open, fit to show a person; empty when ok
  std::string warnings;  ///< missing parts, loops, unknown colours: one per line
};

/// Some pieces, described.
struct Summary {
  size_t count = 0;                ///< distinct known pieces
  std::vector<std::string> parts;  ///< their distinct part files, sorted
};

/// What a command changed. When `structure` is false only placements and colours changed and the
/// piece count is the same: `moved` and `recolored` then list every affected piece (all uses).
struct Changed {
  bool structure = false;
  bool keyframesOnly = false;
  bool sceneOnly = false;
  bool cameraTrack = false;  ///< a Camera track changed: a viewport following it aims again
  bool waitingSpot = false;  ///< a waiting piece was dragged on the floor: laid on the plan, never replanned
  std::vector<uint32_t> moved;
  std::vector<uint32_t> recolored;
  std::vector<uint32_t> removed;  ///< old indices, when deletion leaves all other placements intact
  uint64_t version = 0;  ///< the session's version after it
  /// Not empty when the command was refused: nothing changed, no undo step was made, and this is
  /// why, fit to show a person.
  std::string refused;
};

/// A part file in the library.
struct PartMatch {
  std::string name, description;  ///< "3001.dat", "Brick  2 x  4"
  std::string category;
};

/// One piece, described for the inspector.
struct PieceInfo {
  uint32_t piece = 0;
  std::string part, description, colorName;
  bool inlinePart = false;
  int color = 16;
  int step = 0;              ///< its step in the root model, from 0
  std::string submodelPath;  ///< the submodels it sits in, outermost first, joined by "/"; "" in the root
  bool inSharedSubmodel = false;  ///< its submodel is used more than once: editing it changes every use
  Vec3 position;             ///< where it is in the model, LDU
};

/// A row of the models outline: the whole model, each use of a submodel under the model that
/// uses it, then the submodels used nowhere. Flat, in depth-first file order.
struct OutlineRow {
  std::string group;  ///< the mark on this use, within its parent model
  std::string id;    ///< "root"; the use items' ids from the root joined by "/"; "unused/<name>"
  std::string def;   ///< the submodel it shows; "" for the whole model
  std::string name;  ///< what to call it
  int depth = 0;
  int parent = -1;   ///< the row above it in the tree, or -1
  size_t pieces = 0;  ///< parts under it, at any depth
  size_t uses = 0;    ///< how many times its submodel is used in the file
  bool shared = false;  ///< used more than once: editing it changes every use
  bool unused = false;
  uint64_t useItem = 0;  ///< the use's item, 0 for the root and unused rows
};

/// A step of the model being edited.
struct StepRow {
  size_t index = 0;
  std::string title, notes;
  double pauseAfter = 0;
  bool pinOrder = false;
  bool automatic = false;  ///< made by splitting a step-less file, not by a person
  size_t items = 0;        ///< its parts and submodel uses
  size_t pieces = 0;       ///< the parts they make
  size_t submodels = 0;    ///< direct submodel uses in this step
};

/// An item of a step: a part, or a use of a submodel.
struct ItemRow {
  uint64_t item = 0;
  std::string name, description, colorName, group;
  int color = 16;
  bool submodel = false;
  size_t step = 0, index = 0;
  std::vector<uint32_t> pieces;  ///< the pieces it makes in the model being edited
};

enum class Similar { Part, Color, PartAndColor, Step };

/// A colour of the library's table.
struct ColorInfo {
  int code = 0;
  std::string name;
  uint32_t rgb = 0;  ///< 0xRRGGBB
  float alpha = 1;
  int group = 0;     ///< 0 solid, 1 transparent, 2 metallic (chrome, pearl, metal), 3 other
};

/// What the panes show of a session, made again only when the document or the selection changes.
struct Snapshot {
  uint64_t version = 0;  ///< the session's version (edits, undo and redo; not selection or hiding)
  size_t pieces = 0;
  std::vector<uint32_t> selection;  ///< sorted
  std::vector<PieceInfo> selected;  ///< the first 200 of the selection, described
  std::string undoName, redoName;
  bool dirty = false;
  size_t hidden = 0;
  std::string focus;  ///< the submodel being edited on its own; "" for the whole model
};

}  // namespace bmapp
