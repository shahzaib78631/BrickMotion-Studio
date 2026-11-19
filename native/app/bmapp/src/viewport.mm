#include "bmapp/viewport.h"

#import <QuartzCore/QuartzCore.h>
#include <algorithm>
#include <cmath>
#include <deque>
#include <dispatch/dispatch.h>
#include <exception>
#include <mutex>
#include <optional>
#include "bm/jobs.h"
#include "bm/plan/timeline.h"
#include "bmr/camera.h"
#include "bmr/device.h"
#include "bmr/renderer.h"
#include "bmr/tolerances.h"
#include "engine.h"
#include "session_impl.h"

namespace bmapp {

namespace {
constexpr double kPi = 3.14159265358979323846;

/// One planning run. It plans its own copy of the model, so edits made meanwhile cannot reach
/// it; the viewport takes its result only while that result still belongs to what is shown.
struct PlanJob {
  uint64_t version = 0;  ///< the session's version whose model is planned
  bm::CancelToken cancel;
  std::mutex mutex;
  bool done = false;
  std::optional<bmtools::Planned> planned;
  std::string error;
};

double toLinear(double c) { return c <= 0.04045 ? c / 12.92 : std::pow((c + 0.055) / 1.055, 2.4); }
}  // namespace

struct Viewport::Impl {
  Session* session = nullptr;
  bool owned = false;  ///< made by create(): holds a reference to the session
  bool ok = false;
  std::unique_ptr<bmr::Renderer> renderer;
  bmr::OrbitCamera orbit;
  bmr::FrameOptions options;
  int width = 0, height = 0;
  double scale = 2;
  bool dirty = true;
  bool framed = false;  ///< the first resize frames the model

  std::shared_ptr<PlanJob> job;
  std::optional<bmtools::Planned> planned;  ///< taken from the job on the main thread
  uint64_t plannedVersion = 0;               ///< the session's version it was planned from
  uint64_t seen = 0;                         ///< the session's version last drawn
  uint64_t seenSelection = 0, seenHidden = 0;  ///< the session's view state last sent to the renderer
  std::string planError;
  bool playing = false, wantPlay = false, userMoved = false;
  double frame = -1;  ///< -1 until planned: the model is shown finished
  double playStartTime = 0, playStartFrame = 0;

  bm::Model* model() const { return session->impl().model.get(); }
  double aspect() const { return height > 0 ? double(width) / height : 1.0; }
  double fps() const { return bm::plan::Style{}.fps; }

  void moved() {
    dirty = true;
    if (playing) userMoved = true;
  }

  /// Sends the session's selection and hiding to the renderer when they have changed.
  void syncView() {
    const Session::Impl& s = session->impl();
    if (seenHidden != s.hiddenStamp) {
      seenHidden = s.hiddenStamp;
      renderer->setHidden(s.hidden);
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
  void follow() {
    const uint64_t now = session->version();
    if (now != seen) {
      if (job) {
        job->cancel.cancel();  // the planning block holds its own reference
        job.reset();
      }
      if (planned) {
        planned.reset();
        renderer->setRest();
      }
      catchUp(now);
      seen = now;
      frame = -1;
      playing = wantPlay = false;
      planError.clear();
      dirty = true;
    }
    if (renderer) syncView();
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
      renderer->modelChanged(*model());
      seenSelection = seenHidden = UINT64_MAX;  // pieces may have new indexes: send both again
      return;
    }
    auto tidy = [](std::vector<uint32_t>& v) {
      std::sort(v.begin(), v.end());
      v.erase(std::unique(v.begin(), v.end()), v.end());
    };
    tidy(moved), tidy(recolored);
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

  void startPlanning() {
    follow();
    if (job || planned || !model()) return;
    auto j = std::make_shared<PlanJob>();
    j->version = session->version();
    job = j;
    auto copy = std::make_shared<bm::Model>(*model());
    Session::Impl& s = session->impl();
    const bm::ldraw::Library* library = s.library.get();
    bm::ldraw::PartCache* full = s.full.get();
    const std::filesystem::path ldraw = s.ldraw, file = s.file;
    dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
      std::optional<bmtools::Planned> planned;
      std::string error;
      try {
        bm::plan::Options options;
        options.cancel = &j->cancel;
        planned = bmtools::planModel(*copy, *library, *full, ldraw, options, bm::plan::styleOf(file));
      } catch (const std::exception& e) {
        error = e.what();
      }
      std::lock_guard lock(j->mutex);
      j->planned = std::move(planned);
      j->error = error;
      j->done = true;
    });
  }

