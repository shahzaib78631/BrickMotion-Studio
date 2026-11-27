use std::ffi::CString;

use bm_sys as sys;

use crate::placement::{PlacementInput, PlacementPreview};
use crate::playback::{AssemblyPreview, PlaybackState, ViewportPreferences};
use crate::timeline::BuildTimeline;
use crate::{Camera, Vec2, Vec3, take_string};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ViewPreset {
    Front,
    Back,
    Right,
    Left,
    Top,
    Bottom,
}

/// One rendered picture: sRGB RGBA, top row first.
#[derive(Debug, Clone, Default)]
pub struct Frame {
    pub width: u32,
    pub height: u32,
    pub rgba: Vec<u8>,
}

/// The engine's view of a session. Only reachable through `Document`, which keeps the session
/// alive for as long as the viewport.
pub struct Viewport {
    pub(crate) raw: *mut sys::BmViewport,
}

// The engine's viewport has no thread affinity (it renders offscreen with Metal, whose objects may
// be made on any thread). It may be built on one thread and handed to another, which then uses it
// alone; it is never shared, so it is Send and not Sync.
unsafe impl Send for Viewport {}

impl Viewport {
    pub(crate) fn new(session: *mut sys::BmSession) -> Option<Viewport> {
        let raw = unsafe { sys::bm_viewport_new(session) };
        if raw.is_null() {
            return None;
        }
        if !unsafe { sys::bm_viewport_ok(raw) } {
            unsafe { sys::bm_viewport_free(raw) };
            return None;
        }
        Some(Viewport { raw })
    }

    /// Ignored while either side is zero.
    pub fn resize(&mut self, px_w: u32, px_h: u32, scale: f64) {
        let w = i32::try_from(px_w).unwrap_or(i32::MAX);
        let h = i32::try_from(px_h).unwrap_or(i32::MAX);
        unsafe { sys::bm_viewport_resize(self.raw, w, h, scale) }
    }

    /// True when another frame is wanted soon.
    pub fn draw(&mut self) -> bool {
        unsafe { sys::bm_viewport_draw(self.raw) }
    }

    pub fn needs_draw(&self) -> bool {
        unsafe { sys::bm_viewport_needs_draw(self.raw) }
    }

    /// Copies the last frame into `into`, growing its buffer as needed.
    pub fn read_frame(&mut self, into: &mut Frame) {
        let (mut w, mut h) = (0i32, 0i32);
        let ok = unsafe { sys::bm_viewport_readback(self.raw, into.rgba.as_mut_ptr(), into.rgba.len(), &mut w, &mut h) };
        let need = w.max(0) as usize * h.max(0) as usize * 4;
        if !ok && need > 0 {
            into.rgba.resize(need, 0);
            if !unsafe { sys::bm_viewport_readback(self.raw, into.rgba.as_mut_ptr(), into.rgba.len(), &mut w, &mut h) } {
                w = 0;
                h = 0;
            }
        }
        into.width = w.max(0) as u32;
        into.height = h.max(0) as u32;
        into.rgba.truncate(into.width as usize * into.height as usize * 4);
    }

    pub fn orbit(&mut self, dx: f64, dy: f64) {
        unsafe { sys::bm_viewport_orbit(self.raw, dx, dy) }
    }

    pub fn pan(&mut self, dx: f64, dy: f64) {
        unsafe { sys::bm_viewport_pan(self.raw, dx, dy) }
    }

    pub fn zoom_toward(&mut self, factor: f64, x: f64, y: f64) {
        unsafe { sys::bm_viewport_zoom_toward(self.raw, factor, x, y) }
    }

    pub fn fit_all(&mut self) {
        unsafe { sys::bm_viewport_fit_all(self.raw) }
    }

    /// Frames the selected pieces (the whole model when nothing is selected).
    pub fn frame_selection(&mut self) {
        unsafe { sys::bm_viewport_frame_selection(self.raw) }
    }

