#include "bmapp/viewport.h"

#import <QuartzCore/QuartzCore.h>
#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstring>
#include <deque>
#include <dispatch/dispatch.h>
#include <exception>
#include <map>
#include <mutex>
#include <numeric>
#include <optional>
#include <stdexcept>
#include "animation_authoring.h"
#include "animation_keys.h"
#include "camera_track.h"
#include "bm/jobs.h"
#include "bm/plan/timeline.h"
#include "bmf/director.h"
#include "bmr/camera.h"
#include "bmr/device.h"
#include "bmr/renderer.h"
#include "bmr/tolerances.h"
#include "bms/snap_events.h"
#include "bms/wav.h"
#include "engine.h"
#include "flight_bake_impl.h"
#include "incremental_plan.h"
#include "movie_logo.h"
#include "motion_audit_impl.h"
#include "movie_encoder.h"
#include "placement_worker.h"
#include "preview_arrangement.h"
#include "commands.h"
#include "session_impl.h"
#include "snap_mix_impl.h"

namespace bmapp {

namespace {
constexpr double kPi = 3.14159265358979323846;

bmr::OrbitCamera orbitFor(const SceneCamera& camera) {
  bmr::OrbitCamera orbit;
  orbit.target = {camera.target.x, camera.target.y, camera.target.z};
  const auto delta = bm::Vec3{camera.position.x, camera.position.y, camera.position.z} - orbit.target;
  orbit.distance = bm::length(delta);
  orbit.azimuth = std::atan2(-delta.x, -delta.z);
  orbit.elevation = std::atan2(-delta.y, std::hypot(delta.x, delta.z));
  orbit.fovY = camera.fieldOfView * kPi / 180;
  return orbit;
}

/// One planning run. It plans its own copy of the model, so edits made meanwhile cannot reach
/// it; the viewport takes its result only while that result still belongs to what is shown.
struct PlanJob {
  uint64_t version = 0;  ///< the session's version whose model is planned
  uint64_t inputs = 0;
  uint64_t topology = 0;
  bm::CancelToken cancel;
  std::atomic<PlanStage> stage{PlanStage::Waiting};
  std::mutex mutex;
  bool done = false;
  std::shared_ptr<const bmtools::Planned> planned;
  std::shared_ptr<const bm::Model> model;
  bm::plan::Timeline authoredTimeline;
  BuildTimeline presentation;
  std::string error;
};

struct DirectorJob {
  uint64_t version = 0;
  std::mutex mutex;
  bool done = false;
  std::vector<bm::plan::CameraKey> camera;
  std::vector<double> lenses;
};

struct PlanWorkspace {
  struct Snapshot {
    uint64_t topology;
    std::shared_ptr<const bm::Model> model;
    std::shared_ptr<const bmtools::Planned> result;
  };
  std::optional<bmtools::ConnectorSources> connectors;
  bm::collide::ShapeCache shapes;
  bm::collide::TravelCache travels;
  bm::plan::FlightCheckCache flightChecks;
  std::deque<Snapshot> solves;
};

bool sameAssemblyPose(const bm::Model& a, const bm::Model& b) {
  if (a.pieces().size() != b.pieces().size()) return false;
  return std::equal(a.pieces().begin(), a.pieces().end(), b.pieces().begin(), [](const auto& old, const auto& current) {
    return old.id == current.id && old.part == current.part && old.color == current.color &&
        old.step == current.step && old.steps == current.steps && old.path == current.path &&
        old.world.t == current.world.t &&
        std::equal(std::begin(old.world.r.m), std::end(old.world.r.m), std::begin(current.world.r.m));
  });
}

std::pair<double, double> addSequenceClips(bm::plan::Timeline& timeline, const bm::plan::Style& style) {
  // The web's clock (pacing.ts choosePacing), which the planner paces the build for too: an intro
  // of 1 s and an outro of 3 s with the hero orbit, else 0.5 s, each held within 0.2–120 s.
  const auto frames = [&](double seconds) { return static_cast<int>(std::lround(style.fps * std::clamp(seconds, 0.2, 120.0))); };
  const int intro = frames(style.introSeconds >= 0 ? style.introSeconds : 1.0);
  const int hero = frames(style.outroSeconds >= 0 ? style.outroSeconds : style.heroOrbit ? 3.0 : 0.5);
  if (timeline.flights.empty()) return {};
  for (auto& flight : timeline.flights) {
    flight.startFrame += intro;
    if (flight.appearFrame > 0 || !bm::plan::flown(flight.flag)) flight.appearFrame += intro;
  }
  const int buildEnd = timeline.frames + intro;
  timeline.frames = buildEnd + hero;
  if (!timeline.camera.empty()) {
    for (auto& key : timeline.camera) key.frame += intro;
    if (intro > 0) {
      auto first = timeline.camera.front();
      first.frame = 0;
      timeline.camera.insert(timeline.camera.begin(), first);
    }
    auto last = timeline.camera.back();
    last.frame = buildEnd;
    if (last.frame > timeline.camera.back().frame) timeline.camera.push_back(last);
    if (hero > 0) {
      last.frame += hero;
      if (style.heroOrbit) last.azimuth += 0.7;
      timeline.camera.push_back(last);
    }
  }
  return {intro / style.fps, buildEnd / style.fps};
}

BuildTimeline describe(const bm::Model& model, const bm::plan::Plan& plan, const bm::plan::Timeline& timeline, double fps, uint64_t version,
                       std::pair<double, double> build) {
  BuildTimeline out;
  out.version = version;
  out.framesPerSecond = fps;
  out.duration = timeline.frames / fps;
  out.buildStart = build.first;
  out.buildEnd = build.second;
  out.planningMilliseconds = plan.planMs;
  out.notes = plan.notes;
  const auto owners = bm::plan::owners(timeline, plan, model.pieces().size());
  std::vector<bool> independent(model.pieces().size());
  for (const auto& move : plan.moves)
    if (move.unit.pieces.size() == 1 && !move.authoredFlight && move.unit.pieces.front() < independent.size())
      independent[move.unit.pieces.front()] = true;
  for (uint32_t piece = 0; piece < owners.size(); ++piece) {
    if (owners[piece] < 0) continue;
    const auto& flight = timeline.flights[owners[piece]];
    const auto& item = model.pieces()[piece];
    BuildFlightRow row;
    row.piece = piece;
    row.step = item.step;
    row.depth = flight.depth;
    row.color = item.color;
    row.start = flight.startFrame / fps;
    row.end = (flight.startFrame + flight.frames) / fps;
    row.name = item.part;
    row.independent = independent[piece];
    if (flight.flag != bm::plan::Flag::None) {
      row.flag = bm::plan::name(flight.flag);
      if (flight.depth == 0 && flight.move < plan.moves.size()) {
        const auto blocker = plan.moves[flight.move].blocker;
        if (blocker < model.pieces().size()) row.blocker = model.pieces()[blocker].part;
      }
    }
    out.flights.push_back(std::move(row));
  }
  std::stable_sort(out.flights.begin(), out.flights.end(),
                   [](const BuildFlightRow& a, const BuildFlightRow& b) { return a.start < b.start; });
  std::vector<int> firstChild(timeline.flights.size(), INT_MAX);
  for (const auto& flight : timeline.flights) {
    int parent = flight.parent;
    while (parent >= 0) {
      firstChild[parent] = std::min(firstChild[parent], flight.startFrame);
      parent = timeline.flights[parent].parent;
    }
  }
  for (size_t index = 0; index < timeline.flights.size(); ++index) {
    const auto& flight = timeline.flights[index];
    if (firstChild[index] >= flight.startFrame) continue;
    const auto& pieces = bm::plan::piecesOf(flight, plan);
    if (pieces.empty()) continue;
    const auto& path = model.pieces()[pieces.front()].path;
    if (path.size() <= static_cast<size_t>(flight.depth)) continue;
    out.submodels.push_back({static_cast<int>(index), flight.depth, firstChild[index] / fps, flight.startFrame / fps,
                            (flight.startFrame + flight.frames) / fps,
                            {path.begin(), path.begin() + flight.depth + 1}, pieces});
  }
  return out;
}

double toLinear(double c) { return c <= 0.04045 ? c / 12.92 : std::pow((c + 0.055) / 1.055, 2.4); }
}  // namespace

struct Viewport::Impl {
  Session* session = nullptr;
  /// The session's state the renderer was made from: kept alive (model, caches) until the
  /// renderer is replaced, even when the session reopens.
  std::shared_ptr<Session::Impl> pinned;
  uint64_t generation = 0;
  bool owned = false;  ///< made by create(): holds a reference to the session
  bool ok = false;
  std::unique_ptr<bmr::Renderer> renderer;
  bmr::OrbitCamera orbit;
  std::optional<bmr::OrbitCamera> editorOrbit;
  bmr::FrameOptions options;
  /// The project's look, what the editor lets the viewport leave out, and the editor's own
  /// backdrop (a project without a scene). `options` is made from them (applyLook).
  RenderLook look;
  ViewportPreferences preferences;
  float editorBackground[3] = {1, 1, 1};
  uint64_t lookSeen = UINT64_MAX;
  int width = 0, height = 0;
  double scale = 2;
  bool dirty = true;
  bool framed = false;  ///< the first resize frames the model
  bool orthographic = false;
  double fittedDistance = 400;
  double interactionEnds = 0;

  std::shared_ptr<PlanJob> job;
  std::shared_ptr<PlanWorkspace> planWorkspace = std::make_shared<PlanWorkspace>();
  std::shared_ptr<DirectorJob> directorJob;
  std::optional<bm::plan::Timeline> directedCamera;
  std::vector<double> directedLenses;
  /// The project's Camera track and what its keys look at, for the plan, timeline, track and
  /// view shape they were read for. When it has keys it films the Build in place of the director.
  struct TrackState {
    const void* plan = nullptr;
    uint64_t version = 0, timeline = 0;
    double aspect = 0;
    bool keyframes = false;
    nlohmann::ordered_json track;
    std::optional<camtrack::Context> context;
  } trackState;
  uint64_t timelineRevision = 0;  ///< counts every authoredTimeline a plan brings
  bool trackOff = false;          ///< an export filming with another camera
  std::shared_ptr<const bmtools::Planned> planned;  ///< taken from the job on the main thread
  bm::plan::Timeline authoredTimeline;
  std::shared_ptr<const bmtools::Planned> previous;
  std::shared_ptr<const bm::Model> previousModel;
  uint64_t previousInputs = 0;
  uint64_t previousVersion = 0;
  BuildTimeline presentation;
  uint64_t plannedVersion = 0;               ///< the session's version it was planned from
  uint64_t seen = 0;                         ///< the session's version last drawn
  uint64_t seenSelection = 0, seenHidden = 0;  ///< the session's view state last sent to the renderer
  std::string planError;
  bool playing = false, wantPlay = false, userMoved = false;
  bool autoPlan = false, previewRequested = false, refreshPlan = false, stalePlan = false, standardPreview = false;
  bool director = false, loop = false;
  bool keyframes = false, arranged = false;
  KeyScene keyScene;
  std::vector<KeyTrack> keyTracks;
  std::vector<int> owners;
  double playbackRate = 1, rangeStart = 0, rangeEnd = 0;
  std::optional<double> restoreTime;
  double frame = -1;  ///< -1 until planned: the model is shown finished
  double playStartTime = 0, playStartFrame = 0;

