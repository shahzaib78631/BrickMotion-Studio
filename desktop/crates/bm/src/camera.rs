//! Camera tracks on both clocks, Auto-direct, scene cameras and the export camera.

use std::ffi::{CString, c_char};

use bm_sys as sys;

use crate::session::take_change;
use crate::{Changed, Session, Vec3, Viewport, borrowed, take_string};

/// Which video a Camera track films: the Build, or the Keyframes timeline.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum CameraClock {
    Build,
    Timeline,
}

impl CameraClock {
    fn raw(self) -> i32 {
        match self {
            CameraClock::Build => sys::BM_CLOCK_BUILD,
            CameraClock::Timeline => sys::BM_CLOCK_TIMELINE,
        }
    }
}

/// Holds the C strings a call borrows until it returns.
#[derive(Default)]
struct Strings(Vec<CString>);

impl Strings {
    fn add(&mut self, s: &str) -> *const c_char {
        let c = CString::new(s.replace('\0', "")).unwrap_or_default();
        let p = c.as_ptr();
        self.0.push(c);
        p
    }
}

/// A named view (scene camera), LDU.
#[derive(Clone, Debug, PartialEq)]
pub struct SceneCamera {
    pub id: String,
    pub name: String,
    pub position: Vec3,
    pub target: Vec3,
    pub field_of_view: f64,
    pub near_clip: f64,
    pub far_clip: f64,
    pub orthographic: bool,
}

impl SceneCamera {
    fn from_raw(c: &sys::BmSceneCamera) -> SceneCamera {
        SceneCamera {
            id: borrowed(c.id),
            name: borrowed(c.name),
            position: Vec3::from_raw(c.position),
            target: Vec3::from_raw(c.target),
            field_of_view: c.field_of_view,
            near_clip: c.near_clip,
            far_clip: c.far_clip,
            orthographic: c.orthographic,
        }
    }

    fn to_raw(&self, keep: &mut Strings) -> sys::BmSceneCamera {
        sys::BmSceneCamera {
            id: keep.add(&self.id),
            name: keep.add(&self.name),
            position: self.position.to_raw(),
            target: self.target.to_raw(),
            field_of_view: self.field_of_view,
            near_clip: self.near_clip,
            far_clip: self.far_clip,
            orthographic: self.orthographic,
        }
    }

