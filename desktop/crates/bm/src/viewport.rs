use bm_sys as sys;

use crate::{Camera, Vec3};

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
    raw: *mut sys::BmViewport,
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

    pub fn camera(&self) -> Camera {
        Camera::from_raw(unsafe { sys::bm_viewport_camera(self.raw) })
    }

    pub fn selection_center(&mut self) -> Vec3 {
        Vec3::from_raw(unsafe { sys::bm_viewport_selection_center(self.raw) })
    }
}

impl Drop for Viewport {
    fn drop(&mut self) {
        unsafe { sys::bm_viewport_free(self.raw) }
    }
}
