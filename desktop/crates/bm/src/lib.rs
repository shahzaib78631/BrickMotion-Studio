//! Safe wrappers over the BrickMotion engine (bmffi).
mod error;
mod session;
mod viewport;

use std::path::PathBuf;

use bm_sys as sys;

pub use error::OpenError;
pub use session::{OpenInfo, SelectMode, Session};
pub use viewport::{Frame, ViewPreset, Viewport};

/// Copies an engine string and frees it.
pub(crate) fn take_string(s: sys::BmString) -> String {
    if s.ptr.is_null() {
        return String::new();
    }
    let bytes = unsafe { std::slice::from_raw_parts(s.ptr as *const u8, s.len) };
    let out = String::from_utf8_lossy(bytes).into_owned();
    unsafe { sys::bm_string_free(s) };
    out
}

/// Where the LDraw parts library was found, if anywhere.
pub fn ldraw_directory() -> Option<PathBuf> {
    let d = take_string(unsafe { sys::bm_ldraw_directory() });
    (!d.is_empty()).then(|| PathBuf::from(d))
}

pub fn engine_version() -> String {
    take_string(unsafe { sys::bm_engine_version() })
}

/// One open document: its session and the viewport that draws it.
///
/// The engine's viewport points at its session, so the session lives in a `Box` (its address never
/// moves) and the viewport is always dropped first. A Document may be built on a worker thread
/// (building the viewport is the slow part of opening) and moved to the thread that draws it.
pub struct Document {
    // Field order matters: `viewport` drops before `session`.
    viewport: Option<Viewport>,
    session: Box<Session>,
}

impl Document {
    /// Makes a viewport too, when this Mac has Metal.
    pub fn new(session: Session) -> Document {
        let session = Box::new(session);
        let viewport = Viewport::new(session.raw);
        Document { viewport, session }
    }

    pub fn session(&self) -> &Session {
        &self.session
    }

    pub fn session_mut(&mut self) -> &mut Session {
        &mut self.session
    }

    pub fn viewport(&mut self) -> Option<&mut Viewport> {
        self.viewport.as_mut()
    }

    /// Takes the document `loaded` holds, with a fresh viewport.
    pub fn replace(&mut self, loaded: Session) {
        self.viewport = None;
        self.session.adopt(&loaded);
        drop(loaded);
        self.viewport = Viewport::new(self.session.raw);
    }
}
