#pragma once
// One open document: its model, the engine's caches, and (later) its command log.
#include <cstdint>
#include <memory>
#include <string>
#include <vector>
#include <atomic>
#include "bmapp/bridging.h"
#include "bmapp/flight_bake.h"
#include "bmapp/types.h"
#include "bmapp/model_import.h"
#include "bmapp/inventory_import.h"
#include "bmapp/snap_mix.h"

namespace bmapp {

class Session;
}  // namespace bmapp
// Swift finds a shared reference's retain and release at global scope.
void bmappRetainSession(bmapp::Session* p);
void bmappReleaseSession(bmapp::Session* p);
namespace bmapp {

/// Swift shares one Session by reference (its address never changes, which a Viewport relies
/// on); C++ may also own one directly.
class Session {
 public:
  /// For Swift: a new session with one reference, which Swift then owns.
  static Session* create() SWIFT_RETURNS_RETAINED;
  Session();
  ~Session();
  Session(const Session&) = delete;
  Session& operator=(const Session&) = delete;

  /// BM_LDRAW_DIR, else public/ldraw in the working directory or one above it, else (a developer
  /// build) the repository's public/ldraw; "" if none.
  static std::string ldrawDirectory();
  /// The engine's version, "major.minor.patch".
  static std::string engineVersion();
  /// Any format bm::io reads. On failure the session is left as it was. Opening (open or
  /// openBytes) starts afresh: no undo, nothing selected or hidden, a new generation.
  OpenResult open(const std::string& path);
  /// An untitled project with one empty build step and the usual LDraw library.
  OpenResult newBlank();
  /// A .brickmotion project's bytes; `path` names it (title, errors, the planner's style).
  OpenResult openBytes(const std::string& bytes, const std::string& path);
  /// Installs a successfully opened session whose loading worker has finished.
  void adoptLoadedSession(const Session* loaded);
  /// Different for every document opened, in any session.
  uint64_t generation() const;
  /// The document as a .brickmotion project the web app opens: the opened project with its plan
  /// replaced (its planned "timelines" dropped once the plan has changed). An LDraw import's
  /// colour-16 parts take the colour they show, wherever all their uses agree.
  std::string projectBytes() const;
  std::string projectBytesWithPreview(const std::string& pngBase64) const;
  std::string planBytes() const;
  /// The document as an LDraw MPD.
  std::string mpdBytes() const;
  std::string submodelMpdBytes(const std::string& model) const;
  std::string submodelProjectBytes(const std::string& model) const;
  size_t pieceCount() const;
  /// The file's name without its extension.
  std::string title() const;
  /// True unless the file was a .brickmotion project (an import opens as a new project).
  bool imported() const;
  /// The distinct known pieces of `pieces` and their parts.
  Summary summarize(const std::vector<uint32_t>& pieces) const;
  /// The part and description under the pointer, independent of the inspector's selection limit.
  PartMatch partAt(uint32_t piece) const;
  int partColor(uint32_t piece) const;
  bool isLocalPiece(uint32_t piece) const;
  // Editing. Pieces are indexes into the current model. Every edit is a command on the document
  // (never on the model directly), undone exactly. A piece inside a submodel is edited in the
  // submodel, so every use of it changes; a selection that holds every piece of one use edits
  // that use instead.