    pub fn view(&mut self, p: ViewPreset) {
        let raw = match p {
            ViewPreset::Front => sys::BM_VIEW_FRONT,
            ViewPreset::Back => sys::BM_VIEW_BACK,
            ViewPreset::Right => sys::BM_VIEW_RIGHT,
            ViewPreset::Left => sys::BM_VIEW_LEFT,
            ViewPreset::Top => sys::BM_VIEW_TOP,
            ViewPreset::Bottom => sys::BM_VIEW_BOTTOM,
        };
        unsafe { sys::bm_viewport_view(self.raw, raw) }
    }

    pub fn set_background(&mut self, rgb: [f64; 3]) {
        unsafe { sys::bm_viewport_set_background(self.raw, rgb[0], rgb[1], rgb[2]) }
    }

    pub fn set_orthographic(&mut self, on: bool) {
        unsafe { sys::bm_viewport_set_orthographic(self.raw, on) }
    }

    /// The piece under a point (in points from the top left), if any.
    pub fn pick(&mut self, x: f64, y: f64) -> Option<u32> {
        let p = unsafe { sys::bm_viewport_pick(self.raw, x, y) };
        (p != sys::BM_NO_PIECE).then_some(p)
    }

    /// The shown pieces inside a rectangle (points from the top left, either corner first);
    /// `touching` also takes the ones it only overlaps.
    pub fn marquee(&mut self, a: Vec2, b: Vec2, touching: bool) -> Vec<u32> {
        let n = unsafe { sys::bm_viewport_marquee(self.raw, a.x, a.y, b.x, b.y, touching, std::ptr::null_mut(), 0) };
        let mut out = vec![0u32; n];
        let total = unsafe { sys::bm_viewport_marquee(self.raw, a.x, a.y, b.x, b.y, touching, out.as_mut_ptr(), out.len()) };
        out.truncate(total.min(n));
        out
    }

    pub fn camera(&self) -> Camera {
        Camera::from_raw(unsafe { sys::bm_viewport_camera(self.raw) })
    }

    pub fn selection_center(&mut self) -> Vec3 {
        Vec3::from_raw(unsafe { sys::bm_viewport_selection_center(self.raw) })
    }

    pub fn preview_part(&mut self, input: &PlacementInput, at: Vec2) -> u64 {
        let Ok(part) = CString::new(input.part.as_str()) else { return 0 };
        let raw = sys::BmPlacementInput {
            part: part.as_ptr(),
            color: input.color,
            grip: input.grip,
            turns: input.turns,
            mirrored: input.mirrored,
            snap: input.snap,
            reference: input.reference,
            collision: input.collision,
            anchor: input.anchor.unwrap_or(sys::BM_NO_PIECE),
            grab: input.grab.to_raw(),
            selection: input.selection.as_ptr(),
            selection_len: input.selection.len(),
        };
        unsafe { sys::bm_viewport_preview_part(self.raw, &raw, at.to_raw()) }
    }

    pub fn placement_preview(&self) -> PlacementPreview {
        PlacementPreview::from_raw(unsafe { sys::bm_viewport_placement_preview(self.raw) })
    }

    pub fn clear_placement_preview(&mut self) {
        unsafe { sys::bm_viewport_clear_placement_preview(self.raw) }
    }

    pub fn show_rest(&mut self) {
        unsafe { sys::bm_viewport_show_rest(self.raw) }
    }

    pub fn play(&mut self, on: bool) {
        unsafe { sys::bm_viewport_play(self.raw, on) }
    }

    pub fn play_range(&mut self, start: f64, end: f64) {
        unsafe { sys::bm_viewport_play_range(self.raw, start, end) }
    }

    pub fn seek(&mut self, seconds: f64) {
        unsafe { sys::bm_viewport_seek(self.raw, seconds) }
    }

    pub fn set_playback_rate(&mut self, rate: f64) {
        unsafe { sys::bm_viewport_set_playback_rate(self.raw, rate) }
    }

