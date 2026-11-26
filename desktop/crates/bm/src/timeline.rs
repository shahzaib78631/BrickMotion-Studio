//! Planned Build timeline snapshot, Build lanes, lane packing and timeline-view maths.
use bm_sys as sys;

use crate::{Session, borrowed};

#[derive(Debug, Clone, PartialEq)]
pub struct FlightRow {
    pub piece: u32,
    pub step: i32,
    pub depth: i32,
    pub color: i32,
    pub start: f64,
    pub end: f64,
    pub name: String,
    pub flag: String,
    pub blocker: String,
    pub independent: bool,
}

/// Owned snapshot of a planned Build timeline. Keeps the C handle alive so `BuildLanes` and
/// `arrival_target` pass it back to C++ without rebuilding.
pub struct BuildTimeline {
    raw: *mut sys::BmTimeline,
    pub version: u64,
    pub duration: f64,
    pub fps: f64,
    pub build_start: f64,
    pub build_end: f64,
    pub planning_ms: f64,
    pub standard_preview: bool,
    pub flights: Vec<FlightRow>,
    pub notes: Vec<String>,
}

// Plain engine value owned exclusively by this struct; no thread affinity.
unsafe impl Send for BuildTimeline {}

impl BuildTimeline {
    pub(crate) fn from_raw(raw: *mut sys::BmTimeline) -> Option<Self> {
        if raw.is_null() {
            return None;
        }
        let info = unsafe { sys::bm_timeline_info(raw) };
        let fn_len = unsafe { sys::bm_timeline_flights_len(raw) };
        let flights = (0..fn_len)
            .map(|i| {
                let r = unsafe { sys::bm_timeline_flight_at(raw, i) };
                FlightRow {
                    piece: r.piece,
                    step: r.step,
                    depth: r.depth,
                    color: r.color,
                    start: r.start,
                    end: r.end,
                    name: borrowed(r.name),
                    flag: borrowed(r.flag),
                    blocker: borrowed(r.blocker),
                    independent: r.independent,
                }
            })
            .collect();
        let nn_len = unsafe { sys::bm_timeline_notes_len(raw) };
        let notes = (0..nn_len)
            .map(|i| borrowed(unsafe { sys::bm_timeline_note_at(raw, i) }))
            .collect();
        Some(Self {
            raw,
            version: info.version,
            duration: info.duration,
            fps: info.fps,
            build_start: info.build_start,
            build_end: info.build_end,
            planning_ms: info.planning_ms,
            standard_preview: info.standard_preview,
            flights,
            notes,
        })
    }

    pub fn lanes(&self, session: Option<&Session>) -> BuildLanes {
        BuildLanes::new(self, session)
    }
}

