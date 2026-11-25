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

#[repr(C)]
#[derive(Clone, Copy, Default, Debug, PartialEq)]
pub struct BmVec2 {
    pub x: f64,
    pub y: f64,
}

#[repr(C)]
#[derive(Clone, Copy, Default, Debug, PartialEq)]
pub struct BmVec3 {
    pub x: f64,
    pub y: f64,
    pub z: f64,
}

#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct BmMat3 {
    pub m: [f64; 9],
}

#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct BmCamera {
    pub yaw: f64,
    pub pitch: f64,
    pub distance: f64,
    pub target: BmVec3,
    pub orthographic: bool,
    pub vertical_fov: f64,
}

pub type BmArrow = u32;
pub const BM_ARROW_LEFT: BmArrow = 0;
pub const BM_ARROW_RIGHT: BmArrow = 1;
pub const BM_ARROW_UP: BmArrow = 2;
pub const BM_ARROW_DOWN: BmArrow = 3;

pub type BmGizmoKind = u32;
pub const BM_GIZMO_MOVE: BmGizmoKind = 1;
pub const BM_GIZMO_ROTATE: BmGizmoKind = 2;

pub type BmHandle = u32;
pub const BM_HANDLE_NONE: BmHandle = 0;
pub const BM_HANDLE_X: BmHandle = 1;
pub const BM_HANDLE_Y: BmHandle = 2;
pub const BM_HANDLE_Z: BmHandle = 3;
pub const BM_HANDLE_XY: BmHandle = 4;
pub const BM_HANDLE_YZ: BmHandle = 5;
pub const BM_HANDLE_XZ: BmHandle = 6;
pub const BM_HANDLE_VIEW: BmHandle = 7;

#[repr(C)]
pub struct BmGizmo {
    _private: [u8; 0],
}

#[repr(C)]
pub struct BmParts {
    _private: [u8; 0],
}

#[repr(C)]
#[derive(Clone, Copy)]
pub struct BmPartMatch {
    pub name: *const c_char,
    pub description: *const c_char,
    pub category: *const c_char,
}

#[repr(C)]
pub struct BmStrings {
    _private: [u8; 0],
}

#[repr(C)]
pub struct BmPartPreview {
    _private: [u8; 0],
}

#[repr(C)]
pub struct BmPicture {
    _private: [u8; 0],
}

pub type BmPlacementState = u32;
pub const BM_PLACE_INACTIVE: BmPlacementState = 0;
pub const BM_PLACE_PREPARING: BmPlacementState = 1;
pub const BM_PLACE_FREE: BmPlacementState = 2;
pub const BM_PLACE_SNAPPED: BmPlacementState = 3;
pub const BM_PLACE_REFERENCE: BmPlacementState = 4;
pub const BM_PLACE_BLOCKED: BmPlacementState = 5;
pub const BM_PLACE_UNAVAILABLE: BmPlacementState = 6;

#[repr(C)]
#[derive(Clone, Copy)]
pub struct BmPlacementInput {
    pub part: *const c_char,
    pub color: i32,
    pub grip: i32,
    pub turns: i32,
    pub mirrored: bool,
    pub snap: bool,
    pub reference: bool,
    pub collision: bool,
    pub anchor: u32,
    pub grab: BmVec2,
    pub selection: *const u32,
    pub selection_len: usize,
}

#[repr(C)]
pub struct BmPlacementPreview {
    pub state: BmPlacementState,
    pub rotation: BmMat3,
    pub position: BmVec3,
    pub contact: BmVec3,
    pub grip: u32,
    pub grip_count: u32,
    pub generation: u64,
    pub version: u64,
    pub request: u64,
    pub reason: BmString,
}

#[repr(C)]
pub struct BmSteps {
    _private: [u8; 0],
}

#[repr(C)]
#[derive(Clone, Copy)]
pub struct BmStepRow {
    pub index: usize,
    pub title: *const c_char,
    pub notes: *const c_char,
    pub pause_after: f64,
    pub pin_order: bool,
    pub automatic: bool,
    pub items: usize,
    pub pieces: usize,
    pub submodels: usize,
}

#[repr(C)]
pub struct BmItems {
    _private: [u8; 0],
}

#[repr(C)]
#[derive(Clone, Copy)]
pub struct BmItemRow {
    pub item: u64,
    pub name: *const c_char,
    pub description: *const c_char,
    pub color_name: *const c_char,
    pub group: *const c_char,
    pub color: i32,
    pub submodel: bool,
    pub step: usize,
    pub index: usize,
    pub pieces: usize,
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