  /// On the main thread, before a frame: takes a finished plan.
  void collectPlan() {
    if (!job) return;
    std::lock_guard lock(job->mutex);
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
      plannedVersion = job->version;
      frame = planned->timeline.frames;  // the finished model, which is what is shown
    } else {
      planError = job->error.empty() ? "Planning stopped." : job->error;
    }
    job.reset();
    if (planned && wantPlay) startPlaying();
    dirty = true;
  }

  void showFrame(double f) {
    if (!planned) return;
    f = std::clamp(f, 0.0, static_cast<double>(planned->timeline.frames));
    if (f == frame) return;
    frame = f;
    renderer->setFrame(planned->plan, planned->timeline, f);
    if (playing && !userMoved && !planned->timeline.camera.empty()) {
      const bmr::OrbitCamera along = bmr::OrbitCamera::along(planned->timeline, f);
      orbit = along;
    }
    dirty = true;
  }

  void startPlaying() {
    if (!planned) return;
    if (frame >= planned->timeline.frames) showFrame(0);
    playing = true, userMoved = false;
    playStartTime = CACurrentMediaTime(), playStartFrame = frame;
    dirty = true;
  }

  void advance() {
    const double f = std::min(static_cast<double>(planned->timeline.frames), playStartFrame + (CACurrentMediaTime() - playStartTime) * fps());
    showFrame(f);
    if (f >= planned->timeline.frames) playing = false;
  }

  void fit(double azimuth, double elevation) {
    if (!renderer) return;
    const bm::Box box = renderer->scene().bounds;
    if (box.empty()) return;
    orbit = bmr::OrbitCamera::fitted(box, orbit.fovY, aspect(), azimuth, elevation);
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
  v.seen = session.version();
  Session::Impl& s = session.impl();
  if (!s.model || !bmr::gpuAvailable()) return;
  v.renderer = bmr::Renderer::create(*s.model, *s.full, *s.low);
  v.ok = v.renderer != nullptr;
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
  if (!v.ok) return false;
  v.follow();
  v.collectPlan();
  if (v.playing && v.planned) v.advance();
  const bmr::FrameStats s = v.renderer->draw(v.orbit.camera(v.aspect(), v.renderer->scene().bounds), v.options, metalDrawable);
  v.dirty = v.playing || s.settling || (!s.submitted && v.width > 0 && v.height > 0) || v.job != nullptr;
  return v.dirty;
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

bool Viewport::needsDraw() const { return impl_->dirty || impl_->job != nullptr; }

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
  return c;
}

void Viewport::play(bool on) {
  Impl& v = *impl_;
  if (!v.ok) return;
  v.follow();
  v.wantPlay = on;
  if (!on) {
    v.playing = false;
    v.dirty = true;
    return;
  }
  if (v.planned) v.startPlaying();
  else v.startPlanning();
  v.dirty = true;
}

bool Viewport::playing() const { return impl_->playing; }
double Viewport::seconds() const { return impl_->planned ? std::max(0.0, impl_->frame) / impl_->fps() : 0; }
double Viewport::length() const { return impl_->planned ? impl_->planned->timeline.frames / impl_->fps() : 0; }

void Viewport::seek(double seconds) {
  Impl& v = *impl_;
  if (!v.planned) return;
  v.playing = false;
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
  const bmr::Camera camera = v.orbit.camera(v.aspect(), scene.bounds);
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

PlanState Viewport::planState() const {
  const Impl& v = *impl_;
  const uint64_t now = v.session->version();
  if (v.planned && v.plannedVersion == now) return PlanState::Ready;
  if (v.job && v.job->version == now) return PlanState::Planning;
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