    fn take(raw: sys::BmSceneCamera) -> SceneCamera {
        let out = SceneCamera::from_raw(&raw);
        unsafe { sys::bm_scene_camera_free(raw) };
        out
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct SceneCameras {
    pub cameras: Vec<SceneCamera>,
    pub active_id: String,
    pub use_for_video: bool,
}

/// A key of a Camera track.
#[derive(Clone, Debug, PartialEq)]
pub struct CameraKey {
    pub id: String,
    pub seconds: f64,
    /// "model", "build", "piece" or "point".
    pub target: String,
    /// The move leaving this key; "" for the last key.
    pub preset: String,
    pub azimuth: f64,
    pub elevation: f64,
    pub lens_mm: f64,
    pub fitted: bool,
    pub user: bool,
    pub margin: f64,
    pub distance: f64,
    pub roll: f64,
    pub focus_target: bool,
    pub focus: f64,
    pub blur: f64,
    pub point: Vec3,
    pub eye: Vec3,
}

impl CameraKey {
    fn from_raw(k: &sys::BmCameraKey) -> CameraKey {
        CameraKey {
            id: borrowed(k.id),
            seconds: k.seconds,
            target: borrowed(k.target),
            preset: borrowed(k.preset),
            azimuth: k.azimuth,
            elevation: k.elevation,
            lens_mm: k.lens_mm,
            fitted: k.fitted,
            user: k.user,
            margin: k.margin,
            distance: k.distance,
            roll: k.roll,
            focus_target: k.focus_target,
            focus: k.focus,
            blur: k.blur,
            point: Vec3::from_raw(k.point),
            eye: Vec3::from_raw(k.eye),
        }
    }

    fn to_raw(&self, keep: &mut Strings) -> sys::BmCameraKey {
        sys::BmCameraKey {
            id: keep.add(&self.id),
            seconds: self.seconds,
            target: keep.add(&self.target),
            preset: keep.add(&self.preset),
            azimuth: self.azimuth,
            elevation: self.elevation,
            lens_mm: self.lens_mm,
            fitted: self.fitted,
            user: self.user,
            margin: self.margin,
            distance: self.distance,
            roll: self.roll,
            focus_target: self.focus_target,
            focus: self.focus,
            blur: self.blur,
            point: self.point.to_raw(),
            eye: self.eye.to_raw(),
        }
    }
}

/// The move from one key to the next.
#[derive(Clone, Debug, PartialEq)]
pub struct CameraMove {
    pub from: String,
    pub to: String,
    pub preset: String,
    pub user: bool,
    pub cut: bool,
    pub flow_through: bool,
    /// easeInOut, easeIn, easeOut, linear, holdThenMove, snap.
    pub curve: String,
    pub strength: f64,
    pub straight: bool,
    /// shortest, cw, ccw.
    pub orbit: String,
    pub extra_turns: i32,
    pub overshoot: f64,
    pub motion_blur: f64,
    pub shake: f64,
    pub shake_frequency: f64,
    pub turn_last: f64,
}

impl CameraMove {
    fn from_raw(m: &sys::BmCameraMove) -> CameraMove {
        CameraMove {
            from: borrowed(m.from),
            to: borrowed(m.to),
            preset: borrowed(m.preset),
            user: m.user,
            cut: m.cut,
            flow_through: m.flow_through,
            curve: borrowed(m.curve),
            strength: m.strength,
            straight: m.straight,
            orbit: borrowed(m.orbit),
            extra_turns: m.extra_turns,
            overshoot: m.overshoot,
            motion_blur: m.motion_blur,
            shake: m.shake,
            shake_frequency: m.shake_frequency,
            turn_last: m.turn_last,
        }
    }

    fn to_raw(&self, keep: &mut Strings) -> sys::BmCameraMove {
        sys::BmCameraMove {
            from: keep.add(&self.from),
            to: keep.add(&self.to),
            preset: keep.add(&self.preset),
            user: self.user,
            cut: self.cut,
            flow_through: self.flow_through,
            curve: keep.add(&self.curve),
            strength: self.strength,
            straight: self.straight,
            orbit: keep.add(&self.orbit),
            extra_turns: self.extra_turns,
            overshoot: self.overshoot,
            motion_blur: self.motion_blur,
            shake: self.shake,
            shake_frequency: self.shake_frequency,
            turn_last: self.turn_last,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CameraPreset {
    pub id: String,
    pub label: String,
    pub hint: String,
}

/// One clock as a Camera lane reads it.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ClockInfo {
    pub clock: CameraClock,
    pub fps: f64,
    pub duration: f64,
    pub ready: bool,
}

impl ClockInfo {
    fn to_raw(self) -> sys::BmCameraClockInfo {
        sys::BmCameraClockInfo { clock: self.clock.raw(), fps: self.fps, duration: self.duration, ready: self.ready }
    }
}

impl Session {
    pub fn camera_keys(&self, clock: CameraClock) -> Vec<CameraKey> {
        let h = unsafe { sys::bm_session_camera_keys(self.raw, clock.raw()) };
        if h.is_null() {
            return Vec::new();
        }
        let n = unsafe { sys::bm_camera_keys_len(h) };
        let out = (0..n).map(|i| CameraKey::from_raw(&unsafe { sys::bm_camera_keys_at(h, i) })).collect();
        unsafe { sys::bm_camera_keys_free(h) };
        out
    }

    pub fn camera_moves(&self, clock: CameraClock) -> Vec<CameraMove> {
        let h = unsafe { sys::bm_session_camera_moves(self.raw, clock.raw()) };
        if h.is_null() {
            return Vec::new();
        }
        let n = unsafe { sys::bm_camera_moves_len(h) };
        let out = (0..n).map(|i| CameraMove::from_raw(&unsafe { sys::bm_camera_moves_at(h, i) })).collect();
        unsafe { sys::bm_camera_moves_free(h) };
        out
    }

    /// The Auto-direct style that wrote the track; "" for a track made by hand.
    pub fn camera_director_style(&self, clock: CameraClock) -> String {
        take_string(unsafe { sys::bm_session_camera_director_style(self.raw, clock.raw()) })
    }

    pub fn add_camera_key(&self, clock: CameraClock, seconds: f64, view: &SceneCamera, fps: f64, duration: f64) -> Changed {
        let mut keep = Strings::default();
        let v = view.to_raw(&mut keep);
        take_change(unsafe { sys::bm_session_add_camera_key(self.raw, clock.raw(), seconds, v, fps, duration) })
    }

    pub fn set_camera_key_view(&self, clock: CameraClock, id: &str, view: &SceneCamera) -> Changed {
        let mut keep = Strings::default();
        let v = view.to_raw(&mut keep);
        let id = keep.add(id);
        take_change(unsafe { sys::bm_session_set_camera_key_view(self.raw, clock.raw(), id, v) })
    }

    pub fn move_camera_key(&self, clock: CameraClock, id: &str, seconds: f64, fps: f64, duration: f64) -> Changed {
        let mut keep = Strings::default();
        let id = keep.add(id);
        take_change(unsafe { sys::bm_session_move_camera_key(self.raw, clock.raw(), id, seconds, fps, duration) })
    }

    pub fn remove_camera_key(&self, clock: CameraClock, id: &str) -> Changed {
        let mut keep = Strings::default();
        let id = keep.add(id);
        take_change(unsafe { sys::bm_session_remove_camera_key(self.raw, clock.raw(), id) })
    }

    pub fn set_camera_key_target(&self, clock: CameraClock, id: &str, target: &str) -> Changed {
        let mut keep = Strings::default();
        let (id, target) = (keep.add(id), keep.add(target));
        take_change(unsafe { sys::bm_session_set_camera_key_target(self.raw, clock.raw(), id, target) })
    }

    /// Every field of a key; `continuing` grows the open drag's undo step.
    pub fn set_camera_key(&self, clock: CameraClock, key: &CameraKey, continuing: bool) -> Changed {
        let mut keep = Strings::default();
        let k = key.to_raw(&mut keep);
        take_change(unsafe { sys::bm_session_set_camera_key(self.raw, clock.raw(), k, continuing) })
    }

    pub fn set_camera_move(&self, clock: CameraClock, m: &CameraMove, continuing: bool) -> Changed {
        let mut keep = Strings::default();
        let r = m.to_raw(&mut keep);
        take_change(unsafe { sys::bm_session_set_camera_move(self.raw, clock.raw(), r, continuing) })
    }

    pub fn choose_camera_preset(&self, clock: CameraClock, from: &str, preset: &str, distance: f64) -> Changed {
        let mut keep = Strings::default();
        let (from, preset) = (keep.add(from), keep.add(preset));
        take_change(unsafe { sys::bm_session_choose_camera_preset(self.raw, clock.raw(), from, preset, distance) })
    }

    pub fn clear_camera_track(&self, clock: CameraClock) -> Changed {
        take_change(unsafe { sys::bm_session_clear_camera_track(self.raw, clock.raw()) })
    }

    /// "track", "automatic" or "buildView".
    pub fn export_camera(&self) -> String {
        take_string(unsafe { sys::bm_session_export_camera(self.raw) })
    }

    pub fn set_export_camera(&self, camera: &str) -> Changed {
        let mut keep = Strings::default();
        let c = keep.add(camera);
        take_change(unsafe { sys::bm_session_set_export_camera(self.raw, c) })
    }

    pub fn scene_cameras(&self) -> SceneCameras {
        let h = unsafe { sys::bm_session_scene_cameras(self.raw) };
        if h.is_null() {
            return SceneCameras { cameras: Vec::new(), active_id: String::new(), use_for_video: true };
        }
        let n = unsafe { sys::bm_scene_cameras_len(h) };
        let out = SceneCameras {
            cameras: (0..n).map(|i| SceneCamera::from_raw(&unsafe { sys::bm_scene_cameras_at(h, i) })).collect(),
            active_id: borrowed(unsafe { sys::bm_scene_cameras_active_id(h) }),
            use_for_video: unsafe { sys::bm_scene_cameras_use_for_video(h) },
        };
        unsafe { sys::bm_scene_cameras_free(h) };
        out
    }

    /// Adds a camera, or replaces the one with the same id. The caller gives it its id.
    pub fn save_scene_camera(&self, camera: &SceneCamera) -> Changed {
        let mut keep = Strings::default();
        let c = camera.to_raw(&mut keep);
        take_change(unsafe { sys::bm_session_save_scene_camera(self.raw, c) })
    }

    pub fn remove_scene_camera(&self, id: &str) -> Changed {
        let mut keep = Strings::default();
        let id = keep.add(id);
        take_change(unsafe { sys::bm_session_remove_scene_camera(self.raw, id) })
    }

    /// "" uses the automatic camera for video.
    pub fn activate_scene_camera(&self, id: &str) -> Changed {
        let mut keep = Strings::default();
        let id = keep.add(id);
        take_change(unsafe { sys::bm_session_activate_scene_camera(self.raw, id) })
    }
}

impl Viewport {
    pub fn capture_scene_camera(&self) -> SceneCamera {
        SceneCamera::take(unsafe { sys::bm_viewport_capture_scene_camera(self.raw) })
    }

    /// The view the camera track gives at `seconds`.
    pub fn camera_track_view(&mut self, seconds: f64) -> SceneCamera {
        SceneCamera::take(unsafe { sys::bm_viewport_camera_track_view(self.raw, seconds) })
    }

    pub fn recall_scene_camera(&mut self, id: &str) -> bool {
        let mut keep = Strings::default();
        let id = keep.add(id);
        unsafe { sys::bm_viewport_recall_scene_camera(self.raw, id) }
    }

    pub fn follows_camera_track(&mut self) -> bool {
        unsafe { sys::bm_viewport_follows_camera_track(self.raw) }
    }

    /// Follow Camera: the viewport plays the Camera track.
    pub fn set_director_preview(&mut self, directed: bool) {
        unsafe { sys::bm_viewport_set_director_preview(self.raw, directed) }
    }
}

/// The web's nineteen camera moves.
pub fn camera_presets() -> Vec<CameraPreset> {
    let h = unsafe { sys::bm_camera_presets() };
    if h.is_null() {
        return Vec::new();
    }
    let n = unsafe { sys::bm_camera_presets_len(h) };
    let out = (0..n)
        .map(|i| {
            let p = unsafe { sys::bm_camera_presets_at(h, i) };
            CameraPreset { id: borrowed(p.id), label: borrowed(p.label), hint: borrowed(p.hint) }
        })
        .collect();
    unsafe { sys::bm_camera_presets_free(h) };
    out
}

pub fn clock_info(clock: CameraClock, session: &Session, build_fps: f64, build_duration: f64, build_ready: bool) -> ClockInfo {
    let r = unsafe { sys::bm_camera_clock_info(clock.raw(), session.raw, build_fps, build_duration, build_ready) };
    ClockInfo { clock, fps: r.fps, duration: r.duration, ready: r.ready }
}

impl Session {
    /// The id of the clock's key within half a frame of `now`.
    pub fn camera_key_at(&self, clock: CameraClock, now: f64, fps: f64) -> Option<String> {
        let h = unsafe { sys::bm_session_camera_keys(self.raw, clock.raw()) };
        if h.is_null() {
            return None;
        }
        let i = unsafe { sys::bm_camera_key_at(h, now, fps) };
        let id = usize::try_from(i).ok().map(|i| borrowed(unsafe { sys::bm_camera_keys_at(h, i) }.id));
        unsafe { sys::bm_camera_keys_free(h) };
        id
    }
}

pub fn can_auto_direct(clock: CameraClock, session: &Session, build_ready: bool) -> bool {
    unsafe { sys::bm_can_auto_direct(clock.raw(), session.raw, build_ready) }
}

/// A key filming the view at `now` (the key already there takes the view): the change, the key to
/// select and whether a key was added.
pub fn add_camera_key_from_view(
    session: &Session,
    viewport: &mut Viewport,
    clock: CameraClock,
    now: f64,
    info: ClockInfo,
) -> (Changed, String, bool) {
    let mut id = sys::BmString { ptr: std::ptr::null_mut(), len: 0 };
    let mut added = false;
    let c = unsafe { sys::bm_add_camera_key_from_view(session.raw, viewport.raw, clock.raw(), now, info.to_raw(), &mut id, &mut added) };
    (take_change(c), take_string(id), added)
}

/// Look At: "point" fixes the key where it looks now; "model", "build", "piece" follow that.
pub fn aim_camera_key(session: &Session, viewport: &mut Viewport, clock: CameraClock, key: &CameraKey, target: &str) -> Changed {
    let mut keep = Strings::default();
    let k = key.to_raw(&mut keep);
    let t = keep.add(target);
    take_change(unsafe { sys::bm_aim_camera_key(session.raw, viewport.raw, clock.raw(), k, t) })
}

/// Writes the clock's track in `style` from the planned Build.
pub fn auto_direct(session: &Session, viewport: &mut Viewport, clock: CameraClock, style: &str) -> Changed {
    let mut keep = Strings::default();
    let s = keep.add(style);
    take_change(unsafe { sys::bm_auto_direct(session.raw, viewport.raw, clock.raw(), s) })
}
