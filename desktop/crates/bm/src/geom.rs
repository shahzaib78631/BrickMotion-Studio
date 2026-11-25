//! Geometry types, LDraw units and camera-relative arrow axes.
use bm_sys as sys;

/// LDraw units (LDU). −y is up.
pub const STUD: f64 = 20.0;
pub const PLATE: f64 = 8.0;
pub const BRICK: f64 = 24.0;

#[derive(Clone, Copy, Default, PartialEq, Debug)]
pub struct Vec2 {
    pub x: f64,
    pub y: f64,
}

impl Vec2 {
    pub const fn new(x: f64, y: f64) -> Self {
        Self { x, y }
    }

    pub(crate) fn to_raw(self) -> sys::BmVec2 {
        sys::BmVec2 { x: self.x, y: self.y }
    }

    pub(crate) fn from_raw(v: sys::BmVec2) -> Self {
        Self { x: v.x, y: v.y }
    }
}

#[derive(Clone, Copy, Default, PartialEq, Debug)]
pub struct Vec3 {
    pub x: f64,
    pub y: f64,
    pub z: f64,
}

impl Vec3 {
    pub const ZERO: Self = Self { x: 0.0, y: 0.0, z: 0.0 };

    pub const fn new(x: f64, y: f64, z: f64) -> Self {
        Self { x, y, z }
    }

    pub fn scale(self, s: f64) -> Self {
        Self { x: self.x * s, y: self.y * s, z: self.z * s }
    }

    pub fn is_zero(self) -> bool {
        self.x == 0.0 && self.y == 0.0 && self.z == 0.0
    }

    pub(crate) fn to_raw(self) -> sys::BmVec3 {
        sys::BmVec3 { x: self.x, y: self.y, z: self.z }
    }

    pub(crate) fn from_raw(v: sys::BmVec3) -> Self {
        Self { x: v.x, y: v.y, z: v.z }
    }
}

impl std::ops::Sub for Vec3 {
    type Output = Self;
    fn sub(self, other: Self) -> Self {
        Self { x: self.x - other.x, y: self.y - other.y, z: self.z - other.z }
    }
}

/// Row-major 3x3 rotation/basis matrix.
#[derive(Clone, Copy, PartialEq, Debug)]
pub struct Mat3 {
    pub m: [f64; 9],
}

impl Mat3 {
    pub const IDENTITY: Self = Self { m: [1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0] };

    pub(crate) fn to_raw(self) -> sys::BmMat3 {
        sys::BmMat3 { m: self.m }
    }

    pub(crate) fn from_raw(m: sys::BmMat3) -> Self {
        Self { m: m.m }
    }
}

impl Default for Mat3 {
    fn default() -> Self {
        Self::IDENTITY
    }
}

#[derive(Clone, Copy, Default, PartialEq, Debug)]
pub struct Pose {
    pub rotation: Mat3,
    pub position: Vec3,
}

#[derive(Clone, Copy, PartialEq, Debug)]
pub struct Camera {
    pub yaw: f64,
    pub pitch: f64,
    pub distance: f64,
    pub target: Vec3,
    pub orthographic: bool,
    pub vertical_fov: f64,
}

impl Default for Camera {
    fn default() -> Self {
        Self {
            yaw: 0.0,
            pitch: 0.0,
            distance: 0.0,
            target: Vec3::ZERO,
            orthographic: false,
            vertical_fov: 0.6,
        }
    }
}

impl Camera {
    pub(crate) fn to_raw(self) -> sys::BmCamera {
        sys::BmCamera {
            yaw: self.yaw,
            pitch: self.pitch,
            distance: self.distance,
            target: self.target.to_raw(),
            orthographic: self.orthographic,
            vertical_fov: self.vertical_fov,
        }
    }

    pub(crate) fn from_raw(c: sys::BmCamera) -> Self {
        Self {
            yaw: c.yaw,
            pitch: c.pitch,
            distance: c.distance,
            target: Vec3::from_raw(c.target),
            orthographic: c.orthographic,
            vertical_fov: c.vertical_fov,
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Arrow {
    Left,
    Right,
    Up,
    Down,
}

/// The world floor axis an arrow key moves along for this camera.
pub fn arrow_axis(camera: &Camera, arrow: Arrow) -> Vec3 {
    let raw = match arrow {
        Arrow::Left => sys::BM_ARROW_LEFT,
        Arrow::Right => sys::BM_ARROW_RIGHT,
        Arrow::Up => sys::BM_ARROW_UP,
        Arrow::Down => sys::BM_ARROW_DOWN,
    };
    Vec3::from_raw(unsafe { sys::bm_arrow_axis(camera.to_raw(), raw) })
}
