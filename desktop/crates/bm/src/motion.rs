//! Build motion fields, flight bake, motion check, joints and insertion direction.
//!
//! [`FlightBake`], [`MotionAudit`] and [`Inspection`] are captured on the UI thread and may move to
//! one worker thread for their slow call; they are `Send`, never `Sync`.

use bm_sys as sys;

use crate::session::take_change;
use crate::{Changed, Mat3, Pose, Session, Vec3, Viewport, borrowed, take_string};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum MotionScope {
    Project,
    Step,
    Parts,
}

/// Flight timing; negative fields are inherited. `ease`: smooth, gentle, soft, linear.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct MotionFields {
    pub time: f64,
    pub landing: f64,
    pub hover: f64,
    pub ease: i32,
}

impl Default for MotionFields {
    fn default() -> Self {
        MotionFields { time: -1.0, landing: -1.0, hover: -1.0, ease: -1 }
    }
}

impl MotionFields {
    fn to_raw(self) -> sys::BmMotionFields {
        sys::BmMotionFields { time: self.time, landing: self.landing, hover: self.hover, ease: self.ease }
    }

    fn from_raw(f: sys::BmMotionFields) -> MotionFields {
        MotionFields { time: f.time, landing: f.landing, hover: f.hover, ease: f.ease }
    }

    /// The Swift app's easing names.
    pub fn ease_name(ease: i32) -> &'static str {
        match ease {
            1 => "Gentle",
            2 => "Soft",
            3 => "Linear",
            _ => "Smooth",
        }
    }
}

/// Shares of a flight: travel, hover, landing.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct FlightPhases {
    pub travel: f64,
    pub hover: f64,
    pub landing: f64,
}

fn pieces_ptr(pieces: &[u32]) -> *const u32 {
    if pieces.is_empty() { std::ptr::null() } else { pieces.as_ptr() }
}

impl Session {
    pub fn motion_fields(&self, scope: MotionScope, step: usize, pieces: &[u32]) -> MotionFields {
        MotionFields::from_raw(unsafe { sys::bm_session_motion_fields(self.raw, scope as i32, step, pieces_ptr(pieces), pieces.len()) })
    }

    pub fn set_motion_fields(&self, scope: MotionScope, step: usize, pieces: &[u32], fields: MotionFields) -> Changed {
        take_change(unsafe {
            sys::bm_session_set_motion_fields(self.raw, scope as i32, step, pieces_ptr(pieces), pieces.len(), fields.to_raw())
        })
    }

    pub fn apply_flight_bake(&self, bake: &mut FlightBake) -> Changed {
        take_change(unsafe { sys::bm_session_apply_flight_bake(self.raw, bake.raw) })
    }

    /// Commits moved pieces at `anchor`'s pose; refused unless generation and version still match.
    pub fn place_moved(&self, pieces: &[u32], anchor: u32, pose: Pose, generation: u64, version: u64) -> Changed {
        take_change(unsafe {
            sys::bm_session_place_moved(
                self.raw,
                pieces_ptr(pieces),
                pieces.len(),
                anchor,
                pose.rotation.to_raw(),
                pose.position.to_raw(),
                generation,
                version,
            )
        })
    }

    /// The way a piece arrives; zero when the planner chooses.
    pub fn insertion_direction(&self, piece: u32) -> Vec3 {
        Vec3::from_raw(unsafe { sys::bm_session_insertion_direction(self.raw, piece) })
    }

    pub fn set_insertion_direction(&self, pieces: &[u32], direction: Vec3) -> Changed {
        take_change(unsafe { sys::bm_session_set_insertion_direction(self.raw, pieces_ptr(pieces), pieces.len(), direction.to_raw()) })
    }

