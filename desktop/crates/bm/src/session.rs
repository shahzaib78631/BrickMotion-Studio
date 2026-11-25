use std::ffi::CString;
use std::path::Path;

use bm_sys as sys;

use crate::{OpenError, take_string};

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
pub struct Session {
    pub(crate) raw: *mut sys::BmSession,
}

// One owner moves it between threads (a worker opens, the UI adopts); it is never shared.
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
        let ok = r.ok;
        let error = take_string(r.error);
        let warnings = take_string(r.warnings);
        if !ok {
            return Err(fail(if error.is_empty() { "the file could not be opened".into() } else { error }));
        }
        Ok(OpenInfo { warnings: warnings.lines().filter(|l| !l.trim().is_empty()).map(str::to_owned).collect() })
    }

    /// Takes the document `loaded` opened (usually on a worker thread).
    pub fn adopt(&mut self, loaded: &Session) {
        unsafe { sys::bm_session_adopt(self.raw, loaded.raw) }
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

    pub fn select(&mut self, pieces: &[u32], mode: SelectMode) {
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

impl Drop for Session {
    fn drop(&mut self) {
        unsafe { sys::bm_session_free(self.raw) }
    }
}
