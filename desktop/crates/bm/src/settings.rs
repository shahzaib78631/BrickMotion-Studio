//! Build settings, staging settings, waiting parts, and snap sound mix.
use std::ffi::CString;
use std::path::Path;

use bm_sys as sys;

use crate::borrowed;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum BuildOrder {
    #[default]
    TakeApart,
    BottomUp,
}

impl BuildOrder {
    pub(crate) fn from_raw(r: sys::BmBuildOrder) -> Self {
        match r {
            sys::BM_ORDER_BOTTOM_UP => Self::BottomUp,
            _ => Self::TakeApart,
        }
    }
    pub(crate) fn to_raw(self) -> sys::BmBuildOrder {
        match self {
            Self::TakeApart => sys::BM_ORDER_TAKE_APART,
            Self::BottomUp => sys::BM_ORDER_BOTTOM_UP,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum FlightShape {
    #[default]
    Automatic,
    Web,
    Arc,
}

impl FlightShape {
    pub(crate) fn from_raw(r: sys::BmFlightShape) -> Self {
        match r {
            sys::BM_FLIGHT_WEB => Self::Web,
            sys::BM_FLIGHT_ARC => Self::Arc,
            _ => Self::Automatic,
        }
    }
    pub(crate) fn to_raw(self) -> sys::BmFlightShape {
        match self {
            Self::Automatic => sys::BM_FLIGHT_AUTOMATIC,
            Self::Web => sys::BM_FLIGHT_WEB,
            Self::Arc => sys::BM_FLIGHT_ARC,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct BuildSettings {
    pub standard_planner: bool,
    pub order: BuildOrder,
    pub flight: FlightShape,
    pub clean_grown_units: bool,
    pub pieces_per_second: f64,
    pub gap: f64,
    pub step_pause: f64,
    pub clearance: f64,
    pub corner: f64,
    pub video_seconds: f64,
}

impl Default for BuildSettings {
    fn default() -> Self {
        Self {
            standard_planner: false,
            order: BuildOrder::TakeApart,
            flight: FlightShape::Automatic,
            clean_grown_units: false,
            pieces_per_second: 2.0,
            gap: 0.05,
            step_pause: 0.25,
            clearance: 24.0,
            corner: 20.0,
            video_seconds: 0.0,
        }
    }
}

impl BuildSettings {
    pub(crate) fn from_raw(r: sys::BmBuildSettings) -> Self {
        Self {
            standard_planner: r.standard_planner,
            order: BuildOrder::from_raw(r.order),
            flight: FlightShape::from_raw(r.flight),
            clean_grown_units: r.clean_grown_units,
            pieces_per_second: r.pieces_per_second,
            gap: r.gap,
            step_pause: r.step_pause,
            clearance: r.clearance,
            corner: r.corner,
            video_seconds: r.video_seconds,
        }
    }
    pub(crate) fn to_raw(self) -> sys::BmBuildSettings {
        sys::BmBuildSettings {
            standard_planner: self.standard_planner,
            order: self.order.to_raw(),
            flight: self.flight.to_raw(),
            clean_grown_units: self.clean_grown_units,
            pieces_per_second: self.pieces_per_second,
            gap: self.gap,
            step_pause: self.step_pause,
            clearance: self.clearance,
            corner: self.corner,
            video_seconds: self.video_seconds,
        }
    }

    /// Resulting flight duration in seconds, matching `BuildSettingsSheet.swift` (`0.85 / pps`, 0.35–0.9).
    pub fn flight_seconds(&self) -> f64 {
        (0.85 / self.pieces_per_second.max(0.01)).clamp(0.35, 0.9)
    }

    pub fn set_flight_seconds(&mut self, seconds: f64) {
        self.pieces_per_second = 0.85 / seconds.clamp(0.35, 0.9);
    }
}

pub const LAYOUTS: [&str; 9] = [
    "packed",
    "spaced",
    "grid",
    "rows",
    "scattered",
    "showcase",
    "gallery",
    "fan",
    "camera-frame",
];
pub const GROUPS: [&str; 5] = ["step", "colour", "part", "size", "all"];
pub const SIDES: [&str; 5] = ["front-back", "front", "behind", "sides", "around"];
pub const MATCHES: [&str; 2] = ["fill", "nearest"];

#[derive(Debug, Clone, PartialEq)]
pub struct StagingSettings {
    pub layout: String,
    pub group: String,
    pub sides: String,
    pub match_: String,
    pub aspect: f64,
}

impl Default for StagingSettings {
    fn default() -> Self {
        Self {
            layout: "packed".into(),
            group: "step".into(),
            sides: "front-back".into(),
            match_: "fill".into(),
            aspect: 1.0,
        }
    }
}

impl StagingSettings {
    pub(crate) fn from_raw(r: sys::BmStagingSettings) -> Self {
        Self {
            layout: borrowed(r.layout),
            group: borrowed(r.group),
            sides: borrowed(r.sides),
            match_: borrowed(r.match_),
            aspect: r.aspect,
        }
    }

    pub(crate) fn with_raw<R>(&self, f: impl FnOnce(sys::BmStagingSettings) -> R) -> Option<R> {
        let layout = CString::new(self.layout.as_str()).ok()?;
        let group = CString::new(self.group.as_str()).ok()?;
        let sides = CString::new(self.sides.as_str()).ok()?;
        let match_ = CString::new(self.match_.as_str()).ok()?;
        Some(f(sys::BmStagingSettings {
            layout: layout.as_ptr(),
            group: group.as_ptr(),
            sides: sides.as_ptr(),
            match_: match_.as_ptr(),
            aspect: self.aspect,
        }))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum SnapSource {
    #[default]
    Physical,
    Recorded,
    Synthesised,
}

impl SnapSource {
    pub(crate) fn from_raw(r: sys::BmSnapSource) -> Self {
        match r {
            sys::BM_SNAP_RECORDED => Self::Recorded,
            sys::BM_SNAP_SYNTHESISED => Self::Synthesised,
            _ => Self::Physical,
        }
    }
    pub(crate) fn to_raw(self) -> sys::BmSnapSource {
        match self {
            Self::Physical => sys::BM_SNAP_PHYSICAL,
            Self::Recorded => sys::BM_SNAP_RECORDED,
            Self::Synthesised => sys::BM_SNAP_SYNTHESISED,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum SnapLibrary {
    #[default]
    All,
    Freesound,
    OpenGameArt,
}

impl SnapLibrary {
    pub(crate) fn from_raw(r: sys::BmSnapLibrary) -> Self {
        match r {
            sys::BM_SNAP_FREESOUND => Self::Freesound,
            sys::BM_SNAP_OPENGAMEART => Self::OpenGameArt,
            _ => Self::All,
        }
    }
    pub(crate) fn to_raw(self) -> sys::BmSnapLibrary {
        match self {
            Self::All => sys::BM_SNAP_ALL,
            Self::Freesound => sys::BM_SNAP_FREESOUND,
            Self::OpenGameArt => sys::BM_SNAP_OPENGAMEART,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default)]
pub enum SnapExample {
    Plate,
    #[default]
    Brick,
    Pin,
}

impl SnapExample {
    pub(crate) fn to_raw(self) -> sys::BmSnapExample {
        match self {
            Self::Plate => sys::BM_SNAP_PLATE,
            Self::Brick => sys::BM_SNAP_BRICK,
            Self::Pin => sys::BM_SNAP_PIN,
        }
    }
}

/// Named snap-sound presets: `(display title, engine preset id)`.
pub const PRESETS: [(&str, &str); 6] = [
    ("Part Physics", "physical"),
    ("Balanced", "balanced"),
    ("Product Video", "product"),
    ("Click Only", "click"),
    ("Soft", "soft"),
    ("Synthesised", "synth"),
];

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct SnapMix {
    pub enabled: bool,
    pub source: SnapSource,
    pub library: SnapLibrary,
    pub volume: f64,
    pub room: f64,
    pub stereo: f64,
    pub click: f64,
    pub brightness: f64,
    pub thump: f64,
    pub thump_pitch: f64,
    pub thump_length: f64,
    pub pitch: f64,
    pub variation: f64,
    pub size_pitch: bool,
    pub size_match: bool,
    pub together: i32,
}

impl Default for SnapMix {
    fn default() -> Self {
        Self {
            enabled: false,
            source: SnapSource::Physical,
            library: SnapLibrary::All,
            volume: 1.0,
            room: 0.0,
            stereo: 0.25,
            click: 1.0,
            brightness: 3300.0,
            thump: 0.5,
            thump_pitch: 1.0,
            thump_length: 1.0,
            pitch: 1.0,
            variation: 0.5,
            size_pitch: true,
            size_match: true,
            together: 3,
        }
    }
}

impl SnapMix {
    pub(crate) fn from_raw(r: sys::BmSnapMix) -> Self {
        Self {
            enabled: r.enabled,
            source: SnapSource::from_raw(r.source),
            library: SnapLibrary::from_raw(r.library),
            volume: r.volume,
            room: r.room,
            stereo: r.stereo,
            click: r.click,
            brightness: r.brightness,
            thump: r.thump,
            thump_pitch: r.thump_pitch,
            thump_length: r.thump_length,
            pitch: r.pitch,
            variation: r.variation,
            size_pitch: r.size_pitch,
            size_match: r.size_match,
            together: r.together,
        }
    }

    pub(crate) fn to_raw(self) -> sys::BmSnapMix {
        sys::BmSnapMix {
            enabled: self.enabled,
            source: self.source.to_raw(),
            library: self.library.to_raw(),
            volume: self.volume,
            room: self.room,
            stereo: self.stereo,
            click: self.click,
            brightness: self.brightness,
            thump: self.thump,
            thump_pitch: self.thump_pitch,
            thump_length: self.thump_length,
            pitch: self.pitch,
            variation: self.variation,
            size_pitch: self.size_pitch,
            size_match: self.size_match,
            together: self.together,
        }
    }
}

pub fn snap_mix_preset(name: &str) -> SnapMix {
    let Ok(c) = CString::new(name) else {
        return SnapMix::default();
    };
    SnapMix::from_raw(unsafe { sys::bm_snap_mix_preset(c.as_ptr()) })
}

/// Renders one example snap WAV to `file`. Safe to call on a worker thread.
pub fn write_snap_preview(mix: &SnapMix, example: SnapExample, recordings: &Path, file: &Path) -> bool {
    let Ok(rec) = CString::new(recordings.to_string_lossy().as_bytes()) else {
        return false;
    };
    let Ok(dst) = CString::new(file.to_string_lossy().as_bytes()) else {
        return false;
    };
    unsafe { sys::bm_write_snap_preview(mix.to_raw(), example.to_raw(), rec.as_ptr(), dst.as_ptr()) }
}
