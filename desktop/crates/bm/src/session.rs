use std::ffi::CString;
use std::path::Path;

use bm_sys as sys;

use crate::{Changed, ColorInfo, OpenError, OutlineRow, PieceInfo, Snapshot, borrowed, take_string};

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

    pub fn selection(&self) -> Vec<u32> {
        let n = unsafe { sys::bm_session_selection(self.raw, std::ptr::null_mut(), 0) };
        let mut out = vec![0u32; n];
        let total = unsafe { sys::bm_session_selection(self.raw, out.as_mut_ptr(), out.len()) };
        out.truncate(total.min(n));
        out
    }
}

fn take_change(c: sys::BmChange) -> Changed {
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

    pub fn show_all(&self) {
        unsafe { sys::bm_session_show_all(self.raw) }
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
}

impl Drop for Session {
    fn drop(&mut self) {
        unsafe { sys::bm_session_free(self.raw) }
    }
}