  /// Moves by a world offset. `continuing`: part of one drag, which undoes as one step.
  Changed move(const std::vector<uint32_t>& pieces, Vec3 deltaLdu, bool continuing);
  /// Turns about a world axis through a world point, right-handed, in degrees.
  Changed rotate(const std::vector<uint32_t>& pieces, Vec3 axis, double degrees, Vec3 pivot, bool continuing);
  Changed recolor(const std::vector<uint32_t>& pieces, int colorCode);
  Changed remove(const std::vector<uint32_t>& pieces);
  /// Copies go into the same def and step as each original, offset in the world. The copies are
  /// selected after (paste too).
  Changed duplicate(const std::vector<uint32_t>& pieces, Vec3 offsetLdu);
  /// LDraw text: a type-1 line per piece, at its place in the world.
  std::string copy(const std::vector<uint32_t>& pieces) const;
  /// Into the root model's last step, offset in the world.
  Changed paste(const std::string& ldrawText, Vec3 offsetLdu);
  /// Insert a validated pose into the focused definition. A negative step uses its last step.
  Changed placePart(const std::string& part, int color, const PartPose& pose, int step,
                    uint64_t generation, uint64_t version);
  Changed placePartBefore(const std::string& part, int color, const PartPose& pose, int step,
                          int before, uint64_t generation, uint64_t version);
  /// Commits a drag of existing pieces at the validated pose of the piece that was picked up.
  Changed placeMoved(const PieceList& pieces, uint32_t anchor, const PartPose& pose,
                     uint64_t generation, uint64_t version);
  /// Sets pieces at these world poses as one undo step (Seat Loose Pieces). Each piece edits its
  /// own part item; a part item shared by several uses moves once, by its first piece.
  Changed seatPieces(const PieceMoves& moves, uint64_t generation, uint64_t version);
  /// Assigns a named group to selected items in the active definition. Empty removes the mark.
  Changed setGroup(const PieceList& pieces, const std::string& group);
  StringList groupNames() const;
  StringList groupsOf(const PieceList& pieces) const;
  void selectGroup(const std::string& group);
  Changed importModel(const ModelImport* file, const std::string& into, uint64_t generation);
  Changed importInventory(const InventoryImport* inventory);
  Changed replacePart(const std::vector<uint32_t>& pieces, const std::string& part);
  /// Forks the submodel use holding `piece` into "<name> 2" (the next free number).
  Changed makeUnique(uint32_t piece);
  // Focus: one submodel opened to be edited on its own. Every command then acts in it, and the
  // pieces are its pieces. View state: not undone, not saved; the selection is cleared.

  /// Def names from below the root down to the one to edit; {} is the whole model. A path that
  /// stops leading somewhere is cut there.
  Changed focus(const StringList& path);
  StringList focusPath() const;
  /// The submodel being edited, or "".
  std::string focused() const;

  // Steps, of the model being edited. Steps are counted from 0 here; people see them from 1.

