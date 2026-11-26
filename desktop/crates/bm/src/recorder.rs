//! View → Record Viewport's encoder: viewport frames as an H.264 movie.
use std::ffi::CString;
use std::path::Path;

use bm_sys as sys;

use crate::take_string;

/// An H.264 movie being written. The first size sets the movie (even, longest side ≤ 3840);
/// later frames are fitted into it on black.
pub struct Recorder {
    raw: *mut sys::BmRecorder,
}

// The encoder is driven from one thread at a time; it may move to a worker.
unsafe impl Send for Recorder {}

fn c_path(path: &Path) -> CString {
    CString::new(path.to_string_lossy().replace('\0', "")).unwrap_or_default()
}

impl Recorder {
    pub fn start(path: &Path, width: u32, height: u32) -> Result<Recorder, String> {
        let p = c_path(path);
        let mut error = sys::BmString { ptr: std::ptr::null_mut(), len: 0 };
        let raw = unsafe { sys::bm_recorder_start(p.as_ptr(), width as i32, height as i32, &mut error) };
        if raw.is_null() {
            let why = take_string(error);
            return Err(if why.is_empty() { "The recording could not start.".into() } else { why });
        }
        Ok(Recorder { raw })
    }

    /// The movie's size in pixels.
    pub fn size(&self) -> (u32, u32) {
        let s = unsafe { sys::bm_recorder_size(self.raw) };
        (s.width as u32, s.height as u32)
    }

    /// Adds an RGBA frame (top row first) at `seconds`; false when it was dropped.
    pub fn append(&mut self, rgba: &[u8], width: u32, height: u32, seconds: f64) -> bool {
        unsafe { sys::bm_recorder_append(self.raw, rgba.as_ptr(), rgba.len(), width as i32, height as i32, seconds) }
    }

    /// Finishes the file.
    pub fn finish(mut self) -> Result<(), String> {
        let raw = std::mem::replace(&mut self.raw, std::ptr::null_mut());
        let failure = take_string(unsafe { sys::bm_recorder_finish(raw) });
        if failure.is_empty() { Ok(()) } else { Err(failure) }
    }
}

impl Drop for Recorder {
    fn drop(&mut self) {
        if !self.raw.is_null() {
            unsafe { sys::bm_recorder_free(self.raw) };
        }
    }
}

/// The video track's frame count, read with AVFoundation; None when the file has none.
pub fn frame_count(path: &Path) -> Option<u32> {
    let p = c_path(path);
    let n = unsafe { sys::bm_movie_frame_count(p.as_ptr()) };
    (n >= 0).then_some(n as u32)
}
