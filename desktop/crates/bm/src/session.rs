use std::ffi::CString;
use std::path::Path;

use bm_sys as sys;

use crate::steps::{ItemRow, StepFields, StepRow};
use crate::{Changed, ColorInfo, Mat3, OpenError, OutlineRow, PieceInfo, Pose, Snapshot, Vec3, borrowed, take_string};

/// What opening a file reported besides success.
#[derive(Debug, Clone, Default)]
pub struct OpenInfo {
    /// One entry per warning line.
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SelectMode {
    Replace,
    Add,
    Toggle,
}

/// One document in the engine. Owned by one thread at a time.
///
/// Edits take `&self`: a Session is not `Sync`, so only its owning thread can reach it, and a
/// [`Document`](crate::Document) can hand out `&Session` without letting anyone swap the session
/// out from under its viewport.
pub struct Session {
    pub(crate) raw: *mut sys::BmSession,
}

// One owner moves it between threads (a worker opens it, the UI draws it); it is never shared.
unsafe impl Send for Session {}

impl Default for Session {
    fn default() -> Self {
        Self::new()
    }
}

impl Session {
    pub fn new() -> Session {
        let raw = unsafe { sys::bm_session_new() };
        assert!(!raw.is_null(), "the engine could not create a session");
        Session { raw }
    }

    pub fn open(&mut self, path: &Path) -> Result<OpenInfo, OpenError> {
        let fail = |message: String| OpenError { path: path.to_path_buf(), message };
        let c = CString::new(path.to_string_lossy().as_bytes()).map_err(|_| fail("the path contains a NUL byte".into()))?;
        let r = unsafe { sys::bm_session_open(self.raw, c.as_ptr()) };
        open_info(r, fail)
    }

    pub fn title(&self) -> String {
        take_string(unsafe { sys::bm_session_title(self.raw) })
    }

    pub fn piece_count(&self) -> usize {
        unsafe { sys::bm_session_piece_count(self.raw) }
    }

    pub fn generation(&self) -> u64 {
        unsafe { sys::bm_session_generation(self.raw) }
    }

    pub fn select(&self, pieces: &[u32], mode: SelectMode) {
        let m = match mode {
            SelectMode::Replace => sys::BM_SELECT_REPLACE,
            SelectMode::Add => sys::BM_SELECT_ADD,
            SelectMode::Toggle => sys::BM_SELECT_TOGGLE,
        };
        unsafe { sys::bm_session_select(self.raw, pieces.as_ptr(), pieces.len(), m) }
    }

    /// How many pieces are selected, without copying the list.
    pub fn selection_len(&self) -> usize {
        unsafe { sys::bm_session_selection(self.raw, std::ptr::null_mut(), 0) }
    }

    pub fn selection(&self) -> Vec<u32> {
        let n = unsafe { sys::bm_session_selection(self.raw, std::ptr::null_mut(), 0) };
        let mut out = vec![0u32; n];
        let total = unsafe { sys::bm_session_selection(self.raw, out.as_mut_ptr(), out.len()) };
        out.truncate(total.min(n));
        out
    }
}

pub(crate) fn take_change(c: sys::BmChange) -> Changed {
    let refused = take_string(c.refused);
    Changed { structure: c.structure, version: c.version, refused: (!refused.is_empty()).then_some(refused) }
}

fn open_info(r: sys::BmOpenResult, fail: impl Fn(String) -> OpenError) -> Result<OpenInfo, OpenError> {
    let ok = r.ok;
    let error = take_string(r.error);
    let warnings = take_string(r.warnings);
    if !ok {
        return Err(fail(if error.is_empty() { "the file could not be opened".into() } else { error }));
    }
    Ok(OpenInfo { warnings: warnings.lines().filter(|l| !l.trim().is_empty()).map(str::to_owned).collect() })
}

/// Documents: saving, undo, edits, view state and the lists the panes read.
impl Session {
    /// An untitled project with one empty step.
    pub fn new_blank(&mut self) -> Result<OpenInfo, OpenError> {
        let r = unsafe { sys::bm_session_new_blank(self.raw) };
        open_info(r, |message| OpenError { path: "Untitled".into(), message })
    }