  PlacementWorker placementWorker;
  std::shared_ptr<const PlacementWorker::ModelRevision> placementScene;
  std::shared_ptr<const PlacementWorker::Move> placementMove;
  std::optional<ConnectorSite> placementSite;
  PlacementInput placementInput;
  PlacementPreview placement;
  uint64_t placementSent = 0, acceptPlacementSince = 0;
  bool placementPending = false;
  bool placementShowsMove = false;

  bm::Model* model() const { return session->impl().model.get(); }
  double aspect() const { return height > 0 ? double(width) / height : 1.0; }
  bmr::Camera camera(const bm::Box& bounds) const {
    auto out = orbit.camera(aspect(), bounds);
    if (orthographic) out.orthoHalfHeight = orbit.distance * std::tan(orbit.fovY * 0.5);
    if (const auto* shot = onTrackShot()) out.up = camtrack::upLdu(*shot);
    return out;
  }
  /// A waiting piece being dragged on the floor: its flight, the shift it had, where the drag
  /// took hold (LDU) in the level plane through it, and how far it has gone.
  struct WaitingDrag {
    size_t flight = 0;
    bm::Vec3 base, from, delta;
  };
  std::optional<WaitingDrag> waitingDrag;
  /// Where the pointer (points, top left) meets the level plane at `level` (LDU, y down), if it does.
  std::optional<bm::Vec3> onLevel(double x, double y, double level) const {
    if (!renderer || width <= 0 || height <= 0) return std::nullopt;
    const bmr::Camera view = camera(renderer->scene().bounds);
    const bmr::ScreenRay ray = bmr::screenRay(view, 2 * x * scale / width - 1, 1 - 2 * y * scale / height);
    if (std::abs(ray.dir.y) < 1e-9) return std::nullopt;
    const double t = (level - ray.from.y) / ray.dir.y;
    if (!(t > 0) || !std::isfinite(t)) return std::nullopt;
    return ray.from + ray.dir * t;
  }
  /// Shows the frame again as it stands (after a timeline edit laid on in place).
  void reshow() {
    const double at = frame;
    frame = -1;
    if (at >= 0) showFrame(at);
  }

  /// The Camera track's last shot, while the camera still stands where it put it: its roll and
  /// lens apply only then (an orbit or a director's frame since leaves them behind).
  struct TrackLens {
    bmr::OrbitCamera orbit;
    camtrack::Shot shot;
  };
  std::optional<TrackLens> trackLens;
  const camtrack::Shot* onTrackShot() const {
    if (!trackLens || orthographic) return nullptr;
    const auto& a = trackLens->orbit;
    const bool same = a.target.x == orbit.target.x && a.target.y == orbit.target.y && a.target.z == orbit.target.z &&
                      a.distance == orbit.distance && a.azimuth == orbit.azimuth && a.elevation == orbit.elevation && a.fovY == orbit.fovY;
    return same ? &trackLens->shot : nullptr;
  }
  /// `base` with the track shot's depth of field, seen through `camera` (context.ts shotLens).
  bmr::FrameOptions withLens(bmr::FrameOptions base, const bmr::Camera& camera) const {
    const auto* shot = onTrackShot();
    if (!shot || shot->blur <= 0 || !renderer || renderer->scene().bounds.empty()) return base;
    base.lensBlur = camtrack::lensBlurShare(*shot);
    base.focusDistance = camtrack::focusDistance(camera.eye, camera.target, renderer->scene().bounds, shot->focus, camera.near);
    return base;
  }
  double fps() const { return presentation.framesPerSecond; }
  double endFrame() const {
    if (keyframes) return (keyScene.last - keyScene.first) * fps() / keyScene.fps;
    return planned ? authoredTimeline.frames : 0;
  }
  bool canShowTime() const { return planned || (keyframes && !keyScene.buildLinked); }

  void readKeys() {
    keyScene = readKeyScene(session->impl());
    keyTracks = readKeyTracks(session->impl());
  }

  void moved() {
    dirty = true;
    interactionEnds = CACurrentMediaTime() + 0.11;
    if (playing) userMoved = true;
  }

  void clearPlacement() {
    if (placement.state == PlacementState::Inactive) return;
    placementPending = false;
    placement = {};
    placementSite.reset();
    placementMove.reset();
    if (placementShowsMove) seenHidden = UINT64_MAX;
    placementShowsMove = false;
    acceptPlacementSince = ++placementSent;
    placementWorker.clearPending();
    if (renderer) renderer->clearPlacementPreview();
    dirty = true;
  }

  void collectPlacement() {
    const auto reply = placementWorker.take();
    if (!reply || placement.state == PlacementState::Inactive || reply->preview.request < acceptPlacementSince) return;
    placement = reply->preview;
    placementSite = reply->site;
    placementPending = placement.request != placementSent;
    using enum PlacementState;
    if (placement.state == Free || placement.state == Snapped || placement.state == Reference || placement.state == Blocked) {
      const PartPose& p = placement.pose;
      bm::Xform pose;
      std::copy_n(p.rotation.m, 9, pose.r.m);
      pose.t = {p.position.x, p.position.y, p.position.z};
      std::vector<bmr::PlacementGhost> ghosts;
      if (placementMove) {
        const auto& pieces = model()->pieces();
        const bm::Xform delta = pose * pieces[placementInput.anchor].world.inverse();
        const auto& hidden = session->impl().hidden;
        ghosts.reserve(placementMove->pieces.size());
        for (const auto& movement : placementMove->pieces) {
          if (std::binary_search(hidden.begin(), hidden.end(), movement.piece)) continue;
          const auto& piece = pieces[movement.piece];
          ghosts.push_back({piece.part, piece.color, movement.apply(delta, piece.world)});
        }
        if (!placementShowsMove) {
          placementShowsMove = true;
          seenHidden = UINT64_MAX;
          syncView();
        }
      } else {
        ghosts.push_back({placementInput.part, placementInput.color, pose});
      }
      renderer->setPlacementPreview(ghosts, placement.state == Blocked);
    } else {
      renderer->clearPlacementPreview();
    }
    dirty = true;
  }

  /// Sends the session's selection and hiding to the renderer when they have changed.
  void syncView() {
    const Session::Impl& s = session->impl();
    if (seenHidden != s.hiddenStamp) {
      seenHidden = s.hiddenStamp;
      if (placementShowsMove && placementMove) {
        auto hidden = s.hidden;
        hidden.insert(hidden.end(), placementMove->indices.begin(), placementMove->indices.end());
        renderer->setHidden(hidden);
      } else {
        renderer->setHidden(s.hidden);
      }
      dirty = true;
    }
    if (seenSelection != s.selectionStamp) {
      seenSelection = s.selectionStamp;
      renderer->select(s.selection);
      dirty = true;
    }
  }

  /// The document was edited: the renderer catches up with the edits it has not drawn, and a
  /// plan of the old model, finished or not, is dropped.
  /// The session opened another document (Revert, a version, a reload): start again on it.
  void reopen() {
    clearPlacement();
    placementScene.reset();
    if (job) {
      job->cancel.cancel();
      job.reset();
    }
    planned.reset();
    previous.reset();
    previousModel.reset();
    planWorkspace = std::make_shared<PlanWorkspace>();
    directorJob.reset();
    directedCamera.reset();
    directedLenses.clear();
    authoredTimeline = {};
    ++timelineRevision;
    owners.clear();
    if (keyframes) readKeys();
    plannedVersion = 0;
    presentation = {};
    renderer.reset();  // before the state it was made from goes
    lookSeen = UINT64_MAX;
    pinned = session->shared();
    generation = pinned->generation;
    ok = false;
    if (pinned->model && bmr::gpuAvailable())
      renderer = bmr::Renderer::create(*pinned->model, *pinned->full, *pinned->low, roundingOf(renderLookOf(session->impl())));
    ok = renderer != nullptr;
    if (ok && width > 0 && height > 0) renderer->resize(width, height);
    seen = session->version();
    interactionEnds = 0;
    seenSelection = seenHidden = UINT64_MAX;
    frame = -1;
    editorOrbit.reset();
    arranged = false;
    playing = wantPlay = false;
    previewRequested = refreshPlan = stalePlan = standardPreview = false;
    restoreTime.reset();
    planError.clear();
    dirty = true;
  }

  static bmr::Rounding roundingOf(const RenderLook& look) {
    return {look.smoothCurves, look.roundedEdges, look.softStudRoots};
  }

  void applyLook() {
    look = renderLookOf(session->impl());
    lookSeen = session->version();
    if (renderer) renderer->setRounding(roundingOf(look));  // a no-op unless it changed
    options.edges = look.edges && preferences.edges;
    options.floor = look.floor && preferences.floor;
    options.shadows = look.shadows && preferences.shadows;
    options.ambientOcclusion = look.ambientOcclusion && preferences.ambientOcclusion;
    options.refractiveGlass = look.raytracedGlass;
    options.studioLook = look.shading == Shading::Studio;
    options.neuralShader = look.shading == Shading::Neural;
    options.hybridRt = look.shading == Shading::HybridRT;
    options.screenSpaceGi = look.shading == Shading::ScreenSpaceGI;
    options.pathTraced = look.shading == Shading::PathTraced;
    options.realtimePathTrace = look.shading == Shading::RealTimePathTraced;
    options.pathMaxSamples = look.pathSamples;
    options.worldGiOcclusion = look.worldGiOcclusion;
    options.lightsFollowCamera = look.lightsFollowCamera;
    const ScenePreset* scene = preferences.sceneBackdrop ? scenePreset(look.scene) : nullptr;
    for (int i = 0; i < 3; ++i) {
      const double srgb = scene ? (&scene->background.x)[i] : -1;
      options.background[i] = scene ? static_cast<float>(toLinear(srgb)) : editorBackground[i];
    }
    dirty = true;
  }

