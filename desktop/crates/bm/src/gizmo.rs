//! Safe wrappers for move and rotate gizmos: shape, hit-testing, drag maths and projection.
use bm_sys as sys;

use crate::{Camera, Mat3, Vec2, Vec3};

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum GizmoKind {
    Move,
    Rotate,
}

#[derive(Clone, Copy, Default, PartialEq, Eq, Debug)]
pub enum Handle {
    #[default]
    None,
    X,
    Y,
    Z,
    XY,
    YZ,
    XZ,
    View,
}

impl Handle {
    fn to_raw(self) -> sys::BmHandle {
        match self {
            Handle::None => sys::BM_HANDLE_NONE,
            Handle::X => sys::BM_HANDLE_X,
            Handle::Y => sys::BM_HANDLE_Y,
            Handle::Z => sys::BM_HANDLE_Z,
            Handle::XY => sys::BM_HANDLE_XY,
            Handle::YZ => sys::BM_HANDLE_YZ,
            Handle::XZ => sys::BM_HANDLE_XZ,
            Handle::View => sys::BM_HANDLE_VIEW,
        }
    }

    fn from_raw(h: sys::BmHandle) -> Self {
        match h {
            sys::BM_HANDLE_X => Handle::X,
            sys::BM_HANDLE_Y => Handle::Y,
            sys::BM_HANDLE_Z => Handle::Z,
            sys::BM_HANDLE_XY => Handle::XY,
            sys::BM_HANDLE_YZ => Handle::YZ,
            sys::BM_HANDLE_XZ => Handle::XZ,
            sys::BM_HANDLE_VIEW => Handle::View,
            _ => Handle::None,
        }
    }
}

/// A projected gizmo on screen: lines (Move axes) and closed rings (Move planes / Rotate rings).
pub struct GizmoShape {
    pub lines: Vec<(Vec2, Vec2, Handle)>,
    pub rings: Vec<(Vec<Vec2>, Handle)>,
    raw: *mut sys::BmGizmo,
}

// Owns plain vectors inside C++; never shared across threads.
unsafe impl Send for GizmoShape {}

impl GizmoShape {
    pub fn new(camera: &Camera, view: Vec2, origin: Vec3, axes: Mat3, kind: GizmoKind) -> GizmoShape {
        let k = match kind {
            GizmoKind::Move => sys::BM_GIZMO_MOVE,
            GizmoKind::Rotate => sys::BM_GIZMO_ROTATE,
        };
        let raw = unsafe { sys::bm_gizmo_shape(camera.to_raw(), view.to_raw(), origin.to_raw(), axes.to_raw(), k) };
        if raw.is_null() {
            return GizmoShape { lines: Vec::new(), rings: Vec::new(), raw };
        }
        let line_n = unsafe { sys::bm_gizmo_line_len(raw) };
        let mut lines = Vec::with_capacity(line_n);
        for i in 0..line_n {
            let (mut a, mut b, mut h) = (sys::BmVec2::default(), sys::BmVec2::default(), sys::BM_HANDLE_NONE);
            unsafe { sys::bm_gizmo_line(raw, i, &mut a, &mut b, &mut h) };
            lines.push((Vec2::from_raw(a), Vec2::from_raw(b), Handle::from_raw(h)));
        }
        let ring_n = unsafe { sys::bm_gizmo_ring_len(raw) };
        let mut rings = Vec::with_capacity(ring_n);
        for i in 0..ring_n {
            let h = Handle::from_raw(unsafe { sys::bm_gizmo_ring_handle(raw, i) });
            let n = unsafe { sys::bm_gizmo_ring(raw, i, std::ptr::null_mut(), 0) };
            let mut raw_pts = vec![sys::BmVec2::default(); n];
            let total = unsafe { sys::bm_gizmo_ring(raw, i, raw_pts.as_mut_ptr(), raw_pts.len()) };
            raw_pts.truncate(total.min(n));
            let pts = raw_pts.into_iter().map(Vec2::from_raw).collect();
            rings.push((pts, h));
        }
        GizmoShape { lines, rings, raw }
    }

    pub fn hit(&self, p: Vec2, tolerance: f64) -> Handle {
        if self.raw.is_null() {
            return Handle::None;
        }
        Handle::from_raw(unsafe { sys::bm_gizmo_hit(self.raw, p.to_raw(), tolerance) })
    }
}

impl Drop for GizmoShape {
    fn drop(&mut self) {
        if !self.raw.is_null() {
            unsafe { sys::bm_gizmo_free(self.raw) };
        }
    }
}

pub fn handle_axis(camera: &Camera, axes: Mat3, handle: Handle) -> Vec3 {
    Vec3::from_raw(unsafe { sys::bm_handle_axis(camera.to_raw(), axes.to_raw(), handle.to_raw()) })
}

#[allow(clippy::too_many_arguments)]
pub fn drag_move(camera: &Camera, view: Vec2, origin: Vec3, axes: Mat3, handle: Handle, a: Vec2, b: Vec2, snap: Vec3) -> Vec3 {
    Vec3::from_raw(unsafe {
        sys::bm_drag_move(
            camera.to_raw(),
            view.to_raw(),
            origin.to_raw(),
            axes.to_raw(),
            handle.to_raw(),
            a.to_raw(),
            b.to_raw(),
            snap.to_raw(),
        )
    })
}

#[allow(clippy::too_many_arguments)]
pub fn drag_rotate(camera: &Camera, view: Vec2, origin: Vec3, axes: Mat3, handle: Handle, a: Vec2, b: Vec2, free: bool) -> f64 {
    unsafe {
        sys::bm_drag_rotate(
            camera.to_raw(),
            view.to_raw(),
            origin.to_raw(),
            axes.to_raw(),
            handle.to_raw(),
            a.to_raw(),
            b.to_raw(),
            free,
        )
    }
}

pub fn project(camera: &Camera, view: Vec2, p: Vec3) -> Option<Vec2> {
    let mut out = sys::BmVec2::default();
    let ok = unsafe { sys::bm_project_point(camera.to_raw(), view.to_raw(), p.to_raw(), &mut out) };
    ok.then_some(Vec2::from_raw(out))
}