    /// The document as .brickmotion project bytes.
    pub fn project_bytes(&self) -> Vec<u8> {
        let s = unsafe { sys::bm_session_project_bytes(self.raw) };
        if s.ptr.is_null() {
            return Vec::new();
        }
        let out = unsafe { std::slice::from_raw_parts(s.ptr as *const u8, s.len) }.to_vec();
        unsafe { sys::bm_string_free(s) };
        out
    }

    /// True unless the file was a .brickmotion project.
    pub fn imported(&self) -> bool {
        unsafe { sys::bm_session_imported(self.raw) }
    }

    pub fn dirty(&self) -> bool {
        unsafe { sys::bm_session_dirty(self.raw) }
    }

    pub fn mark_saved(&self) {
        unsafe { sys::bm_session_mark_saved(self.raw) }
    }

    pub fn version(&self) -> u64 {
        unsafe { sys::bm_session_version(self.raw) }
    }

    pub fn structure_version(&self) -> u64 {
        unsafe { sys::bm_session_structure_version(self.raw) }
    }

    pub fn can_undo(&self) -> bool {
        unsafe { sys::bm_session_can_undo(self.raw) }
    }

    pub fn can_redo(&self) -> bool {
        unsafe { sys::bm_session_can_redo(self.raw) }
    }

    pub fn undo_name(&self) -> String {
        take_string(unsafe { sys::bm_session_undo_name(self.raw) })
    }

    pub fn redo_name(&self) -> String {
        take_string(unsafe { sys::bm_session_redo_name(self.raw) })
    }

    pub fn undo(&self) -> Changed {
        take_change(unsafe { sys::bm_session_undo(self.raw) })
    }

    pub fn redo(&self) -> Changed {
        take_change(unsafe { sys::bm_session_redo(self.raw) })
    }

    /// Deletes pieces as one undo step.
    pub fn remove(&self, pieces: &[u32]) -> Changed {
        take_change(unsafe { sys::bm_session_remove(self.raw, pieces.as_ptr(), pieces.len()) })
    }

    /// Moves pieces by a world LDU offset (`move` is a keyword).
    pub fn translate(&self, pieces: &[u32], delta: Vec3, continuing: bool) -> Changed {
        take_change(unsafe { sys::bm_session_move(self.raw, pieces.as_ptr(), pieces.len(), delta.to_raw(), continuing) })
    }

    /// Turns pieces about a world axis through a world pivot, in degrees.
    pub fn rotate(&self, pieces: &[u32], axis: Vec3, degrees: f64, pivot: Vec3, continuing: bool) -> Changed {
        take_change(unsafe {
            sys::bm_session_rotate(self.raw, pieces.as_ptr(), pieces.len(), axis.to_raw(), degrees, pivot.to_raw(), continuing)
        })
    }

    pub fn recolor(&self, pieces: &[u32], code: i32) -> Changed {
        take_change(unsafe { sys::bm_session_recolor(self.raw, pieces.as_ptr(), pieces.len(), code) })
    }

    pub fn duplicate(&self, pieces: &[u32], offset: Vec3) -> Changed {
        take_change(unsafe { sys::bm_session_duplicate(self.raw, pieces.as_ptr(), pieces.len(), offset.to_raw()) })
    }

    pub fn replace_part(&self, pieces: &[u32], part: &str) -> Changed {
        let Ok(c) = CString::new(part) else {
            return Changed { structure: false, version: self.version(), refused: Some("invalid part name".into()) };
        };
        take_change(unsafe { sys::bm_session_replace_part(self.raw, pieces.as_ptr(), pieces.len(), c.as_ptr()) })
    }

    pub fn end_gesture(&self) {
        unsafe { sys::bm_session_end_gesture(self.raw) }
    }

    pub fn axes_of(&self, piece: u32) -> Mat3 {
        Mat3::from_raw(unsafe { sys::bm_session_axes_of(self.raw, piece) })
    }

    pub fn copy(&self, pieces: &[u32]) -> String {
        take_string(unsafe { sys::bm_session_copy(self.raw, pieces.as_ptr(), pieces.len()) })
    }

