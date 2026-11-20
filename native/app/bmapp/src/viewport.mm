#include "bmapp/viewport.h"

#import <QuartzCore/QuartzCore.h>
#include <algorithm>
#include <chrono>
#include <cmath>
#include <deque>
#include <dispatch/dispatch.h>
#include <exception>
#include <mutex>
#include <optional>
#include "animation_authoring.h"
#include "animation_keys.h"
#include "bm/jobs.h"
#include "bm/plan/timeline.h"
#include "bmf/director.h"
#include "bmr/camera.h"
#include "bmr/device.h"
#include "bmr/renderer.h"
#include "bmr/tolerances.h"
#include "engine.h"
#include "incremental_plan.h"
#include "motion_audit_impl.h"
#include "placement_worker.h"
#include "preview_arrangement.h"
#include "session_impl.h"

namespace bmapp {

namespace {
constexpr double kPi = 3.14159265358979323846;

/// One planning run. It plans its own copy of the model, so edits made meanwhile cannot reach
/// it; the viewport takes its result only while that result still belongs to what is shown.
struct PlanJob {
  uint64_t version = 0;  ///< the session's version whose model is planned
  uint64_t inputs = 0;
  bm::CancelToken cancel;
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
  std::optional<bmtools::ConnectorSources> connectors;
  bm::collide::ShapeCache shapes;
};

std::pair<double, double> addSequenceClips(bm::plan::Timeline& timeline, const bm::plan::Style& style) {
  const auto frames = [&](double seconds) { return static_cast<int>(std::lround(style.fps * std::clamp(seconds, 0.0, 120.0))); };
  const int intro = frames(style.introSeconds >= 0 ? style.introSeconds : 1);
  const int hero = frames(style.outroSeconds >= 0 ? style.outroSeconds : style.heroOrbit ? 3 : 1.5);
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
  bool autoPlan = false, previewRequested = false, refreshPlan = false, stalePlan = false;
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
    return out;
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
    owners.clear();
    if (keyframes) readKeys();
    plannedVersion = 0;
    presentation = {};
    renderer.reset();  // before the state it was made from goes
    pinned = session->shared();
    generation = pinned->generation;
    ok = false;
    if (pinned->model && bmr::gpuAvailable()) renderer = bmr::Renderer::create(*pinned->model, *pinned->full, *pinned->low);
    ok = renderer != nullptr;
    if (ok && width > 0 && height > 0) renderer->resize(width, height);
    seen = session->version();
    interactionEnds = 0;
    seenSelection = seenHidden = UINT64_MAX;
    frame = -1;
    editorOrbit.reset();
    arranged = false;
    playing = wantPlay = false;
    previewRequested = refreshPlan = stalePlan = false;
    restoreTime.reset();
    planError.clear();
    dirty = true;
  }

  void follow() {
    if (session->impl().generation != generation) reopen();
    if (!renderer) return;
    const uint64_t now = session->version();
    if (now != seen) {
      const auto& log = session->impl().changes;
      const bool handKeys = !log.empty() && log.front().version <= seen + 1 && log.back().version == now &&
          std::all_of(log.begin(), log.end(), [&](const Changed& change) { return change.version <= seen || change.keyframesOnly; });
      if (handKeys && (planned || !job)) {
        seen = now;
        if (planned) plannedVersion = presentation.version = now;
        if (keyframes) {
          readKeys();
          const double at = frame;
          frame = -1;
          if (at >= 0) showFrame(at);
        }
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

  void startPlanning() {
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
    const auto authored = std::make_shared<const AnimationAuthoring>(animationAuthoring(*session));
    const std::shared_ptr<const bmtools::Planned> cached = previousInputs == j->inputs ? previous : nullptr;
    const uint32_t moved = cached ? UINT32_MAX : singleMoved(s);
    const std::shared_ptr<const bmtools::Planned> rewind = moved == UINT32_MAX ? nullptr : previous;
    const std::shared_ptr<const bm::Model> earlier = moved == UINT32_MAX ? nullptr : previousModel;
    const bm::ldraw::Library* library = s.library.get();
    bm::ldraw::PartCache* full = s.full.get();
    const std::filesystem::path ldraw = s.ldraw;
    const auto workspace = planWorkspace;
    std::shared_ptr<Session::Impl> keep = session->shared();  // the library and caches it reads
    dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
      (void)keep;
      auto planned = cached;
      bm::plan::Timeline timeline;
      BuildTimeline presentation;
      std::string error;
      try {
        const auto start = std::chrono::steady_clock::now();
        bm::plan::Options options;
        options.cancel = &j->cancel;
        options.authored = &authored->constraints;
        const auto& style = authored->style;
        size_t reused = planned ? planned->plan.moves.size() : 0;
        if (!planned && !workspace->connectors) workspace->connectors.emplace(*library, ldraw);
        if (rewind && earlier) {
          if (auto local = replanMove(*earlier, *copy, moved, *rewind, *full, *workspace->connectors, workspace->shapes, style, options)) {
            reused = local->reused;
            planned = std::make_shared<bmtools::Planned>(std::move(local->planned));
          }
        }
        if (!planned && !j->cancel.cancelled()) {
          auto result = std::make_shared<bmtools::Planned>();
          auto& sources = *workspace->connectors;
          result->plan = bm::plan::planModel(*copy, result->graph, sources.connectors, &sources.gears, *full, workspace->shapes, options);
          if (!j->cancel.cancelled())
            result->timeline = bm::plan::buildTimeline(*copy, *full, result->plan, style, options.down);
          planned = std::move(result);
        }
        if (!j->cancel.cancelled()) {
          timeline = planned->timeline;
          retimeAnimation(*copy, planned->plan, timeline, *authored);
          std::vector<std::string> waitingNotes;
          orientWaitingParts(*copy, planned->plan, timeline, *authored, *full, workspace->shapes, waitingNotes, j->cancel);
          const auto build = addSequenceClips(timeline, style);
          presentation = describe(*copy, planned->plan, timeline, style.fps, j->version, build);
          presentation.notes.insert(presentation.notes.end(), waitingNotes.begin(), waitingNotes.end());
          presentation.planningMilliseconds = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - start).count();
          presentation.reusedMoves = reused;
        }
      } catch (const std::exception& e) {
        error = e.what();
      }
      std::lock_guard lock(j->mutex);
      j->planned = std::move(planned);
      j->authoredTimeline = std::move(timeline);
      j->presentation = std::move(presentation);
      j->error = error;
      j->done = true;
    });
  }

