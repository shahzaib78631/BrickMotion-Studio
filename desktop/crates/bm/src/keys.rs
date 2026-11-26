//! Keyframes: the key scene, key objects, keys, key rows, flight paths and the shared key maths.

use bm_sys as sys;

use crate::session::take_change;
use crate::{Changed, Session, Vec3, Viewport, borrowed};

/// A key's channel, in the engine's order.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum KeyChannel {
    #[default]
    PositionX,
    PositionY,
    PositionZ,
    RotationX,
    RotationY,
    RotationZ,
    ScaleX,
    ScaleY,
    ScaleZ,
    Visibility,
}

impl KeyChannel {
    pub const ALL: [KeyChannel; 10] = [
        KeyChannel::PositionX,
        KeyChannel::PositionY,
        KeyChannel::PositionZ,
        KeyChannel::RotationX,
        KeyChannel::RotationY,
        KeyChannel::RotationZ,
        KeyChannel::ScaleX,
        KeyChannel::ScaleY,
        KeyChannel::ScaleZ,
        KeyChannel::Visibility,
    ];

    pub fn raw(self) -> i32 {
        self as i32
    }

    pub fn from_raw(v: i32) -> KeyChannel {
        usize::try_from(v).ok().and_then(|i| Self::ALL.get(i).copied()).unwrap_or(KeyChannel::PositionX)
    }

    /// The Swift app's property titles.
    pub fn title(self) -> &'static str {
        ["Position X", "Position Y", "Position Z", "Rotation X", "Rotation Y", "Rotation Z", "Scale X", "Scale Y", "Scale Z", "Visibility"]
            [self as usize]
    }

    /// The value's unit: studs, degrees, a factor, or none.
    pub fn suffix(self) -> &'static str {
        match self as usize {
            0..=2 => " studs",
            3..=5 => "°",
            6..=8 => "×",
            _ => "",
        }
    }

    /// The value with no key (scale 1, everything else 0).
    pub fn default_value(self) -> f64 {
        if matches!(self, KeyChannel::ScaleX | KeyChannel::ScaleY | KeyChannel::ScaleZ) { 1.0 } else { 0.0 }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Default)]
pub enum Interpolation {
    #[default]
    Smooth,
    Linear,
    Hold,
}

impl Interpolation {
    pub const ALL: [Interpolation; 3] = [Interpolation::Smooth, Interpolation::Linear, Interpolation::Hold];