    pub fn paste(&self, text: &str, offset: Vec3) -> Changed {
        let Ok(c) = CString::new(text) else {
            return Changed { structure: false, version: self.version(), refused: Some("clipboard text contains a NUL byte".into()) };
        };
        take_change(unsafe { sys::bm_session_paste(self.raw, c.as_ptr(), offset.to_raw()) })
    }

    #[allow(clippy::too_many_arguments)]
    pub fn place_part(
        &self,
        part: &str,
        color: i32,
        pose: &Pose,
        step: Option<usize>,
        before: Option<usize>,
        generation: u64,
        version: u64,
    ) -> Changed {
        let Ok(c) = CString::new(part) else {
            return Changed { structure: false, version: self.version(), refused: Some("invalid part name".into()) };
        };
        let step_i = step.and_then(|s| i32::try_from(s).ok()).unwrap_or(-1);
        let before_i = before.and_then(|b| i32::try_from(b).ok()).unwrap_or(-1);
        take_change(unsafe {
            sys::bm_session_place_part(
                self.raw,
                c.as_ptr(),
                color,
                pose.rotation.to_raw(),
                pose.position.to_raw(),
                step_i,
                before_i,
                generation,
                version,
            )
        })
    }

    /// Every piece not hidden.
    pub fn select_all(&self) {
        unsafe { sys::bm_session_select_all(self.raw) }
    }

    pub fn select_none(&self) {
        unsafe { sys::bm_session_select_none(self.raw) }
    }

    pub fn hide(&self, pieces: &[u32]) {
        unsafe { sys::bm_session_hide(self.raw, pieces.as_ptr(), pieces.len()) }
    }

    pub fn show(&self, pieces: &[u32]) {
        if !pieces.is_empty() {
            unsafe { sys::bm_session_show(self.raw, pieces.as_ptr(), pieces.len()) }
        }
    }

    pub fn show_all(&self) {
        unsafe { sys::bm_session_show_all(self.raw) }
    }

    /// The part name, description and category of `piece`.
    pub fn part_at(&self, piece: u32) -> crate::library::PartMatch {
        let mut name = sys::BmString { ptr: std::ptr::null_mut(), len: 0 };
        let mut description = sys::BmString { ptr: std::ptr::null_mut(), len: 0 };
        let mut category = sys::BmString { ptr: std::ptr::null_mut(), len: 0 };
        unsafe { sys::bm_session_part_at(self.raw, piece, &mut name, &mut description, &mut category) };
        crate::library::PartMatch {
            name: take_string(name),
            description: take_string(description),
            category: take_string(category),
        }
    }

    pub fn part_color(&self, piece: u32) -> i32 {
        unsafe { sys::bm_session_part_color(self.raw, piece) }
    }

    /// Focuses the session on a submodel path (empty returns to the main model).
    pub fn focus(&self, path: &[String]) -> Changed {
        let cstrings: Vec<CString> = path.iter().filter_map(|s| CString::new(s.as_str()).ok()).collect();
        let ptrs: Vec<*const std::ffi::c_char> = cstrings.iter().map(|s| s.as_ptr()).collect();
        let ptr = if ptrs.is_empty() { std::ptr::null() } else { ptrs.as_ptr() };
        take_change(unsafe { sys::bm_session_focus(self.raw, ptr, ptrs.len()) })
    }

    /// The currently focused submodel name, or empty string when editing the main model.
    pub fn focused(&self) -> String {
        take_string(unsafe { sys::bm_session_focused(self.raw) })
    }

    /// The focused submodel path (empty when at the main model).
    pub fn focus_path(&self) -> Vec<String> {
        let joined = take_string(unsafe { sys::bm_session_focus_path(self.raw) });
        if joined.is_empty() {
            Vec::new()
        } else {
            joined.split('\n').map(str::to_owned).collect()
        }
    }

