//! Playback transport, planner status, cached Build timeline and lanes.
//! Mirrors `AnimationWorkspace.swift`: never mixes lanes from one plan version with a newer state.
use std::collections::HashSet;
use std::rc::Rc;

use bm::playback::{AssemblyPreview, PlanStage, PlanState, PlaybackState};
use bm::timeline::{BuildLanes, BuildTimeline, FlightRow};

/// Whether a request made at session version `expected` runs on a plan of version `planned`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Due {
    Now,
    Later,
    Dropped,
}

pub(crate) fn due(expected: u64, planned: u64) -> Due {
    match planned.cmp(&expected) {
        std::cmp::Ordering::Equal => Due::Now,
        std::cmp::Ordering::Less => Due::Later,
        std::cmp::Ordering::Greater => Due::Dropped,
    }
}

/// Which clock the timeline and the viewport follow.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Clock {
    /// The planned build: steps, flights and pauses.
    #[default]
    Build,
    /// The key scene: frames from `first` to `last` at the scene's frame rate.
    Keyframes,
}

/// Playback and planner state for the open document.
pub struct Transport {
    clock: Clock,
    /// The session's key scene, read again whenever the session version changes.
    pub key_scene: bm::keys::KeyScene,
    key_scene_version: Option<u64>,
    /// The Keyframes playhead, put back when a finished plan drops the viewport to rest.
    scene_time: f64,
    pub state: PlaybackState,
    /// The session version the cached `timeline` and `lanes` were built from.
    pub version: Option<u64>,
    pub timeline: Option<Rc<BuildTimeline>>,
    pub lanes: Option<Rc<BuildLanes>>,
    pub pins: HashSet<u32>,
    pub failure: String,
    pub rate: f64,
    pub looping: bool,
    pub focused_step: Option<usize>,
    pub step_preview: Option<AssemblyPreview>,
    pub playhead_run: Option<usize>,
    last_build_time: f64,
    pending_step: Option<(usize, bool, u64)>,
    rebuild_steps_at: Option<u64>,
    pub staging_preview_at: Option<u64>,
    generation: Option<u64>,
    pins_version: Option<u64>,
    pending_change: Option<bm::Changed>,
    /// Test seam: forces a Failed plan state with this error message.
    #[doc(hidden)]
    pub forced_failure: Option<String>,
}

impl Default for Transport {
    fn default() -> Self {
        Self {
            clock: Clock::Build,
            key_scene: bm::keys::KeyScene::default(),
            key_scene_version: None,
            scene_time: 0.0,
            state: PlaybackState::default(),
            version: None,
            timeline: None,
            lanes: None,
            pins: HashSet::new(),
            failure: String::new(),
            rate: 1.0,
            looping: false,
            focused_step: None,
            step_preview: None,
            playhead_run: None,
            last_build_time: 0.0,
            pending_step: None,
            rebuild_steps_at: None,
            staging_preview_at: None,
            generation: None,
            pins_version: None,
            pending_change: None,
            forced_failure: None,
        }
    }
}

