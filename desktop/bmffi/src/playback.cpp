// Playback, planning, timeline snapshots, Build lanes, lane packing and timeline-view maths.
#include <algorithm>
#include <cstring>
#include <vector>

#include "bmapp/build_lanes.h"
#include "bmapp/timeline_view.h"
#include "bmffi.h"
#include "internal.h"

struct BmTimeline {
  bmapp::BuildTimeline timeline;
};

struct BmLanes {
  bmapp::BuildLanes lanes;
};

namespace {

BmPlanState fromPlanState(bmapp::PlanState s) {
  switch (s) {
    case bmapp::PlanState::Idle: return BM_PLAN_IDLE;
    case bmapp::PlanState::Planning: return BM_PLAN_PLANNING;
    case bmapp::PlanState::Ready: return BM_PLAN_READY;
    case bmapp::PlanState::Failed: return BM_PLAN_FAILED;
  }
  return BM_PLAN_IDLE;
}

BmPlanStage fromPlanStage(bmapp::PlanStage s) {
  switch (s) {
    case bmapp::PlanStage::Waiting: return BM_STAGE_WAITING;
    case bmapp::PlanStage::Solving: return BM_STAGE_SOLVING;
    case bmapp::PlanStage::CheckingFlights: return BM_STAGE_CHECKING_FLIGHTS;
    case bmapp::PlanStage::Preparing: return BM_STAGE_PREPARING;
    case bmapp::PlanStage::StandardPreview: return BM_STAGE_STANDARD_PREVIEW;
  }
  return BM_STAGE_WAITING;
}

bmapp::AssemblyPreview toAssemblyPreview(BmAssemblyPreview m) {
  switch (m) {
    case BM_PREVIEW_ASSEMBLED: return bmapp::AssemblyPreview::Assembled;
    case BM_PREVIEW_SEPARATED: return bmapp::AssemblyPreview::Separated;
    case BM_PREVIEW_LAID_OUT: return bmapp::AssemblyPreview::LaidOut;
    case BM_PREVIEW_EXPLODED: return bmapp::AssemblyPreview::Exploded;
  }
  return bmapp::AssemblyPreview::Assembled;
}

bmapp::TimelineView toView(BmTimelineView v) {
  bmapp::TimelineView out;
  out.zoom = v.zoom;
  out.offset = v.offset;
  out.viewportWidth = v.viewport_width;
  out.leadInset = v.lead_inset;
  out.trailInset = v.trail_inset;
  return out;
}

void writeView(BmTimelineView* dst, const bmapp::TimelineView& src) {
  dst->zoom = src.zoom;
  dst->offset = src.offset;
  dst->viewport_width = src.viewportWidth;
  dst->lead_inset = src.leadInset;
  dst->trail_inset = src.trailInset;
}

template <typename T>
size_t copySlice(const std::vector<T>& src, T* out, size_t cap) {
  if (out && cap > 0 && !src.empty()) {
    const size_t n = std::min(src.size(), cap);
    std::memcpy(out, src.data(), n * sizeof(T));
  }
  return src.size();
}

}  // namespace