    /// The pieces under an outline row.
    pub fn pieces_of_row(&self, id: &str) -> Vec<u32> {
        let Ok(c) = CString::new(id) else { return Vec::new() };
        let n = unsafe { sys::bm_session_pieces_of_row(self.raw, c.as_ptr(), std::ptr::null_mut(), 0) };
        let mut out = vec![0u32; n];
        let total = unsafe { sys::bm_session_pieces_of_row(self.raw, c.as_ptr(), out.as_mut_ptr(), out.len()) };
        out.truncate(total.min(n));
        out
    }

    pub fn outline(&self) -> Vec<OutlineRow> {
        let h = unsafe { sys::bm_session_outline(self.raw) };
        if h.is_null() {
            return Vec::new();
        }
        let n = unsafe { sys::bm_outline_len(h) };
        let rows = (0..n)
            .map(|i| {
                let r = unsafe { sys::bm_outline_row(h, i) };
                OutlineRow {
                    id: borrowed(r.id),
                    def: borrowed(r.def),
                    name: borrowed(r.name),
                    group: borrowed(r.group),
                    depth: r.depth.max(0) as u32,
                    parent: (r.parent >= 0).then_some(r.parent as usize),
                    pieces: r.pieces,
                    uses: r.uses,
                    shared: r.shared,
                    unused: r.unused,
                }
            })
            .collect();
        unsafe { sys::bm_outline_free(h) };
        rows
    }

    pub fn snapshot(&self) -> Snapshot {
        let h = unsafe { sys::bm_session_snapshot(self.raw) };
        if h.is_null() {
            return Snapshot::default();
        }
        let info = unsafe { sys::bm_snapshot_info(h) };
        let n = unsafe { sys::bm_snapshot_piece_len(h) };
        let described = (0..n)
            .map(|i| {
                let p = unsafe { sys::bm_snapshot_piece(h, i) };
                PieceInfo {
                    piece: p.piece,
                    part: borrowed(p.part),
                    description: borrowed(p.description),
                    color_name: borrowed(p.color_name),
                    submodel_path: borrowed(p.submodel_path),
                    color: p.color,
                    step: p.step,
                    in_shared_submodel: p.in_shared_submodel,
                }
            })
            .collect();
        unsafe { sys::bm_snapshot_free(h) };
        Snapshot {
            version: info.version,
            pieces: info.pieces,
            selected: info.selected,
            hidden: info.hidden,
            dirty: info.dirty,
            described,
        }
    }

    /// The library's colours, by group then code.
    pub fn colors(&self) -> Vec<ColorInfo> {
        let h = unsafe { sys::bm_colors(self.raw) };
        if h.is_null() {
            return Vec::new();
        }
        let n = unsafe { sys::bm_colors_len(h) };
        let out = (0..n)
            .map(|i| {
                let c = unsafe { sys::bm_colors_at(h, i) };
                ColorInfo {
                    code: c.code,
                    name: borrowed(c.name),
                    rgb: [(c.rgb >> 16) as u8, (c.rgb >> 8) as u8, c.rgb as u8],
                    alpha: c.alpha,
                    group: c.group,
                }
            })
            .collect();
        unsafe { sys::bm_colors_free(h) };
        out
    }

    pub fn steps(&self) -> Vec<StepRow> {
        let h = unsafe { sys::bm_session_steps(self.raw) };
        if h.is_null() {
            return Vec::new();
        }
        let n = unsafe { sys::bm_steps_len(h) };
        let out = (0..n)
            .map(|i| {
                let r = unsafe { sys::bm_steps_at(h, i) };
                StepRow {
                    index: r.index,
                    title: borrowed(r.title),
                    notes: borrowed(r.notes),
                    pause_after: r.pause_after,
                    pin_order: r.pin_order,
                    automatic: r.automatic,
                    items: r.items,
                    pieces: r.pieces,
                    submodels: r.submodels,
                }
            })
            .collect();
        unsafe { sys::bm_steps_free(h) };
        out
    }

