//! Raw declarations for desktop/bmffi/include/bmffi.h, kept in step by hand; the `bm` crate's
//! `header_and_rust_decls_agree` test checks every name.
#![allow(non_camel_case_types)]

use std::ffi::c_char;

#[repr(C)]
pub struct BmSession {
    _private: [u8; 0],
}
#[repr(C)]
pub struct BmViewport {
    _private: [u8; 0],
}

#[repr(C)]
#[derive(Clone, Copy)]
pub struct BmString {
    pub ptr: *mut c_char,
    pub len: usize,
}

#[repr(C)]
pub struct BmOpenResult {
    pub ok: bool,
    pub error: BmString,
    pub warnings: BmString,
}

pub type BmViewPreset = u32;
pub const BM_VIEW_FRONT: BmViewPreset = 0;
pub const BM_VIEW_BACK: BmViewPreset = 1;
pub const BM_VIEW_RIGHT: BmViewPreset = 2;
pub const BM_VIEW_LEFT: BmViewPreset = 3;
pub const BM_VIEW_TOP: BmViewPreset = 4;
pub const BM_VIEW_BOTTOM: BmViewPreset = 5;

pub type BmSelectMode = u32;
pub const BM_SELECT_REPLACE: BmSelectMode = 0;
pub const BM_SELECT_ADD: BmSelectMode = 1;
pub const BM_SELECT_TOGGLE: BmSelectMode = 2;

pub const BM_NO_PIECE: u32 = u32::MAX;

unsafe extern "C" {
    pub fn bm_string_free(s: BmString);
    pub fn bm_ldraw_directory() -> BmString;
    pub fn bm_engine_version() -> BmString;

    pub fn bm_session_new() -> *mut BmSession;
    pub fn bm_session_free(s: *mut BmSession);
    pub fn bm_session_open(s: *mut BmSession, utf8_path: *const c_char) -> BmOpenResult;
    pub fn bm_open_result_free(r: BmOpenResult);
    pub fn bm_session_adopt(into: *mut BmSession, loaded: *const BmSession);
    pub fn bm_session_title(s: *const BmSession) -> BmString;
    pub fn bm_session_piece_count(s: *const BmSession) -> usize;
    pub fn bm_session_generation(s: *const BmSession) -> u64;
    pub fn bm_session_select(s: *mut BmSession, pieces: *const u32, n: usize, mode: BmSelectMode);
    pub fn bm_session_selection(s: *const BmSession, out: *mut u32, cap: usize) -> usize;

    pub fn bm_viewport_new(s: *mut BmSession) -> *mut BmViewport;
    pub fn bm_viewport_free(v: *mut BmViewport);
    pub fn bm_viewport_ok(v: *const BmViewport) -> bool;
    pub fn bm_viewport_resize(v: *mut BmViewport, px_w: i32, px_h: i32, scale: f64);
    pub fn bm_viewport_draw(v: *mut BmViewport) -> bool;
    pub fn bm_viewport_needs_draw(v: *const BmViewport) -> bool;
    pub fn bm_viewport_readback(v: *mut BmViewport, rgba: *mut u8, cap: usize, w: *mut i32, h: *mut i32) -> bool;
    pub fn bm_viewport_orbit(v: *mut BmViewport, dx_pt: f64, dy_pt: f64);
    pub fn bm_viewport_pan(v: *mut BmViewport, dx_pt: f64, dy_pt: f64);
    pub fn bm_viewport_zoom_toward(v: *mut BmViewport, factor: f64, x_pt: f64, y_pt: f64);
    pub fn bm_viewport_fit_all(v: *mut BmViewport);
    pub fn bm_viewport_view(v: *mut BmViewport, preset: BmViewPreset);
    pub fn bm_viewport_set_background(v: *mut BmViewport, r: f64, g: f64, b: f64);
    pub fn bm_viewport_set_orthographic(v: *mut BmViewport, on: bool);
    pub fn bm_viewport_pick(v: *mut BmViewport, x_pt: f64, y_pt: f64) -> u32;
}

/// Every function declared above, for the header agreement test.
pub const DECLARED: &[&str] = &[
    "bm_string_free", "bm_ldraw_directory", "bm_engine_version",
    "bm_session_new", "bm_session_free", "bm_session_open", "bm_open_result_free", "bm_session_adopt",
    "bm_session_title", "bm_session_piece_count", "bm_session_generation", "bm_session_select",
    "bm_session_selection",
    "bm_viewport_new", "bm_viewport_free", "bm_viewport_ok", "bm_viewport_resize", "bm_viewport_draw",
    "bm_viewport_needs_draw", "bm_viewport_readback", "bm_viewport_orbit", "bm_viewport_pan",
    "bm_viewport_zoom_toward", "bm_viewport_fit_all", "bm_viewport_view", "bm_viewport_set_background",
    "bm_viewport_set_orthographic", "bm_viewport_pick",
];