    pub fn bm_session_move(s: *mut BmSession, pieces: *const u32, n: usize, delta: BmVec3, continuing: bool) -> BmChange;
    pub fn bm_session_rotate(s: *mut BmSession, pieces: *const u32, n: usize, axis: BmVec3, degrees: f64, pivot: BmVec3, continuing: bool) -> BmChange;
    pub fn bm_session_recolor(s: *mut BmSession, pieces: *const u32, n: usize, code: i32) -> BmChange;
    pub fn bm_session_duplicate(s: *mut BmSession, pieces: *const u32, n: usize, offset: BmVec3) -> BmChange;
    pub fn bm_session_replace_part(s: *mut BmSession, pieces: *const u32, n: usize, part: *const c_char) -> BmChange;
    pub fn bm_session_end_gesture(s: *mut BmSession);
    pub fn bm_session_axes_of(s: *const BmSession, piece: u32) -> BmMat3;
    pub fn bm_session_copy(s: *const BmSession, pieces: *const u32, n: usize) -> BmString;
    pub fn bm_session_paste(s: *mut BmSession, ldraw_text: *const c_char, offset: BmVec3) -> BmChange;
    pub fn bm_viewport_camera(v: *const BmViewport) -> BmCamera;
    pub fn bm_viewport_selection_center(v: *mut BmViewport) -> BmVec3;
    pub fn bm_arrow_axis(camera: BmCamera, arrow: BmArrow) -> BmVec3;

    pub fn bm_gizmo_shape(camera: BmCamera, view_points: BmVec2, origin: BmVec3, axes: BmMat3, kind: BmGizmoKind) -> *mut BmGizmo;
    pub fn bm_gizmo_free(g: *mut BmGizmo);
    pub fn bm_gizmo_line_len(g: *const BmGizmo) -> usize;
    pub fn bm_gizmo_line(g: *const BmGizmo, i: usize, a: *mut BmVec2, b: *mut BmVec2, h: *mut BmHandle);
    pub fn bm_gizmo_ring_len(g: *const BmGizmo) -> usize;
    pub fn bm_gizmo_ring_handle(g: *const BmGizmo, i: usize) -> BmHandle;
    pub fn bm_gizmo_ring(g: *const BmGizmo, i: usize, out: *mut BmVec2, cap: usize) -> usize;
    pub fn bm_gizmo_hit(g: *const BmGizmo, point: BmVec2, tolerance: f64) -> BmHandle;
    pub fn bm_handle_axis(camera: BmCamera, axes: BmMat3, handle: BmHandle) -> BmVec3;
    pub fn bm_drag_move(camera: BmCamera, view: BmVec2, origin: BmVec3, axes: BmMat3, handle: BmHandle, a: BmVec2, b: BmVec2, snap: BmVec3) -> BmVec3;
    pub fn bm_drag_rotate(camera: BmCamera, view: BmVec2, origin: BmVec3, axes: BmMat3, handle: BmHandle, a: BmVec2, b: BmVec2, free: bool) -> f64;
    pub fn bm_project_point(camera: BmCamera, view: BmVec2, p: BmVec3, out: *mut BmVec2) -> bool;

    pub fn bm_library_parts(query: *const c_char, category: *const c_char, limit: usize) -> *mut BmParts;
    pub fn bm_common_parts() -> *mut BmParts;
    pub fn bm_parts_len(p: *const BmParts) -> usize;
    pub fn bm_parts_at(p: *const BmParts, i: usize) -> BmPartMatch;
    pub fn bm_parts_free(p: *mut BmParts);
    pub fn bm_part_categories() -> *mut BmStrings;
    pub fn bm_strings_len(s: *const BmStrings) -> usize;
    pub fn bm_strings_at(s: *const BmStrings, i: usize) -> *const c_char;
    pub fn bm_strings_free(s: *mut BmStrings);
    pub fn bm_part_preview_new() -> *mut BmPartPreview;
    pub fn bm_part_preview_free(p: *mut BmPartPreview);
    pub fn bm_part_preview_render(p: *mut BmPartPreview, part: *const c_char, color: i32, dark: bool) -> *mut BmPicture;
    pub fn bm_picture_info(p: *const BmPicture, w: *mut i32, h: *mut i32);
    pub fn bm_picture_rgba(p: *const BmPicture) -> *const u8;
    pub fn bm_picture_free(p: *mut BmPicture);