    /// Sets loose pieces at their seated poses as one undo step; refuses a stale revision.
    pub fn seat_pieces(&self, moves: &[(u32, Pose)], generation: u64, version: u64) -> Changed {
        let raw: Vec<sys::BmPieceMove> = moves
            .iter()
            .map(|&(piece, pose)| sys::BmPieceMove {
                piece,
                rotation: pose.rotation.to_raw(),
                position: pose.position.to_raw(),
            })
            .collect();
        let ptr = if raw.is_empty() { std::ptr::null() } else { raw.as_ptr() };
        take_change(unsafe { sys::bm_session_seat_pieces(self.raw, ptr, raw.len(), generation, version) })
    }
}

/// `fields` with every unset field taken from the enclosing scope, then the defaults.
pub fn effective_motion(session: &Session, scope: MotionScope, step: usize, fields: MotionFields) -> MotionFields {
    MotionFields::from_raw(unsafe { sys::bm_effective_motion(session.raw, scope as i32, step, fields.to_raw()) })
}

pub fn flight_phases(effective: MotionFields) -> FlightPhases {
    let (mut travel, mut hover, mut landing) = (0.0, 0.0, 0.0);
    unsafe { sys::bm_flight_phases(effective.to_raw(), &mut travel, &mut hover, &mut landing) };
    FlightPhases { travel, hover, landing }
}

/// Planned flights captured for baking into keys.
pub struct FlightBake {
    raw: *mut sys::BmFlightBake,
}

// Captured on the UI thread, prepared on one worker, applied back on the UI thread: never shared.
unsafe impl Send for FlightBake {}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BakeResult {
    pub flights: i32,
    pub keys: i32,
    pub error: Option<String>,
}

impl FlightBake {
    /// Baking replaces keys the pieces already have (ask first).
    pub fn replaces_keys(&self) -> bool {
        unsafe { sys::bm_flight_bake_replaces_keys(self.raw) }
    }

    /// Slow: run it on a worker thread.
    pub fn prepare(&mut self) -> BakeResult {
        let r = unsafe { sys::bm_flight_bake_prepare(self.raw) };
        let error = take_string(r.error);
        BakeResult { flights: r.flights, keys: r.keys, error: (!error.is_empty()).then_some(error) }
    }
}

impl Drop for FlightBake {
    fn drop(&mut self) {
        unsafe { sys::bm_flight_bake_free(self.raw) }
    }
}

/// A piece's keyed motion captured for a collision check.
pub struct MotionAudit {
    raw: *mut sys::BmMotionAudit,
}

unsafe impl Send for MotionAudit {}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MotionContact {
    pub a: u32,
    pub b: u32,
    pub first_frame: i32,
    pub last_frame: i32,
    pub part: String,
    pub blocker: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MotionReport {
    pub tested_frames: i32,
    pub stride: i32,
    pub intervals: i32,
    pub contacts: Vec<MotionContact>,
    pub error: Option<String>,
}

impl MotionAudit {
    /// Slow: run it on a worker thread.
    pub fn check(&mut self) -> MotionReport {
        let h = unsafe { sys::bm_motion_audit_check(self.raw) };
        if h.is_null() {
            return MotionReport { tested_frames: 0, stride: 1, intervals: 0, contacts: Vec::new(), error: Some("The check failed.".into()) };
        }
        let (mut tested_frames, mut stride, mut intervals) = (0, 1, 0);
        unsafe { sys::bm_motion_report_counts(h, &mut tested_frames, &mut stride, &mut intervals) };
        let error = borrowed(unsafe { sys::bm_motion_report_error(h) });
        let n = unsafe { sys::bm_motion_report_contacts_len(h) };
        let contacts = (0..n)
            .map(|i| {
                let c = unsafe { sys::bm_motion_report_contact_at(h, i) };
                MotionContact {
                    a: c.a,
                    b: c.b,
                    first_frame: c.first_frame,
                    last_frame: c.last_frame,
                    part: borrowed(c.part),
                    blocker: borrowed(c.blocker),
                }
            })
            .collect();
        unsafe { sys::bm_motion_report_free(h) };
        MotionReport { tested_frames, stride, intervals, contacts, error: (!error.is_empty()).then_some(error) }
    }
}

impl Drop for MotionAudit {
    fn drop(&mut self) {
        unsafe { sys::bm_motion_audit_free(self.raw) }
    }
}

impl Viewport {
    /// None when nothing is planned to bake.
    pub fn capture_flight_bake(&mut self, pieces: &[u32], detach: bool) -> Option<FlightBake> {
        let raw = unsafe { sys::bm_viewport_capture_flight_bake(self.raw, pieces_ptr(pieces), pieces.len(), detach) };
        (!raw.is_null()).then_some(FlightBake { raw })
    }