  void follow() {
    if (session->impl().generation != generation) reopen();
    if (!renderer) return;
    const uint64_t now = session->version();
    if (now != lookSeen) applyLook();
    if (now != seen) {
      const auto& log = session->impl().changes;
      const bool presentationOnly = !log.empty() && log.front().version <= seen + 1 && log.back().version == now &&
          std::all_of(log.begin(), log.end(), [&](const Changed& change) {
            return change.version <= seen || change.keyframesOnly || change.sceneOnly;
          });
      if (presentationOnly && (planned || !job)) {
        const bool handKeys = std::any_of(log.begin(), log.end(), [&](const Changed& change) {
          return change.version > seen && change.keyframesOnly;
        });
        const bool trackEdited = std::any_of(log.begin(), log.end(), [&](const Changed& change) {
          return change.version > seen && change.cameraTrack;
        });
        const bool spotsMoved = std::any_of(log.begin(), log.end(), [&](const Changed& change) {
          return change.version > seen && change.waitingSpot;
        });
        seen = now;
        if (planned) plannedVersion = presentation.version = now;
        if (handKeys && keyframes) readKeys();
        // a dragged waiting spot is laid on the plan as it stands (a drag never replans)
        if (spotsMoved && planned) {
          shiftWaitingParts(planned->plan, authoredTimeline, animationAuthoring(*session).waitingShifts, model()->pieces().size());
          ++timelineRevision;
        }
        // shown again: hand keys and dragged spots move pieces; an edited Camera track aims the
        // camera anew (its roll and lens with it) where the director is following it
        if ((handKeys && keyframes) || (spotsMoved && planned) || (trackEdited && director && !userMoved)) reshow();
        syncView();
        return;
      }
      if (keyframes) readKeys();
      stalePlan = stalePlan || planned || job;
      if (planned && frame >= 0 && frame < authoredTimeline.frames) restoreTime = frame / fps();
      clearPlacement();
      placementScene.reset();
      if (job) {
        job->cancel.cancel();  // the planning block holds its own reference
      }
      directorJob.reset();
      directedCamera.reset();
      directedLenses.clear();
      const bool wasPreviewing = planned || arranged || (keyframes && frame >= 0);
      planned.reset();
      arranged = false;
      catchUp(now);
      if (wasPreviewing) renderer->setRest();
      seen = now;
      frame = -1;
      playing = wantPlay = false;
      refreshPlan = autoPlan && previewRequested && model() && !model()->pieces().empty();
      planError.clear();
      dirty = true;
    }
    syncView();
  }

  /// Applies the edits after `seen`: in place when none changed the structure and all are still
  /// in the session's log, else by building the scene again.
  void catchUp(uint64_t now) {
    if (!renderer) return;
    const std::deque<Changed>& log = session->impl().changes;
    bool rebuild = log.empty() || log.front().version > seen + 1 || log.back().version != now;
    std::vector<uint32_t> moved, recolored;
    for (const Changed& c : log) {
      if (c.version <= seen) continue;
      if (c.structure) rebuild = true;
      moved.insert(moved.end(), c.moved.begin(), c.moved.end());
      recolored.insert(recolored.end(), c.recolored.begin(), c.recolored.end());
    }
    if (rebuild) {
      interactionEnds = CACurrentMediaTime() + 0.11;
      if (now == seen + 1 && !log.empty() && !log.back().removed.empty())
        renderer->modelDeleted(*model(), log.back().removed);
      else
        renderer->modelChanged(*model());
      seenSelection = seenHidden = UINT64_MAX;  // pieces may have new indexes: send both again
      return;
    }
    auto tidy = [](std::vector<uint32_t>& v) {
      std::sort(v.begin(), v.end());
      v.erase(std::unique(v.begin(), v.end()), v.end());
    };
    tidy(moved), tidy(recolored);
    if (!moved.empty() || !recolored.empty()) interactionEnds = CACurrentMediaTime() + 0.11;
    if (!moved.empty()) renderer->modelChanged(*model(), &moved);
    if (!recolored.empty()) renderer->recolored(recolored);
  }

  /// A point's place in the picture, in points from the top left; false when it is behind the eye.
  bool project(const bmr::Mat4& viewProj, bm::Vec3 p, double& x, double& y) const {
    float clip[4];
    bmr::transform(viewProj, p, clip);
    if (clip[3] <= 1e-6f) return false;
    x = (clip[0] / clip[3] + 1) / 2 * width / scale;
    y = (1 - clip[1] / clip[3]) / 2 * height / scale;
    return true;
  }

  uint32_t singleMoved(const Session::Impl& s) const {
    if (!previousModel || s.changes.empty() || s.changes.front().version > previousVersion + 1 ||
        s.changes.back().version != s.version) return UINT32_MAX;
    uint32_t only = UINT32_MAX;
    size_t placements = 0;
    for (const auto& change : s.changes) {
      if (change.version <= previousVersion) continue;
      if (change.structure) return UINT32_MAX;
      if (!change.moved.empty()) ++placements;
      for (uint32_t candidate : change.moved) {
        if (only != UINT32_MAX && only != candidate) return UINT32_MAX;
        only = candidate;
      }
    }
    return s.planInputs == previousInputs + placements ? only : UINT32_MAX;
  }