    pub fn set_playback_loop(&mut self, loop_: bool) {
        unsafe { sys::bm_viewport_set_playback_loop(self.raw, loop_) }
    }

    pub fn request_plan(&mut self) {
        unsafe { sys::bm_viewport_request_plan(self.raw) }
    }

    pub fn regenerate_plan(&mut self, standard_preview: bool) {
        unsafe { sys::bm_viewport_regenerate_plan(self.raw, standard_preview) }
    }

    pub fn playback_state(&self) -> PlaybackState {
        PlaybackState::from_raw(unsafe { sys::bm_viewport_playback_state(self.raw) })
    }

    pub fn plan_error(&self) -> String {
        take_string(unsafe { sys::bm_viewport_plan_error(self.raw) })
    }

    pub fn planned_version(&self) -> u64 {
        unsafe { sys::bm_viewport_planned_version(self.raw) }
    }

    pub fn set_preferences(&mut self, prefs: ViewportPreferences) {
        unsafe { sys::bm_viewport_set_preferences(self.raw, prefs.to_raw()) }
    }

    pub fn arrange(&mut self, step: Option<usize>, mode: AssemblyPreview) {
        let s = step.map_or(-1, |i| i32::try_from(i).unwrap_or(i32::MAX));
        unsafe { sys::bm_viewport_arrange(self.raw, s, mode.to_raw()) }
    }

    pub fn build_order(&mut self) -> Vec<u32> {
        let n = unsafe { sys::bm_viewport_build_order(self.raw, std::ptr::null_mut(), 0) };
        let mut out = vec![0u32; n];
        let total = unsafe { sys::bm_viewport_build_order(self.raw, out.as_mut_ptr(), out.len()) };
        out.truncate(total.min(n));
        out
    }

    pub fn build_timeline(&self) -> Option<BuildTimeline> {
        BuildTimeline::from_raw(unsafe { sys::bm_viewport_build_timeline(self.raw) })
    }

    pub fn can_turn_waiting_part(&self, piece: u32) -> bool {
        unsafe { sys::bm_viewport_can_turn_waiting_part(self.raw, piece) }
    }

    pub fn waiting_turn_to_match(&self, piece: u32) -> f64 {
        unsafe { sys::bm_viewport_waiting_turn_to_match(self.raw, piece) }
    }

    pub fn can_move_waiting_part(&self, piece: u32) -> bool {
        unsafe { sys::bm_viewport_can_move_waiting_part(self.raw, piece) }
    }

    pub fn begin_waiting_drag(&mut self, piece: u32, x: f64, y: f64) -> bool {
        unsafe { sys::bm_viewport_begin_waiting_drag(self.raw, piece, x, y) }
    }

    pub fn drag_waiting_part(&mut self, x: f64, y: f64) -> Vec3 {
        Vec3::from_raw(unsafe { sys::bm_viewport_drag_waiting_part(self.raw, x, y) })
    }

    pub fn end_waiting_drag(&mut self) -> Vec3 {
        Vec3::from_raw(unsafe { sys::bm_viewport_end_waiting_drag(self.raw) })
    }

    pub fn write_snap_track(&mut self, file: &std::path::Path, recordings: &std::path::Path) -> Result<(), String> {
        let dst = CString::new(file.to_string_lossy().as_bytes()).map_err(|_| "invalid file path".to_owned())?;
        let rec = CString::new(recordings.to_string_lossy().as_bytes())
            .map_err(|_| "invalid recordings path".to_owned())?;
        let err = take_string(unsafe { sys::bm_viewport_write_snap_track(self.raw, dst.as_ptr(), rec.as_ptr()) });
        if err.is_empty() { Ok(()) } else { Err(err) }
    }
}

impl Drop for Viewport {
    fn drop(&mut self) {
        unsafe { sys::bm_viewport_free(self.raw) }
    }
}