  /// On the main thread, before a frame: takes a finished plan.
  void collectPlan() {
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
      requestDirector();
    } else {
      planError = job->error.empty() ? "Planning stopped." : job->error;
      wantPlay = false;
    }
    restoreTime.reset();
    job.reset();
    if (planned && wantPlay) startPlaying();
    dirty = true;
  }

  void requestDirector() {
    if (!director || !planned || directorJob || directedCamera || !previousModel) return;
    auto work = std::make_shared<DirectorJob>();
    work->version = previousVersion;
    directorJob = work;
    const auto plan = planned;
    const auto geometry = previousModel;
    const auto backing = pinned;
    const auto timeline = std::make_shared<const bm::plan::Timeline>(authoredTimeline);
    const double projection = aspect(), rate = fps();
    dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
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
    });
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

  void cameraAt(double buildFrame) {
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
    if (director && !userMoved && (!keyframes || keyScene.buildLinked)) cameraAt(buildFrame);
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
  const bool interactive = v.model()->pieces().size() >= 1500 && CACurrentMediaTime() < v.interactionEnds;
  bmr::FrameOptions paint = v.options;
  paint.interactive = interactive;
  if (interactive && v.model()->pieces().size() >= 8000) {
    // Contact shading and glass transport return when the large model comes to rest.
    paint.shadows = paint.ambientOcclusion = false;
    paint.refractiveGlass = false;
  }
  const bmr::FrameStats s = v.renderer->draw(v.camera(v.renderer->visibleBounds()), paint, metalDrawable);
  v.dirty = interactive || v.playing || s.settling || (!s.submitted && v.width > 0 && v.height > 0);
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

void Viewport::setBackground(double r, double g, double b) {
  float* bg = impl_->options.background;
  bg[0] = static_cast<float>(toLinear(r)), bg[1] = static_cast<float>(toLinear(g)), bg[2] = static_cast<float>(toLinear(b));
  impl_->dirty = true;
}

void Viewport::setPreferences(const ViewportPreferences& p) {
  Impl& v = *impl_;
  v.options.edges = p.edges;
  v.options.floor = p.floor;
  v.options.shadows = p.shadows;
  v.options.ambientOcclusion = p.ambientOcclusion;
  v.autoPlan = p.autoPlan;
  if (!v.autoPlan) v.refreshPlan = false;
  v.dirty = true;
}

bool Viewport::needsDraw() const { return impl_->dirty || impl_->job || impl_->directorJob || impl_->placementPending; }

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

void Viewport::regeneratePlan() {
  auto& v = *impl_;
  if (!v.ok) return;
  v.follow();
  if (v.job) v.job->cancel.cancel();
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
  return {seconds(), length(), v.playing, v.wantPlay && !v.playing, v.frame < 0,
          v.stalePlan || (v.planned && state != PlanState::Ready), state, plannedVersion()};
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