  void startPlanning(bool synchronous = false) {
    follow();
    if (job || planned || !model() || model()->pieces().empty()) return;
    planError.clear();
    auto j = std::make_shared<PlanJob>();
    j->version = session->version();
    job = j;
    auto copy = std::make_shared<bm::Model>(*model());
    j->model = copy;
    Session::Impl& s = session->impl();
    j->inputs = s.planInputs;
    j->topology = s.planTopology;
    const auto authored = std::make_shared<const AnimationAuthoring>(animationAuthoring(*session));
    const std::shared_ptr<const bmtools::Planned> cached = previousInputs == j->inputs ? previous : nullptr;
    const uint32_t moved = cached ? UINT32_MAX : singleMoved(s);
    const std::shared_ptr<const bmtools::Planned> rewind = moved == UINT32_MAX ? nullptr : previous;
    const std::shared_ptr<const bm::Model> earlier = moved == UINT32_MAX ? nullptr : previousModel;
    const bm::ldraw::Library* library = s.library.get();
    bm::ldraw::PartCache* full = s.full.get();
    const std::filesystem::path ldraw = s.ldraw;
    const auto workspace = planWorkspace;
    // The project's planner, or the editor's Standard Preview when the native plan failed.
    const bool useStandard = standardPreview || animationAuthoring(*session).style.planner == bm::plan::Planner::Legacy;
    std::shared_ptr<Session::Impl> keep = session->shared();  // the library and caches it reads
    void (^makePlan)() = ^{
      (void)keep;
      auto planned = cached;
      bm::plan::Timeline timeline;
      BuildTimeline presentation;
      std::string error;
      try {
        const auto start = std::chrono::steady_clock::now();
        const auto priorFlightChecks = workspace->flightChecks.hits();
        bm::plan::Options options;
        options.cancel = &j->cancel;
        options.travelCache = &workspace->travels;
        options.authored = &authored->constraints;
        options.order = authored->order;
        options.cleanGrownUnits = authored->cleanGrownUnits;
        auto style = authored->style;
        if (useStandard) style.planner = bm::plan::Planner::Legacy;
        j->stage.store(useStandard ? PlanStage::StandardPreview : PlanStage::Solving, std::memory_order_relaxed);
        // Pointer nudges and undo frequently return to a recently validated pose. Keep a
        // few exact matches, scoped to one definition and one set of assembly constraints.
        auto& recent = workspace->solves;
        std::erase_if(recent, [&](const auto& snapshot) { return snapshot.topology != j->topology; });
        bool reusedSnapshot = false;
        if (!planned) {
          const auto found = std::find_if(recent.begin(), recent.end(), [&](const auto& snapshot) {
            return sameAssemblyPose(*snapshot.model, *copy);
          });
          if (found != recent.end()) {
            planned = found->result;
            recent.erase(found);
            reusedSnapshot = true;
          }
        }
        size_t reused = planned ? planned->plan.moves.size() : 0;
        if (!planned && !workspace->connectors) workspace->connectors.emplace(*library, ldraw);
        // The local repair re-runs the take-apart sequencer around one piece; other settings plan whole.
        const bool repairable = options.order == bm::plan::Order::Reverse && !options.cleanGrownUnits;
        if (!useStandard && !planned && rewind && earlier && repairable) {
          if (auto local = replanMove(*earlier, *copy, moved, *rewind, *full, *workspace->connectors,
                                      workspace->shapes, style, options, workspace->flightChecks)) {
            reused = local->reused;
            planned = std::make_shared<bmtools::Planned>(std::move(local->planned));
          }
        }
        if (!planned && !j->cancel.cancelled()) {
          auto result = std::make_shared<bmtools::Planned>();
          auto& sources = *workspace->connectors;
          if (useStandard) {
            result->graph = bm::connect::buildGraph(*copy, sources.connectors, &sources.gears);
          } else {
            result->plan = bm::plan::planModel(*copy, result->graph, sources.connectors, &sources.gears, *full, workspace->shapes, options);
            j->stage.store(PlanStage::CheckingFlights, std::memory_order_relaxed);
          }
          if (!j->cancel.cancelled()) {
            auto* connectors = useStandard ? &sources.connectors : nullptr;
            result->timeline = bm::plan::buildTimeline(*copy, *full, result->plan, style, options.down,
                                                       connectors, &result->graph, &workspace->shapes, &j->cancel,
                                                       &workspace->flightChecks, options.travelCache);
          }
          planned = std::move(result);
        }
        if (!j->cancel.cancelled()) {
          if (!planned || planned->timeline.flights.empty()) throw std::runtime_error("No playable flights were generated for this model.");
          j->stage.store(PlanStage::Preparing, std::memory_order_relaxed);
          if (planned->plan.complete && copy->pieces().size() <= 2000 &&
              std::none_of(recent.begin(), recent.end(), [&](const auto& snapshot) { return snapshot.result == planned; })) {
            recent.push_front({j->topology, copy, planned});
            if (recent.size() > 3) recent.pop_back();
          }
          timeline = planned->timeline;
          retimeAnimation(*copy, planned->plan, timeline, *authored);
          std::vector<std::string> waitingNotes;
          orientWaitingParts(*copy, planned->plan, timeline, *authored, *full, workspace->shapes, waitingNotes, j->cancel);
          swingStaging(*copy, timeline, authored->stagingTurn);
          shiftWaitingParts(planned->plan, timeline, authored->waitingShifts, copy->pieces().size());
          const auto build = addSequenceClips(timeline, style);
          presentation = describe(*copy, planned->plan, timeline, style.fps, j->version, build);
          presentation.notes.insert(presentation.notes.end(), waitingNotes.begin(), waitingNotes.end());
          presentation.planningMilliseconds = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - start).count();
          presentation.reusedMoves = reused;
          presentation.reusedFlightChecks = workspace->flightChecks.hits() - priorFlightChecks;
          presentation.reusedSnapshot = reusedSnapshot;
          presentation.standardPreview = useStandard;
          if (useStandard) presentation.notes.emplace_back("Standard Preview follows authored step order. Its flights require manual collision review.");
        }
      } catch (const std::exception& e) {
        planned.reset();
        error = e.what();
      }
      std::lock_guard lock(j->mutex);
      j->planned = std::move(planned);
      j->authoredTimeline = std::move(timeline);
      j->presentation = std::move(presentation);
      j->error = error;
      j->done = true;
    };
    if (synchronous) makePlan();
    else dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), makePlan);
  }

  /// On the main thread, before a frame: takes a finished plan.
  void collectPlan(bool synchronousDirector = false) {
    if (!job) return;
    const auto inFlight = job;
    std::lock_guard lock(inFlight->mutex);
    if (!job->done) return;
    if (job->cancel.cancelled()) {
      job.reset();
      return;
    }
    if (job->version != session->version()) {  // planned from a model since edited
      job.reset();
      return;
    }
    if (job->planned) {
      planned = std::move(job->planned);
      authoredTimeline = std::move(job->authoredTimeline);
      ++timelineRevision;
      owners = bm::plan::owners(authoredTimeline, planned->plan, model()->pieces().size());
      previous = planned;
      previousModel = job->model;
      previousInputs = job->inputs;
      previousVersion = job->version;
      plannedVersion = job->version;
      presentation = std::move(job->presentation);
      stalePlan = false;
      frame = -1;
      if (!wantPlay && restoreTime) showFrame(*restoreTime * fps());
      requestDirector(synchronousDirector);
    } else {
      planError = job->error.empty() ? "Planning stopped." : job->error;
      wantPlay = false;
    }
    restoreTime.reset();
    job.reset();
    if (planned && wantPlay) startPlaying();
    dirty = true;
  }

  void requestDirector(bool synchronous = false) {
    if (!director || !planned || directorJob || directedCamera || !previousModel) return;
    auto work = std::make_shared<DirectorJob>();
    work->version = previousVersion;
    directorJob = work;
    const auto plan = planned;
    const auto geometry = previousModel;
    const auto backing = pinned;
    const auto timeline = std::make_shared<const bm::plan::Timeline>(authoredTimeline);
    const double projection = aspect(), rate = fps();
    void (^makeTrack)() = ^{
      std::vector<bm::plan::CameraKey> camera;
      std::vector<double> lenses;
      try {
        bm::collide::ShapeCache shapes;
        const bm::collide::World world(*geometry, *backing->full, shapes);
        const auto beats = bm::film::beatsOf(*timeline, plan->plan, *geometry, world);
        const auto shots = bm::film::direct(beats, *timeline, plan->plan, world, bm::film::referenceStyle(), rate);
        bm::film::FrameShape shape;
        shape.aspect = projection;
        const auto track = bm::film::shoot(shots, beats, *timeline, plan->plan, world, shape, rate);
        bm::plan::Timeline keys;
        bmtools::keysFromTrack(track, keys);
        camera = std::move(keys.camera);
        lenses.reserve(track.frames.size());
        for (const auto& shot : track.frames) lenses.push_back(shot.fovY);
      } catch (const std::exception&) {
        // The base build remains playable if a director view cannot be generated.
      }
      std::lock_guard lock(work->mutex);
      work->camera = std::move(camera);
      work->lenses = std::move(lenses);
      work->done = true;
    };
    if (synchronous) makeTrack();
    else dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), makeTrack);
  }

  void collectDirector() {
    const auto current = directorJob;
    if (!current) return;
    std::lock_guard lock(current->mutex);
    if (!current->done) return;
    directorJob.reset();
    if (current->version != previousVersion) return;
    directedCamera.emplace();
    directedCamera->camera = std::move(current->camera);
    directedLenses = std::move(current->lenses);
    if (director && !userMoved && !directedCamera->camera.empty()) {
      cameraAt(std::max(0.0, frame));
      dirty = true;
    }
  }

  /// Each piece's box at rest (LDU), by piece.
  std::vector<bm::Box> restBoxes() const {
    const auto& scene = renderer->scene();
    std::vector<bm::Box> boxes(model()->pieces().size());
    for (size_t piece = 0; piece < boxes.size() && piece < scene.where.size(); ++piece) {
      const auto [group, index] = scene.where[piece];
      if (group < scene.groups.size() && index < scene.groups[group].restBoxes.size())
        boxes[piece] = scene.groups[group].restBoxes[index];
    }
    return boxes;
  }

  /// Every flight's landing on the Build clock, grouped into the main model (first) and each unit
  /// built on its own spot (holding the flights with it as parent; a unit flying in lands on its
  /// parent's group), and the model at rest. LDU; empty until planned.
  struct Landings {
    std::vector<std::vector<camtrack::Landing>> groups;
    bm::Box model;
  };
  Landings buildLandings() const {
    Landings out;
    if (!planned || !renderer || !model()) return out;
    const auto boxes = restBoxes();
    const auto& flights = authoredTimeline.flights;
    std::map<int, size_t> groupOf{{-1, 0}};
    out.groups.resize(1);
    for (const auto& flight : flights)
      if (flight.parent >= 0 && groupOf.emplace(flight.parent, out.groups.size()).second) out.groups.emplace_back();
    const double rate = fps();
    for (size_t i = 0; i < flights.size(); ++i) {
      const auto& flight = flights[i];
      bm::Box rest;
      for (uint32_t p : bm::plan::piecesOf(flight, planned->plan))
        if (p < boxes.size()) rest.merge(boxes[p]);
      if (rest.empty()) continue;
      if (flight.parent < 0) out.model.merge(rest);
      const int end = flight.startFrame + flight.frames;
      // where it lands: on its seat, or on its unit's spot while that still waits on the floor
      const bm::Box landed = rest.transformed(bm::plan::motionAt(authoredTimeline, i, static_cast<double>(end)));
      out.groups[groupOf[flight.parent]].push_back({flight.startFrame / rate, end / rate, landed});
    }
    return out;
  }

  /// What the Camera track's keys look at (camtrack::buildContext): the main model and each unit
  /// built on its own spot, with where and when every flight lands. On the Keyframes clock, a
  /// linked Build is followed on its own clock (its start frame and speed), as the web's
  /// timelineCameraContext; without one every key frames the model.
  camtrack::Context trackContext() const {
    camtrack::Context context;
    context.aspect = aspect();
    if (!renderer || !model()) return context;
    const bool build = planned && (!keyframes || keyScene.buildLinked);
    if (build) {
      auto landings = buildLandings();
      std::vector<camtrack::Assembly> groups;
      for (auto& lands : landings.groups) {
        auto& group = groups.emplace_back();
        for (auto& land : lands) group.lands.push_back({land.start, land.end, camtrack::toWeb(land.box)});
      }
      context = camtrack::buildContext(std::move(groups), camtrack::toWeb(landings.model), aspect());
    }
    if (!keyframes) return context;
    if (!build) {
      const bm::Box bounds = camtrack::toWeb(renderer->scene().bounds);
      context.model = bounds;
      context.build = [bounds](double) { return bounds; };
      context.piece = [](double) { return std::optional<bm::Box>{}; };
      return context;
    }
    const double first = keyScene.first, rate = std::max(1, keyScene.fps), start = keyScene.buildStart, speed = keyScene.buildSpeed;
    const auto toBuild = [=](double seconds) { return std::max(0.0, (first + seconds * rate - start) / rate * speed); };
    context.build = [inner = context.build, toBuild](double t) { return inner(toBuild(t)); };
    context.piece = [inner = context.piece, toBuild](double t) { return inner(toBuild(t)); };
    return context;
  }

  /// Reads the Camera track again when the session, plan, timeline, tab or view shape changed.
  void refreshTrack() {
    const void* plan = planned ? planned.get() : nullptr;
    auto& t = trackState;
    const uint64_t version = session->version();
    if (plan == t.plan && version == t.version && timelineRevision == t.timeline && aspect() == t.aspect &&
        keyframes == t.keyframes)
      return;
    const bool scene = keyframes || plan;
    auto track = scene ? cameraTrackOf(session->impl(), keyframes ? CameraClock::Timeline : CameraClock::Build)
                       : nlohmann::ordered_json{};
    // the keyframe scene (its build link) is part of the session: a new version may change it
    const bool sameScene = plan == t.plan && timelineRevision == t.timeline && aspect() == t.aspect &&
                           keyframes == t.keyframes && (!keyframes || version == t.version);
    t.plan = plan, t.version = version, t.timeline = timelineRevision, t.aspect = aspect(), t.keyframes = keyframes;
    if (sameScene && track == t.track) return;
    t.track = std::move(track);
    t.context.reset();
    if (scene && renderer && model() && !camtrack::keysOf(t.track).empty()) t.context = trackContext();
  }

  /// The Camera track of the clock shown is in charge.
  bool followsTrack() {
    if (trackOff) return false;
    refreshTrack();
    return trackState.context.has_value();
  }

  /// Points the camera as the track's shot at `seconds` of its video; false without a shot.
  bool trackShotAt(double seconds) {
    if (!followsTrack()) return false;
    // sampled at the exact time, so a hard cut stays a cut between frames
    const auto shot = camtrack::sample(trackState.track, std::max(0.0, seconds), *trackState.context);
    if (!shot) return false;
    const bm::Vec3 eye = camtrack::toLdu(shot->eye), target = camtrack::toLdu(shot->target), d = eye - target;
    orbit.target = target;
    orbit.distance = bm::length(d);
    orbit.azimuth = std::atan2(-d.x, -d.z);  // OrbitCamera::eye: azimuth 0 is the front, the eye on the -z side
    orbit.elevation = std::atan2(-d.y, std::hypot(d.x, d.z));
    orbit.fovY = shot->fovDegrees * kPi / 180;
    trackLens = TrackLens{orbit, *shot};
    return true;
  }

  /// The Build's camera at a frame of the Build: its Camera track, else the director's.
  void cameraAt(double buildFrame) {
    if (!keyframes && trackShotAt(buildFrame / fps())) return;
    const auto& cameraTrack = directedCamera && !directedCamera->camera.empty() ? *directedCamera : authoredTimeline;
    if (cameraTrack.camera.empty()) return;
    orbit = bmr::OrbitCamera::along(cameraTrack, buildFrame);
    if (!directedLenses.empty()) {
      const double f = std::clamp(buildFrame, 0.0, static_cast<double>(directedLenses.size() - 1));
      const size_t left = static_cast<size_t>(f), right = std::min(left + 1, directedLenses.size() - 1);
      orbit.fovY = std::lerp(directedLenses[left], directedLenses[right], f - left);
    }
  }

  void showFrame(double f) {
    if (!canShowTime()) return;
    f = std::clamp(f, 0.0, endFrame());
    if (f == frame) return;
    const bool enteringBuild = frame < 0 && !keyframes && !editorOrbit && !director;
    if (enteringBuild) editorOrbit = orbit;
    frame = f;
    arranged = false;
    double buildFrame = f;
    if (keyframes) {
      static const bm::plan::Plan emptyPlan;
      static const bm::plan::Timeline emptyTimeline;
      const double sceneFrame = keyScene.first + f * keyScene.fps / fps();
      buildFrame = std::clamp((sceneFrame - keyScene.buildStart) * keyScene.buildSpeed * fps() / keyScene.fps,
                              0.0, static_cast<double>(authoredTimeline.frames));
      const auto keyed = keyPoses(keyScene, keyTracks, renderer->scene(), *model(), authoredTimeline, owners, buildFrame, sceneFrame);
      if (keyScene.buildLinked && planned) renderer->setFrame(planned->plan, authoredTimeline, buildFrame, keyed);
      else renderer->setFrame(emptyPlan, emptyTimeline, 0, keyed);
    } else {
      renderer->setFrame(planned->plan, authoredTimeline, f);
    }
    if (enteringBuild && !renderer->visibleBounds().empty()) {
      orbit = bmr::OrbitCamera::fitted(renderer->visibleBounds(), orbit.fovY, aspect(), orbit.azimuth, orbit.elevation);
      fittedDistance = orbit.distance;
    }
    if (director && !userMoved) {
      // the Keyframes timeline's own track, on its clock; else the Build's camera
      if (!(keyframes && trackShotAt(f / fps())) && (!keyframes || keyScene.buildLinked)) cameraAt(buildFrame);
    }
    dirty = true;
  }

  void startPlaying() {
    if (!canShowTime()) return;
    playing = true, userMoved = false;
    const double end = rangeEnd > 0 ? std::min(rangeEnd * fps(), endFrame()) : endFrame();
    if (frame < rangeStart * fps() || frame >= end) showFrame(rangeStart * fps());
    playStartTime = CACurrentMediaTime(), playStartFrame = frame;
    dirty = true;
  }

  void advance() {
    const double end = rangeEnd > 0 ? std::min(rangeEnd * fps(), endFrame()) : endFrame();
    const double f = std::min(end, playStartFrame + (CACurrentMediaTime() - playStartTime) * fps() * playbackRate);
    showFrame(f);
    if (f < end) return;
    if (loop && end > rangeStart * fps()) {
      showFrame(rangeStart * fps());
      playStartTime = CACurrentMediaTime(), playStartFrame = frame;
    } else {
      playing = wantPlay = false;
    }
  }

  void fit(double azimuth, double elevation) {
    if (!renderer) return;
    const bm::Box box = renderer->visibleBounds();
    if (box.empty()) return;
    orbit = bmr::OrbitCamera::fitted(box, orbit.fovY, aspect(), azimuth, elevation);
    fittedDistance = orbit.distance;
    moved();
  }
};