    pub fn title(self) -> &'static str {
        ["Smooth", "Linear", "Hold"][self as usize]
    }

    fn from_raw(v: i32) -> Interpolation {
        match v {
            1 => Interpolation::Linear,
            2 => Interpolation::Hold,
            _ => Interpolation::Smooth,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Keyframe {
    pub channel: KeyChannel,
    pub frame: i32,
    pub value: f64,
    pub interpolation: Interpolation,
}

impl Keyframe {
    pub fn new(channel: KeyChannel, frame: i32, value: f64) -> Keyframe {
        Keyframe { channel, frame, value, interpolation: Interpolation::Smooth }
    }

    fn to_raw(self) -> sys::BmKeyframe {
        sys::BmKeyframe { channel: self.channel.raw(), frame: self.frame, value: self.value, interpolation: self.interpolation as i32 }
    }

    fn from_raw(k: sys::BmKeyframe) -> Keyframe {
        Keyframe {
            channel: KeyChannel::from_raw(k.channel),
            frame: k.frame,
            value: k.value,
            interpolation: Interpolation::from_raw(k.interpolation),
        }
    }
}

fn raw_keys(keys: &[Keyframe]) -> Vec<sys::BmKeyframe> {
    keys.iter().map(|k| k.to_raw()).collect()
}

/// The Keyframes timeline's scene: frames `first..=last` at `fps`, optionally linked to the Build.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct KeyScene {
    pub fps: i32,
    pub first: i32,
    pub last: i32,
    pub build_linked: bool,
    pub build_start: i32,
    pub build_speed: f64,
}

impl Default for KeyScene {
    fn default() -> Self {
        KeyScene { fps: 24, first: 1, last: 250, build_linked: false, build_start: 1, build_speed: 1.0 }
    }
}

impl KeyScene {
    fn to_raw(self) -> sys::BmKeyScene {
        sys::BmKeyScene {
            fps: self.fps,
            first: self.first,
            last: self.last,
            build_linked: self.build_linked,
            build_start: self.build_start,
            build_speed: self.build_speed,
        }
    }

    fn from_raw(s: sys::BmKeyScene) -> KeyScene {
        KeyScene {
            fps: s.fps,
            first: s.first,
            last: s.last,
            build_linked: s.build_linked,
            build_start: s.build_start,
            build_speed: s.build_speed,
        }
    }

    /// The Keyframes clock's length, lane and seek scale: (last - first) / fps.
    pub fn length(&self) -> f64 {
        f64::from(self.last - self.first) / f64::from(self.fps.max(1))
    }

    /// The frame `seconds` from the first frame.
    pub fn frame_at(&self, seconds: f64) -> i32 {
        self.first + (seconds * f64::from(self.fps.max(1))).round() as i32
    }

    /// Seconds from the first frame to `frame`.
    pub fn seconds_at(&self, frame: i32) -> f64 {
        f64::from(frame - self.first) / f64::from(self.fps.max(1))
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct KeyMarker {
    pub frame: i32,
    pub channels: usize,
}

/// One row of the Keyframes object list.
#[derive(Clone, Debug, PartialEq)]
pub struct KeyObject {
    pub piece: u32,
    pub submodel: bool,
    pub name: String,
    pub baked: bool,
    pub keyed: bool,
    pub keys: Vec<Keyframe>,
    pub members: Vec<u32>,
    pub markers: Vec<KeyMarker>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct KeyRowPick {
    pub piece: u32,
    pub frame: i32,
    pub submodel: bool,
}

fn raw_picks(picks: &[KeyRowPick]) -> Vec<sys::BmKeyRowPick> {
    picks.iter().map(|p| sys::BmKeyRowPick { piece: p.piece, frame: p.frame, submodel: p.submodel }).collect()
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct FlightPathPoint {
    pub frame: i32,
    pub at: Vec3,
}

/// A piece's baked flight as a line through the air, with a dot per key.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct FlightPath {
    pub line: Vec<FlightPathPoint>,
    pub keys: Vec<FlightPathPoint>,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct FlightPose {
    pub position: Vec3,
    pub rotation: [f64; 4],
}

impl FlightPose {
    fn to_raw(self) -> sys::BmFlightPose {
        let [qx, qy, qz, qw] = self.rotation;
        sys::BmFlightPose { position: self.position.to_raw(), qx, qy, qz, qw }
    }

    fn from_raw(p: sys::BmFlightPose) -> FlightPose {
        FlightPose { position: Vec3::from_raw(p.position), rotation: [p.qx, p.qy, p.qz, p.qw] }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum GizmoTool {
    Move,
    Rotate,
    Scale,
}

impl Session {
    pub fn key_scene(&self) -> KeyScene {
        KeyScene::from_raw(unsafe { sys::bm_session_key_scene(self.raw) })
    }

    pub fn set_key_scene(&self, scene: KeyScene) -> Changed {
        take_change(unsafe { sys::bm_session_set_key_scene(self.raw, scene.to_raw()) })
    }

    pub fn key_objects(&self) -> Vec<KeyObject> {
        let h = unsafe { sys::bm_session_key_objects(self.raw) };
        if h.is_null() {
            return Vec::new();
        }
        let n = unsafe { sys::bm_key_objects_len(h) };
        let out = (0..n)
            .map(|i| {
                let r = unsafe { sys::bm_key_objects_at(h, i) };
                let mut keys = vec![sys::BmKeyframe::default(); r.keys];
                let kn = unsafe { sys::bm_key_objects_keys(h, i, keys.as_mut_ptr(), keys.len()) };
                keys.truncate(kn.min(r.keys));
                let mut members = vec![0u32; r.members];
                let mn = unsafe { sys::bm_key_objects_members(h, i, members.as_mut_ptr(), members.len()) };
                members.truncate(mn.min(r.members));
                let mut frames = vec![0i32; r.markers];
                let mut channels = vec![0usize; r.markers];
                let k = unsafe { sys::bm_key_objects_markers(h, i, frames.as_mut_ptr(), channels.as_mut_ptr(), r.markers) };
                let markers =
                    frames.iter().zip(&channels).take(k.min(r.markers)).map(|(&frame, &channels)| KeyMarker { frame, channels }).collect();
                KeyObject {
                    piece: r.piece,
                    submodel: r.submodel,
                    name: borrowed(r.name),
                    baked: r.baked,
                    keyed: r.keyed,
                    keys: keys.into_iter().map(Keyframe::from_raw).collect(),
                    members,
                    markers,
                }
            })
            .collect();
        unsafe { sys::bm_key_objects_free(h) };
        out
    }

    pub fn key_value(&self, piece: u32, channel: KeyChannel, frame: f64, submodel: bool) -> f64 {
        unsafe { sys::bm_session_key_value(self.raw, piece, channel.raw(), frame, submodel) }
    }

    /// Inserts or replaces keys. `continuing` grows the open drag's undo step.
    pub fn set_keys(&self, piece: u32, keys: &[Keyframe], continuing: bool, submodel: bool) -> Changed {
        let raw = raw_keys(keys);
        take_change(unsafe { sys::bm_session_set_keys(self.raw, piece, raw.as_ptr(), raw.len(), continuing, submodel) })
    }

    pub fn remove_keys(&self, piece: u32, keys: &[Keyframe], submodel: bool) -> Changed {
        let raw = raw_keys(keys);
        take_change(unsafe { sys::bm_session_remove_keys(self.raw, piece, raw.as_ptr(), raw.len(), submodel) })
    }

    /// Moves keys by `offset` frames. The engine does not clamp: clamp with [`key_offset_limits`].
    pub fn move_keys(&self, piece: u32, keys: &[Keyframe], offset: i32, submodel: bool) -> Changed {
        let raw = raw_keys(keys);
        take_change(unsafe { sys::bm_session_move_keys(self.raw, piece, raw.as_ptr(), raw.len(), offset, submodel) })
    }

    pub fn move_key_rows(&self, picks: &[KeyRowPick], offset: i32) -> Changed {
        let raw = raw_picks(picks);
        take_change(unsafe { sys::bm_session_move_key_rows(self.raw, raw.as_ptr(), raw.len(), offset) })
    }

    pub fn remove_key_rows(&self, picks: &[KeyRowPick]) -> Changed {
        let raw = raw_picks(picks);
        take_change(unsafe { sys::bm_session_remove_key_rows(self.raw, raw.as_ptr(), raw.len()) })
    }

    pub fn set_baked_keys(&self, piece: u32, keys: &[Keyframe]) -> Changed {
        let raw = raw_keys(keys);
        take_change(unsafe { sys::bm_session_set_baked_keys(self.raw, piece, raw.as_ptr(), raw.len()) })
    }

    pub fn has_editable_flight_keys(&self, piece: u32) -> bool {
        unsafe { sys::bm_session_has_editable_flight_keys(self.raw, piece) }
    }

    pub fn add_flight_path_point(&self, piece: u32, frame: i32) -> Changed {
        take_change(unsafe { sys::bm_session_add_flight_path_point(self.raw, piece, frame) })
    }

    pub fn set_flight_path_point(&self, piece: u32, frame: i32, at: Vec3, continuing: bool) -> Changed {
        take_change(unsafe { sys::bm_session_set_flight_path_point(self.raw, piece, frame, at.to_raw(), continuing) })
    }

    pub fn delete_flight_path_point(&self, piece: u32, frame: i32) -> Changed {
        take_change(unsafe { sys::bm_session_delete_flight_path_point(self.raw, piece, frame) })
    }

    pub fn return_flight_to_planner(&self, piece: u32) -> Changed {
        take_change(unsafe { sys::bm_session_return_flight_to_planner(self.raw, piece) })
    }

    pub fn use_flight_in_build(&self, piece: u32, route: &[FlightPose]) -> Changed {
        let raw: Vec<sys::BmFlightPose> = route.iter().map(|p| p.to_raw()).collect();
        take_change(unsafe { sys::bm_session_use_flight_in_build(self.raw, piece, raw.as_ptr(), raw.len()) })
    }
}

fn copy_points(
    h: *const sys::BmFlightPath,
    f: unsafe extern "C" fn(*const sys::BmFlightPath, *mut sys::BmFlightPathPoint, usize) -> usize,
) -> Vec<FlightPathPoint> {
    let n = unsafe { f(h, std::ptr::null_mut(), 0) };
    let mut raw = vec![sys::BmFlightPathPoint::default(); n];
    let got = unsafe { f(h, raw.as_mut_ptr(), raw.len()) };
    raw.truncate(got.min(n));
    raw.into_iter().map(|p| FlightPathPoint { frame: p.frame, at: Vec3::from_raw(p.at) }).collect()
}

impl Viewport {
    /// Plays the key scene (true) or the planned Build (false).
    pub fn use_keyframes(&mut self, enabled: bool) {
        unsafe { sys::bm_viewport_use_keyframes(self.raw, enabled) }
    }

    /// None when the piece has no baked one-piece flight.
    pub fn flight_path(&mut self, piece: u32) -> Option<FlightPath> {
        let h = unsafe { sys::bm_viewport_flight_path(self.raw, piece) };
        if h.is_null() {
            return None;
        }
        let path = FlightPath { line: copy_points(h, sys::bm_flight_path_line), keys: copy_points(h, sys::bm_flight_path_keys) };
        unsafe { sys::bm_flight_path_free(h) };
        Some(path)
    }

    /// Where a drag from (x0, y0) to (x1, y1) moves a point, on the plane through it facing the view.
    pub fn drag_facing_view(&self, through: Vec3, x0: f64, y0: f64, x1: f64, y1: f64) -> Vec3 {
        Vec3::from_raw(unsafe { sys::bm_viewport_drag_facing_view(self.raw, through.to_raw(), x0, y0, x1, y1) })
    }

    pub fn edited_flight_route(&mut self, piece: u32) -> Vec<FlightPose> {
        let n = unsafe { sys::bm_viewport_edited_flight_route(self.raw, piece, std::ptr::null_mut(), 0) };
        let mut raw = vec![sys::BmFlightPose::default(); n];
        let got = unsafe { sys::bm_viewport_edited_flight_route(self.raw, piece, raw.as_mut_ptr(), raw.len()) };
        raw.truncate(got.min(n));
        raw.into_iter().map(FlightPose::from_raw).collect()
    }
}

/// How far picked keys spanning `earliest..=latest` may move and stay in the scene.
pub fn key_offset_limits(scene: KeyScene, earliest: i32, latest: i32) -> (i32, i32) {
    let (mut lower, mut upper) = (0, 0);
    unsafe { sys::bm_key_offset_limits(scene.to_raw(), earliest, latest, &mut lower, &mut upper) };
    (lower, upper)
}

pub fn clamp_offset(limits: (i32, i32), offset: i32) -> i32 {
    offset.max(limits.0).min(limits.1)
}

pub fn linked_key_scene(scene: KeyScene, enabled: bool, build_duration: f64) -> KeyScene {
    KeyScene::from_raw(unsafe { sys::bm_linked_key_scene(scene.to_raw(), enabled, build_duration) })
}

pub fn flight_keys_start(scene: KeyScene, flight_start: f64) -> f64 {
    unsafe { sys::bm_flight_keys_start(scene.to_raw(), flight_start) }
}

/// The three keys an Auto Key drag writes at `frame`.
pub fn auto_key_values(tool: GizmoTool, origin: Vec3, change: Vec3, frame: i32) -> Vec<Keyframe> {
    let mut out = [sys::BmKeyframe::default(); 3];
    let n = unsafe { sys::bm_auto_key_values(tool as i32, origin.to_raw(), change.to_raw(), frame, out.as_mut_ptr(), 3) };
    out.iter().take(n.min(3)).map(|k| Keyframe::from_raw(*k)).collect()
}

/// The piece and submodel flag an Auto Key drag keys, or None when it cannot key this selection.
pub fn auto_key_target(session: &Session, selection: &[u32], auto_key: bool, key_submodel: Option<u32>) -> Option<(u32, bool)> {
    let (mut piece, mut submodel) = (0u32, false);
    let ks = key_submodel.map_or(-1, i64::from);
    let ok = unsafe {
        sys::bm_auto_key_target(session.raw, selection.as_ptr(), selection.len(), auto_key, ks, &mut piece, &mut submodel)
    };
    ok.then_some((piece, submodel))
}

/// The nearest frame strictly after (or before) `frame` among the objects' markers.
pub fn adjacent_key_frame(objects: &[KeyObject], frame: i32, after: bool) -> Option<i32> {
    let frames: Vec<i32> = objects.iter().flat_map(|o| o.markers.iter().map(|m| m.frame)).collect();
    let mut out = 0;
    unsafe { sys::bm_key_adjacent_frame(frames.as_ptr(), frames.len(), frame, after, &mut out) }.then_some(out)
}