impl Drop for BuildTimeline {
    fn drop(&mut self) {
        unsafe { sys::bm_timeline_free(self.raw) }
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct LaneRun {
    pub id: usize,
    pub step: i32,
    pub start: f64,
    pub end: f64,
    pub next: f64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct LaneStep {
    pub step: i32,
    pub start: f64,
    pub end: f64,
    pub pause_end: f64,
    pub flights: Vec<usize>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct LaneSubmodel {
    pub scheduled: bool,
    pub flight: i32,
    pub item: u64,
    pub depth: i32,
    pub start: f64,
    pub end: f64,
    pub attach: Option<f64>,
    pub name: String,
    pub path: Vec<String>,
    pub pieces: Vec<u32>,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ArrivalTarget {
    pub step: i32,
    pub before: usize,
    pub time: f64,
}

/// Lanes computed from a `BuildTimeline` by `bmapp::buildLanes`. Keeps its C handle alive so
/// `run_index_at`, `travel` and `arrival_target` run in C++ without rebuilding.
pub struct BuildLanes {
    raw: *mut sys::BmLanes,
    pub runs: Vec<LaneRun>,
    pub steps: Vec<LaneStep>,
    pub submodels: Vec<LaneSubmodel>,
    pub diagnostics: Vec<usize>,
}

unsafe impl Send for BuildLanes {}

impl BuildLanes {
    pub fn new(timeline: &BuildTimeline, session: Option<&Session>) -> Self {
        let s_raw = session.map_or(std::ptr::null(), |s| s.raw);
        let raw = unsafe { sys::bm_lanes_new(timeline.raw, s_raw) };
        if raw.is_null() {
            return Self {
                raw,
                runs: Vec::new(),
                steps: Vec::new(),
                submodels: Vec::new(),
                diagnostics: Vec::new(),
            };
        }

        let runs_len = unsafe { sys::bm_lanes_runs_len(raw) };
        let runs = (0..runs_len)
            .map(|i| {
                let r = unsafe { sys::bm_lanes_run_at(raw, i) };
                LaneRun { id: r.id, step: r.step, start: r.start, end: r.end, next: r.next }
            })
            .collect();

        let steps_len = unsafe { sys::bm_lanes_steps_len(raw) };
        let steps = (0..steps_len)
            .map(|i| {
                let st = unsafe { sys::bm_lanes_step_at(raw, i) };
                let mut flights = vec![0usize; st.flights];
                let got = unsafe { sys::bm_lanes_step_flights(raw, i, flights.as_mut_ptr(), flights.len()) };
                flights.truncate(got.min(st.flights));
                LaneStep { step: st.step, start: st.start, end: st.end, pause_end: st.pause_end, flights }
            })
            .collect();

        let sub_len = unsafe { sys::bm_lanes_submodels_len(raw) };
        let submodels = (0..sub_len)
            .map(|i| {
                let sm = unsafe { sys::bm_lanes_submodel_at(raw, i) };
                let mut pieces = vec![0u32; sm.pieces];
                let got = unsafe { sys::bm_lanes_submodel_pieces(raw, i, pieces.as_mut_ptr(), pieces.len()) };
                pieces.truncate(got.min(sm.pieces));
                let raw_path = crate::take_string(unsafe { sys::bm_lanes_submodel_path(raw, i) });
                let path = if raw_path.is_empty() {
                    Vec::new()
                } else {
                    raw_path.split('\n').map(str::to_owned).collect()
                };
                LaneSubmodel {
                    scheduled: sm.scheduled,
                    flight: sm.flight,
                    item: sm.item,
                    depth: sm.depth,
                    start: sm.start,
                    end: sm.end,
                    attach: sm.has_attach.then_some(sm.attach),
                    name: borrowed(sm.name),
                    path,
                    pieces,
                }
            })
            .collect();

        let diag_len = unsafe { sys::bm_lanes_diagnostics(raw, std::ptr::null_mut(), 0) };
        let mut diagnostics = vec![0usize; diag_len];
        let got = unsafe { sys::bm_lanes_diagnostics(raw, diagnostics.as_mut_ptr(), diagnostics.len()) };
        diagnostics.truncate(got.min(diag_len));

        Self { raw, runs, steps, submodels, diagnostics }
    }

    pub fn run_index_at(&self, seconds: f64) -> Option<usize> {
        let idx = unsafe { sys::bm_lanes_run_index_at(self.raw, seconds) };
        (idx >= 0).then_some(idx as usize)
    }

    pub fn travel(&self, time: f64, duration: f64, forward: bool) -> f64 {
        unsafe { sys::bm_lanes_travel(self.raw, time, duration, forward) }
    }

    pub fn arrival_target(
        &self,
        timeline: &BuildTimeline,
        session: Option<&Session>,
        time: f64,
        excluding: &[u32],
    ) -> Option<ArrivalTarget> {
        let s_raw = session.map_or(std::ptr::null(), |s| s.raw);
        let (mut step, mut before, mut at) = (0i32, 0usize, 0.0f64);
        let ok = unsafe {
            sys::bm_lanes_arrival_target(
                self.raw,
                timeline.raw,
                s_raw,
                time,
                excluding.as_ptr(),
                excluding.len(),
                &mut step,
                &mut before,
                &mut at,
            )
        };
        ok.then_some(ArrivalTarget { step, before, time: at })
    }
}

impl Drop for BuildLanes {
    fn drop(&mut self) {
        unsafe { sys::bm_lanes_free(self.raw) }
    }
}

/// Packs x/width spans (sorted by x) into non-overlapping rows; returns `(rows, row_count)`.
pub fn pack_lane(spans: &[(f64, f64)]) -> (Vec<u32>, usize) {
    if spans.is_empty() {
        return (Vec::new(), 0);
    }
    let xs: Vec<f64> = spans.iter().map(|s| s.0).collect();
    let ws: Vec<f64> = spans.iter().map(|s| s.1).collect();
    let mut rows = vec![0u32; spans.len()];
    let count = unsafe { sys::bm_pack_lane(xs.as_ptr(), ws.as_ptr(), spans.len(), rows.as_mut_ptr()) };
    (rows, count)
}

/// Ruler tick spacing (1, 2 or 5 × 10^n) keeping labels ~76 px apart.
pub fn tick_interval(duration: f64, width: f64) -> f64 {
    unsafe { sys::bm_tick_interval(duration, width) }
}

/// Zoom and scroll state of a timeline track area (mirrors `bmapp::TimelineView`).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct TimelineView {
    pub zoom: f64,
    pub offset: f64,
    pub viewport_width: f64,
    pub lead_inset: f64,
    pub trail_inset: f64,
}

impl Default for TimelineView {
    fn default() -> Self {
        Self {
            zoom: 1.0,
            offset: 0.0,
            viewport_width: 1.0,
            lead_inset: 12.0,
            trail_inset: 12.0,
        }
    }
}

impl TimelineView {
    fn to_raw(self) -> sys::BmTimelineView {
        sys::BmTimelineView {
            zoom: self.zoom,
            offset: self.offset,
            viewport_width: self.viewport_width,
            lead_inset: self.lead_inset,
            trail_inset: self.trail_inset,
        }
    }

    fn apply_raw(&mut self, r: sys::BmTimelineView) {
        self.zoom = r.zoom;
        self.offset = r.offset;
        self.viewport_width = r.viewport_width;
        self.lead_inset = r.lead_inset;
        self.trail_inset = r.trail_inset;
    }

    pub fn logical_width(&self) -> f64 {
        (self.viewport_width - self.lead_inset - self.trail_inset).max(1.0) * self.zoom
    }

    pub fn content_width(&self) -> f64 {
        self.logical_width() + self.lead_inset + self.trail_inset
    }

    pub fn maximum_offset(&self) -> f64 {
        (self.content_width() - self.viewport_width).max(0.0)
    }

    pub fn visible_start(&self) -> f64 {
        ((self.offset - self.lead_inset) / self.logical_width()).max(0.0)
    }

    pub fn visible_end(&self) -> f64 {
        ((self.offset + self.viewport_width - self.lead_inset) / self.logical_width()).min(1.0)
    }

    /// A time's x along the logical width (before the lead inset).
    pub fn x(&self, time: f64, duration: f64) -> f64 {
        self.logical_width() * time / duration.max(0.001)
    }

    /// A time's x inside the visible track viewport (accounting for lead inset and scroll offset).
    pub fn screen_x(&self, time: f64, duration: f64) -> f64 {
        self.x(time, duration) + self.lead_inset - self.offset
    }

    pub fn time_at(&self, screen_x: f64, duration: f64) -> f64 {
        unsafe { sys::bm_timeline_view_time_at(self.to_raw(), screen_x, duration) }
    }

    pub fn magnify(&mut self, factor: f64, screen_x: f64) -> bool {
        let mut raw = self.to_raw();
        let changed = unsafe { sys::bm_timeline_view_magnify(&mut raw, factor, screen_x) };
        self.apply_raw(raw);
        changed
    }

    pub fn zoom_by(&mut self, factor: f64, playhead: f64, duration: f64) -> bool {
        let mut raw = self.to_raw();
        let changed = unsafe { sys::bm_timeline_view_zoom_by(&mut raw, factor, playhead, duration) };
        self.apply_raw(raw);
        changed
    }

    pub fn fit(&mut self) -> bool {
        let mut raw = self.to_raw();
        let changed = unsafe { sys::bm_timeline_view_fit(&mut raw) };
        self.apply_raw(raw);
        changed
    }

    pub fn reveal(&mut self, time: f64, duration: f64, centred: bool) -> bool {
        let mut raw = self.to_raw();
        let changed = unsafe { sys::bm_timeline_view_reveal(&mut raw, time, duration, centred) };
        self.apply_raw(raw);
        changed
    }

    pub fn pan_at_edge(&mut self, screen_x: f64) -> bool {
        let mut raw = self.to_raw();
        let changed = unsafe { sys::bm_timeline_view_pan_at_edge(&mut raw, screen_x) };
        self.apply_raw(raw);
        changed
    }
}