  size_t stepCount() const;
  StepFields stepFields(size_t at) const;
  /// An empty step before `at` (`at` == stepCount() adds one at the end).
  Changed insertStep(size_t at);
  /// Its pieces join the step before (the next one when it is the first); notes are joined.
  Changed deleteStep(size_t at);
  Changed moveStep(size_t from, size_t to);
  /// The items of step `at` that hold these pieces go to a new step after it, in their order.
  Changed splitStep(size_t at, const std::vector<uint32_t>& pieces);
  /// Inserts a step for the suffix beginning at `firstItem`, preserving the original item order.
  Changed splitStepAt(size_t step, size_t firstItem);
  /// Step `first + 1` joins step `first`.
  Changed mergeSteps(size_t first);
  /// `continuing`: part of one editing session (typing), which undoes as one step.
  Changed setStepFields(size_t at, const StepFields& fields, bool continuing);
  MotionFields motionFields(MotionScope scope, size_t step, const PieceList& pieces) const;
  Changed setMotionFields(MotionScope scope, size_t step, const PieceList& pieces, const MotionFields& fields);
  Changed setSequenceDuration(SequenceSegment segment, double seconds);
  StagingSettings stagingSettings() const;
  Changed setStagingSettings(const StagingSettings& settings);
  /// The focused model's whole staging area, turned about the model (degrees, -180–180).
  double stagingTurn() const;
  Changed setStagingTurn(double degrees);
  /// How many waiting pieces were turned or dragged on the floor one by one (in every model),
  /// and putting them all back where the planner lays them, as one step.
  size_t movedWaitingParts() const;
  Changed putBackWaitingParts();
  /// Build Staging's Apply: layout, turn and optionally putting moved waiting parts back, as one undo step.
  Changed applyStaging(const StagingSettings& settings, double turn, bool straighten);
  /// The focused model's Camera tracks, one for each clock: keys at seconds of that video (the
  /// Build video, or the Keyframes timeline from its first frame), the move between each pair
  /// chosen from cameraPresets(). Each edit is one named undo step.
  std::vector<CameraTrackKey> cameraKeys(CameraClock clock) const;
  std::vector<CameraMove> cameraMoves(CameraClock clock) const;
  /// The Auto-direct style the track was last written in; "" when none.
  std::string cameraDirectorStyle(CameraClock clock) const;
  static std::vector<CameraPreset> cameraPresets();
  /// A key that reproduces `view` (LDraw units) at `seconds`; nudged by a frame off another key.
  Changed addCameraKey(CameraClock clock, double seconds, const SceneCamera& view, double fps, double duration);
  Changed setCameraKeyView(CameraClock clock, const std::string& id, const SceneCamera& view);
  Changed moveCameraKey(CameraClock clock, const std::string& id, double seconds, double fps, double duration);
  Changed removeCameraKey(CameraClock clock, const std::string& id);
  /// "model", "build" or "piece": the key follows it, its distance fitted.
  Changed setCameraKeyTarget(CameraClock clock, const std::string& id, const std::string& target);
  /// The inspector's fields of key `key.id` (see camtrack setKeyFields). `continuing`: grows the
  /// step of the edit just before it to the same key (a slider being dragged).
  Changed setCameraKey(CameraClock clock, const CameraTrackKey& key, bool continuing);
  /// The inspector's settings of the move leaving `move.from`; `continuing` as for keys.
  Changed setCameraMove(CameraClock clock, const CameraMove& move, bool continuing);
  /// The move leaving key `fromId`. `distance`: about how far the camera is (LDU), for slides.
  Changed chooseCameraPreset(CameraClock clock, const std::string& fromId, const std::string& presetId, double distance);
  Changed clearCameraTrack(CameraClock clock);
  /// The web's Auto-direct in a style ("reference", "showcase", "turntable", "calm", "energetic",
  /// "overhead") from the planned Build (Viewport::cameraDirectorInput), merged with the keys and
  /// moves made by hand; videos then use the track. On the Timeline clock the keys follow the
  /// linked Build (its start and speed), and it is refused without one. One undo step.
  Changed autoDirectCamera(CameraClock clock, const CameraDirectorInput& build, const std::string& style, double lensMm);
  /// Which camera films Build videos, as the web's exportCamera: "track" (the Camera track when
  /// it has keys, else the automatic camera; the default), "automatic" or "buildView".
  std::string exportCamera() const;
  Changed setExportCamera(const std::string& camera);
  SceneCameras sceneCameras() const;
  Changed saveSceneCamera(const SceneCamera& camera);
  Changed removeSceneCamera(const std::string& id);
  Changed activateSceneCamera(const std::string& id);
  /// How the project is drawn, here and in every export (one named undo step a change).
  RenderLook renderLook() const;
  Changed setRenderLook(const RenderLook& look);
  /// The web's scenes, in its chooser's order.
  static ScenePresets scenes();
  /// How the native planner orders and paces the build. A change replans.
  BuildSettings buildSettings() const;
  Changed setBuildSettings(const BuildSettings& settings);
  SnapMix snapMix() const;
  Changed setSnapMix(const SnapMix& mix);
  Changed turnWaitingPart(uint32_t piece, double degrees);
  /// Drags where a piece waits on the floor by `delta` (LDU; its height is ignored), adding to
  /// earlier drags (the web's floorShift, on its item: every copy of a submodel alike). The
  /// build is not replanned: the piece still lands as planned. "Move Waiting Part".
  Changed shiftWaitingPart(uint32_t piece, Vec3 delta);
  /// How far a piece's waiting spot has been dragged, LDU (zero: where the planner put it).
  Vec3 waitingShift(uint32_t piece) const;
  Changed setInsertionDirection(const PieceList& pieces, Vec3 direction);
  Vec3 insertionDirection(uint32_t piece) const;
  Changed scale(const PieceList& pieces, Vec3 factor, Mat3 axes, Vec3 pivot, bool continuing);
  KeyScene keyScene() const;
  std::vector<KeyTrack> keyTracks() const;
  bool hasEditableFlightKeys(uint32_t piece) const;
  double keyValue(uint32_t piece, KeyChannel channel, double frame) const;
  /// Selects the containing use when a baked leaf shares its representative piece.
  double keyValue(uint32_t piece, KeyChannel channel, double frame, bool submodel) const;
  Changed setKeyScene(const KeyScene& scene);
  /// Inserts or replaces keys for a part in the active model. Repeated updates can form one drag.
  Changed setKeys(uint32_t piece, const KeyList& keys, bool continuing);
  Changed setKeys(uint32_t piece, const KeyList& keys, bool continuing, bool submodel);
  /// Removes the keys' channel and frame pairs. Useful for moving or deleting several keys.
  Changed removeKeys(uint32_t piece, const KeyList& keys);
  Changed removeKeys(uint32_t piece, const KeyList& keys, bool submodel);
  Changed moveKey(uint32_t piece, KeyChannel channel, int from, int to);
  Changed moveKeys(uint32_t piece, const KeyList& keys, int offset);
  Changed moveKeys(uint32_t piece, const KeyList& keys, int offset, bool submodel);
  Changed moveKeyRows(const KeyRowPicks& keys, int offset);
  Changed removeKeyRows(const KeyRowPicks& keys);
  Changed setBakedKeys(uint32_t piece, const KeyList& keys);
  /// A flight open as keys, edited as its path (Viewport::flightPath), as the web's: a point
  /// added where the path runs (it keeps its shape); a point moved to `location` (studs from the
  /// seat, the location channels; a drag one step); a point deleted, never the first or last
  /// (they hold the start and the seat). Every location channel is keyed at every point.
  Changed addFlightPathPoint(uint32_t piece, int32_t frame);
  Changed setFlightPathPoint(uint32_t piece, int32_t frame, Vec3 location, bool continuing);
  Changed deleteFlightPathPoint(uint32_t piece, int32_t frame);
  Changed applyFlightBake(FlightBake* bake);
  Changed editBuildFlight(uint32_t piece, const KeyList& keys, const KeyScene& scene);
  Changed returnFlightToPlanner(uint32_t piece);
  Changed useFlightInBuild(uint32_t piece, const FlightPoseList& route);
  /// To the end of `step` (stepCount() makes a new last step). A piece inside a submodel moves
  /// only with its whole use.
  Changed moveToStep(const std::vector<uint32_t>& pieces, size_t step);
  /// Inserts and fills a new step at this index as one command.
  Changed moveToNewStep(const PieceList& pieces, size_t index);
  Changed reorderInStep(size_t step, size_t from, size_t to);
  Changed reorderArrival(size_t step, size_t from, size_t to);
  /// Drops the selected items before the original item index, or at the end of the step.
  Changed moveArrival(const PieceList& pieces, size_t step, size_t before, bool force);
  Changed setArrivalPinned(const PieceList& pieces, bool pinned);
  PieceList arrivalPins() const;
  Changed regenerateSteps(const PieceList& buildOrder);
  // Submodels. Pieces moved between models keep where they are in the world.