    pub fn bm_placement_preview_free(p: BmPlacementPreview);
    pub fn bm_viewport_preview_part(v: *mut BmViewport, input: *const BmPlacementInput, point: BmVec2) -> u64;
    pub fn bm_viewport_placement_preview(v: *const BmViewport) -> BmPlacementPreview;
    pub fn bm_viewport_clear_placement_preview(v: *mut BmViewport);
    pub fn bm_viewport_show_rest(v: *mut BmViewport);
    pub fn bm_session_place_part(s: *mut BmSession, part: *const c_char, color: i32, rotation: BmMat3, position: BmVec3, step: i32, before: i32, generation: u64, version: u64) -> BmChange;

    pub fn bm_session_steps(s: *const BmSession) -> *mut BmSteps;
    pub fn bm_steps_len(st: *const BmSteps) -> usize;
    pub fn bm_steps_at(st: *const BmSteps, i: usize) -> BmStepRow;
    pub fn bm_steps_free(st: *mut BmSteps);
    pub fn bm_session_step_items(s: *const BmSession, step: usize) -> *mut BmItems;
    pub fn bm_items_len(it: *const BmItems) -> usize;
    pub fn bm_items_at(it: *const BmItems, i: usize) -> BmItemRow;
    pub fn bm_item_pieces(it: *const BmItems, i: usize, out: *mut u32, cap: usize) -> usize;
    pub fn bm_items_free(it: *mut BmItems);
    pub fn bm_session_pieces_of_step(s: *const BmSession, step: usize, out: *mut u32, cap: usize) -> usize;
    pub fn bm_session_insert_step(s: *mut BmSession, at: usize) -> BmChange;
    pub fn bm_session_delete_step(s: *mut BmSession, at: usize) -> BmChange;
    pub fn bm_session_move_step(s: *mut BmSession, from: usize, to: usize) -> BmChange;
    pub fn bm_session_split_step(s: *mut BmSession, at: usize, pieces: *const u32, n: usize) -> BmChange;
    pub fn bm_session_merge_steps(s: *mut BmSession, first: usize) -> BmChange;
    pub fn bm_session_set_step_fields(s: *mut BmSession, at: usize, title: *const c_char, notes: *const c_char, pause_after: f64, pin_order: bool, continuing: bool) -> BmChange;
    pub fn bm_session_move_to_step(s: *mut BmSession, pieces: *const u32, n: usize, step: usize) -> BmChange;
    pub fn bm_session_reorder_in_step(s: *mut BmSession, step: usize, from: usize, to: usize) -> BmChange;
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
    "bm_session_move", "bm_session_rotate", "bm_session_recolor", "bm_session_duplicate",
    "bm_session_replace_part", "bm_session_end_gesture", "bm_session_axes_of", "bm_session_copy",
    "bm_session_paste", "bm_viewport_camera", "bm_viewport_selection_center", "bm_arrow_axis",
    "bm_gizmo_shape", "bm_gizmo_free", "bm_gizmo_line_len", "bm_gizmo_line", "bm_gizmo_ring_len",
    "bm_gizmo_ring_handle", "bm_gizmo_ring", "bm_gizmo_hit", "bm_handle_axis", "bm_drag_move",
    "bm_drag_rotate", "bm_project_point",
    "bm_library_parts", "bm_common_parts", "bm_parts_len", "bm_parts_at", "bm_parts_free",
    "bm_part_categories", "bm_strings_len", "bm_strings_at", "bm_strings_free",
    "bm_part_preview_new", "bm_part_preview_free", "bm_part_preview_render",
    "bm_picture_info", "bm_picture_rgba", "bm_picture_free",
    "bm_placement_preview_free", "bm_viewport_preview_part", "bm_viewport_placement_preview",
    "bm_viewport_clear_placement_preview", "bm_viewport_show_rest", "bm_session_place_part",
    "bm_session_steps", "bm_steps_len", "bm_steps_at", "bm_steps_free",
    "bm_session_step_items", "bm_items_len", "bm_items_at", "bm_item_pieces", "bm_items_free",
    "bm_session_pieces_of_step", "bm_session_insert_step", "bm_session_delete_step",
    "bm_session_move_step", "bm_session_split_step", "bm_session_merge_steps",
    "bm_session_set_step_fields", "bm_session_move_to_step", "bm_session_reorder_in_step",
];
