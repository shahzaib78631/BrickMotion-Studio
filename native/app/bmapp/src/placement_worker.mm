#include "placement_worker.h"

#include <dispatch/dispatch.h>
#include <cmath>
#include <mutex>
#include <numbers>
#include "bmapp/keys.h"
#include "engine.h"
#include "session_impl.h"

namespace bmapp {
namespace {

using bm::Vec3, bm::Xform;

struct PreparedModel {
  std::shared_ptr<const PlacementWorker::ModelRevision> scene;
  bmtools::ConnectorSources sources;
  bm::collide::ShapeCache shapes;
  std::unique_ptr<PlacementSolver> solver;

  explicit PreparedModel(std::shared_ptr<const PlacementWorker::ModelRevision> revision)
    : scene(revision), sources(*scene->backing->library, scene->backing->ldraw) { reset(std::move(revision)); }

  void reset(std::shared_ptr<const PlacementWorker::ModelRevision> revision) {
    solver.reset();
    scene = std::move(revision);
    solver = std::make_unique<PlacementSolver>(scene->model, *scene->backing->full, sources.connectors, shapes);
  }
};

bmr::ScreenRay cursorRay(const bmr::Camera& c, Vec2 point, Vec2 view) {
  return bmr::screenRay(c, 2 * point.x / view.x - 1, 1 - 2 * point.y / view.y);
}

Xform orientation(const PlacementInput& input) {
  const double angle = (input.turns % 4) * (std::numbers::pi / 2);
  const double cos = std::round(std::cos(angle)), sin = std::round(std::sin(angle));
  const double mirror = input.mirrored ? -1 : 1;
  return {{{cos * mirror, 0, sin, 0, 1, 0, -sin * mirror, 0, cos}}, {}};
}

PartPose bridgePose(const Xform& pose) {
  PartPose out;
  std::copy_n(pose.r.m, 9, out.rotation.m);
  out.position = {pose.t.x, pose.t.y, pose.t.z};
  return out;
}

PlacementWorker::Result solve(PreparedModel& engine, const PlacementWorker::Request& request) {
  const auto& [number, revision, input, camera, point, view, floor, sceneBounds, hidden, retained, move] = request;
  PlacementWorker::Result result;
  auto& preview = result.preview;
  preview.generation = revision->generation;
  preview.version = revision->version;
  preview.request = number;
  preview.state = PlacementState::Unavailable;
  preview.gripCount = engine.solver->gripCount(input.part);
  const auto mesh = revision->model.mesh(input.part, *revision->backing->full);
  const bool shadowsLibrary = !move && revision->model.library().isInline(input.part);
  if (mesh->triangles.empty() || shadowsLibrary) {
    preview.reason = shadowsLibrary ? "This model already defines a custom part with that name." :
                                       "This part’s geometry is unavailable.";
    return result;
  }

  const auto ray = cursorRay(camera, point, view);
  const Vec3 delta = camera.target - ray.from;
  const double focal = std::max(bm::dot(delta, ray.dir), 24.0);
  const double maxRay = sceneBounds.empty() ? focal : focal + bm::length(sceneBounds.max - sceneBounds.min);
  Xform pose = orientation(input);
  const std::span<const uint32_t> moving = move ? std::span(move->indices) : std::span<const uint32_t>{};
  const auto surface = engine.solver->frontSurface(ray.from, ray.from + ray.dir * maxRay, hidden, moving);
  auto onPlane = [&](const bmr::ScreenRay& direction, double y) {
    const double ground = std::abs(direction.dir.y) > 1e-6 ? (y - direction.from.y) / direction.dir.y : -1;
    const bool hitsGround = ground > 0 && ground < maxRay * 2;
    return direction.from + direction.dir * (hitsGround ? ground : focal);
  };
  double plane = floor;
  Vec3 grabOffset;
  if (move) {
    const auto& original = revision->model.pieces()[input.anchor].world;
    pose.r = pose.r * original.r;
    plane = mesh->bounds.transformed(original).max.y;
    grabOffset = original.t - onPlane(cursorRay(camera, input.grab, view), plane);
  }
  const Vec3 at = surface ? surface->point : onPlane(ray, plane);
  const auto bounds = mesh->bounds.transformed(pose);
  const Vec3 center = (bounds.min + bounds.max) * 0.5;
  const Vec3 offset = move ? grabOffset : -center;
  pose.t = {at.x + offset.x, (surface ? at.y : plane) - bounds.max.y, at.z + offset.z};
  if (!move && !surface && input.snap) {
    pose.t.x = std::round(pose.t.x / kStud) * kStud;
    pose.t.z = std::round(pose.t.z / kStud) * kStud;
  }
  const double depth = std::max(bm::length(at - ray.from), 1.0);
  const double halfHeight = camera.orthoHalfHeight > 0 ? camera.orthoHalfHeight : std::tan(camera.fovY * 0.5) * depth;
  const double reach = std::clamp(28 * halfHeight / view.y, 7.0, 20.0);
  const auto grip = input.grip < 0 ? std::nullopt : std::optional(static_cast<uint32_t>(input.grip));
  const std::span<const MovingPiece> moved = move ? std::span(move->pieces) : std::span<const MovingPiece>{};
  // The hand holds a new part by its underside centre, a moved one where the pointer took it.
  PlacementAim aim{ray.from, bm::normalized(ray.dir), std::nullopt, {}};
  if (surface) aim.hitDepth = bm::dot(surface->point - ray.from, aim.dir);
  if (move) {
    const auto& original = revision->model.pieces()[input.anchor].world;
    aim.held = original.inverse().apply(original.t - grabOffset);
  } else {
    const auto& local = mesh->bounds;
    aim.held = {(local.min.x + local.max.x) * 0.5, local.max.y, (local.min.z + local.max.z) * 0.5};
  }
  const auto placement = engine.solver->solve({input.part, pose, at, reach, grip, retained, moving, input.snap,
                                              hidden, moved, input.anchor, input.reference, input.collision, {}, aim});
  if (!placement) {
    preview.reason = "Move the pointer onto the model or the floor.";
    return result;
  }

  std::visit([&](const auto& placed) {
    preview.pose = bridgePose(placed.pose);
    using Value = std::decay_t<decltype(placed)>;
    if constexpr (std::is_same_v<Value, PlacedOnConnector>) {
      preview.state = PlacementState::Snapped;
      preview.grip = placed.grip;
      preview.contact = {placed.contact.x, placed.contact.y, placed.contact.z};
      result.site = placed.site;
    } else if constexpr (std::is_same_v<Value, PlacementBlocked>) {
      preview.state = PlacementState::Blocked;
      const auto& blocker = revision->model.pieces()[placed.blocker];
      const auto* file = revision->model.library().find(blocker.part);
      preview.reason = "Intersects " + (file && !file->description.empty() ? file->description : blocker.part) + ".";
    } else if constexpr (std::is_same_v<Value, PlacedFromExample>) {
      preview.state = PlacementState::Reference;
      preview.contact = preview.pose.position;
    } else {
      preview.state = PlacementState::Free;
    }
  }, *placement);
  return result;
}

}  // namespace

struct PlacementWorker::State {
  dispatch_queue_t queue = dispatch_queue_create_with_target("com.brickmotion.placement", DISPATCH_QUEUE_SERIAL,
                                                            dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0));
  std::mutex handoff;
  bool running = false;  ///< also guarded by handoff
  std::optional<Request> latest;
  std::optional<Result> finished;
  std::unique_ptr<PreparedModel> prepared;  ///< accessed only on queue