    pub fn step_items(&self, step: usize) -> Vec<ItemRow> {
        let h = unsafe { sys::bm_session_step_items(self.raw, step) };
        if h.is_null() {
            return Vec::new();
        }
        let n = unsafe { sys::bm_items_len(h) };
        let out = (0..n)
            .map(|i| {
                let r = unsafe { sys::bm_items_at(h, i) };
                let pn = unsafe { sys::bm_item_pieces(h, i, std::ptr::null_mut(), 0) };
                let mut pieces = vec![0u32; pn];
                let total = unsafe { sys::bm_item_pieces(h, i, pieces.as_mut_ptr(), pieces.len()) };
                pieces.truncate(total.min(pn));
                ItemRow {
                    item: r.item,
                    name: borrowed(r.name),
                    description: borrowed(r.description),
                    color_name: borrowed(r.color_name),
                    group: borrowed(r.group),
                    color: r.color,
                    submodel: r.submodel,
                    step: r.step,
                    index: r.index,
                    pieces,
                }
            })
            .collect();
        unsafe { sys::bm_items_free(h) };
        out
    }

    pub fn pieces_of_step(&self, step: usize) -> Vec<u32> {
        let n = unsafe { sys::bm_session_pieces_of_step(self.raw, step, std::ptr::null_mut(), 0) };
        let mut out = vec![0u32; n];
        let total = unsafe { sys::bm_session_pieces_of_step(self.raw, step, out.as_mut_ptr(), out.len()) };
        out.truncate(total.min(n));
        out
    }

    pub fn insert_step(&self, at: usize) -> Changed {
        take_change(unsafe { sys::bm_session_insert_step(self.raw, at) })
    }

    pub fn delete_step(&self, at: usize) -> Changed {
        take_change(unsafe { sys::bm_session_delete_step(self.raw, at) })
    }

    pub fn move_step(&self, from: usize, to: usize) -> Changed {
        take_change(unsafe { sys::bm_session_move_step(self.raw, from, to) })
    }

    pub fn split_step(&self, at: usize, pieces: &[u32]) -> Changed {
        take_change(unsafe { sys::bm_session_split_step(self.raw, at, pieces.as_ptr(), pieces.len()) })
    }

    pub fn merge_steps(&self, first: usize) -> Changed {
        take_change(unsafe { sys::bm_session_merge_steps(self.raw, first) })
    }

    pub fn set_step_fields(&self, at: usize, fields: &StepFields, continuing: bool) -> Changed {
        let Ok(title) = CString::new(fields.title.as_str()) else {
            return Changed { structure: false, version: self.version(), refused: Some("invalid title".into()) };
        };
        let Ok(notes) = CString::new(fields.notes.as_str()) else {
            return Changed { structure: false, version: self.version(), refused: Some("invalid notes".into()) };
        };
        take_change(unsafe {
            sys::bm_session_set_step_fields(
                self.raw,
                at,
                title.as_ptr(),
                notes.as_ptr(),
                fields.pause_after,
                fields.pin_order,
                continuing,
            )
        })
    }

    pub fn move_to_step(&self, pieces: &[u32], step: usize) -> Changed {
        take_change(unsafe { sys::bm_session_move_to_step(self.raw, pieces.as_ptr(), pieces.len(), step) })
    }

    pub fn reorder_in_step(&self, step: usize, from: usize, to: usize) -> Changed {
        take_change(unsafe { sys::bm_session_reorder_in_step(self.raw, step, from, to) })
    }

    pub fn move_arrival(&self, pieces: &[u32], step: usize, before: usize, force: bool) -> Changed {
        take_change(unsafe {
            sys::bm_session_move_arrival(self.raw, pieces.as_ptr(), pieces.len(), step, before, force)
        })
    }

    pub fn reorder_arrival(&self, step: usize, from: usize, to: usize) -> Changed {
        take_change(unsafe { sys::bm_session_reorder_arrival(self.raw, step, from, to) })
    }

    pub fn set_arrival_pinned(&self, pieces: &[u32], pinned: bool) -> Changed {
        take_change(unsafe {
            sys::bm_session_set_arrival_pinned(self.raw, pieces.as_ptr(), pieces.len(), pinned)
        })
    }

    pub fn arrival_pins(&self) -> Vec<u32> {
        let n = unsafe { sys::bm_session_arrival_pins(self.raw, std::ptr::null_mut(), 0) };
        let mut out = vec![0u32; n];
        let total = unsafe { sys::bm_session_arrival_pins(self.raw, out.as_mut_ptr(), out.len()) };
        out.truncate(total.min(n));
        out
    }