Viewport* Viewport::create(Session* session) {
  auto* v = new Viewport(*session);
  ::bmappRetainSession(session);
  v->impl_->owned = true;
  return v;
}

void* Viewport::metalDevice() { return bmr::gpuAvailable() ? bmr::gpuDevice() : nullptr; }

Viewport::Viewport(Session& session) : impl_(std::make_unique<Impl>()) {
  Impl& v = *impl_;
  v.session = &session;
  v.reopen();
  // The shadow and height maps are drawn again over frames while the view turns or pieces move.
  v.options.mapTrianglesPerFrame = bmr::kMapTrianglesPerFrame;
}

Viewport::~Viewport() {
  if (impl_->job) impl_->job->cancel.cancel();
  impl_->renderer.reset();
  if (impl_->owned) ::bmappReleaseSession(impl_->session);
}

bool Viewport::ok() const { return impl_->ok; }
uintptr_t Viewport::sessionAddress() const { return reinterpret_cast<uintptr_t>(impl_->session); }

void Viewport::resize(int pixelsWide, int pixelsHigh, double backingScale) {
  Impl& v = *impl_;
  v.scale = backingScale > 0 ? backingScale : 1;
  if (pixelsWide == v.width && pixelsHigh == v.height) return;
  v.width = pixelsWide, v.height = pixelsHigh;
  if (!v.ok) return;
  v.renderer->resize(pixelsWide, pixelsHigh);
  if (!v.framed && pixelsWide > 0 && pixelsHigh > 0) {
    v.framed = true;
    v.fit(v.orbit.azimuth, v.orbit.elevation);
  }
  v.dirty = true;
}

bool Viewport::draw(void* metalDrawable) {
  bool submitted = false;
  return drawFrame(metalDrawable, submitted);
}

bool Viewport::drawFrame(void* metalDrawable, bool& submitted) {
  Impl& v = *impl_;
  if (v.session->impl().generation != v.generation) v.reopen();
  if (!v.ok) return false;
  v.follow();
  v.collectPlan();
  v.collectDirector();
  if ((v.refreshPlan || (v.wantPlay && !v.canShowTime())) && !v.job) {
    v.refreshPlan = false;
    v.startPlanning();
  }
  v.collectPlacement();
  if (v.playing && v.canShowTime()) v.advance();
  if (metalDrawable && !v.dirty && (v.placementPending || v.job || v.directorJob)) return true;
  const bool gesture = CACurrentMediaTime() < v.interactionEnds;
  const bool interactive = v.model()->pieces().size() >= 1500 && gesture;
  bmr::FrameOptions paint = v.options;
  paint.interactive = interactive;
  if (interactive && v.model()->pieces().size() >= 8000) {
    // Contact shading and glass transport return when the large model comes to rest.
    paint.shadows = paint.ambientOcclusion = false;
    paint.refractiveGlass = false;
  }
  // As bmview: glass transport and path tracing are drawn once the view is still.
  const bool still = !gesture && !v.playing && v.placement.state == PlacementState::Inactive;
  const bool held = (paint.refractiveGlass || paint.pathTraced) && !still;
  if (held) paint.refractiveGlass = paint.pathTraced = false;
  const bmr::Camera view = v.camera(v.renderer->visibleBounds());
  const bmr::FrameStats s = v.renderer->draw(view, v.withLens(paint, view), metalDrawable);
  submitted = s.submitted;
  const bool converging = (paint.pathTraced || paint.realtimePathTrace) &&
                          s.pathSamples < static_cast<uint32_t>(paint.pathMaxSamples);
  v.dirty = interactive || (held && gesture) || converging || v.playing || s.settling || (!s.submitted && v.width > 0 && v.height > 0);
  return v.dirty || v.placementPending || v.job || v.directorJob;
}

Picture Viewport::readback() {
  Picture p;
  if (!impl_->ok) return p;
  bmr::Image image = impl_->renderer->readback();
  if (image.empty()) return p;
  p.width = image.width, p.height = image.height;
  p.rgba = std::move(image.rgba);
  return p;
}

bool Picture::copyRGBA(uint8_t* destination, size_t count) const {
  if (!destination || count == 0 || count != rgba.size()) return false;
  std::memcpy(destination, rgba.data(), count);
  return true;
}

Picture Viewport::capture() {
  bool submitted = false;
  drawFrame(nullptr, submitted);
  if (!submitted) return {};
  impl_->dirty = true;
  return readback();
}