  /// `preferred`, else "<preferred> 2", 3, ...: the first name no submodel has.
  std::string freeSubmodelName(const std::string& preferred) const;
  /// An empty submodel with one empty step, used nowhere yet.
  Changed newSubmodel(const std::string& name);
  /// The items holding these pieces (a whole use counts as its use) become a new submodel, one
  /// step per step they were in; one use of it takes their place. They stay selected.
  Changed makeSubmodel(const std::vector<uint32_t>& pieces, const std::string& name);
  /// The use holding `piece` is replaced by copies of its submodel's items, in its place.
  Changed extract(uint32_t piece);
  /// To the last step of `submodel`, through its first use in this model.
  Changed moveToModel(const std::vector<uint32_t>& pieces, const std::string& submodel);
  /// Every use follows.
  Changed renameSubmodel(const std::string& from, const std::string& to);
  /// Only one that is not used.
  Changed deleteSubmodel(const std::string& submodel);
  /// Ends a drag: the next continuing move or turn starts a new undo step.
  void endGesture();
  bool canUndo() const;
  bool canRedo() const;
  /// "Move Piece", "Recolour 3 Pieces", ...; "" when there is none.
  std::string undoName() const;
  std::string redoName() const;
  Changed undo();
  Changed redo();
  /// Changed since the last markSaved (or since opening).
  bool dirty() const;
  void markSaved();
  /// Goes up with every change, undo and redo included.
  uint64_t version() const;
  /// How many steps undo can go back: a growing drag leaves it, a new step raises it.
  size_t undoDepth() const;