impl Transport {
    /// Polls the viewport's playback and planner state once per frame. Returns true when anything
    /// visible changed. Never replaces `timeline`/`lanes` until a new Ready version arrives.
    pub fn update(&mut self, session: &bm::Session, vp: &mut bm::Viewport) -> bool {
        let mut changed = false;
        let doc_gen = session.generation();
        if self.generation != Some(doc_gen) {
            self.reset();
            vp.use_keyframes(false);
            self.generation = Some(doc_gen);
            vp.set_playback_rate(self.rate);
            vp.set_playback_loop(self.looping);
            changed = true;
        }

        let next = vp.playback_state();
        if let Some(msg) = &self.forced_failure {
            let was = self.state.plan == PlanState::Failed && self.failure == *msg;
            self.state = next;
            self.state.plan = PlanState::Failed;
            self.failure = msg.clone();
            return !was;
        }
        if self.clock == Clock::Build && next.plan == PlanState::Ready {
            self.last_build_time = if next.at_rest { next.duration } else { next.seconds };
        }
        let status_changed = next.plan != self.state.plan
            || next.version != self.state.version
            || next.playing != self.state.playing
            || next.waiting_to_play != self.state.waiting_to_play
            || next.at_rest != self.state.at_rest
            || next.stale != self.state.stale
            || (next.duration - self.state.duration).abs() > 1e-6
            || next.stage != self.state.stage;
        let fps = self.clock_fps().max(1.0);
        let time_changed = (next.seconds * fps).floor() != (self.state.seconds * fps).floor();
        if status_changed || time_changed {
            changed = true;
        }
        self.state = next;
        if self.clock == Clock::Keyframes {
            if !next.at_rest {
                self.scene_time = next.seconds;
            } else if self.scene_shows_time() {
                // A plan landing resets the viewport's frame; the Keyframes playhead stays put.
                vp.seek(self.scene_time);
                self.state = vp.playback_state();
                changed = true;
            }
        }

        let error = if next.plan == PlanState::Failed { vp.plan_error() } else { String::new() };
        if self.failure != error {
            self.failure = error;
            changed = true;
        }

        let cur_ver = session.version();
        if self.key_scene_version != Some(cur_ver) {
            let scene = session.key_scene();
            if scene != self.key_scene {
                self.key_scene = scene;
                changed = true;
            }
            self.key_scene_version = Some(cur_ver);
        }
        if self.pins_version != Some(cur_ver) {
            self.pins = session.arrival_pins().into_iter().collect();
            self.pins_version = Some(cur_ver);
        }

        if next.plan == PlanState::Ready && self.version != Some(next.version)
            && let Some(tl) = vp.build_timeline()
        {
            let tl_version = tl.version;
            let lanes = tl.lanes(Some(session));
            self.version = Some(tl_version);
            self.timeline = Some(Rc::new(tl));
            self.lanes = Some(Rc::new(lanes));
            self.pins = session.arrival_pins().into_iter().collect();
            self.pins_version = Some(cur_ver);
            changed = true;

            // Each request waits for the plan of the version it was made at: an older plan that
            // finishes first keeps it, a newer one drops it.
            if let Some(expected) = self.staging_preview_at {
                let d = due(expected, tl_version);
                if d != Due::Later {
                    self.staging_preview_at = None;
                }
                if d == Due::Now {
                    self.seek(vp, 0.0);
                }
            }
            if let Some((step, through_end, expected)) = self.pending_step {
                let d = due(expected, tl_version);
                if d != Due::Later {
                    self.pending_step = None;
                }
                if d == Due::Now {
                    self.play_step_ready(vp, step, through_end);
                }
            }
            if let Some(expected) = self.rebuild_steps_at {
                let d = if cur_ver == expected { due(expected, tl_version) } else { Due::Dropped };
                if d != Due::Later {
                    self.rebuild_steps_at = None;
                }
                if d == Due::Now {
                    let order = vp.build_order();
                    if !order.is_empty() {
                        self.pending_change = Some(session.regenerate_steps(&order));
                    }
                }
            }
        }

        self.update_playhead_run();
        changed
    }

    pub fn take_changed(&mut self) -> Option<bm::Changed> {
        self.pending_change.take()
    }

    pub fn clock(&self) -> Clock {
        self.clock
    }

    /// Switches clocks: playback stops and the playhead goes to the new clock's start.
    pub fn set_clock(&mut self, vp: &mut bm::Viewport, clock: Clock) {
        if self.clock == clock {
            return;
        }
        self.clock = clock;
        self.staging_preview_at = None;
        self.pending_step = None;
        self.focused_step = None;
        self.step_preview = None;
        vp.use_keyframes(clock == Clock::Keyframes);
        self.scene_time = 0.0;
        self.state = vp.playback_state();
        self.update_playhead_run();
    }

    /// Seconds of the key scene: `(last − first) / fps`.
    pub fn scene_length(scene: &bm::keys::KeyScene) -> f64 {
        if scene.fps <= 0 { 0.0 } else { f64::from(scene.last - scene.first) / f64::from(scene.fps) }
    }

    /// The scene frame under the playhead: `first + round(time × fps)`.
    pub fn key_frame(&self, scene: &bm::keys::KeyScene) -> i32 {
        scene.first + (self.time() * f64::from(scene.fps)).round() as i32
    }

    /// Whether the Keyframes clock can show time: a scene that follows the build needs a plan.
    fn scene_shows_time(&self) -> bool {
        !self.key_scene.build_linked || self.ready()
    }

    /// Seeks the Keyframes clock to a scene time, snapped to the scene's frames.
    pub fn seek_scene(&mut self, vp: &mut bm::Viewport, seconds: f64) {
        if !self.scene_shows_time() {
            return;
        }
        let fps = f64::from(self.key_scene.fps.max(1));
        let t = (seconds.clamp(0.0, self.duration().max(0.0)) * fps).round() / fps;
        vp.seek(t);
        self.state = vp.playback_state();
        self.scene_time = self.state.seconds;
    }

