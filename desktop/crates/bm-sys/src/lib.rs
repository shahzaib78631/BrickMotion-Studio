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

#[repr(C)]
pub struct BmChange {
    pub structure: bool,
    pub version: u64,
    pub refused: BmString,
}

#[repr(C)]
pub struct BmOutline {
    _private: [u8; 0],
}
#[repr(C)]
pub struct BmSnapshot {
    _private: [u8; 0],
}
#[repr(C)]
pub struct BmColors {
    _private: [u8; 0],
}

#[repr(C)]
#[derive(Clone, Copy)]
pub struct BmOutlineRow {
    pub id: *const c_char,
    pub def: *const c_char,
    pub name: *const c_char,
    pub group: *const c_char,
    pub depth: i32,
    pub parent: i32,
    pub pieces: usize,
    pub uses: usize,
    pub shared: bool,
    pub unused: bool,
}

#[repr(C)]
#[derive(Clone, Copy)]
pub struct BmSnapshotInfo {
    pub version: u64,
    pub pieces: usize,
    pub selected: usize,
    pub hidden: usize,
    pub dirty: bool,
}

#[repr(C)]
#[derive(Clone, Copy)]
pub struct BmPieceInfo {
    pub piece: u32,
    pub part: *const c_char,
    pub description: *const c_char,
    pub color_name: *const c_char,
    pub submodel_path: *const c_char,
    pub color: i32,
    pub step: i32,
    pub in_shared_submodel: bool,
}

#[repr(C)]
#[derive(Clone, Copy)]
pub struct BmColor {
    pub code: i32,
    pub name: *const c_char,
    pub rgb: u32,
    pub alpha: f32,
    pub group: i32,
}

unsafe extern "C" {
    pub fn bm_string_free(s: BmString);
    pub fn bm_ldraw_directory() -> BmString;
    pub fn bm_engine_version() -> BmString;

    pub fn bm_session_new() -> *mut BmSession;
    pub fn bm_session_free(s: *mut BmSession);
    pub fn bm_session_open(s: *mut BmSession, utf8_path: *const c_char) -> BmOpenResult;
    pub fn bm_open_result_free(r: BmOpenResult);
    pub fn bm_session_title(s: *const BmSession) -> BmString;
    pub fn bm_session_piece_count(s: *const BmSession) -> usize;
    pub fn bm_session_generation(s: *const BmSession) -> u64;
    pub fn bm_session_select(s: *mut BmSession, pieces: *const u32, n: usize, mode: BmSelectMode);
    pub fn bm_session_selection(s: *const BmSession, out: *mut u32, cap: usize) -> usize;

    pub fn bm_viewport_new(s: *mut BmSession) -> *mut BmViewport;
    pub fn bm_metal_available() -> bool;
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
    pub fn bm_viewport_frame_selection(v: *mut BmViewport);

    pub fn bm_change_free(c: BmChange);
    pub fn bm_session_new_blank(s: *mut BmSession) -> BmOpenResult;
    pub fn bm_session_project_bytes(s: *const BmSession) -> BmString;
    pub fn bm_session_imported(s: *const BmSession) -> bool;
    pub fn bm_session_dirty(s: *const BmSession) -> bool;
    pub fn bm_session_mark_saved(s: *mut BmSession);
    pub fn bm_session_version(s: *const BmSession) -> u64;
    pub fn bm_session_structure_version(s: *const BmSession) -> u64;
    pub fn bm_session_can_undo(s: *const BmSession) -> bool;
    pub fn bm_session_can_redo(s: *const BmSession) -> bool;
    pub fn bm_session_undo_name(s: *const BmSession) -> BmString;
    pub fn bm_session_redo_name(s: *const BmSession) -> BmString;
    pub fn bm_session_undo(s: *mut BmSession) -> BmChange;
    pub fn bm_session_redo(s: *mut BmSession) -> BmChange;
    pub fn bm_session_remove(s: *mut BmSession, pieces: *const u32, n: usize) -> BmChange;
    pub fn bm_session_select_all(s: *mut BmSession);
    pub fn bm_session_select_none(s: *mut BmSession);
    pub fn bm_session_hide(s: *mut BmSession, pieces: *const u32, n: usize);
    pub fn bm_session_show_all(s: *mut BmSession);
    pub fn bm_session_pieces_of_row(s: *const BmSession, outline_id: *const c_char, out: *mut u32, cap: usize) -> usize;

    pub fn bm_session_outline(s: *const BmSession) -> *mut BmOutline;
    pub fn bm_outline_len(o: *const BmOutline) -> usize;
    pub fn bm_outline_row(o: *const BmOutline, i: usize) -> BmOutlineRow;
    pub fn bm_outline_free(o: *mut BmOutline);
    pub fn bm_session_snapshot(s: *const BmSession) -> *mut BmSnapshot;
    pub fn bm_snapshot_info(s: *const BmSnapshot) -> BmSnapshotInfo;
    pub fn bm_snapshot_piece_len(s: *const BmSnapshot) -> usize;
    pub fn bm_snapshot_piece(s: *const BmSnapshot, i: usize) -> BmPieceInfo;
    pub fn bm_snapshot_free(s: *mut BmSnapshot);
    pub fn bm_colors(s: *const BmSession) -> *mut BmColors;
    pub fn bm_colors_len(c: *const BmColors) -> usize;
    pub fn bm_colors_at(c: *const BmColors, i: usize) -> BmColor;
    pub fn bm_colors_free(c: *mut BmColors);
    pub fn bm_struct_size(name: *const c_char) -> usize;
}

/// Every function declared above, for the header agreement test.
pub const DECLARED: &[&str] = &[
    "bm_string_free", "bm_ldraw_directory", "bm_engine_version",
    "bm_session_new", "bm_session_free", "bm_session_open", "bm_open_result_free",
    "bm_session_title", "bm_session_piece_count", "bm_session_generation", "bm_session_select",
    "bm_session_selection",
    "bm_viewport_new", "bm_metal_available", "bm_viewport_free", "bm_viewport_ok", "bm_viewport_resize", "bm_viewport_draw",
    "bm_viewport_needs_draw", "bm_viewport_readback", "bm_viewport_orbit", "bm_viewport_pan",
    "bm_viewport_zoom_toward", "bm_viewport_fit_all", "bm_viewport_view", "bm_viewport_set_background",
    "bm_viewport_set_orthographic", "bm_viewport_pick", "bm_viewport_frame_selection",
    "bm_change_free", "bm_session_new_blank", "bm_session_project_bytes", "bm_session_imported",
    "bm_session_dirty", "bm_session_mark_saved", "bm_session_version", "bm_session_structure_version",
    "bm_session_can_undo", "bm_session_can_redo", "bm_session_undo_name", "bm_session_redo_name",
    "bm_session_undo", "bm_session_redo", "bm_session_remove", "bm_session_select_all",
    "bm_session_select_none", "bm_session_hide", "bm_session_show_all", "bm_session_pieces_of_row",
    "bm_session_outline", "bm_outline_len", "bm_outline_row", "bm_outline_free", "bm_session_snapshot",
    "bm_snapshot_info", "bm_snapshot_piece_len", "bm_snapshot_piece", "bm_snapshot_free", "bm_colors",
    "bm_colors_len", "bm_colors_at", "bm_colors_free", "bm_struct_size",
];
