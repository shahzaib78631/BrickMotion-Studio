//! Safe types for live snapping part placement previews and commit.
use bm_sys as sys;

use crate::{Mat3, Pose, Vec2, Vec3, take_string};

#[derive(Clone, Copy, Default, PartialEq, Eq, Debug)]
pub enum PlacementState {
    #[default]
    Inactive,
    Preparing,
    Free,
    Snapped,
    Reference,
    Blocked,
    Unavailable,
}

impl PlacementState {
    pub(crate) fn from_raw(s: sys::BmPlacementState) -> Self {
        match s {
            sys::BM_PLACE_PREPARING => PlacementState::Preparing,
            sys::BM_PLACE_FREE => PlacementState::Free,
            sys::BM_PLACE_SNAPPED => PlacementState::Snapped,
            sys::BM_PLACE_REFERENCE => PlacementState::Reference,
            sys::BM_PLACE_BLOCKED => PlacementState::Blocked,
            sys::BM_PLACE_UNAVAILABLE => PlacementState::Unavailable,
            _ => PlacementState::Inactive,
        }
    }

    pub fn is_placeable(self) -> bool {
        matches!(self, PlacementState::Free | PlacementState::Snapped | PlacementState::Reference)
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct PlacementInput {
    pub part: String,
    pub color: i32,
    pub grip: i32,
    pub turns: i32,
    pub mirrored: bool,
    pub snap: bool,
    pub reference: bool,
    pub collision: bool,
    pub anchor: Option<u32>,
    pub grab: Vec2,
    pub selection: Vec<u32>,
}

impl Default for PlacementInput {
    fn default() -> Self {
        Self {
            part: String::new(),
            color: 71,
            grip: -1,
            turns: 0,
            mirrored: false,
            snap: true,
            reference: false,
            collision: true,
            anchor: None,
            grab: Vec2::default(),
            selection: Vec::new(),
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct PlacementPreview {
    pub state: PlacementState,
    pub pose: Pose,
    pub contact: Vec3,
    pub grip: u32,
    pub grip_count: u32,
    pub generation: u64,
    pub version: u64,
    pub request: u64,
    pub reason: String,
}

impl PlacementPreview {
    pub(crate) fn from_raw(p: sys::BmPlacementPreview) -> Self {
        let reason = take_string(p.reason);
        Self {
            state: PlacementState::from_raw(p.state),
            pose: Pose { rotation: Mat3::from_raw(p.rotation), position: Vec3::from_raw(p.position) },
            contact: Vec3::from_raw(p.contact),
            grip: p.grip,
            grip_count: p.grip_count,
            generation: p.generation,
            version: p.version,
            request: p.request,
            reason,
        }
    }
}