    /// Frames per second of the clock in use.
    pub fn clock_fps(&self) -> f64 {
        match self.clock {
            Clock::Build => self.fps(),
            Clock::Keyframes => f64::from(self.key_scene.fps.max(1)),
        }
    }

    fn update_playhead_run(&mut self) {
        if self.clock == Clock::Keyframes {
            self.playhead_run = None;
            return;
        }
        let t = self.time();
        self.playhead_run = self.lanes.as_ref().and_then(|l| l.run_index_at(t));
    }

    pub fn stale_shown(&self) -> bool {
        self.clock == Clock::Build && self.state.stale && self.build_duration() > 0.0
    }

    pub fn build_duration(&self) -> f64 {
        self.timeline.as_ref().map_or(0.0, |t| t.duration)
    }

    pub fn fps(&self) -> f64 {
        self.timeline.as_ref().map_or(30.0, |t| t.fps)
    }

    pub fn build_start(&self) -> f64 {
        self.timeline.as_ref().map_or(0.0, |t| t.build_start)
    }

    pub fn build_end(&self) -> f64 {
        self.timeline.as_ref().map_or(0.0, |t| t.build_end)
    }

    pub fn flights(&self) -> &[FlightRow] {
        self.timeline.as_deref().map_or(&[], |t| &t.flights)
    }

    pub fn notes(&self) -> &[String] {
        self.timeline.as_deref().map_or(&[], |t| &t.notes)
    }

    pub fn standard_preview(&self) -> bool {
        self.timeline.as_ref().is_some_and(|t| t.standard_preview)
    }

    pub fn duration(&self) -> f64 {
        if self.clock == Clock::Keyframes {
            return if self.scene_shows_time() { self.state.duration } else { 0.0 };
        }
        if self.stale_shown() { self.build_duration() } else { self.state.duration }
    }

    pub fn time(&self) -> f64 {
        if self.clock == Clock::Keyframes {
            return if self.scene_shows_time() && !self.state.at_rest { self.state.seconds } else { 0.0 };
        }
        if self.stale_shown() {
            self.last_build_time
        } else if self.state.at_rest {
            self.state.duration
        } else {
            self.state.seconds
        }
    }

    pub fn ready(&self) -> bool {
        self.state.plan == PlanState::Ready
    }

    pub fn busy(&self) -> bool {
        self.state.plan == PlanState::Planning
    }