    /// None when the piece has nothing to check.
    pub fn audit_motion(&mut self, piece: u32) -> Option<MotionAudit> {
        let raw = unsafe { sys::bm_viewport_audit_motion(self.raw, piece) };
        (!raw.is_null()).then_some(MotionAudit { raw })
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub enum JointType {
    #[default]
    Fixed,
    Hinge,
    Slider,
    Cylindrical,
    Ball,
    Flexible,
}

impl JointType {
    fn from_raw(v: i32) -> JointType {
        match v {
            1 => JointType::Hinge,
            2 => JointType::Slider,
            3 => JointType::Cylindrical,
            4 => JointType::Ball,
            5 => JointType::Flexible,
            _ => JointType::Fixed,
        }
    }

    /// The Swift app's names.
    pub fn title(self) -> &'static str {
        match self {
            JointType::Fixed => "Fixed",
            JointType::Hinge => "Hinge",
            JointType::Slider => "Slider",
            JointType::Cylindrical => "Turn and Slide",
            JointType::Ball => "Ball Joint",
            JointType::Flexible => "Flexible",
        }
    }

    /// Hinge, turn-and-slide and ball joints turn.
    pub fn turns(self) -> bool {
        matches!(self, JointType::Hinge | JointType::Cylindrical | JointType::Ball)
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct JointRow {
    pub a: u32,
    pub b: u32,
    pub kind: JointType,
    pub point: Vec3,
    pub axis: Vec3,
    pub release: Vec3,
    pub angle: f64,
    pub clearance: f64,
    pub mate_count: usize,
}

#[derive(Clone, Debug, PartialEq)]
pub struct JointReport {
    pub joints: Vec<JointRow>,
    pub error: Option<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct JointEdit {
    pub pieces: Vec<u32>,
    pub pivot: u32,
    pub pose: Pose,
    pub error: Option<String>,
}

/// Kinematic branch and collision-free travel limits for one joint.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct JointInfo {
    pub pieces: Vec<u32>,
    pub kind: JointType,
    pub pivot: Vec3,
    pub axis: Vec3,
    pub can_turn: bool,
    pub can_slide: bool,
    pub full_turn: bool,
    pub min_deg: f64,
    pub max_deg: f64,
    pub min_slide: f64,
    pub max_slide: f64,
    pub min_blocker: String,
    pub max_blocker: String,
    pub error: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum CheckKind {
    Overlap,
    Unsupported,
    Tipping,
    SingleConnector,
    MissingDefinition,
    UnknownColour,
    SubmodelLoop,
}

impl CheckKind {
    pub const ALL: [CheckKind; 7] = [
        CheckKind::Overlap,
        CheckKind::Unsupported,
        CheckKind::Tipping,
        CheckKind::SingleConnector,
        CheckKind::MissingDefinition,
        CheckKind::UnknownColour,
        CheckKind::SubmodelLoop,
    ];

    fn from_raw(v: i32) -> CheckKind {
        match v {
            0 => CheckKind::Overlap,
            1 => CheckKind::Unsupported,
            2 => CheckKind::Tipping,
            3 => CheckKind::SingleConnector,
            4 => CheckKind::MissingDefinition,
            5 => CheckKind::UnknownColour,
            _ => CheckKind::SubmodelLoop,
        }
    }

    /// Swift's Model Checks section titles.
    pub fn title(self) -> &'static str {
        match self {
            CheckKind::Overlap => "Overlaps",
            CheckKind::Unsupported => "Unsupported Parts",
            CheckKind::Tipping => "Unstable Groups",
            CheckKind::SingleConnector => "Single-Connector Attachments",
            CheckKind::MissingDefinition => "Missing Definitions",
            CheckKind::UnknownColour => "Unknown Colours",
            CheckKind::SubmodelLoop => "Submodel Loops",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ModelCheck {
    pub kind: CheckKind,
    pub title: String,
    pub detail: String,
    pub pieces: Vec<u32>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ModelChecks {
    pub findings: Vec<ModelCheck>,
    pub error: Option<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct LoosePiece {
    pub piece: u32,
    pub onto: u32,
    pub pose: Pose,
    pub offset: f64,
    pub angle: f64,
    pub safe: bool,
    pub note: String,
}

/// Loose-piece check result; keeps the engine handle so choice rules and detail formatting call `bmapp`.
pub struct LoosePieces {
    pub rows: Vec<LoosePiece>,
    pub error: Option<String>,
    raw: *mut sys::BmLoosePieces,
}

unsafe impl Send for LoosePieces {}

impl LoosePieces {
    pub fn initial_choice(&self) -> Vec<u32> {
        if self.raw.is_null() {
            return Vec::new();
        }
        let n = unsafe { sys::bm_loose_initial_choice(self.raw, std::ptr::null_mut(), 0) };
        let mut out = vec![0u32; n];
        let got = unsafe { sys::bm_loose_initial_choice(self.raw, out.as_mut_ptr(), out.len()) };
        out.truncate(got.min(n));
        out
    }

    pub fn waiting_on(&self, piece: u32, chosen: &[u32]) -> Option<u32> {
        if self.raw.is_null() {
            return None;
        }
        let w = unsafe { sys::bm_loose_waiting_on(self.raw, piece, pieces_ptr(chosen), chosen.len()) };
        (w != sys::BM_NO_PIECE).then_some(w)
    }

    pub fn uncheck(&self, piece: u32, chosen: &[u32]) -> Vec<u32> {
        if self.raw.is_null() {
            return Vec::new();
        }
        let n = unsafe { sys::bm_loose_uncheck(self.raw, piece, pieces_ptr(chosen), chosen.len(), std::ptr::null_mut(), 0) };
        let mut out = vec![0u32; n];
        let got = unsafe { sys::bm_loose_uncheck(self.raw, piece, pieces_ptr(chosen), chosen.len(), out.as_mut_ptr(), out.len()) };
        out.truncate(got.min(n));
        out
    }

    pub fn detail(&self, index: usize, onto_name: &str) -> String {
        if self.raw.is_null() {
            return String::new();
        }
        let Ok(c) = std::ffi::CString::new(onto_name) else { return String::new() };
        take_string(unsafe { sys::bm_loose_detail(self.raw, index, c.as_ptr()) })
    }
}

impl Drop for LoosePieces {
    fn drop(&mut self) {
        if !self.raw.is_null() {
            unsafe { sys::bm_loose_pieces_free(self.raw) };
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct HabitFit {
    pub name: String,
    pub description: String,
    pub color: i32,
    pub pose: Pose,
    pub models: u32,
    pub total: u32,
    pub links: u32,
    pub joint: String,
    pub why: String,
}

#[derive(Clone, Debug, PartialEq)]
pub struct FittingPart {
    pub name: String,
    pub contact: Vec3,
}

/// A snapshot of the model for joint work.
pub struct Inspection {
    raw: *mut sys::BmInspection,
}

unsafe impl Send for Inspection {}

impl Inspection {
    pub fn capture(session: &Session) -> Option<Inspection> {
        let raw = unsafe { sys::bm_inspection_capture(session.raw) };
        (!raw.is_null()).then_some(Inspection { raw })
    }

    pub fn joints(&mut self, selection: &[u32], show_all: bool, check_geometry: bool) -> JointReport {
        let h = unsafe { sys::bm_inspection_joints(self.raw, pieces_ptr(selection), selection.len(), show_all, check_geometry) };
        if h.is_null() {
            return JointReport { joints: Vec::new(), error: Some("The joints could not be read.".into()) };
        }
        let n = unsafe { sys::bm_joints_len(h) };
        let joints = (0..n)
            .map(|i| {
                let r = unsafe { sys::bm_joints_at(h, i) };
                JointRow {
                    a: r.a,
                    b: r.b,
                    kind: JointType::from_raw(r.kind),
                    point: Vec3::from_raw(r.point),
                    axis: Vec3::from_raw(r.axis),
                    release: Vec3::from_raw(r.release),
                    angle: r.angle,
                    clearance: r.clearance,
                    mate_count: r.mate_count,
                }
            })
            .collect();
        let error = borrowed(unsafe { sys::bm_joints_error(h) });
        unsafe { sys::bm_joints_free(h) };
        JointReport { joints, error: (!error.is_empty()).then_some(error) }
    }

    /// The pieces rigidly joined to `piece`.
    pub fn body(&mut self, piece: u32) -> Vec<u32> {
        let n = unsafe { sys::bm_inspection_body(self.raw, piece, std::ptr::null_mut(), 0) };
        let mut out = vec![0u32; n];
        let got = unsafe { sys::bm_inspection_body(self.raw, piece, out.as_mut_ptr(), out.len()) };
        out.truncate(got.min(n));
        out
    }

    /// Turns `moving` about its joint with `fixed` by `degrees` (0 detaches). Slow: a worker's job.
    pub fn change_joint(&mut self, fixed: u32, moving: u32, degrees: f64, collision: bool) -> JointEdit {
        let h = unsafe { sys::bm_inspection_change_joint(self.raw, fixed, moving, degrees, collision) };
        if h.is_null() {
            return JointEdit { pieces: Vec::new(), pivot: u32::MAX, pose: Pose::default(), error: Some("The joint could not change.".into()) };
        }
        let n = unsafe { sys::bm_joint_edit_pieces(h, std::ptr::null_mut(), 0) };
        let mut pieces = vec![0u32; n];
        let got = unsafe { sys::bm_joint_edit_pieces(h, pieces.as_mut_ptr(), pieces.len()) };
        pieces.truncate(got.min(n));
        let mut rotation = sys::BmMat3 { m: [0.0; 9] };
        let mut position = sys::BmVec3::default();
        unsafe { sys::bm_joint_edit_pose(h, &mut rotation, &mut position) };
        let error = borrowed(unsafe { sys::bm_joint_edit_error(h) });
        let pivot = unsafe { sys::bm_joint_edit_pivot(h) };
        unsafe { sys::bm_joint_edit_free(h) };
        JointEdit {
            pieces,
            pivot,
            pose: Pose { rotation: Mat3::from_raw(rotation), position: Vec3::from_raw(position) },
            error: (!error.is_empty()).then_some(error),
        }
    }

    /// Computes the articulated moving branch, resolved axis/pivot, and collision-free angular & slide travel.
    pub fn joint_info(&mut self, fixed: u32, moving: u32, collision: bool) -> JointInfo {
        let h = unsafe { sys::bm_inspection_joint_info(self.raw, fixed, moving, collision) };
        if h.is_null() {
            return JointInfo { error: Some("Couldn't inspect joint.".into()), ..Default::default() };
        }
        let d = unsafe { sys::bm_joint_info_data(h) };
        let n = unsafe { sys::bm_joint_info_pieces(h, std::ptr::null_mut(), 0) };
        let mut pieces = vec![0u32; n];
        let got = unsafe { sys::bm_joint_info_pieces(h, pieces.as_mut_ptr(), pieces.len()) };
        pieces.truncate(got.min(n));
        let min_blocker = borrowed(unsafe { sys::bm_joint_info_min_blocker(h) });
        let max_blocker = borrowed(unsafe { sys::bm_joint_info_max_blocker(h) });
        let error = borrowed(unsafe { sys::bm_joint_info_error(h) });
        unsafe { sys::bm_joint_info_free(h) };
        JointInfo {
            pieces,
            kind: JointType::from_raw(d.kind),
            pivot: Vec3::from_raw(d.pivot),
            axis: Vec3::from_raw(d.axis),
            can_turn: d.can_turn,
            can_slide: d.can_slide,
            full_turn: d.full_turn,
            min_deg: d.min_deg,
            max_deg: d.max_deg,
            min_slide: d.min_slide,
            max_slide: d.max_slide,
            min_blocker,
            max_blocker,
            error: (!error.is_empty()).then_some(error),
        }
    }

    /// Turns (`degrees`, up to ±360°) and/or slides (`slide_ldu`) the moving branch; `axis_override`
    /// selects the axis for ball joints. Both zero detaches along release.
    pub fn change_joint_ex(
        &mut self,
        fixed: u32,
        moving: u32,
        degrees: f64,
        slide_ldu: f64,
        axis_override: Vec3,
        collision: bool,
    ) -> JointEdit {
        let h = unsafe {
            sys::bm_inspection_change_joint_ex(
                self.raw,
                fixed,
                moving,
                degrees,
                slide_ldu,
                axis_override.to_raw(),
                collision,
            )
        };
        if h.is_null() {
            return JointEdit {
                pieces: Vec::new(),
                pivot: sys::BM_NO_PIECE,
                pose: Pose::default(),
                error: Some("Couldn't move joint.".into()),
            };
        }
        let error = borrowed(unsafe { sys::bm_joint_edit_error(h) });
        let n = unsafe { sys::bm_joint_edit_pieces(h, std::ptr::null_mut(), 0) };
        let mut pieces = vec![0u32; n];
        let got = unsafe { sys::bm_joint_edit_pieces(h, pieces.as_mut_ptr(), pieces.len()) };
        pieces.truncate(got.min(n));
        let mut rotation = sys::BmMat3 { m: [0.0; 9] };
        let mut position = sys::BmVec3 { x: 0.0, y: 0.0, z: 0.0 };
        unsafe { sys::bm_joint_edit_pose(h, &mut rotation, &mut position) };
        let pivot = unsafe { sys::bm_joint_edit_pivot(h) };
        unsafe { sys::bm_joint_edit_free(h) };
        JointEdit {
            pieces,
            pivot,
            pose: Pose { rotation: Mat3::from_raw(rotation), position: Vec3::from_raw(position) },
            error: (!error.is_empty()).then_some(error),
        }
    }

    pub fn check_model(&mut self) -> ModelChecks {
        let h = unsafe { sys::bm_inspection_check_model(self.raw) };
        if h.is_null() {
            return ModelChecks { findings: Vec::new(), error: Some("The model check failed.".into()) };
        }
        let n = unsafe { sys::bm_model_checks_len(h) };
        let findings = (0..n)
            .map(|i| {
                let kind = CheckKind::from_raw(unsafe { sys::bm_model_checks_kind(h, i) });
                let title = borrowed(unsafe { sys::bm_model_checks_title(h, i) });
                let detail = borrowed(unsafe { sys::bm_model_checks_detail(h, i) });
                let pn = unsafe { sys::bm_model_checks_pieces(h, i, std::ptr::null_mut(), 0) };
                let mut pieces = vec![0u32; pn];
                let got = unsafe { sys::bm_model_checks_pieces(h, i, pieces.as_mut_ptr(), pieces.len()) };
                pieces.truncate(got.min(pn));
                ModelCheck { kind, title, detail, pieces }
            })
            .collect();
        let error = borrowed(unsafe { sys::bm_model_checks_error(h) });
        unsafe { sys::bm_model_checks_free(h) };
        ModelChecks { findings, error: (!error.is_empty()).then_some(error) }
    }

    pub fn loose_pieces(&mut self) -> LoosePieces {
        let h = unsafe { sys::bm_inspection_loose_pieces(self.raw) };
        if h.is_null() {
            return LoosePieces { rows: Vec::new(), error: Some("Couldn't check for loose pieces.".into()), raw: std::ptr::null_mut() };
        }
        let n = unsafe { sys::bm_loose_pieces_len(h) };
        let rows = (0..n)
            .map(|i| {
                let r = unsafe { sys::bm_loose_pieces_at(h, i) };
                LoosePiece {
                    piece: r.piece,
                    onto: r.onto,
                    pose: Pose { rotation: Mat3::from_raw(r.rotation), position: Vec3::from_raw(r.position) },
                    offset: r.offset,
                    angle: r.angle,
                    safe: r.safe,
                    note: borrowed(unsafe { sys::bm_loose_pieces_note(h, i) }),
                }
            })
            .collect();
        let error = borrowed(unsafe { sys::bm_loose_pieces_error(h) });
        LoosePieces { rows, error: (!error.is_empty()).then_some(error), raw: h }
    }

    pub fn habit_fits(&mut self, piece: u32, limit: usize) -> Vec<HabitFit> {
        let h = unsafe { sys::bm_inspection_habit_fits(self.raw, piece, limit) };
        if h.is_null() {
            return Vec::new();
        }
        let n = unsafe { sys::bm_habit_fits_len(h) };
        let out = (0..n)
            .map(|i| {
                let r = unsafe { sys::bm_habit_fits_at(h, i) };
                HabitFit {
                    name: borrowed(unsafe { sys::bm_habit_fits_name(h, i) }),
                    description: borrowed(unsafe { sys::bm_habit_fits_description(h, i) }),
                    color: r.color,
                    pose: Pose { rotation: Mat3::from_raw(r.rotation), position: Vec3::from_raw(r.position) },
                    models: r.models,
                    total: r.total,
                    links: r.links,
                    joint: borrowed(unsafe { sys::bm_habit_fits_joint(h, i) }),
                    why: borrowed(unsafe { sys::bm_habit_fits_why(h, i) }),
                }
            })
            .collect();
        unsafe { sys::bm_habit_fits_free(h) };
        out
    }

    pub fn fitting_parts(&mut self, piece: u32, candidates: &[String], limit: usize) -> Vec<FittingPart> {
        let cstrings: Vec<std::ffi::CString> = candidates.iter().filter_map(|s| std::ffi::CString::new(s.as_str()).ok()).collect();
        let ptrs: Vec<*const std::ffi::c_char> = cstrings.iter().map(|s| s.as_ptr()).collect();
        let ptr = if ptrs.is_empty() { std::ptr::null() } else { ptrs.as_ptr() };
        let h = unsafe { sys::bm_inspection_fitting_parts(self.raw, piece, ptr, ptrs.len(), limit) };
        if h.is_null() {
            return Vec::new();
        }
        let n = unsafe { sys::bm_fitting_parts_len(h) };
        let out = (0..n)
            .map(|i| FittingPart {
                name: borrowed(unsafe { sys::bm_fitting_parts_name(h, i) }),
                contact: Vec3::from_raw(unsafe { sys::bm_fitting_parts_contact(h, i) }),
            })
            .collect();
        unsafe { sys::bm_fitting_parts_free(h) };
        out
    }
}

impl Drop for Inspection {
    fn drop(&mut self) {
        unsafe { sys::bm_inspection_free(self.raw) }
    }
}
