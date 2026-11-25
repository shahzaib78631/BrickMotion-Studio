//! Safe wrappers over the BrickMotion engine (bmffi).
mod error;
pub mod geom;
pub mod gizmo;
pub mod library;
mod outline;
pub mod placement;
mod session;
pub mod steps;
mod viewport;

use std::path::PathBuf;

use bm_sys as sys;

pub use error::OpenError;
pub use geom::{Arrow, BRICK, Camera, Mat3, PLATE, Pose, STUD, Vec2, Vec3, arrow_axis};
pub use outline::{Changed, ColorInfo, OutlineRow, PieceInfo, Snapshot};
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

/// Copies a borrowed C string (owned by a list handle).
pub(crate) fn borrowed(p: *const std::ffi::c_char) -> String {
    if p.is_null() {
        return String::new();
    }
    unsafe { std::ffi::CStr::from_ptr(p) }.to_string_lossy().into_owned()
}

/// Where the LDraw parts library was found, if anywhere.
pub fn ldraw_directory() -> Option<PathBuf> {
    let d = take_string(unsafe { sys::bm_ldraw_directory() });
    (!d.is_empty()).then(|| PathBuf::from(d))
}

/// True when this Mac has a Metal device, so viewports can be made.
pub fn metal_available() -> bool {
    unsafe { sys::bm_metal_available() }
}

pub fn engine_version() -> String {
    take_string(unsafe { sys::bm_engine_version() })
}

/// One open document: its session and the viewport that draws it.
///
/// The engine's viewport keeps its own reference to the engine session it draws, so the two must
/// stay paired: a Document hands out only `&Session` (edits take `&self`), so nothing can swap the
/// session for another while the viewport still draws the old one on this thread. The viewport is
/// dropped first. A Document may be built on a worker thread (building the viewport is the slow
/// part of opening) and moved, whole, to the thread that draws it.
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

    pub fn viewport(&mut self) -> Option<&mut Viewport> {
        self.viewport.as_mut()
    }

    pub fn parts(&mut self) -> (&Session, Option<&mut Viewport>) {
        (&self.session, self.viewport.as_mut())
    }
}