    pub fn stage_label(&self) -> &'static str {
        match self.state.stage {
            PlanStage::Solving => "Solving Build Order…",
            PlanStage::CheckingFlights => "Checking Flight Paths…",
            PlanStage::Preparing => "Preparing Timeline…",
            PlanStage::StandardPreview => "Planning Standard Preview…",
            PlanStage::Waiting => {
                if self.state.stale {
                    "Updating Build…"
                } else {
                    "Planning Build…"
                }
            }
        }
    }

    pub fn current_step(&self) -> Option<usize> {
        if let Some(s) = self.focused_step {
            return Some(s);
        }
        let idx = self.playhead_run?;
        self.lanes
            .as_ref()?
            .runs
            .get(idx)
            .and_then(|r| usize::try_from(r.step).ok())
    }

    /// Toggles playback (plans first if nothing is planned). Callers cancel live placement first.
    pub fn toggle(&mut self, vp: &mut bm::Viewport) {
        self.step_preview = None;
        let start = !self.state.playing && !self.state.waiting_to_play;
        vp.play(start);
        self.state = vp.playback_state();
        self.update_playhead_run();
    }

    pub fn seek(&mut self, vp: &mut bm::Viewport, seconds: f64) {
        if self.clock == Clock::Keyframes {
            self.seek_scene(vp, seconds);
            return;
        }
        if !self.ready() {
            return;
        }
        self.focused_step = None;
        self.step_preview = None;
        let fps = self.fps().max(1.0);
        let dur = self.duration().max(0.0);
        let frame = (seconds.clamp(0.0, dur) * fps).round() / fps;
        vp.seek(frame);
        self.state = vp.playback_state();
        self.last_build_time = if self.state.at_rest { self.state.duration } else { self.state.seconds };
        self.update_playhead_run();
    }

    pub fn select_run(&mut self, vp: &mut bm::Viewport, run_index: usize) {
        let Some(run) = self.lanes.as_ref().and_then(|l| l.runs.get(run_index)).copied() else {
            return;
        };
        self.seek(vp, run.end);
        self.focused_step = usize::try_from(run.step).ok();
    }

    pub fn rest(&mut self, vp: &mut bm::Viewport) {
        self.staging_preview_at = None;
        self.pending_step = None;
        self.focused_step = None;
        self.step_preview = None;
        vp.show_rest();
        self.state = vp.playback_state();
        self.update_playhead_run();
    }

    pub fn travel(&mut self, vp: &mut bm::Viewport, forward: bool) {
        let Some(t) = self.lanes.as_ref().map(|l| l.travel(self.time(), self.duration(), forward)) else {
            return;
        };
        self.seek(vp, t);
    }

    pub fn play_step(&mut self, vp: &mut bm::Viewport, session: &bm::Session, step: usize, through_end: bool) {
        self.focused_step = Some(step);
        self.step_preview = None;
        let ver = session.version();
        if !self.ready() || self.version != Some(ver) {
            self.pending_step = Some((step, through_end, ver));
            self.plan(vp);
            return;
        }
        self.play_step_ready(vp, step, through_end);
    }

    fn play_step_ready(&mut self, vp: &mut bm::Viewport, step: usize, through_end: bool) {
        let Some(clip) = self
            .lanes
            .as_ref()
            .and_then(|l| l.steps.iter().find(|s| s.step == step as i32))
            .map(|s| (s.start, s.end))
        else {
            return;
        };
        let end = if through_end {
            0.0
        } else {
            (clip.0 + 1.0 / self.fps().max(1.0)).max(clip.1)
        };
        vp.play_range(clip.0, end);
        self.state = vp.playback_state();
        self.update_playhead_run();
    }

    pub fn arrange(&mut self, vp: &mut bm::Viewport, step: Option<usize>, mode: AssemblyPreview) {
        self.focused_step = step;
        self.step_preview = Some(mode);
        vp.arrange(step, mode);
        self.state = vp.playback_state();
        self.update_playhead_run();
    }

    pub fn plan(&mut self, vp: &mut bm::Viewport) {
        vp.request_plan();
        self.state = vp.playback_state();
    }

    pub fn regenerate(&mut self, vp: &mut bm::Viewport, standard: bool) {
        self.version = None;
        vp.regenerate_plan(standard);
        self.state = vp.playback_state();
    }

    pub fn preview_staging(&mut self, session: &bm::Session, vp: &mut bm::Viewport) {
        let ver = session.version();
        if vp.planned_version() == ver && self.ready() {
            self.seek(vp, 0.0);
        } else {
            self.staging_preview_at = Some(ver);
            self.plan(vp);
        }
    }

    pub fn regenerate_steps(&mut self, session: &bm::Session, vp: &mut bm::Viewport) -> Option<bm::Changed> {
        let ver = session.version();
        if self.ready() && self.version == Some(ver) {
            let order = vp.build_order();
            if order.is_empty() {
                None
            } else {
                Some(session.regenerate_steps(&order))
            }
        } else {
            self.rebuild_steps_at = Some(ver);
            self.plan(vp);
            None
        }
    }

    pub fn set_rate(&mut self, vp: &mut bm::Viewport, rate: f64) {
        self.rate = rate;
        vp.set_playback_rate(rate);
    }

    pub fn set_looping(&mut self, vp: &mut bm::Viewport, looping: bool) {
        self.looping = looping;
        vp.set_playback_loop(looping);
    }

    pub fn reset(&mut self) {
        self.clock = Clock::Build;
        self.key_scene = bm::keys::KeyScene::default();
        self.key_scene_version = None;
        self.scene_time = 0.0;
        self.state = PlaybackState::default();
        self.version = None;
        self.timeline = None;
        self.lanes = None;
        self.pins.clear();
        self.failure.clear();
        self.focused_step = None;
        self.step_preview = None;
        self.playhead_run = None;
        self.last_build_time = 0.0;
        self.pending_step = None;
        self.rebuild_steps_at = None;
        self.staging_preview_at = None;
        self.pins_version = None;
        self.pending_change = None;
    }
}

#[cfg(test)]
mod tests {
    use super::{Due, due};

    #[test]
    fn a_request_waits_for_its_own_plan() {
        // The plan for the requested version runs it.
        assert_eq!(due(7, 7), Due::Now);
        // An older plan finishing first must not drop the request.
        assert_eq!(due(7, 6), Due::Later);
        // A newer plan supersedes it.
        assert_eq!(due(7, 8), Due::Dropped);
    }
}