extern "C" {

void bm_viewport_play(BmViewport* v, bool on) {
  if (!v) return;
  bmffi::guardVoid([&] { v->v->play(on); });
}

void bm_viewport_play_range(BmViewport* v, double start, double end) {
  if (!v) return;
  bmffi::guardVoid([&] { v->v->playRange(start, end); });
}

void bm_viewport_seek(BmViewport* v, double seconds) {
  if (!v) return;
  bmffi::guardVoid([&] { v->v->seek(seconds); });
}

void bm_viewport_set_playback_rate(BmViewport* v, double rate) {
  if (!v) return;
  bmffi::guardVoid([&] { v->v->setPlaybackRate(rate); });
}

void bm_viewport_set_playback_loop(BmViewport* v, bool loop) {
  if (!v) return;
  bmffi::guardVoid([&] { v->v->setPlaybackLoop(loop); });
}

void bm_viewport_request_plan(BmViewport* v) {
  if (!v) return;
  bmffi::guardVoid([&] { v->v->requestPlan(); });
}

void bm_viewport_regenerate_plan(BmViewport* v, bool standard_preview) {
  if (!v) return;
  bmffi::guardVoid([&] { v->v->regeneratePlan(standard_preview); });
}

BmPlaybackState bm_viewport_playback_state(const BmViewport* v) {
  const BmPlaybackState empty{0, 0, false, false, true, false, BM_PLAN_IDLE, 0, BM_STAGE_WAITING};
  if (!v) return empty;
  return bmffi::guard(empty, [&] {
    const bmapp::PlaybackState st = v->v->playbackState();
    return BmPlaybackState{st.seconds, st.duration, st.playing, st.waitingToPlay, st.atRest, st.stale,
                           fromPlanState(st.plan), st.version, fromPlanStage(st.stage)};
  });
}

BmString bm_viewport_plan_error(const BmViewport* v) {
  if (!v) return BmString{nullptr, 0};
  return bmffi::guard(BmString{nullptr, 0}, [&] { return bmffi::make(v->v->planError()); });
}

uint64_t bm_viewport_planned_version(const BmViewport* v) {
  if (!v) return 0;
  return bmffi::guard<uint64_t>(0, [&] { return v->v->plannedVersion(); });
}

void bm_viewport_set_preferences(BmViewport* v, BmViewportPreferences p) {
  if (!v) return;
  bmffi::guardVoid([&] {
    bmapp::ViewportPreferences prefs;
    prefs.edges = p.edges;
    prefs.floor = p.floor;
    prefs.shadows = p.shadows;
    prefs.ambientOcclusion = p.ambient_occlusion;
    prefs.autoPlan = p.auto_plan;
    prefs.sceneBackdrop = p.scene_backdrop;
    v->v->setPreferences(prefs);
  });
}

void bm_viewport_arrange(BmViewport* v, int32_t step, BmAssemblyPreview mode) {
  if (!v) return;
  bmffi::guardVoid([&] { v->v->arrange(step, toAssemblyPreview(mode)); });
}

size_t bm_viewport_build_order(BmViewport* v, uint32_t* out, size_t cap) {
  if (!v) return 0;
  return bmffi::guard<size_t>(0, [&] { return copySlice(v->v->buildOrder(), out, cap); });
}

BmTimeline* bm_viewport_build_timeline(const BmViewport* v) {
  if (!v) return nullptr;
  return bmffi::handle<BmTimeline>([&] { return new BmTimeline{v->v->buildTimeline()}; });
}

BmTimelineInfo bm_timeline_info(const BmTimeline* t) {
  const BmTimelineInfo empty{0, 0, 30, 0, 0, 0, false};
  if (!t) return empty;
  const bmapp::BuildTimeline& tl = t->timeline;
  return BmTimelineInfo{tl.version, tl.duration, tl.framesPerSecond, tl.buildStart, tl.buildEnd,
                        tl.planningMilliseconds, tl.standardPreview};
}

size_t bm_timeline_flights_len(const BmTimeline* t) {
  return t ? t->timeline.flights.size() : 0;
}

BmFlightRow bm_timeline_flight_at(const BmTimeline* t, size_t i) {
  if (!t || i >= t->timeline.flights.size())
    return BmFlightRow{BM_NO_PIECE, 0, 0, 16, 0, 0, "", "", "", false};
  const bmapp::BuildFlightRow& f = t->timeline.flights[i];
  return BmFlightRow{f.piece, f.step, f.depth, f.color, f.start, f.end, f.name.c_str(), f.flag.c_str(),
                     f.blocker.c_str(), f.independent};
}

size_t bm_timeline_notes_len(const BmTimeline* t) {
  return t ? t->timeline.notes.size() : 0;
}

const char* bm_timeline_note_at(const BmTimeline* t, size_t i) {
  if (!t || i >= t->timeline.notes.size()) return "";
  return t->timeline.notes[i].c_str();
}

void bm_timeline_free(BmTimeline* t) {
  delete t;
}

BmLanes* bm_lanes_new(const BmTimeline* t, const BmSession* s) {
  if (!t) return nullptr;
  return bmffi::handle<BmLanes>(
      [&] { return new BmLanes{bmapp::buildLanes(t->timeline, s ? s->s : nullptr)}; });
}

size_t bm_lanes_runs_len(const BmLanes* l) {
  return l ? l->lanes.runs.size() : 0;
}

BmLaneRun bm_lanes_run_at(const BmLanes* l, size_t i) {
  if (!l || i >= l->lanes.runs.size()) return BmLaneRun{0, 0, 0, 0, 0};
  const bmapp::LaneRun& r = l->lanes.runs[i];
  return BmLaneRun{r.id, r.step, r.start, r.end, r.next};
}

size_t bm_lanes_steps_len(const BmLanes* l) {
  return l ? l->lanes.steps.size() : 0;
}

BmLaneStep bm_lanes_step_at(const BmLanes* l, size_t i) {
  if (!l || i >= l->lanes.steps.size()) return BmLaneStep{0, 0, 0, 0, 0};
  const bmapp::LaneStep& st = l->lanes.steps[i];
  return BmLaneStep{st.step, st.start, st.end, st.pauseEnd, st.flights.size()};
}

size_t bm_lanes_step_flights(const BmLanes* l, size_t i, size_t* out, size_t cap) {
  if (!l || i >= l->lanes.steps.size()) return 0;
  return copySlice(l->lanes.steps[i].flights, out, cap);
}

size_t bm_lanes_submodels_len(const BmLanes* l) {
  return l ? l->lanes.submodels.size() : 0;
}

BmLaneSubmodel bm_lanes_submodel_at(const BmLanes* l, size_t i) {
  if (!l || i >= l->lanes.submodels.size())
    return BmLaneSubmodel{false, -1, 0, 0, 0, 0, 0, false, "", 0};
  const bmapp::LaneSubmodel& sm = l->lanes.submodels[i];
  const char* name = sm.path.empty() ? "" : sm.path.back().c_str();
  const bool hasAttach = sm.attach >= 0;
  return BmLaneSubmodel{sm.scheduled, sm.flight, sm.item, sm.depth, sm.start, sm.end,
                        hasAttach ? sm.attach : 0, hasAttach, name, sm.pieces.size()};
}

size_t bm_lanes_submodel_pieces(const BmLanes* l, size_t i, uint32_t* out, size_t cap) {
  if (!l || i >= l->lanes.submodels.size()) return 0;
  return copySlice(l->lanes.submodels[i].pieces, out, cap);
}

size_t bm_lanes_diagnostics(const BmLanes* l, size_t* out, size_t cap) {
  if (!l) return 0;
  return copySlice(l->lanes.diagnostics, out, cap);
}

int64_t bm_lanes_run_index_at(const BmLanes* l, double seconds) {
  if (!l) return -1;
  size_t run = 0;
  return bmapp::runAt(l->lanes, seconds, &run) ? static_cast<int64_t>(run) : -1;
}

double bm_lanes_travel(const BmLanes* l, double time, double duration, bool forward) {
  if (!l) return forward ? duration : 0;
  return bmapp::travel(l->lanes, time, duration, forward);
}

bool bm_lanes_arrival_target(const BmLanes* l, const BmTimeline* t, const BmSession* s, double time,
                             const uint32_t* excluding, size_t n, int32_t* step, size_t* before,
                             double* at) {
  if (!l || !t) return false;
  return bmffi::guard(false, [&] {
    const bmapp::ArrivalTarget target =
        bmapp::arrivalTarget(l->lanes, t->timeline, s ? s->s : nullptr, time, bmffi::list(excluding, n));
    if (!target.ok) return false;
    if (step) *step = target.step;
    if (before) *before = target.before;
    if (at) *at = target.time;
    return true;
  });
}

void bm_lanes_free(BmLanes* l) {
  delete l;
}

size_t bm_pack_lane(const double* x, const double* width, size_t n, uint32_t* rows_out) {
  if (!x || !width || n == 0) return 0;
  return bmffi::guard<size_t>(0, [&] {
    bmapp::LaneSpanList spans;
    spans.reserve(n);
    for (size_t i = 0; i < n; ++i) spans.push_back(bmapp::LaneSpan{x[i], width[i]});
    const bmapp::LanePacking packed = bmapp::packLane(spans);
    if (rows_out && !packed.rows.empty())
      std::memcpy(rows_out, packed.rows.data(), std::min(n, packed.rows.size()) * sizeof(uint32_t));
    return packed.count;
  });
}

bool bm_timeline_view_magnify(BmTimelineView* view, double factor, double screen_x) {
  if (!view) return false;
  bmapp::TimelineView v = toView(*view);
  const bool changed = v.magnify(factor, screen_x);
  writeView(view, v);
  return changed;
}

bool bm_timeline_view_zoom_by(BmTimelineView* view, double factor, double playhead, double duration) {
  if (!view) return false;
  bmapp::TimelineView v = toView(*view);
  const bool changed = v.zoomBy(factor, playhead, duration);
  writeView(view, v);
  return changed;
}

bool bm_timeline_view_fit(BmTimelineView* view) {
  if (!view) return false;
  bmapp::TimelineView v = toView(*view);
  const bool changed = v.fit();
  writeView(view, v);
  return changed;
}

bool bm_timeline_view_reveal(BmTimelineView* view, double time, double duration, bool centred) {
  if (!view) return false;
  bmapp::TimelineView v = toView(*view);
  const bool changed = v.reveal(time, duration, centred);
  writeView(view, v);
  return changed;
}

bool bm_timeline_view_pan_at_edge(BmTimelineView* view, double screen_x) {
  if (!view) return false;
  bmapp::TimelineView v = toView(*view);
  const bool changed = v.panAtEdge(screen_x);
  writeView(view, v);
  return changed;
}

double bm_timeline_view_time_at(BmTimelineView view, double screen_x, double duration) {
  return toView(view).timeAt(screen_x, duration);
}

double bm_tick_interval(double duration, double width) {
  return bmapp::tickInterval(duration, width);
}

}  // extern "C"