  void run() {
    for (;;) {
      std::optional<Request> next;
      {
        std::lock_guard lock(handoff);
        next.swap(latest);
        if (!next) {
          running = false;
          return;
        }
      }
      Result result;
      try {
        if (!prepared || prepared->scene->generation != next->scene->generation)
          prepared = std::make_unique<PreparedModel>(next->scene);
        else if (prepared->scene != next->scene || !prepared->solver)
          prepared->reset(next->scene);
        result = solve(*prepared, *next);
      } catch (const std::exception&) {
        result.preview.state = PlacementState::Unavailable;
        result.preview.request = next->number;
        result.preview.generation = next->scene->generation;
        result.preview.version = next->scene->version;
        result.preview.reason = "The placement preview could not be prepared.";
      }
      std::lock_guard lock(handoff);
      finished = std::move(result);
    }
  }
};

PlacementWorker::PlacementWorker() : state_(std::make_shared<State>()) {}
PlacementWorker::~PlacementWorker() { clearPending(); }

void PlacementWorker::submit(Request request) {
  const auto state = state_;
  {
    std::lock_guard lock(state->handoff);
    state->latest = std::move(request);
    if (state->running) return;
    state->running = true;
  }
  dispatch_async(state->queue, ^{ state->run(); });
}

std::optional<PlacementWorker::Result> PlacementWorker::take() {
  std::lock_guard lock(state_->handoff);
  std::optional<Result> out;
  out.swap(state_->finished);
  return out;
}

void PlacementWorker::clearPending() {
  std::lock_guard lock(state_->handoff);
  state_->latest.reset();
  state_->finished.reset();
}

}  // namespace bmapp