std::string Viewport::exportMovie(const MovieSettings& settings, const std::string& destination) {
  Impl& v = *impl_;
  if (!ok() || !v.model() || v.model()->pieces().empty()) return "This model has no renderable parts.";
  if (destination.empty() || settings.width < 2 || settings.height < 2 || settings.width > 3840 ||
      settings.height > 3840 || settings.width % 2 != 0 || settings.height % 2 != 0 ||
      settings.fps < 1 || settings.fps > 120) return "The video size or frame rate is invalid.";
  if (!std::isfinite(settings.yaw) || !std::isfinite(settings.pitch) || !std::isfinite(settings.fieldOfView) ||
      settings.fieldOfView <= 0 || settings.fieldOfView >= kPi) return "The video camera is invalid.";
  if (settings.bitRate != 0 && (settings.bitRate < 100'000 || settings.bitRate > 240'000'000))
    return "The video bitrate is invalid.";

  @autoreleasepool {
    try {
      const bool turntable = settings.source == MovieSource::Turntable;
      const bool usingKeys = settings.source == MovieSource::Keyframes;
      std::optional<SceneCamera> savedCamera;
      if (!settings.sceneCameraId.empty()) {
        if (turntable || !v.session->focusPath().empty()) return "A saved camera frames the entire project.";
        const auto cameras = v.session->sceneCameras();
        const auto saved = std::find_if(cameras.cameras.begin(), cameras.cameras.end(),
                                       [&](const auto& item) { return item.id == settings.sceneCameraId; });
        if (saved == cameras.cameras.end()) return "The selected scene camera is missing.";
        savedCamera = *saved;
      }
      resize(settings.width, settings.height, 1);
      v.applyLook();  // the project's look as saved, whichever source is exported
      v.options.mapTrianglesPerFrame = 0;  // complete the lighting for every frame sent to the encoder
      v.orthographic = settings.viewportAngle && settings.orthographic;
      v.standardPreview = settings.standardPreview;
      v.director = !turntable && !settings.viewportAngle && !savedCamera;
      v.trackOff = !settings.cameraTrack;
      struct TrackOn {
        Impl& v;
        ~TrackOn() { v.trackOff = false; }
      } restoreTrack{v};
      useKeyframes(usingKeys);
      if (!turntable && (!usingKeys || v.keyScene.buildLinked)) {
        v.startPlanning(true);
        v.collectPlan(true);
        v.collectDirector();
        if (!v.planned) return v.planError.empty() ? "The build could not be planned for export." : v.planError;
      }

      if (savedCamera) {
        v.orbit = orbitFor(*savedCamera);
        v.orthographic = savedCamera->orthographic;
      } else if (settings.viewportAngle) {
        v.orbit.fovY = settings.fieldOfView;
        v.fit(settings.yaw, settings.pitch);
      }
      const double duration = turntable ? settings.turntableSeconds : length();
      if (!std::isfinite(duration) || duration <= 0 || duration * settings.fps >= INT_MAX - 2)
        return "The selected animation has an invalid duration.";
      // Keyframes use an inclusive range. The turntable omits the duplicate final view.
      const double samples = duration * settings.fps;
      const int frames = std::max(1, static_cast<int>(std::ceil(std::nextafter(samples, 0.0))) + (usingKeys ? 1 : 0));
      const auto turntableStart = [&] {
        auto orbit = bmr::OrbitCamera::framing(v.renderer->scene().bounds, v.orbit.fovY, v.aspect());
        orbit.azimuth = v.orbit.azimuth;
        orbit.elevation = v.orbit.elevation;
        return orbit;
      }();
      if (!turntable && !v.director && !savedCamera) {
        auto bounds = v.renderer->scene().bounds;
        v.showFrame(0);
        bounds.merge(v.renderer->visibleBounds());
        v.orbit = bmr::OrbitCamera::fitted(bounds, v.orbit.fovY, v.aspect(), v.orbit.azimuth, v.orbit.elevation);
      }
      if (!settings.snapWave.empty()) {
        if (settings.source != MovieSource::Build || settings.standardPreview || v.session->buildSettings().standardPlanner)
          return "Snap audio requires a native Build video.";
        const auto& scene = v.renderer->scene();
        const auto boxes = v.restBoxes();
        const auto fixed = v.orbit;
        const auto screenX = [&](int frame, bm::Vec3 point) {
          if (v.director) v.cameraAt(frame);
          const auto camera = v.camera(scene.bounds);
          const auto projection = bmr::multiply(bmr::projectionMatrix(camera), bmr::viewMatrix(camera, {}));
          float clip[4];
          bmr::transform(projection, point, clip);
          return clip[3] > 1e-6f ? static_cast<double>(clip[0]) / clip[3] : 0.0;
        };
        auto snaps = bms::snapEvents(*v.model(), v.planned->graph, v.planned->plan, v.authoredTimeline, boxes, screenX);
        v.orbit = fixed;
        bms::Mixer mixer(std::move(snaps), v.authoredTimeline.frames, v.fps(),
                         snapOptions(v.session->snapMix(), settings.snapRecordings));
        if (!bms::writeWav(mixer, settings.snapWave)) return "The snap audio could not be written.";
      }
      std::optional<MovieLogo> logo;
      if (!settings.logo.empty()) {
        std::string failure;
        logo = loadMovieLogo(settings.logo, settings.width, settings.height, settings.logoCorner, failure);
        if (!logo) return failure;
      }
      bmtools::encodeMovie(destination, settings.width, settings.height, settings.fps, frames, [&](int index) {
        if (turntable) {
          v.orbit = turntableStart;
          v.orbit.azimuth += 2 * kPi * index / frames;
        } else {
          v.showFrame(std::min(duration, static_cast<double>(index) / settings.fps) * v.fps());
        }
        auto camera = v.camera(v.renderer->visibleBounds());
        if (savedCamera) {
          camera.near = savedCamera->nearClip;
          camera.far = savedCamera->farClip;
        }
        const bmr::FrameOptions frameOptions = v.withLens(v.options, camera);
        auto drawn = v.renderer->draw(camera, frameOptions);
        if (!drawn.submitted) throw std::runtime_error("Metal could not draw a video frame.");
        if ((v.options.pathTraced || v.options.realtimePathTrace) && drawn.pathSamples == 0)
          throw std::runtime_error("Path tracing is not available on this Mac. Choose another shading in View → Look.");
        // Path traced: the same frame again until it has its samples (stops if it stops gaining).
        const uint32_t targetSamples = v.options.realtimePathTrace
                                           ? std::min<uint32_t>(8u, static_cast<uint32_t>(std::max(1, v.options.pathMaxSamples)))
                                           : static_cast<uint32_t>(v.options.pathMaxSamples);
        for (uint32_t before = 0; (v.options.pathTraced || v.options.realtimePathTrace) &&
                                  drawn.pathSamples > before && drawn.pathSamples < targetSamples;) {
          before = drawn.pathSamples;
          drawn = v.renderer->draw(camera, frameOptions);
        }
        auto picture = v.renderer->readback();
        if (logo) composite(picture, *logo);
        return picture;
      }, settings.bitRate);
    } catch (const std::exception& error) {
      return error.what();
    }
  }
  return {};
}

std::string Viewport::writeSnapTrack(const std::string& file, const std::string& recordings) {
  auto& v = *impl_;
  v.follow();
  if (!v.renderer || !v.planned || planState() != PlanState::Ready) return "The build has not been planned.";
  if (v.presentation.standardPreview || v.planned->plan.moves.empty()) return "Snap sounds need the native planner.";
  try {
    const auto& scene = v.renderer->scene();
    const auto boxes = v.restBoxes();
    // Panned for the view as it is now: the editor's camera does not follow the director here.
    const auto camera = v.camera(scene.bounds);
    const auto projection = bmr::multiply(bmr::projectionMatrix(camera), bmr::viewMatrix(camera, {}));
    const auto screenX = [&](int, bm::Vec3 point) {
      float clip[4];
      bmr::transform(projection, point, clip);
      return clip[3] > 1e-6f ? static_cast<double>(clip[0]) / clip[3] : 0.0;
    };
    auto snaps = bms::snapEvents(*v.model(), v.planned->graph, v.planned->plan, v.authoredTimeline, boxes, screenX);
    bms::Mixer mixer(std::move(snaps), v.authoredTimeline.frames, v.fps(), snapOptions(v.session->snapMix(), recordings));
    if (!bms::writeWav(mixer, file)) return "The snap sounds could not be written.";
  } catch (const std::exception& error) {
    return error.what();
  }
  return {};
}

void Viewport::setBackground(double r, double g, double b) {
  float* bg = impl_->editorBackground;
  bg[0] = static_cast<float>(toLinear(r)), bg[1] = static_cast<float>(toLinear(g)), bg[2] = static_cast<float>(toLinear(b));
  impl_->applyLook();
}

void Viewport::setPreferences(const ViewportPreferences& p) {
  Impl& v = *impl_;
  v.preferences = p;
  v.applyLook();
  v.autoPlan = p.autoPlan;
  if (!v.autoPlan) v.refreshPlan = false;
  v.dirty = true;
}

bool Viewport::needsDraw() const {
  const Impl& view = *impl_;
  const Session::Impl& session = view.session->impl();
  // Swift checks before draw(), so follow() may not have seen the document notification's edit yet.
  if (view.generation != session.generation) return true;
  return view.ok && (view.dirty || view.job || view.directorJob || view.placementPending ||
      view.seen != session.version || view.seenSelection != session.selectionStamp || view.seenHidden != session.hiddenStamp);
}

uint64_t Viewport::previewPart(const PlacementInput& input, Vec2 point) {
  Impl& v = *impl_;
  v.follow();
  if (!v.ok || v.width <= 0 || v.height <= 0 || v.playing || !v.model()) return 0;
  const uint64_t number = ++v.placementSent;
  const auto& prior = v.placementInput;
  if (input.anchor != UINT32_MAX && (v.placement.state == PlacementState::Inactive || prior.anchor != input.anchor ||
                                     prior.selection != input.selection || !v.placementMove)) {
    auto move = std::make_shared<PlacementWorker::Move>();
    move->pieces = piecesAfterMove(v.session->impl(), input.selection, input.anchor);
    for (const auto& p : move->pieces) move->indices.push_back(p.piece);
    if (!std::binary_search(move->indices.begin(), move->indices.end(), input.anchor)) return 0;
    v.placementMove = std::move(move);
  }
  const bool changedGrip = prior.grip != input.grip || prior.turns != input.turns || prior.mirrored != input.mirrored;
  const bool changedPart = prior.part != input.part || prior.color != input.color;
  if (v.placement.state == PlacementState::Inactive || changedPart || changedGrip ||
      prior.snap != input.snap || prior.reference != input.reference || prior.collision != input.collision)
    v.acceptPlacementSince = number;
  if (changedPart || changedGrip || !input.snap) v.placementSite.reset();
  if (!v.placementScene) {
    v.placementScene = std::make_shared<PlacementWorker::ModelRevision>(PlacementWorker::ModelRevision{
      v.pinned, *v.model(), v.generation, v.session->version()
    });
  }
  if (v.placement.state == PlacementState::Inactive) v.placement.state = PlacementState::Preparing;
  v.placementInput = input;
  v.placementPending = true;
  const auto& bounds = v.renderer->scene().bounds;
  v.placementWorker.submit({number, v.placementScene, input, v.camera(bounds), point,
                           {v.width / v.scale, v.height / v.scale}, bounds.empty() ? 0 : bounds.max.y,
                           bounds, v.session->impl().hidden, v.placementSite, v.placementMove});
  return number;
}

PlacementPreview Viewport::placementPreview() const { return impl_->placement; }
void Viewport::previewFit(uint32_t piece, const PartPose& pose) {
  auto& v = *impl_;
  v.follow();
  if (!v.renderer || !v.model() || piece >= v.model()->pieces().size()) return;
  v.clearPlacement();
  const auto& part = v.model()->pieces()[piece];
  bm::Xform transform;
  transform.t = {pose.position.x, pose.position.y, pose.position.z};
  std::copy_n(pose.rotation.m, 9, transform.r.m);
  v.renderer->setPlacementPreview({{part.part, part.color, transform}}, false);
  v.placement.state = PlacementState::Snapped;
  v.dirty = true;
}
void Viewport::clearPlacementPreview() { impl_->clearPlacement(); }

void Viewport::orbit(double dxPoints, double dyPoints) {
  impl_->orbit.drag(dxPoints, dyPoints);
  impl_->moved();
}

void Viewport::pan(double dxPoints, double dyPoints) {
  Impl& v = *impl_;
  v.orbit.pan(dxPoints * v.scale, dyPoints * v.scale, v.height);
  v.moved();
}

void Viewport::zoom(double factor) {
  if (!(factor > 0) || !std::isfinite(factor)) return;
  impl_->orbit.zoom(1 / factor);
  impl_->moved();
}

void Viewport::zoomToward(double factor, double xPoints, double yPoints) {
  Impl& v = *impl_;
  if (!(factor > 0) || !std::isfinite(factor) || v.height <= 0) return;
  const double f = 1 / factor;  // the distance's multiplier
  const double ox = xPoints * v.scale - v.width / 2.0, oy = yPoints * v.scale - v.height / 2.0;  // pixels from the middle, down positive
  v.orbit.pan(-(1 - f) * ox, -(1 - f) * oy, v.height);
  v.orbit.zoom(f);
  v.moved();
}

void Viewport::rotateGesture(double degrees) {
  impl_->orbit.orbit(degrees * kPi / 180, 0);
  impl_->moved();
}

void Viewport::fitAll() { impl_->fit(impl_->orbit.azimuth, impl_->orbit.elevation); }

void Viewport::view(ViewPreset preset) {
  double az = 0, el = 0;
  switch (preset) {
    case ViewPreset::Front: az = 0, el = 0; break;
    case ViewPreset::Back: az = kPi, el = 0; break;
    case ViewPreset::Right: az = -kPi / 2, el = 0; break;  // the eye on +x, the model's right
    case ViewPreset::Left: az = kPi / 2, el = 0; break;
    case ViewPreset::Top: az = 0, el = bmr::kMaxElevation; break;
    case ViewPreset::Bottom: az = 0, el = -bmr::kMaxElevation; break;
  }
  Impl& v = *impl_;
  v.orbit.azimuth = az, v.orbit.elevation = el;
  v.fit(az, el);
}

CameraState Viewport::camera() const {
  const bmr::OrbitCamera& o = impl_->orbit;
  CameraState c;
  c.yaw = o.azimuth, c.pitch = o.elevation, c.distance = o.distance;
  c.target = {o.target.x, o.target.y, o.target.z};
  c.orthographic = impl_->orthographic;
  c.verticalFOV = o.fovY;
  return c;
}

SceneCamera Viewport::captureSceneCamera() const {
  const auto& v = *impl_;
  const auto camera = v.camera(v.renderer ? v.renderer->visibleBounds() : bm::Box{});
  SceneCamera saved;
  saved.position = {camera.eye.x, camera.eye.y, camera.eye.z};
  saved.target = {camera.target.x, camera.target.y, camera.target.z};
  saved.fieldOfView = camera.fovY * 180 / kPi;
  saved.orthographic = v.orthographic;
  return saved;
}

bool Viewport::followsCameraTrack() {
  impl_->follow();
  return impl_->followsTrack();
}

SceneCamera Viewport::cameraTrackView(double seconds) {
  auto& v = *impl_;
  v.follow();
  if (!v.renderer || !v.followsTrack() || !std::isfinite(seconds)) return captureSceneCamera();
  const auto keep = v.orbit;
  v.trackShotAt(std::clamp(seconds, 0.0, v.endFrame() / v.fps()));
  const auto view = captureSceneCamera();
  v.orbit = keep;
  return view;
}

CameraDirectorInput Viewport::cameraDirectorInput() {
  auto& v = *impl_;
  v.follow();
  CameraDirectorInput input;
  if (!v.renderer || !v.planned || planState() != PlanState::Ready) return input;
  const auto timeline = buildTimeline();
  const auto landings = v.buildLandings();
  if (landings.model.empty()) return input;
  for (const auto& group : landings.groups)
    for (const auto& land : group)
      input.lands.push_back({land.start, land.end, {land.box.min.x, land.box.min.y, land.box.min.z}, {land.box.max.x, land.box.max.y, land.box.max.z}});
  input.modelMin = {landings.model.min.x, landings.model.min.y, landings.model.min.z};
  input.modelMax = {landings.model.max.x, landings.model.max.y, landings.model.max.z};
  input.intro = timeline.buildStart, input.buildEnd = timeline.buildEnd, input.duration = timeline.duration;
  input.ok = true;
  return input;
}

bool Viewport::recallSceneCamera(const std::string& id) {
  auto& v = *impl_;
  if (!v.session->focusPath().empty()) return false;
  const auto cameras = v.session->sceneCameras();
  const auto saved = std::find_if(cameras.cameras.begin(), cameras.cameras.end(),
                                 [&](const auto& item) { return item.id == id; });
  if (saved == cameras.cameras.end()) return false;
  v.orbit = orbitFor(*saved);
  v.orthographic = saved->orthographic;
  v.moved();
  return true;
}

void Viewport::setOrthographic(bool enabled) {
  impl_->orthographic = enabled;
  impl_->moved();
}

void Viewport::centerOnFloor() {
  auto& v = *impl_;
  if (!v.renderer) return;
  const auto& bounds = v.renderer->scene().bounds;
  if (bounds.empty()) return;
  v.orbit.target = {(bounds.min.x + bounds.max.x) * 0.5, bounds.max.y, (bounds.min.z + bounds.max.z) * 0.5};
  v.moved();
}

void Viewport::setViewStyle(ViewStyle style) {
  auto& v = *impl_;
  v.options.clay = style == ViewStyle::Clay;
  v.options.wireframe = style == ViewStyle::Wireframe;
  v.dirty = true;
}

void Viewport::setGridSpacing(double ldu) {
  if (!std::isfinite(ldu)) return;
  impl_->options.gridSpacing = std::clamp(ldu, 0.0, 1000.0);
  impl_->dirty = true;
}

double Viewport::zoomPercent() const {
  return 100 * impl_->fittedDistance / std::max(1.0, impl_->orbit.distance);
}

void Viewport::play(bool on) {
  Impl& v = *impl_;
  if (!v.ok) return;
  v.follow();
  v.wantPlay = on && v.model() && !v.model()->pieces().empty();
  if (on) v.previewRequested = true;
  if (!v.wantPlay) {
    v.playing = false;
    v.dirty = true;
    return;
  }
  if (v.canShowTime()) v.startPlaying();
  else v.startPlanning();
  v.dirty = true;
}

void Viewport::requestPlan() {
  auto& v = *impl_;
  if (!v.ok) return;
  v.follow();
  v.previewRequested = true;
  if (v.job && v.job->cancel.cancelled()) v.refreshPlan = true;
  v.startPlanning();
  v.dirty = true;
}

void Viewport::regeneratePlan(bool standardPreview) {
  auto& v = *impl_;
  if (!v.ok) return;
  v.follow();
  if (v.job) v.job->cancel.cancel();
  v.planWorkspace = std::make_shared<PlanWorkspace>();
  v.standardPreview = standardPreview;
  v.previous.reset();
  v.previousModel.reset();
  v.directorJob.reset();
  v.directedCamera.reset();
  v.directedLenses.clear();
  v.planned.reset();
  v.plannedVersion = 0;
  v.previewRequested = true;
  v.playing = v.wantPlay = false;
  if (v.frame >= 0) v.restoreTime = v.frame / v.fps();
  v.frame = -1;
  v.refreshPlan = true;
  v.stalePlan = true;
  v.dirty = true;
}

void Viewport::playRange(double start, double end) {
  if (!std::isfinite(start) || !std::isfinite(end) || start < 0 || (end > 0 && end <= start)) return;
  auto& v = *impl_;
  v.follow();
  v.rangeStart = start;
  v.rangeEnd = end;
  if (v.canShowTime()) v.showFrame(start * v.fps());
  play(true);
}

void Viewport::setPlaybackRate(double rate) {
  if (!std::isfinite(rate) || rate < 0.1 || rate > 8) return;
  auto& v = *impl_;
  if (v.playing) {
    v.advance();
    v.playStartTime = CACurrentMediaTime();
    v.playStartFrame = v.frame;
  }
  v.playbackRate = rate;
}

void Viewport::setPlaybackLoop(bool loop) { impl_->loop = loop; }

void Viewport::setDirectorPreview(bool directed) {
  auto& v = *impl_;
  v.director = directed;
  v.userMoved = false;
  if (directed) {
    if (v.planned) v.cameraAt(std::max(0.0, v.frame));
    v.requestDirector();
  }
  v.dirty = true;
}

void Viewport::useKeyframes(bool enabled) {
  auto& v = *impl_;
  v.follow();
  if (v.keyframes == enabled || !v.renderer) return;
  v.keyframes = enabled;
  v.playing = v.wantPlay = false;
  v.rangeStart = v.rangeEnd = 0;
  v.frame = -1;
  if (enabled) {
    v.readKeys();
    v.showFrame(0);
  } else {
    v.renderer->setRest();
  }
  v.dirty = true;
}

KeyList Viewport::bakeFlight(uint32_t piece) {
  auto& v = *impl_;
  v.follow();
  if (!v.renderer || !v.planned || !v.keyScene.buildLinked) return {};
  return bakeFlightKeys(piece, v.keyScene, v.renderer->scene(), *v.model(), v.authoredTimeline, v.owners, v.fps());
}

KeyList Viewport::bakeFlightInScene(uint32_t piece, const KeyScene& scene) {
  auto& v = *impl_;
  v.follow();
  if (!v.renderer || planState() != PlanState::Ready || !v.session->isLocalPiece(piece) ||
      !scene.buildLinked || scene.fps <= 0 || scene.last < scene.first || scene.last > 20000 ||
      !std::isfinite(scene.buildSpeed) || scene.buildSpeed <= 0) return {};
  return bakeFlightKeys(piece, scene, v.renderer->scene(), *v.model(), v.authoredTimeline, v.owners, v.fps());
}

FlightPoseList Viewport::editedFlightRoute(uint32_t piece) {
  auto& v = *impl_;
  v.follow();
  if (!v.renderer || !v.session->isLocalPiece(piece)) return {};
  const auto tracks = readKeyTracks(v.session->impl());
  const auto track = std::find_if(tracks.begin(), tracks.end(), [&](const auto& row) {
    return row.object == piece && row.baked && row.members.size() == 1;
  });
  return track == tracks.end() ? FlightPoseList{} : flightRouteFromKeys(*track, v.renderer->scene(), *v.model());
}

FlightPath Viewport::flightPath(uint32_t piece) {
  auto& v = *impl_;
  v.follow();
  if (!v.renderer || !v.model() || !v.session->isLocalPiece(piece)) return {};
  const auto tracks = readKeyTracks(v.session->impl());
  const auto track = std::find_if(tracks.begin(), tracks.end(), [&](const auto& row) {
    return row.object == piece && row.baked && row.members.size() == 1;
  });
  return track == tracks.end() ? FlightPath{} : flightPathFromKeys(*track, v.renderer->scene(), *v.model());
}

Vec3 Viewport::dragFacingView(Vec3 through, double x0, double y0, double x1, double y1) const {
  const auto& v = *impl_;
  if (!v.renderer || v.width <= 0 || v.height <= 0) return {};
  const bmr::Camera view = v.camera(v.renderer->scene().bounds);
  const bm::Vec3 point{through.x, through.y, through.z}, normal = bm::normalized(view.target - view.eye);
  const auto hit = [&](double x, double y) -> std::optional<bm::Vec3> {
    const auto ray = bmr::screenRay(view, 2 * x * v.scale / v.width - 1, 1 - 2 * y * v.scale / v.height);
    const double along = bm::dot(ray.dir, normal);
    if (std::abs(along) < 1e-9) return std::nullopt;
    const double t = bm::dot(point - ray.from, normal) / along;
    if (!std::isfinite(t)) return std::nullopt;
    return ray.from + ray.dir * t;
  };
  const auto a = hit(x0, y0), b = hit(x1, y1);
  if (!a || !b) return {};
  const bm::Vec3 d = *b - *a;
  return {d.x, d.y, d.z};
}

FlightBake* Viewport::captureFlightBake(const PieceList& selected, bool detach) {
  auto& v = *impl_;
  v.follow();
  if (!v.renderer || !v.model() || planState() != PlanState::Ready || v.model()->pieces().empty()) return nullptr;
  PieceList pieces = selected;
  if (detach) {
    pieces.resize(v.model()->pieces().size());
    std::iota(pieces.begin(), pieces.end(), 0);
  } else {
    std::sort(pieces.begin(), pieces.end());
    pieces.erase(std::unique(pieces.begin(), pieces.end()), pieces.end());
    if (pieces.empty() || pieces.back() >= v.model()->pieces().size()) return nullptr;
  }
  auto bake = std::make_unique<FlightBake::Impl>();
  bake->detach = detach;
  bake->scene = v.session->keyScene();
  bake->buildFPS = v.fps();
  if (pieces.size() <= 2000) {
    bake->timeline = v.authoredTimeline;
    for (const auto piece : pieces) {
      const auto& modelPiece = v.model()->pieces()[piece];
      const auto pivot = keyPivot(v.renderer->scene(), piece, modelPiece.world);
      bake->targets.push_back({{}, {}, pivot, v.owners[piece]});
    }
  }
  prepareBakeEdit(*bake, v.session->impl(), pieces);
  return new FlightBake(std::move(bake));
}

MotionAudit* Viewport::auditMotion(uint32_t piece) {
  auto& v = *impl_;
  v.follow();
  if (!v.renderer || !v.model() || piece >= v.model()->pieces().size() ||
      (v.keyScene.buildLinked && !v.planned)) return nullptr;
  auto state = std::make_unique<MotionAudit::Impl>(MotionAudit::Impl{
    v.session->shared(), *v.model(), v.renderer->scene(), v.authoredTimeline, v.owners, v.keyScene, v.keyTracks, piece, v.fps()
  });
  return new MotionAudit(std::move(state));
}

void Viewport::arrange(int step, AssemblyPreview mode) {
  auto& v = *impl_;
  v.follow();
  if (!v.renderer || !v.model() || (step >= 0 && static_cast<size_t>(step) >= v.session->stepCount())) return;
  static const bm::plan::Plan plan;
  static const bm::plan::Timeline timeline;
  const auto poses = arrangement(*v.model(), v.renderer->scene(), step, mode);
  v.clearPlacement();
  v.playing = v.wantPlay = false;
  v.frame = -1;
  v.arranged = true;
  v.renderer->setFrame(plan, timeline, 0, poses);
  v.fit(v.orbit.azimuth, v.orbit.elevation);
}

PlaybackState Viewport::playbackState() const {
  const auto& v = *impl_;
  const auto state = planState();
  const auto stage = v.job ? v.job->stage.load(std::memory_order_relaxed) : PlanStage::Waiting;
  return {seconds(), length(), v.playing, v.wantPlay && !v.playing, v.frame < 0,
          v.stalePlan || (v.planned && state != PlanState::Ready), state, plannedVersion(), stage};
}

BuildTimeline Viewport::buildTimeline() const {
  return planState() == PlanState::Ready ? impl_->presentation : BuildTimeline{};
}

PieceList Viewport::buildOrder() const {
  PieceList out;
  if (planState() == PlanState::Ready)
    for (const auto& move : impl_->planned->plan.moves)
      out.insert(out.end(), move.unit.pieces.begin(), move.unit.pieces.end());
  return out;
}

bool Viewport::canTurnWaitingPart(uint32_t piece) const {
  const auto& v = *impl_;
  if (!v.planned || v.keyframes || v.playing || v.plannedVersion != v.session->version() ||
      !v.session->isLocalPiece(piece) || piece >= v.owners.size() || v.owners[piece] < 0) return false;
  const auto& flight = v.authoredTimeline.flights[static_cast<size_t>(v.owners[piece])];
  return v.frame >= flight.appearFrame && v.frame < flight.startFrame &&
      bm::plan::piecesOf(flight, v.planned->plan).size() == 1 && canTurnOnFloor(flight);
}

bool Viewport::canMoveWaitingPart(uint32_t piece) const {
  const auto& v = *impl_;
  if (!v.planned || v.keyframes || v.playing || v.plannedVersion != v.session->version() ||
      piece >= v.owners.size() || v.owners[piece] < 0) return false;
  const auto& flight = v.authoredTimeline.flights[static_cast<size_t>(v.owners[piece])];
  return v.frame >= flight.appearFrame && v.frame < flight.startFrame && bm::plan::piecesOf(flight, v.planned->plan).size() == 1;
}

bool Viewport::beginWaitingDrag(uint32_t piece, double x, double y) {
  auto& v = *impl_;
  v.follow();
  v.waitingDrag.reset();
  if (!canMoveWaitingPart(piece)) return false;
  const size_t index = static_cast<size_t>(v.owners[piece]);
  const auto& flight = v.authoredTimeline.flights[index];
  const auto hold = v.onLevel(x, y, bm::plan::poseAt(flight, v.frame).t.y);
  if (!hold) return false;
  v.waitingDrag = Impl::WaitingDrag{index, flight.shift, *hold, {}};
  return true;
}

Vec3 Viewport::dragWaitingPart(double x, double y) {
  auto& v = *impl_;
  if (!v.waitingDrag || v.waitingDrag->flight >= v.authoredTimeline.flights.size()) return {};
  auto& drag = *v.waitingDrag;
  if (const auto at = v.onLevel(x, y, drag.from.y)) {
    drag.delta = {at->x - drag.from.x, 0, at->z - drag.from.z};
    v.authoredTimeline.flights[drag.flight].shift = drag.base + drag.delta;
    v.reshow();
  }
  return {drag.delta.x, drag.delta.y, drag.delta.z};
}

Vec3 Viewport::endWaitingDrag() {
  auto& v = *impl_;
  if (!v.waitingDrag) return {};
  const auto drag = *v.waitingDrag;
  v.waitingDrag.reset();
  if (drag.flight < v.authoredTimeline.flights.size()) {
    v.authoredTimeline.flights[drag.flight].shift = drag.base;  // the saved drag lays it on again
    v.reshow();
  }
  return {drag.delta.x, drag.delta.y, drag.delta.z};
}

double Viewport::waitingTurnToMatch(uint32_t piece) const {
  if (!canTurnWaitingPart(piece)) return 0;
  const auto& v = *impl_;
  return waitFacingSeat(v.authoredTimeline.flights[static_cast<size_t>(v.owners[piece])]);
}

bool Viewport::playing() const { return impl_->playing; }
void Viewport::showRest() {
  auto& v = *impl_;
  v.follow();
  v.playing = v.wantPlay = false;
  v.rangeStart = v.rangeEnd = 0;
  v.restoreTime.reset();
  v.frame = -1;
  v.arranged = false;
  if (v.editorOrbit) {
    v.orbit = *v.editorOrbit;
    v.fittedDistance = v.orbit.distance;
    v.editorOrbit.reset();
  }
  if (v.renderer) v.renderer->setRest();
  v.dirty = true;
}
double Viewport::seconds() const { return impl_->canShowTime() ? std::max(0.0, impl_->frame) / impl_->fps() : 0; }
double Viewport::length() const { return impl_->endFrame() / impl_->fps(); }

void Viewport::seek(double seconds) {
  Impl& v = *impl_;
  v.follow();
  if (!v.canShowTime() || !std::isfinite(seconds)) return;
  v.playing = v.wantPlay = false;
  v.rangeStart = v.rangeEnd = 0;
  v.userMoved = false;
  v.showFrame(seconds * v.fps());
}

uint32_t Viewport::pick(double xPoints, double yPoints) {
  Impl& v = *impl_;
  if (!v.ok) return UINT32_MAX;
  return v.renderer->pick(static_cast<int>(std::floor(xPoints * v.scale)), static_cast<int>(std::floor(yPoints * v.scale)));
}

std::vector<uint32_t> Viewport::marquee(double x0, double y0, double x1, double y1, bool touching) {
  Impl& v = *impl_;
  std::vector<uint32_t> out;
  if (!v.ok || v.width <= 0 || v.height <= 0) return out;
  v.follow();
  if (x0 > x1) std::swap(x0, x1);
  if (y0 > y1) std::swap(y0, y1);
  const bmr::Scene& scene = v.renderer->scene();
  const bmr::Camera camera = v.camera(scene.bounds);
  const bmr::Mat4 viewProj = bmr::multiply(bmr::projectionMatrix(camera), bmr::viewMatrix(camera, scene.origin));
  for (const bmr::Group& g : scene.groups) {
    const bm::Box& b = g.partBox;
    if (b.empty()) continue;
    for (const bmr::Instance& in : g.instances) {
      if (in.flags & bmr::kNotShown) continue;
      // The part's box, placed as drawn now, seen through the camera.
      double left = 1e300, top = 1e300, right = -1e300, bottom = -1e300;
      bool behind = false;
      for (int corner = 0; corner < 8; corner++) {
        const bm::Vec3 c{corner & 1 ? b.max.x : b.min.x, corner & 2 ? b.max.y : b.min.y, corner & 4 ? b.max.z : b.min.z};
        const float* m = in.model;
        const bm::Vec3 p{m[0] * c.x + m[1] * c.y + m[2] * c.z + m[3], m[4] * c.x + m[5] * c.y + m[6] * c.z + m[7], m[8] * c.x + m[9] * c.y + m[10] * c.z + m[11]};
        double x = 0, y = 0;
        if (!v.project(viewProj, p, x, y)) {
          behind = true;
          break;
        }
        left = std::min(left, x), right = std::max(right, x), top = std::min(top, y), bottom = std::max(bottom, y);
      }
      if (behind) continue;
      const bool inside = left >= x0 && right <= x1 && top >= y0 && bottom <= y1;
      const bool meets = left <= x1 && right >= x0 && top <= y1 && bottom >= y0;
      if (touching ? meets : inside) out.push_back(in.piece);
    }
  }
  std::sort(out.begin(), out.end());
  return out;
}

void Viewport::showSelection() {
  if (!impl_->ok) return;
  impl_->follow();
}

void Viewport::frameSelection() {
  Impl& v = *impl_;
  if (!v.ok) return;
  v.follow();
  const bm::Box box = v.renderer->selectionBounds();
  if (box.empty()) {
    v.fit(v.orbit.azimuth, v.orbit.elevation);
    return;
  }
  v.orbit = bmr::OrbitCamera::fitted(box, v.orbit.fovY, v.aspect(), v.orbit.azimuth, v.orbit.elevation);
  v.moved();
}

Vec3 Viewport::selectionCenter() {
  Impl& v = *impl_;
  if (!v.ok) return {};
  v.follow();
  const bm::Box box = v.renderer->selectionBounds();
  const bm::Vec3 c = box.empty() ? v.orbit.target : (box.min + box.max) * 0.5;
  return {c.x, c.y, c.z};
}

PlanState Viewport::planState() const {
  const Impl& v = *impl_;
  const uint64_t now = v.session->version();
  if (v.planned && v.plannedVersion == now) return PlanState::Ready;
  if (v.job && v.job->version == now) return PlanState::Planning;
  if (v.seen == now && ((v.wantPlay && !v.canShowTime()) || v.refreshPlan) && v.model() && !v.model()->pieces().empty())
    return PlanState::Planning;
  if (v.planned || v.job) return PlanState::Idle;  // of a model since edited
  if (!v.planError.empty()) return PlanState::Failed;
  return PlanState::Idle;
}

std::string Viewport::planError() const { return impl_->planError; }

uint64_t Viewport::plannedVersion() const { return impl_->planned ? impl_->plannedVersion : 0; }

}  // namespace bmapp

void bmappRetainViewport(bmapp::Viewport* v) { v->refs_.fetch_add(1, std::memory_order_relaxed); }
void bmappReleaseViewport(bmapp::Viewport* v) {
  if (v->refs_.fetch_sub(1, std::memory_order_acq_rel) == 1) delete v;
}