  // Selection and hiding are view state: not commands, not undone, not saved. Both follow the
  // pieces through edits (a piece deleted drops out).

  void select(const std::vector<uint32_t>& pieces, SelectMode mode);
  /// Every piece not hidden.
  void selectAll();
  void selectNone();
  std::vector<uint32_t> selection() const;
  /// Hidden pieces are neither drawn nor picked, whatever the build's playback shows.
  void hide(const std::vector<uint32_t>& pieces);
  /// Shows these pieces again; the rest stay as they are.
  void show(const std::vector<uint32_t>& pieces);
  void showAll();
  std::vector<uint32_t> hidden() const;
  /// The piece's own axes in the model, each made unit (the gizmo's local axes); identity for none.
  Mat3 axesOf(uint32_t piece) const;
  /// The pieces of the root model's use that holds `piece` (just `piece` when it is in the root).
  std::vector<uint32_t> usePieces(uint32_t piece) const;
  /// Library parts whose name and description hold every word of `query`: an exact name first,
  /// then the closest descriptions. Moved and obsolete parts (~) are left out. The first call reads
  /// the library's part list (once per library, for every session).
  std::vector<PartMatch> searchParts(const std::string& query, size_t limit) const;
  // What the panes list. Each is made again only after a structural change (or a focus change).

  /// Goes up with every edit that adds, removes or regroups items, and with focus changes; not
  /// with moves, turns or recolours.
  uint64_t structureVersion() const;
  std::vector<OutlineRow> outline() const;
  /// The steps of the model being edited.
  std::vector<StepRow> steps() const;
  std::vector<StepRow> stepsOfSubmodel(const std::string& definition) const;
  std::vector<ItemRow> stepItems(size_t step) const;
  /// The pieces under an outline row, in the model being edited (none when it is outside it).
  std::vector<uint32_t> piecesOfRow(const std::string& outlineId) const;
  std::vector<uint32_t> piecesOfStep(size_t step) const;
  /// Selects every piece, not hidden, like one already selected in this way.
  void selectSimilar(Similar kind);
  /// The library's colours, by group then code, without 16 and 24 (main and edge colour).
  std::vector<ColorInfo> colors() const;
  /// Cheap: made once per version and selection change.
  Snapshot snapshot() const;

  /// This session's address, so a caller can check a Viewport was made against it.
  uintptr_t address() const { return reinterpret_cast<uintptr_t>(this); }

  struct Impl;
  Impl& impl() const { return *impl_; }
  /// The current document's state, kept alive by whoever holds it (a viewport, a planning run)
  /// after a reopen replaces it.
  std::shared_ptr<Impl> shared() const { return impl_; }

 private:
  friend void ::bmappRetainSession(Session*);
  friend void ::bmappReleaseSession(Session*);
  std::atomic<int> refs_{1};
  std::shared_ptr<Impl> impl_;
} SWIFT_SHARED_REFERENCE(bmappRetainSession, bmappReleaseSession);

}  // namespace bmapp