    pub fn set_sequence_duration(&self, segment: crate::playback::Segment, seconds: f64) -> Changed {
        take_change(unsafe { sys::bm_session_set_sequence_duration(self.raw, segment.to_raw(), seconds) })
    }

    pub fn regenerate_steps(&self, order: &[u32]) -> Changed {
        take_change(unsafe { sys::bm_session_regenerate_steps(self.raw, order.as_ptr(), order.len()) })
    }

    pub fn move_to_new_step(&self, pieces: &[u32], index: usize) -> Changed {
        take_change(unsafe {
            sys::bm_session_move_to_new_step(self.raw, pieces.as_ptr(), pieces.len(), index)
        })
    }

    pub fn undo_depth(&self) -> usize {
        unsafe { sys::bm_session_undo_depth(self.raw) }
    }

    pub fn build_settings(&self) -> crate::settings::BuildSettings {
        crate::settings::BuildSettings::from_raw(unsafe { sys::bm_session_build_settings(self.raw) })
    }

    pub fn set_build_settings(&self, settings: &crate::settings::BuildSettings) -> Changed {
        take_change(unsafe { sys::bm_session_set_build_settings(self.raw, settings.to_raw()) })
    }

    pub fn staging_settings(&self) -> crate::settings::StagingSettings {
        crate::settings::StagingSettings::from_raw(unsafe { sys::bm_session_staging_settings(self.raw) })
    }

    pub fn set_staging_settings(&self, settings: &crate::settings::StagingSettings) -> Changed {
        settings
            .with_raw(|raw| take_change(unsafe { sys::bm_session_set_staging_settings(self.raw, raw) }))
            .unwrap_or_else(|| Changed {
                structure: false,
                version: self.version(),
                refused: Some("invalid staging settings".into()),
            })
    }

    pub fn staging_turn(&self) -> f64 {
        unsafe { sys::bm_session_staging_turn(self.raw) }
    }

    pub fn set_staging_turn(&self, degrees: f64) -> Changed {
        take_change(unsafe { sys::bm_session_set_staging_turn(self.raw, degrees) })
    }

    pub fn moved_waiting_parts(&self) -> usize {
        unsafe { sys::bm_session_moved_waiting_parts(self.raw) }
    }

    pub fn put_back_waiting_parts(&self) -> Changed {
        take_change(unsafe { sys::bm_session_put_back_waiting_parts(self.raw) })
    }

    pub fn apply_staging(&self, settings: &crate::settings::StagingSettings, turn: f64, straighten: bool) -> Changed {
        settings
            .with_raw(|raw| take_change(unsafe { sys::bm_session_apply_staging(self.raw, raw, turn, straighten) }))
            .unwrap_or_else(|| Changed {
                structure: false,
                version: self.version(),
                refused: Some("invalid staging settings".into()),
            })
    }

    pub fn turn_waiting_part(&self, piece: u32, degrees: f64) -> Changed {
        take_change(unsafe { sys::bm_session_turn_waiting_part(self.raw, piece, degrees) })
    }

    pub fn shift_waiting_part(&self, piece: u32, delta: Vec3) -> Changed {
        take_change(unsafe { sys::bm_session_shift_waiting_part(self.raw, piece, delta.to_raw()) })
    }

    pub fn waiting_shift(&self, piece: u32) -> Vec3 {
        Vec3::from_raw(unsafe { sys::bm_session_waiting_shift(self.raw, piece) })
    }

    pub fn snap_mix(&self) -> crate::settings::SnapMix {
        crate::settings::SnapMix::from_raw(unsafe { sys::bm_session_snap_mix(self.raw) })
    }

    pub fn set_snap_mix(&self, mix: &crate::settings::SnapMix) -> Changed {
        take_change(unsafe { sys::bm_session_set_snap_mix(self.raw, mix.to_raw()) })
    }
}

impl Drop for Session {
    fn drop(&mut self) {
        unsafe { sys::bm_session_free(self.raw) }
    }
}
