//! Safe wrappers for the LDraw parts catalog and offscreen square part previews.
use std::ffi::CString;

use bm_sys as sys;

use crate::{Frame, borrowed};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PartMatch {
    pub name: String,
    pub description: String,
    pub category: String,
}

fn take_parts(h: *mut sys::BmParts) -> Vec<PartMatch> {
    if h.is_null() {
        return Vec::new();
    }
    let n = unsafe { sys::bm_parts_len(h) };
    let out = (0..n)
        .map(|i| {
            let m = unsafe { sys::bm_parts_at(h, i) };
            PartMatch {
                name: borrowed(m.name),
                description: borrowed(m.description),
                category: borrowed(m.category),
            }
        })
        .collect();
    unsafe { sys::bm_parts_free(h) };
    out
}

pub fn library_parts(query: &str, category: &str, limit: usize) -> Vec<PartMatch> {
    let Ok(q) = CString::new(query) else { return Vec::new() };
    let Ok(c) = CString::new(category) else { return Vec::new() };
    take_parts(unsafe { sys::bm_library_parts(q.as_ptr(), c.as_ptr(), limit) })
}

pub fn common_parts() -> Vec<PartMatch> {
    take_parts(unsafe { sys::bm_common_parts() })
}

pub fn part_categories() -> Vec<String> {
    let h = unsafe { sys::bm_part_categories() };
    if h.is_null() {
        return Vec::new();
    }
    let n = unsafe { sys::bm_strings_len(h) };
    let out = (0..n).map(|i| borrowed(unsafe { sys::bm_strings_at(h, i) })).collect();
    unsafe { sys::bm_strings_free(h) };
    out
}

/// Worker-owned square studio part renderer. Send (moves to its worker), never Sync.
pub struct PartPreview {
    raw: *mut sys::BmPartPreview,
}

unsafe impl Send for PartPreview {}

impl PartPreview {
    pub fn new() -> Option<PartPreview> {
        let raw = unsafe { sys::bm_part_preview_new() };
        (!raw.is_null()).then_some(PartPreview { raw })
    }

    /// Renders a square RGBA picture for `part` in `color`, or `None` when the part cannot render.
    pub fn render(&mut self, part: &str, color: i32, dark: bool) -> Option<Frame> {
        let c = CString::new(part).ok()?;
        let pic = unsafe { sys::bm_part_preview_render(self.raw, c.as_ptr(), color, dark) };
        if pic.is_null() {
            return None;
        }
        let (mut w, mut h) = (0i32, 0i32);
        unsafe { sys::bm_picture_info(pic, &mut w, &mut h) };
        let ptr = unsafe { sys::bm_picture_rgba(pic) };
        let frame = if w > 0 && h > 0 && !ptr.is_null() {
            let len = w as usize * h as usize * 4;
            let rgba = unsafe { std::slice::from_raw_parts(ptr, len) }.to_vec();
            Some(Frame { width: w as u32, height: h as u32, rgba })
        } else {
            None
        };
        unsafe { sys::bm_picture_free(pic) };
        frame
    }
}

impl Drop for PartPreview {
    fn drop(&mut self) {
        unsafe { sys::bm_part_preview_free(self.raw) };
    }
}
