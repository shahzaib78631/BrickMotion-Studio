//! Playback state, planner status, viewport preferences, assembly preview and sequence segments.
use bm_sys as sys;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum PlanState {
    #[default]
    Idle,
    Planning,
    Ready,
    Failed,
}

impl PlanState {
    pub(crate) fn from_raw(raw: sys::BmPlanState) -> Self {
        match raw {
            sys::BM_PLAN_PLANNING => Self::Planning,
            sys::BM_PLAN_READY => Self::Ready,
            sys::BM_PLAN_FAILED => Self::Failed,
            _ => Self::Idle,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum PlanStage {
    #[default]
    Waiting,
    Solving,
    CheckingFlights,
    Preparing,
    StandardPreview,
}

impl PlanStage {
    pub(crate) fn from_raw(raw: sys::BmPlanStage) -> Self {
        match raw {
            sys::BM_STAGE_SOLVING => Self::Solving,
            sys::BM_STAGE_CHECKING_FLIGHTS => Self::CheckingFlights,
            sys::BM_STAGE_PREPARING => Self::Preparing,
            sys::BM_STAGE_STANDARD_PREVIEW => Self::StandardPreview,
            _ => Self::Waiting,
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Self::Waiting => "Planning",
            Self::Solving => "Ordering",
            Self::CheckingFlights => "Checking flights",
            Self::Preparing => "Preparing",
            Self::StandardPreview => "Standard preview",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum AssemblyPreview {
    #[default]
    Assembled,
    Separated,
    LaidOut,
    Exploded,
}

impl AssemblyPreview {
    pub(crate) fn to_raw(self) -> sys::BmAssemblyPreview {
        match self {
            Self::Assembled => sys::BM_PREVIEW_ASSEMBLED,
            Self::Separated => sys::BM_PREVIEW_SEPARATED,
            Self::LaidOut => sys::BM_PREVIEW_LAID_OUT,
            Self::Exploded => sys::BM_PREVIEW_EXPLODED,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Segment {
    Intro,
    Build,
    Hero,
}

impl Segment {
    pub(crate) fn to_raw(self) -> sys::BmSegment {
        match self {
            Self::Intro => sys::BM_SEGMENT_INTRO,
            Self::Build => sys::BM_SEGMENT_BUILD,
            Self::Hero => sys::BM_SEGMENT_HERO,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PlaybackState {
    pub seconds: f64,
    pub duration: f64,
    pub playing: bool,
    pub waiting_to_play: bool,
    pub at_rest: bool,
    pub stale: bool,
    pub plan: PlanState,
    pub version: u64,
    pub stage: PlanStage,
}

impl Default for PlaybackState {
    fn default() -> Self {
        Self {
            seconds: 0.0,
            duration: 0.0,
            playing: false,
            waiting_to_play: false,
            at_rest: true,
            stale: false,
            plan: PlanState::Idle,
            version: 0,
            stage: PlanStage::Waiting,
        }
    }
}

impl PlaybackState {
    pub(crate) fn from_raw(r: sys::BmPlaybackState) -> Self {
        Self {
            seconds: r.seconds,
            duration: r.duration,
            playing: r.playing,
            waiting_to_play: r.waiting_to_play,
            at_rest: r.at_rest,
            stale: r.stale,
            plan: PlanState::from_raw(r.plan),
            version: r.version,
            stage: PlanStage::from_raw(r.stage),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ViewportPreferences {
    pub edges: bool,
    pub floor: bool,
    pub shadows: bool,
    pub ambient_occlusion: bool,
    pub auto_plan: bool,
    pub scene_backdrop: bool,
}

impl Default for ViewportPreferences {
    fn default() -> Self {
        Self {
            edges: true,
            floor: true,
            shadows: true,
            ambient_occlusion: true,
            auto_plan: true,
            scene_backdrop: true,
        }
    }
}

impl ViewportPreferences {
    pub(crate) fn to_raw(self) -> sys::BmViewportPreferences {
        sys::BmViewportPreferences {
            edges: self.edges,
            floor: self.floor,
            shadows: self.shadows,
            ambient_occlusion: self.ambient_occlusion,
            auto_plan: self.auto_plan,
            scene_backdrop: self.scene_backdrop,
        }
    }
}
