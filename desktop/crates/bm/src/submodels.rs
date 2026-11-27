//! Submodels, groups, scale and import-into: thin wrappers over the engine's edits.
use std::ffi::CString;
use std::path::Path;

use bm_sys as sys;

use crate::session::take_change;
use crate::{Changed, Mat3, Session, Vec3, borrowed, take_string};

fn refused(s: &Session, why: &str) -> Changed {
    Changed { structure: false, version: s.version(), refused: Some(why.into()) }
}

fn lines(joined: String) -> Vec<String> {
    if joined.is_empty() { Vec::new() } else { joined.split('\n').map(str::to_owned).collect() }
}

impl Session {
    /// `preferred`, else "<preferred> 2", 3, …: the first name no submodel has.
    pub fn free_submodel_name(&self, preferred: &str) -> String {
        let Ok(c) = CString::new(preferred) else { return preferred.to_owned() };
        take_string(unsafe { sys::bm_session_free_submodel_name(self.raw, c.as_ptr()) })
    }

    /// An empty submodel with one empty step, used nowhere yet.
    pub fn new_submodel(&self, name: &str) -> Changed {
        let Ok(c) = CString::new(name) else { return refused(self, "invalid name") };
        take_change(unsafe { sys::bm_session_new_submodel(self.raw, c.as_ptr()) })
    }

    /// The items holding `pieces` become a new submodel; one use of it takes their place.
    pub fn make_submodel(&self, pieces: &[u32], name: &str) -> Changed {
        let Ok(c) = CString::new(name) else { return refused(self, "invalid name") };
        take_change(unsafe { sys::bm_session_make_submodel(self.raw, pieces.as_ptr(), pieces.len(), c.as_ptr()) })
    }

    /// The use holding `piece` is replaced by copies of its submodel's items.
    pub fn extract(&self, piece: u32) -> Changed {
        take_change(unsafe { sys::bm_session_extract(self.raw, piece) })
    }

    /// To the last step of `submodel`, through its first use in this model.
    pub fn move_to_model(&self, pieces: &[u32], submodel: &str) -> Changed {
        let Ok(c) = CString::new(submodel) else { return refused(self, "invalid name") };
        take_change(unsafe { sys::bm_session_move_to_model(self.raw, pieces.as_ptr(), pieces.len(), c.as_ptr()) })
    }

    pub fn rename_submodel(&self, from: &str, to: &str) -> Changed {
        let (Ok(f), Ok(t)) = (CString::new(from), CString::new(to)) else { return refused(self, "invalid name") };
        take_change(unsafe { sys::bm_session_rename_submodel(self.raw, f.as_ptr(), t.as_ptr()) })
    }

    /// Only a submodel that is not used.
    pub fn delete_submodel(&self, name: &str) -> Changed {
        let Ok(c) = CString::new(name) else { return refused(self, "invalid name") };
        take_change(unsafe { sys::bm_session_delete_submodel(self.raw, c.as_ptr()) })
    }

    /// Forks the submodel use holding `piece` into "<name> 2" (the next free number).
    pub fn make_unique(&self, piece: u32) -> Changed {
        take_change(unsafe { sys::bm_session_make_unique(self.raw, piece) })
    }

    /// Names a group on `pieces`; an empty name removes the mark.
    pub fn set_group(&self, pieces: &[u32], group: &str) -> Changed {
        let Ok(c) = CString::new(group) else { return refused(self, "invalid name") };
        take_change(unsafe { sys::bm_session_set_group(self.raw, pieces.as_ptr(), pieces.len(), c.as_ptr()) })
    }

    pub fn group_names(&self) -> Vec<String> {
        lines(take_string(unsafe { sys::bm_session_group_names(self.raw) }))
    }

    pub fn groups_of(&self, pieces: &[u32]) -> Vec<String> {
        lines(take_string(unsafe { sys::bm_session_groups_of(self.raw, pieces.as_ptr(), pieces.len()) }))
    }

    /// Selects every piece of `group`.
    pub fn select_group(&self, group: &str) {
        if let Ok(c) = CString::new(group) {
            unsafe { sys::bm_session_select_group(self.raw, c.as_ptr()) }
        }
    }

    /// Scales `pieces` by `factor` along `axes` about `pivot`; `continuing` joins the open gesture.
    pub fn scale(&self, pieces: &[u32], factor: Vec3, axes: Mat3, pivot: Vec3, continuing: bool) -> Changed {
        take_change(unsafe {
            sys::bm_session_scale(self.raw, pieces.as_ptr(), pieces.len(), factor.to_raw(), axes.to_raw(), pivot.to_raw(), continuing)
        })
    }

    /// Adds a model read by [`ModelImport::read`] into `into` ("" is the open model).
    pub fn import_model(&self, file: &ModelImport, into: &str, generation: u64) -> Changed {
        let Ok(c) = CString::new(into) else { return refused(self, "invalid name") };
        take_change(unsafe { sys::bm_session_import_model(self.raw, file.raw, c.as_ptr(), generation) })
    }
}

/// A model file read once, independently of any document. Immutable, so it can be read on a
/// worker and handed to the document's thread.
pub struct ModelImport {
    raw: *mut sys::BmModelImport,
}

// SAFETY: the engine's ModelImport is immutable after `read` returns.
unsafe impl Send for ModelImport {}

impl ModelImport {
    /// The file, or why it could not be read.
    pub fn read(path: &Path) -> Result<ModelImport, String> {
        let Ok(c) = CString::new(path.to_string_lossy().as_bytes()) else { return Err("invalid path".into()) };
        let raw = unsafe { sys::bm_model_import_read(c.as_ptr()) };
        if raw.is_null() {
            return Err("The file could not be read.".into());
        }
        let out = ModelImport { raw };
        let error = borrowed(unsafe { sys::bm_model_import_error(raw) });
        if error.is_empty() { Ok(out) } else { Err(error) }
    }
}

impl Drop for ModelImport {
    fn drop(&mut self) {
        unsafe { sys::bm_model_import_free(self.raw) }
    }
}
