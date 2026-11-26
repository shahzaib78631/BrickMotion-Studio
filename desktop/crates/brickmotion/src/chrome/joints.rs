//! Sophisticated joint-based rotation & articulation system (`AssemblyReview`, `JointCard`,
//! `EditorOverlays`, plus Smart Joints 3D direct-drag rings, collision-swept travel limits,
//! ball-joint multi-axis gimbal, linear slide handles, branch switching & side-flip).
use std::collections::{HashMap, HashSet};

use bm::motion::{Inspection, JointEdit, JointInfo, JointReport, JointRow, JointType};
use egui::{Align2, Color32, CornerRadius, CursorIcon, FontId, Pos2, Rect, Sense, Shape, Stroke, StrokeKind, Ui, WidgetInfo, pos2, vec2};

use super::float_panel::{self, Head, PanelKind, group_heading};
use super::widgets::{hairline, inset_group, secondary_button, segmented, switch_row};
use crate::BrickMotionApp;
use crate::icons::Icon;
use crate::theme::Theme;
use crate::workers::{Job, Stale};

const MARKER_HIT: f32 = 11.0;
const RING_HIT: f32 = 11.0;
const SLIDE_HIT: f32 = 11.0;
const RING_SCREEN_PX: f32 = 58.0;

/// What a joint report was made for: the document (Swift's `Revision`), the selection and the
/// inspection's flags. `hidden` is the hidden-piece count (bm reports no hidden list).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct JointKey {
    pub generation: u64,
    pub version: u64,
    pub structure: u64,
    pub hidden: usize,
    pub selection: Vec<u32>,
    pub all: bool,
    pub geometry: bool,
}

type DocKey = (u64, u64);
type InfoKey = (u64, u64, u32, u32, bool);

/// Axis choice for ball (spherical) joints.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum BallAxis {
    #[default]
    Y,
    X,
    Z,
    View,
}

impl BallAxis {
    fn label(self) -> &'static str {
        match self {
            BallAxis::X => "X",
            BallAxis::Y => "Y",
            BallAxis::Z => "Z",
            BallAxis::View => "View",
        }
    }

    fn vector(self, cam: &bm::Camera) -> bm::Vec3 {
        match self {
            BallAxis::X => bm::Vec3::new(1.0, 0.0, 0.0),
            BallAxis::Y => bm::Vec3::new(0.0, 1.0, 0.0),
            BallAxis::Z => bm::Vec3::new(0.0, 0.0, 1.0),
            BallAxis::View => unit(camera_direction(cam)),
        }
    }
}

/// Active interactive 3D ring rotation or linear slide drag on the open joint.
#[derive(Clone, Debug)]
struct LiveJointDrag {
    mode: DragKind,
    pivot: bm::Vec3,
    axis: bm::Vec3,
    branch: Vec<u32>,
    start_pos: Pos2,
    start_angle_rad: f64,
    applied: f64,
    min_limit: f64,
    max_limit: f64,
    min_blocker: String,
    max_blocker: String,
    hit_limit: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum DragKind {
    Turn,
    Slide,
}

#[derive(Default)]
pub struct JointsView {
    /// View › Joint Markers.
    pub show: bool,
    /// The Joint panel's "Check geometry".
    pub check_geometry: bool,
    pub report: Option<Vec<JointRow>>,
    pub for_key: Option<JointKey>,
    /// The open joint: (fixed, moving).
    pub open: Option<(u32, u32)>,
    /// Cached kinematic branch + collision-free limits for the open joint.
    pub info: Option<(InfoKey, JointInfo)>,
    /// Axis choice when rotating a spherical (ball) joint.
    pub ball_axis: BallAxis,
    /// The open joint's last refusal.
    pub error: Option<String>,
    pub changing: bool,
    /// Markers on screen this frame.
    pub markers: Vec<((u32, u32), Pos2)>,
    /// Last projected 3D rotation ring points (for direct-drag hit-testing).
    ring_pts: Vec<Pos2>,
    /// Last projected 3D slide arrow endpoints (for direct-drag hit-testing).
    slide_seg: Option<(Pos2, Pos2)>,
    /// Active interactive 3D ring / slide drag.
    live_drag: Option<LiveJointDrag>,
    /// Cached slider drag value while scrubbing the continuous angle/slide slider.
    slider_applied: f64,
    slider_active: bool,
    inspect: Job<JointKey, JointReport>,
    started: Option<JointKey>,
    info_job: Job<InfoKey, JointInfo>,
    info_started: Option<InfoKey>,
    change_job: Job<DocKey, (JointEdit, (u32, u32))>,
    /// The selection whose card was closed: picking it does not open the card again.
    dismissed: Option<Vec<u32>>,
    marker_press: bool,
    /// Cached piece -> display name map for `(generation, version)`.
    names_cache: Option<(DocKey, HashMap<u32, String>)>,
}

impl JointsView {
    pub fn busy(&self) -> bool {
        self.inspect.busy() || self.change_job.busy() || self.info_job.busy()
    }

    pub fn dragging(&self) -> bool {
        self.live_drag.is_some() || self.slider_active
    }

    /// The report is for the document and selection as they stand.
    pub fn current(&self, s: &bm::Session) -> bool {
        self.report.is_some() && self.for_key.as_ref() == Some(&self.key(s, false))
    }

    fn key(&self, s: &bm::Session, smart: bool) -> JointKey {
        let selection = s.selection();
        let geometry = selection.len() == 1 && self.check_geometry;
        JointKey {
            generation: s.generation(),
            version: s.version(),
            structure: s.structure_version(),
            hidden: s.snapshot().hidden,
            all: self.show || self.open.is_some() || selection.len() == 1 || smart,
            selection,
            geometry,
        }
    }

    pub fn reset(&mut self) {
        let show = self.show;
        *self = JointsView { show, ..JointsView::default() };
    }

    pub fn row(&self) -> Option<JointRow> {
        let k = self.open?;
        self.report.as_ref()?.iter().find(|j| same(j, k)).copied()
    }

    /// Current kinematic `JointInfo` for the open joint, when computed for this document & collision flag.
    pub fn open_info(&self, s: &bm::Session, collision: bool) -> Option<&JointInfo> {
        let k = self.open?;
        let key = (s.generation(), s.version(), k.0, k.1, collision);
        self.info.as_ref().filter(|(ik, _)| *ik == key).map(|(_, info)| info)
    }

    /// All moving joints touching the currently open moving piece (or current 1-piece selection).
    fn sibling_joints(&self) -> Vec<JointRow> {
        let Some(rows) = &self.report else { return Vec::new() };
        let focus = self.open.map(|(_, m)| m);
        let Some(piece) = focus else { return Vec::new() };
        rows.iter()
            .filter(|r| r.kind != JointType::Fixed && (r.a == piece || r.b == piece))
            .copied()
            .collect()
    }
}

fn same(j: &JointRow, k: (u32, u32)) -> bool {
    (j.a, j.b) == k || (j.b, j.a) == k
}

fn unit(v: bm::Vec3) -> bm::Vec3 {
    let l = (v.x * v.x + v.y * v.y + v.z * v.z).sqrt();
    if l > 1e-9 {
        bm::Vec3::new(v.x / l, v.y / l, v.z / l)
    } else {
        bm::Vec3::new(0.0, 1.0, 0.0)
    }
}

fn dot(a: bm::Vec3, b: bm::Vec3) -> f64 {
    a.x * b.x + a.y * b.y + a.z * b.z
}

fn active_axis(row: &JointRow, info: Option<&JointInfo>, ball_axis: BallAxis, cam: &bm::Camera) -> bm::Vec3 {
    if row.kind == JointType::Ball {
        return ball_axis.vector(cam);
    }
    let raw = info.map(|i| i.axis).unwrap_or(row.axis);
    unit(raw)
}

fn active_pivot(row: &JointRow, info: Option<&JointInfo>) -> bm::Vec3 {
    info.map(|i| i.pivot).unwrap_or(row.point)
}

/// Opens a joint: (fixed, moving).
pub fn open(app: &mut BrickMotionApp, joint: (u32, u32)) {
    app.joints.open = Some(joint);
    app.joints.error = None;
    app.joints.info_started = None;
    app.joints.live_drag = None;
    app.joints.slider_active = false;
    app.panels.unfold(PanelKind::Joint);
}

/// Swaps fixed and moving sides of the open joint.
pub fn flip_side(app: &mut BrickMotionApp) {
    if let Some((fixed, moving)) = app.joints.open {
        open(app, (moving, fixed));
    }
}

pub fn close(app: &mut BrickMotionApp) {
    if app.joints.live_drag.take().is_some() || app.joints.slider_active {
        app.joints.slider_active = false;
        app.doc.session().end_gesture();
    }
    app.joints.open = None;
    app.joints.error = None;
    app.joints.dismissed = Some(app.doc.session().selection());
}

pub fn is_open(app: &BrickMotionApp) -> bool {
    app.joints.open.is_some() && app.joints.row().is_some()
}

/// True when Smart Joints has an interactive turning ring active that should replace the free Rotate gizmo.
pub fn owns_rotate_gizmo(app: &BrickMotionApp) -> bool {
    app.edit.smart_joints && app.edit.tool == crate::Tool::Rotate && is_open(app)
}

/// Keeps the report & kinematic limits current and takes the workers' results; once a frame.
pub fn sync(app: &mut BrickMotionApp, ctx: &egui::Context) {
    let s = app.doc.session();
    let selection = s.selection();
    let smart = app.edit.smart_joints;
    let collision = app.edit.collision;
    let active_mode = app.joints.show || (smart && !selection.is_empty()) || app.joints.open.is_some() || app.joints.change_job.busy();
    if !active_mode {
        app.joints.inspect.cancel();
        app.joints.started = None;
        app.joints.info_job.cancel();
        app.joints.info_started = None;
        app.joints.report = None;
        app.joints.for_key = None;
        app.joints.info = None;
        app.joints.dismissed = None;
        return;
    }

    // While actively live-dragging a joint ring or slider, defer background re-inspection until release
    // so the 60-fps articulation isn't interrupted by constant worker restarts.
    if app.joints.dragging() {
        return;
    }

    let key = app.joints.key(s, smart);
    match app.joints.inspect.poll(&key) {
        Some(Ok(r)) => {
            let err = r.error;
            app.joints.report = Some(r.joints);
            app.joints.for_key = Some(key.clone());
            app.joints.started = None;
            reconcile(app, &selection);
            if let Some(e) = err {
                if app.joints.open.is_some() {
                    app.joints.error = Some(e);
                } else {
                    crate::notices::push(
                        &mut app.notices,
                        crate::notices::Notice::Warning { title: "Couldn't inspect joints".into(), detail: e },
                    );
                }
            }
        }
        Some(Err(Stale)) => app.joints.started = None,
        None => {}
    }

    if app.joints.for_key.as_ref() != Some(&key)
        && app.joints.started.as_ref() != Some(&key)
        && !app.joints.inspect.busy()
        && let Some(mut inspection) = Inspection::capture(app.doc.session())
    {
        let (sel, all, geometry) = (key.selection.clone(), key.all, key.geometry);
        if app.joints.inspect.start(key.clone(), move || inspection.joints(&sel, all, geometry)) {
            app.joints.started = Some(key.clone());
        }
    }

    // Compute kinematic branch + collision-swept travel limits for the open joint.
    if let Some((fixed, moving)) = app.joints.open {
        let s = app.doc.session();
        let ikey: InfoKey = (s.generation(), s.version(), fixed, moving, collision);
        match app.joints.info_job.poll(&ikey) {
            Some(Ok(info)) => {
                app.joints.info = Some((ikey, info));
                app.joints.info_started = None;
            }
            Some(Err(Stale)) => app.joints.info_started = None,
            None => {}
        }
        let have_info = app.joints.info.as_ref().is_some_and(|(k, _)| *k == ikey);
        if !have_info
            && app.joints.info_started != Some(ikey)
            && !app.joints.info_job.busy()
            && let Some(mut inspection) = Inspection::capture(app.doc.session())
            && app.joints.info_job.start(ikey, move || inspection.joint_info(fixed, moving, collision))
        {
            app.joints.info_started = Some(ikey);
        }
    } else {
        app.joints.info_job.cancel();
        app.joints.info_started = None;
    }

    let doc = (key.generation, key.version);
    match app.joints.change_job.poll(&doc) {
        Some(Ok((edit, k))) => {
            app.joints.changing = false;
            if app.joints.open == Some(k) {
                apply(app, edit, doc);
            }
        }
        Some(Err(Stale)) => app.joints.changing = false,
        None => {}
    }
    if app.joints.busy() {
        ctx.request_repaint_after(std::time::Duration::from_millis(30));
    }
}

/// The open joint follows the new report; a single picked part opens its joint when markers or Smart Joints are on.
fn reconcile(app: &mut BrickMotionApp, selection: &[u32]) {
    let smart = app.edit.smart_joints;
    let j = &mut app.joints;
    let rows = j.report.clone().unwrap_or_default();
    if let Some(k) = j.open
        && !rows.iter().any(|r| same(r, k))
    {
        j.open = None;
        j.error = None;
    }
    if j.dismissed.as_deref().is_some_and(|d| d != selection) {
        j.dismissed = None;
    }
    // Auto-open the picked part's moving joint when Joint Markers OR Smart Joints is enabled.
    if j.open.is_none()
        && (j.show || smart)
        && let [p] = selection
        && j.dismissed.is_none()
        && let Some(r) = rows.iter().find(|r| r.kind != JointType::Fixed && (r.a == *p || r.b == *p))
    {
        // The picked part is the one that moves.
        j.open = Some(if r.b == *p { (r.a, r.b) } else { (r.b, r.a) });
    }
}

fn apply(app: &mut BrickMotionApp, edit: JointEdit, doc: DocKey) {
    if let Some(e) = edit.error {
        app.joints.error = Some(e);
        return;
    }
    let s = app.doc.session();
    let local: HashSet<u32> = (0..s.steps().len())
        .flat_map(|st| s.step_items(st))
        .filter(|i| !i.submodel)
        .flat_map(|i| i.pieces)
        .collect();
    if !edit.pieces.iter().all(|p| local.contains(p)) {
        app.joints.error = Some("Open the submodel that contains this connection.".into());
        return;
    }
    let c = s.place_moved(&edit.pieces, edit.pivot, edit.pose, doc.0, doc.1);
    app.edited(c);
}

/// Turns the open joint by `degrees` (0 detaches), on the worker.
pub fn change(app: &mut BrickMotionApp, degrees: f64) {
    let axis = if app.joints.row().is_some_and(|r| r.kind == JointType::Ball) {
        let cam = app.doc.viewport().map(|vp| vp.camera()).unwrap_or_default();
        app.joints.ball_axis.vector(&cam)
    } else {
        bm::Vec3::ZERO
    };
    change_ex(app, degrees, 0.0, axis);
}

/// Turns and/or slides the open joint on the worker; both zero detaches.
pub fn change_ex(app: &mut BrickMotionApp, degrees: f64, slide_ldu: f64, axis_override: bm::Vec3) {
    let Some(k) = app.joints.open else { return };
    if app.joints.changing || app.joints.change_job.busy() {
        return;
    }
    let s = app.doc.session();
    let doc = (s.generation(), s.version());
    let Some(mut inspection) = Inspection::capture(s) else { return };
    let collision = app.edit.collision;
    app.joints.error = None;
    if app.joints.change_job.start(doc, move || {
        (inspection.change_joint_ex(k.0, k.1, degrees, slide_ldu, axis_override, collision), k)
    }) {
        app.joints.changing = true;
    }
}

/// Selects everything rigidly joined to the open joint's moving part.
pub fn select_body(app: &mut BrickMotionApp) {
    let Some((_, moving)) = app.joints.open else { return };
    let Some(mut inspection) = Inspection::capture(app.doc.session()) else { return };
    let pieces = inspection.body(moving);
    if !pieces.is_empty() {
        app.doc.session().select(&pieces, bm::SelectMode::Replace);
        // The card stays with the joint, not with whichever part the body starts at.
        app.joints.dismissed = Some(app.doc.session().selection());
    }
}

/// Selects the entire articulated moving branch across the open joint.
pub fn select_branch(app: &mut BrickMotionApp) {
    let pieces = app
        .joints
        .open_info(app.doc.session(), app.edit.collision)
        .map(|i| i.pieces.clone())
        .unwrap_or_default();
    if !pieces.is_empty() {
        app.doc.session().select(&pieces, bm::SelectMode::Replace);
        app.joints.dismissed = Some(app.doc.session().selection());
    }
}

/// Where the camera looks from, as a direction pieces arrive along (`ArrivalDirection.camera`).
pub fn camera_direction(cam: &bm::Camera) -> bm::Vec3 {
    let (y, h) = (-cam.pitch.sin(), cam.pitch.cos());
    bm::Vec3::new(-h * cam.yaw.sin(), y, -h * cam.yaw.cos())
}

/// The axis direction closest to `d`.
pub fn nearest_axis(d: bm::Vec3) -> bm::Vec3 {
    let (ax, ay, az) = (d.x.abs(), d.y.abs(), d.z.abs());
    let sign = |v: f64| if v < 0.0 { -1.0 } else { 1.0 };
    if ax >= ay && ax >= az {
        bm::Vec3::new(sign(d.x), 0.0, 0.0)
    } else if ay >= az {
        bm::Vec3::new(0.0, sign(d.y), 0.0)
    } else {
        bm::Vec3::new(0.0, 0.0, sign(d.z))
    }
}

/// The six axes and their names (`ArrivalDirection.axes`).
pub const AXES: [(&str, [f64; 3]); 6] = [
    ("From Above", [0.0, -1.0, 0.0]),
    ("From Below", [0.0, 1.0, 0.0]),
    ("From Front", [0.0, 0.0, -1.0]),
    ("From Back", [0.0, 0.0, 1.0]),
    ("From Left", [-1.0, 0.0, 0.0]),
    ("From Right", [1.0, 0.0, 0.0]),
];

/// "Automatic", an axis name, or "Custom".
pub fn direction_label(d: bm::Vec3) -> &'static str {
    if d.x == 0.0 && d.y == 0.0 && d.z == 0.0 {
        return "Automatic";
    }
    AXES.iter().find(|(_, a)| (d.x * a[0] + d.y * a[1] + d.z * a[2] - 1.0).abs() < 0.001).map_or("Custom", |a| a.0)
}

/// Sets the selected parts' insertion direction (zero is Automatic).
pub fn set_direction(app: &mut BrickMotionApp, d: bm::Vec3) {
    let pieces = app.doc.session().selection();
    if pieces.is_empty() {
        return;
    }
    let c = app.doc.session().set_insertion_direction(&pieces, d);
    app.edited(c);
}

/// Insertion direction from the current view, to its nearest axis.
pub fn direction_from_view(app: &mut BrickMotionApp) {
    let Some(vp) = app.doc.viewport() else { return };
    let d = nearest_axis(camera_direction(&vp.camera()));
    set_direction(app, d);
}

fn dist_to_segment(p: Pos2, a: Pos2, b: Pos2) -> f32 {
    let d = b - a;
    let len2 = d.length_sq();
    let t = if len2 > 1e-6 { ((p - a).dot(d) / len2).clamp(0.0, 1.0) } else { 0.0 };
    p.distance(a + d * t)
}

fn dist_to_ring(p: Pos2, pts: &[Pos2]) -> f32 {
    if pts.len() < 2 {
        return f32::INFINITY;
    }
    pts.windows(2).map(|w| dist_to_segment(p, w[0], w[1])).fold(f32::INFINITY, f32::min)
}

/// Checks whether every piece in `pieces` belongs to the focused model (not inside a child submodel).
fn all_local(s: &bm::Session, pieces: &[u32]) -> bool {
    let local: HashSet<u32> = (0..s.steps().len())
        .flat_map(|st| s.step_items(st))
        .filter(|i| !i.submodel)
        .flat_map(|i| i.pieces)
        .collect();
    !pieces.is_empty() && pieces.iter().all(|p| local.contains(p))
}

/// Handles clicks on joint markers AND direct 3D dragging of the open joint's rotation ring or slide handle.
/// Returns true while the primary pointer belongs to the joint overlay.
pub fn handle_pointer(ui: &Ui, app: &mut BrickMotionApp) -> bool {
    let (pressed, down, pos, mods) = ui.input(|i| {
        (
            i.pointer.primary_pressed(),
            i.pointer.primary_down(),
            i.pointer.latest_pos(),
            i.modifiers,
        )
    });

    // Continue or finish an active 3D joint ring / slide drag.
    if let Some(mut drag) = app.joints.live_drag.take() {
        if down {
            if let (Some(p), Some(rect), Some(vp)) = (pos, app.viewport.last_rect, app.doc.viewport()) {
                let cam = vp.camera();
                let view = bm::Vec2::new(f64::from(rect.width()), f64::from(rect.height()));
                match drag.mode {
                    DragKind::Turn => {
                        if let Some(piv_local) = bm::gizmo::project(&cam, view, drag.pivot)
                            && piv_local.x.is_finite()
                            && piv_local.y.is_finite()
                        {
                            let piv_scr = pos2(rect.left() + piv_local.x as f32, rect.top() + piv_local.y as f32);
                            let cur_rad = f64::from(p.y - piv_scr.y).atan2(f64::from(p.x - piv_scr.x));
                            let mut delta_rad = -(cur_rad - drag.start_angle_rad);
                            while delta_rad > std::f64::consts::PI {
                                delta_rad -= std::f64::consts::TAU;
                            }
                            while delta_rad < -std::f64::consts::PI {
                                delta_rad += std::f64::consts::TAU;
                            }
                            // Match right-hand rule around `drag.axis` relative to the camera look direction.
                            let eye_dir = camera_direction(&cam);
                            if dot(drag.axis, eye_dir) < 0.0 {
                                delta_rad = -delta_rad;
                            }
                            let raw_deg = delta_rad.to_degrees();
                            let snapped = if mods.shift {
                                raw_deg.round()
                            } else {
                                (raw_deg / 15.0).round() * 15.0
                            };
                            let clamped = snapped.clamp(drag.min_limit, drag.max_limit);
                            drag.hit_limit = if snapped > drag.max_limit + 0.01 && !drag.max_blocker.is_empty() {
                                Some(drag.max_blocker.clone())
                            } else if snapped < drag.min_limit - 0.01 && !drag.min_blocker.is_empty() {
                                Some(drag.min_blocker.clone())
                            } else {
                                None
                            };
                            let step = clamped - drag.applied;
                            if step.abs() > 1e-4 {
                                let c = app.doc.session().rotate(&drag.branch, drag.axis, step, drag.pivot, true);
                                if c.refused.is_none() {
                                    drag.applied = clamped;
                                }
                            }
                        }
                    }
                    DragKind::Slide => {
                        if let Some((a, b)) = app.joints.slide_seg {
                            let dir = b - a;
                            let px_len = dir.length().max(1.0);
                            let u = dir / px_len;
                            let along_px = (p - drag.start_pos).dot(u) as f64;
                            // 40 LDU spans the drawn arrow half-length.
                            let raw_ldu = along_px * (40.0 / f64::from(px_len * 0.5).max(1.0));
                            let snapped = if mods.shift {
                                (raw_ldu * 2.0).round() * 0.5
                            } else {
                                (raw_ldu / 4.0).round() * 4.0
                            };
                            let clamped = snapped.clamp(drag.min_limit, drag.max_limit);
                            let step = clamped - drag.applied;
                            if step.abs() > 1e-4 {
                                let delta = bm::Vec3::new(drag.axis.x * step, drag.axis.y * step, drag.axis.z * step);
                                let c = app.doc.session().translate(&drag.branch, delta, true);
                                if c.refused.is_none() {
                                    drag.applied = clamped;
                                }
                            }
                        }
                    }
                }
            }
            app.joints.live_drag = Some(drag);
        } else {
            // Release: close the single undo step and let the next frame refresh joint limits.
            app.doc.session().end_gesture();
            app.joints.info_started = None;
            app.joints.started = None;
        }
        return true;
    }

    if app.joints.marker_press {
        if !down {
            app.joints.marker_press = false;
        }
        return true;
    }
    if app.edit.placement.is_some() || app.transport.state.playing {
        return false;
    }
    let (Some(rect), Some(p)) = (app.viewport.last_rect, pos) else { return false };
    if !pressed || !rect.contains(p) || ui.ctx().layer_id_at(p) != Some(ui.layer_id()) {
        return false;
    }

    // 1. Direct press on the open joint's 3D rotation ring or slide handle starts live articulation.
    if let Some(row) = app.joints.row() {
        let on_ring = row.kind.turns() && dist_to_ring(p, &app.joints.ring_pts) <= RING_HIT;
        let on_slide = app.joints.slide_seg.is_some_and(|(a, b)| dist_to_segment(p, a, b) <= SLIDE_HIT);
        if (on_ring || on_slide)
            && let Some(info) = app.joints.open_info(app.doc.session(), app.edit.collision).cloned()
        {
            if let Some(err) = info.error {
                app.joints.error = Some(err);
                app.joints.marker_press = true;
                return true;
            }
            if !all_local(app.doc.session(), &info.pieces) {
                app.joints.error = Some("Open the submodel that contains this connection.".into());
                app.joints.marker_press = true;
                return true;
            }
            let Some(vp) = app.doc.viewport() else { return false };
            let cam = vp.camera();
            let view = bm::Vec2::new(f64::from(rect.width()), f64::from(rect.height()));
            let pivot = active_pivot(&row, Some(&info));
            let axis = active_axis(&row, Some(&info), app.joints.ball_axis, &cam);
            let piv_scr = bm::gizmo::project(&cam, view, pivot)
                .map(|q| pos2(rect.left() + q.x as f32, rect.top() + q.y as f32))
                .unwrap_or(p);
            let start_angle_rad = f64::from(p.y - piv_scr.y).atan2(f64::from(p.x - piv_scr.x));
            let (mode, min_limit, max_limit) = if on_ring {
                (DragKind::Turn, info.min_deg, info.max_deg)
            } else {
                (DragKind::Slide, info.min_slide, info.max_slide)
            };
            app.doc.session().end_gesture();
            app.joints.error = None;
            app.joints.live_drag = Some(LiveJointDrag {
                mode,
                pivot,
                axis,
                branch: info.pieces,
                start_pos: p,
                start_angle_rad,
                applied: 0.0,
                min_limit,
                max_limit,
                min_blocker: info.min_blocker,
                max_blocker: info.max_blocker,
                hit_limit: None,
            });
            return true;
        }
    }

    // Never steal a press on an active move/rotate gizmo handle (unless Smart Joints owns Rotate).
    if !owns_rotate_gizmo(app)
        && let Some(gizmo) = &app.viewport.gizmo
    {
        let pt = bm::Vec2::new(f64::from(p.x - rect.left()), f64::from(p.y - rect.top()));
        if gizmo.hit(pt, 8.0) != bm::gizmo::Handle::None {
            return false;
        }
    }

    // 2. Click on a joint marker dot opens that joint.
    if !app.joints.show && !app.edit.smart_joints {
        return false;
    }
    let hit = app
        .joints
        .markers
        .iter()
        .map(|(k, m)| (*k, m.distance(p)))
        .filter(|(_, d)| *d <= MARKER_HIT)
        .min_by(|a, b| a.1.total_cmp(&b.1));
    let Some((k, _)) = hit else { return false };
    open(app, k);
    app.joints.marker_press = true;
    true
}

fn description(kind: JointType) -> &'static str {
    match kind {
        JointType::Fixed => "Held rigidly in place",
        JointType::Hinge => "Turns about its pin",
        JointType::Slider => "Slides along its axis",
        JointType::Cylindrical => "Turns about the axle and slides along it",
        JointType::Ball => "Turns freely about the ball",
        JointType::Flexible => "Bends with the part",
    }
}

/// Builds and caches a piece -> display name table once per document version so joint overlays and
/// panels don't scan every step across FFI each frame.
fn part_name(app: &mut BrickMotionApp, piece: u32) -> String {
    let s = app.doc.session();
    let key = (s.generation(), s.version());
    if app.joints.names_cache.as_ref().is_none_or(|(k, _)| *k != key) {
        let tidy = |d: &str| d.split_whitespace().collect::<Vec<_>>().join(" ");
        let mut map = HashMap::new();
        for st in 0..s.steps().len() {
            for item in s.step_items(st) {
                let label = if !item.submodel && !item.description.is_empty() {
                    tidy(&item.description)
                } else {
                    tidy(item.name.trim_end_matches(".ldr").trim_end_matches(".dat"))
                };
                for p in item.pieces {
                    if !item.submodel || !map.contains_key(&p) {
                        map.insert(p, label.clone());
                    }
                }
            }
        }
        app.joints.names_cache = Some((key, map));
    }
    app.joints
        .names_cache
        .as_ref()
        .and_then(|(_, m)| m.get(&piece).cloned())
        .unwrap_or_else(|| format!("Part {}", piece + 1))
}

/// "A ↔ B", or one name when both parts go by the same one.
fn pair_name(app: &mut BrickMotionApp, a: u32, b: u32) -> String {
    let a = part_name(app, a);
    let b = part_name(app, b);
    if a == b { a } else { format!("{a} ↔ {b}") }
}

fn degrees(v: f64) -> String {
    let n = v.round() as i64;
    if n < 0 { format!("−{}°", -n) } else { format!("{n}°") }
}

/// World-space radius corresponding to `px` screen points at `point`.
fn world_radius(cam: &bm::Camera, view_h: f64, point: bm::Vec3, px: f32) -> f64 {
    let eye_dir = camera_direction(cam);
    let eye = bm::Vec3::new(
        cam.target.x + eye_dir.x * cam.distance,
        cam.target.y + eye_dir.y * cam.distance,
        cam.target.z + eye_dir.z * cam.distance,
    );
    let fwd = bm::Vec3::new(-eye_dir.x, -eye_dir.y, -eye_dir.z);
    let away = dot(bm::Vec3::new(point.x - eye.x, point.y - eye.y, point.z - eye.z), fwd).max(20.0);
    let world_h = if cam.orthographic {
        2.0 * cam.distance * (cam.vertical_fov * 0.5).tan()
    } else {
        2.0 * away * (cam.vertical_fov * 0.5).tan()
    };
    (f64::from(px) * world_h / view_h.max(1.0)).clamp(14.0, 120.0)
}

/// Markers, the open joint's axis, interactive 3D rotation ring, collision-limit arcs, slide handle, and card.
pub fn show(ui: &mut Ui, app: &mut BrickMotionApp) {
    app.joints.markers.clear();
    app.joints.ring_pts.clear();
    app.joints.slide_seg = None;
    let Some(rect) = app.viewport.last_rect else { return };
    let Some(vp) = app.doc.viewport() else { return };
    let cam = vp.camera();
    let view = bm::Vec2::new(f64::from(rect.width()), f64::from(rect.height()));
    let project = |at: bm::Vec3| -> Option<Pos2> {
        bm::gizmo::project(&cam, view, at)
            .filter(|p| p.x.is_finite() && p.y.is_finite())
            .map(|p| pos2(rect.left() + p.x as f32, rect.top() + p.y as f32))
    };
    let t = app.theme;
    let painter = ui.painter_at(rect);
    let open_key = app.joints.open;
    let selection: HashSet<u32> = app.doc.session().selection().into_iter().collect();
    let show_markers = app.joints.show || (app.edit.smart_joints && !selection.is_empty());
    let hover = ui
        .input(|i| i.pointer.hover_pos())
        .filter(|p| rect.contains(*p) && ui.ctx().layer_id_at(*p) == Some(ui.layer_id()));
    let mut hovered_joint: Option<(JointRow, Pos2)> = None;

    if show_markers
        && let Some(rows) = app.joints.report.clone()
    {
        let mut drawn: Vec<Pos2> = Vec::new();
        let dimmed = open_key.is_some();
        let dot_r = if dimmed { 2.8 } else { 3.6 };
        let fill = if dimmed {
            Color32::from_rgba_unmultiplied(t.accent.r(), t.accent.g(), t.accent.b(), 110)
        } else {
            Color32::from_rgba_unmultiplied(t.accent.r(), t.accent.g(), t.accent.b(), 220)
        };
        let ring = if dimmed { Color32::from_white_alpha(90) } else { Color32::from_white_alpha(200) };
        for j in rows.iter().filter(|j| j.kind != JointType::Fixed) {
            // In Smart Joints mode without global Joint Markers, only show markers on selected pieces.
            if !app.joints.show && !selection.contains(&j.a) && !selection.contains(&j.b) {
                continue;
            }
            if open_key.is_some_and(|k| same(j, k)) {
                continue;
            }
            let Some(p) = project(j.point).filter(|p| rect.contains(*p)) else { continue };
            app.joints.markers.push(((j.a, j.b), p));
            if drawn.iter().any(|q| q.distance_sq(p) < 49.0) {
                continue;
            }
            drawn.push(p);
            let is_hov = hover.is_some_and(|h| h.distance(p) <= MARKER_HIT);
            if is_hov {
                hovered_joint = Some((*j, p));
                painter.circle(p, 5.5, t.accent, Stroke::new(1.5, Color32::WHITE));
            } else {
                painter.circle(p, dot_r, fill, Stroke::new(1.0, ring));
            }
        }
    }

    if let Some((hj, hp)) = hovered_joint
        && app.joints.live_drag.is_none()
    {
        ui.ctx().set_cursor_icon(CursorIcon::PointingHand);
        let tip = format!("{} · {}", hj.kind.title(), pair_name(app, hj.a, hj.b));
        let g = painter.layout_no_wrap(tip, FontId::proportional(11.0), t.text1);
        let chip = Rect::from_min_size(
            pos2((hp.x + 10.0).min(rect.right() - g.size().x - 20.0), (hp.y - 26.0).max(rect.top() + super::ribbon::SPACE + 6.0)),
            g.size() + vec2(14.0, 8.0),
        );
        painter.rect(chip, 6.0, t.float_fill(), Stroke::new(1.0, t.border2), StrokeKind::Inside);
        painter.galley(chip.min + vec2(7.0, 4.0), g, t.text1);
    }

    let Some(row) = app.joints.row() else { return };
    let info = app.joints.open_info(app.doc.session(), app.edit.collision).cloned();
    let pivot3 = active_pivot(&row, info.as_ref());
    let Some(pivot) = project(pivot3) else { return };
    if show_markers {
        app.joints.markers.push(((row.a, row.b), pivot));
    }

    // Axis, interactive 3D rotation ring, collision-limit markers, and slide arrow.
    let axis = active_axis(&row, info.as_ref(), app.joints.ball_axis, &cam);
    let r_world = world_radius(&cam, view.y, pivot3, RING_SCREEN_PX);
    let at = |k: f64| bm::Vec3::new(pivot3.x + axis.x * k, pivot3.y + axis.y * k, pivot3.z + axis.z * k);
    if let (Some(p0), Some(p1)) = (project(at(-r_world * 1.5)), project(at(r_world * 1.5))) {
        painter.extend(Shape::dashed_line(&[p0, p1], Stroke::new(1.5, t.accent), 6.0, 4.0));
    }

    // 3D Rotation Ring (for Hinge, Cylindrical, Ball).
    if row.kind.turns() {
        let helper = if axis.y.abs() < 0.9 { bm::Vec3::new(0.0, 1.0, 0.0) } else { bm::Vec3::new(1.0, 0.0, 0.0) };
        let u = cross(axis, helper);
        let v = cross(axis, u);
        let ring: Vec<Pos2> = (0..=64)
            .filter_map(|i| {
                let th = f64::from(i) / 64.0 * std::f64::consts::TAU;
                let (c, s) = (th.cos() * r_world, th.sin() * r_world);
                project(bm::Vec3::new(pivot3.x + u.x * c + v.x * s, pivot3.y + u.y * c + v.y * s, pivot3.z + u.z * c + v.z * s))
            })
            .collect();
        let dragging_ring = app.joints.live_drag.as_ref().is_some_and(|d| d.mode == DragKind::Turn);
        let ring_hot = dragging_ring || hover.is_some_and(|h| dist_to_ring(h, &ring) <= RING_HIT);
        if dragging_ring {
            ui.ctx().set_cursor_icon(CursorIcon::Grabbing);
        } else if ring_hot {
            ui.ctx().set_cursor_icon(CursorIcon::Grab);
        }
        let ring_color = if ring_hot {
            t.accent
        } else {
            Color32::from_rgba_unmultiplied(t.accent.r(), t.accent.g(), t.accent.b(), 195)
        };
        let ring_width = if ring_hot { 3.0 } else { 2.0 };
        painter.add(Shape::line(ring.clone(), Stroke::new(ring_width, ring_color)));

        // Subtle 15° tick notches around the ring so rotation increments read like a precision protractor.
        for k in 0..24 {
            let th = f64::from(k) * (std::f64::consts::TAU / 24.0);
            let major = k % 6 == 0;
            let r_in = r_world * if major { 0.86 } else { 0.92 };
            let (c, s) = (th.cos(), th.sin());
            let p_in = project(bm::Vec3::new(pivot3.x + (u.x * c + v.x * s) * r_in, pivot3.y + (u.y * c + v.y * s) * r_in, pivot3.z + (u.z * c + v.z * s) * r_in));
            let p_out = project(bm::Vec3::new(pivot3.x + (u.x * c + v.x * s) * r_world, pivot3.y + (u.y * c + v.y * s) * r_world, pivot3.z + (u.z * c + v.z * s) * r_world));
            if let (Some(a), Some(b)) = (p_in, p_out) {
                let tick_c = Color32::from_rgba_unmultiplied(t.accent.r(), t.accent.g(), t.accent.b(), if major { 175 } else { 95 });
                painter.line_segment([a, b], Stroke::new(if major { 1.5 } else { 1.0 }, tick_c));
            }
        }

        // Paint live drag readout pill & swept angle indicator.
        if let Some(drag) = &app.joints.live_drag
            && drag.mode == DragKind::Turn
            && let Some(ptr) = ui.input(|i| i.pointer.latest_pos())
        {
            let label = match &drag.hit_limit {
                Some(blocker) => format!("{} · Stop: {blocker}", degrees(drag.applied)),
                None => degrees(drag.applied),
            };
            crate::gizmo::paint_readout(&painter, &t, ptr, &label);
        }
        app.joints.ring_pts = ring;
    }

    // 3D Linear Slide Handle (for Slider & Cylindrical joints).
    let can_slide = row.kind == JointType::Slider || row.kind == JointType::Cylindrical || info.as_ref().is_some_and(|i| i.can_slide);
    if can_slide
        && let (Some(pa), Some(pb)) = (project(at(-r_world * 0.9)), project(at(r_world * 0.9)))
    {
        let dragging_slide = app.joints.live_drag.as_ref().is_some_and(|d| d.mode == DragKind::Slide);
        let slide_hot = dragging_slide || hover.is_some_and(|h| dist_to_segment(h, pa, pb) <= SLIDE_HIT);
        let slide_c = if slide_hot { Color32::from_rgb(0x30, 0xa4, 0x6c) } else { Color32::from_rgba_unmultiplied(0x30, 0xa4, 0x6c, 210) };
        painter.line_segment([pa, pb], Stroke::new(if slide_hot { 3.0 } else { 2.0 }, slide_c));
        // Arrowheads on both ends.
        let dir = pb - pa;
        let len = dir.length();
        if len > 12.0 {
            let u = dir / len;
            let n = vec2(-u.y, u.x);
            for (tip, sgn) in [(pb, 1.0f32), (pa, -1.0f32)] {
                let base = tip - u * (9.0 * sgn);
                painter.add(Shape::convex_polygon(vec![tip, base + n * 4.0, base - n * 4.0], slide_c, Stroke::NONE));
            }
        }
        if dragging_slide {
            ui.ctx().set_cursor_icon(CursorIcon::Grabbing);
            if let (Some(drag), Some(ptr)) = (&app.joints.live_drag, ui.input(|i| i.pointer.latest_pos())) {
                crate::gizmo::paint_readout(&painter, &t, ptr, &format!("{:+.1} LDU", drag.applied));
            }
        } else if slide_hot {
            ui.ctx().set_cursor_icon(CursorIcon::Grab);
        }
        app.joints.slide_seg = Some((pa, pb));
    }

    painter.circle(pivot, 4.8, t.accent, Stroke::new(1.5, Color32::WHITE));
    card(ui, app, &t, rect, pivot, row, info.as_ref());
}

fn cross(a: bm::Vec3, b: bm::Vec3) -> bm::Vec3 {
    let c = bm::Vec3::new(a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x);
    let l = (c.x * c.x + c.y * c.y + c.z * c.z).sqrt().max(1e-9);
    bm::Vec3::new(c.x / l, c.y / l, c.z / l)
}

/// The floating card beside the pivot with quick angle steps, continuous angle/slide sliders,
/// ball-joint axis picker, side swap, joint switcher, rigid body selection, and detach.
fn card(ui: &mut Ui, app: &mut BrickMotionApp, t: &Theme, rect: Rect, pivot: Pos2, row: JointRow, info: Option<&JointInfo>) {
    const W: f32 = 276.0;
    let names = pair_name(app, row.a, row.b);
    let siblings = app.joints.sibling_joints();
    let cur_idx = siblings.iter().position(|j| same(j, (row.a, row.b))).unwrap_or(0);
    let tl_pad = if app.workspace == crate::Workspace::Animate { app.timeline.height + 16.0 } else { 0.0 };
    let min_y = rect.top() + super::ribbon::SPACE + 8.0;
    let x = (pivot.x + 18.0).min(rect.right() - W - 8.0).max(rect.left() + 8.0);
    let y = (pivot.y - 70.0).clamp(min_y, (rect.bottom() - tl_pad - 220.0).max(min_y));

    let mut act_deg: Option<f64> = None;
    let mut act_slide: Option<f64> = None;
    let mut detach = false;
    let (mut body, mut branch_sel, mut flip, mut shut) = (false, false, false, false);
    let mut switch_to: Option<(u32, u32)> = None;
    let mut next_ball_axis = app.joints.ball_axis;
    let changing = app.joints.changing;
    let error = app.joints.error.clone().or_else(|| info.and_then(|i| i.error.clone()));
    let live_applied = app.joints.live_drag.as_ref().map(|d| (d.mode, d.applied));
    let can_slide = row.kind == JointType::Slider || row.kind == JointType::Cylindrical || info.is_some_and(|i| i.can_slide);
    let min_deg = info.map_or(-180.0, |i| i.min_deg);
    let max_deg = info.map_or(180.0, |i| i.max_deg);
    let full_turn = info.is_none_or(|i| i.full_turn);
    let branch_ready = info.is_some_and(|i| i.error.is_none() && !i.pieces.is_empty());

    egui::Area::new(egui::Id::unique("joint_card"))
        .order(egui::Order::Middle)
        .fixed_pos(pos2(x, y))
        .show(ui.ctx(), |ui| {
            super::float_frame(t).inner_margin(egui::Margin::symmetric(12, 10)).show(ui, |ui| {
                ui.set_width(W - 24.0);
                let r = ui.interact(ui.max_rect(), egui::Id::unique("joint_card_body"), Sense::hover());
                r.widget_info(|| WidgetInfo::labeled(egui::Role::Group, true, "Joint card"));
                ui.horizontal(|ui| {
                    let (ir, _) = ui.allocate_exact_size(vec2(14.0, 14.0), Sense::hover());
                    crate::icons::paint(ui, Icon::Rotate, ir, 14.0, t.accent);
                    ui.label(egui::RichText::new(row.kind.title()).strong().size(12.5).color(t.text1));
                    if siblings.len() > 1 {
                        ui.label(egui::RichText::new(format!("{}/{}", cur_idx + 1, siblings.len())).size(10.5).color(t.text3));
                    }
                    ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                        if super::icon_button(ui, t, Icon::Close, "Close joint", true, false, 18.0).clicked() {
                            shut = true;
                        }
                        if super::icon_button_tip(ui, t, Icon::Replace, "Swap fixed & moving side", "Swap which side stays fixed and which side moves", !changing, false, 20.0).clicked() {
                            flip = true;
                        }
                        if siblings.len() > 1 {
                            let next_j = siblings[(cur_idx + 1) % siblings.len()];
                            let prev_j = siblings[(cur_idx + siblings.len() - 1) % siblings.len()];
                            if super::icon_button_tip(ui, t, Icon::Chevron, "Next joint", "Switch to next joint on this piece", true, false, 18.0).clicked() {
                                switch_to = Some((next_j.a, next_j.b));
                            }
                            if super::icon_button_tip(ui, t, Icon::Back, "Previous joint", "Switch to previous joint on this piece", true, false, 18.0).clicked() {
                                switch_to = Some((prev_j.a, prev_j.b));
                            }
                        }
                    });
                });
                ui.add(egui::Label::new(egui::RichText::new(&names).size(11.0).color(t.text3)).truncate());
                ui.label(egui::RichText::new(description(row.kind)).size(11.0).color(t.text3));

                if row.kind == JointType::Ball {
                    ui.add_space(6.0);
                    let axes = [BallAxis::X, BallAxis::Y, BallAxis::Z, BallAxis::View];
                    let labels = [BallAxis::X.label(), BallAxis::Y.label(), BallAxis::Z.label(), BallAxis::View.label()];
                    let mut idx = axes.iter().position(|a| *a == next_ball_axis).unwrap_or(0);
                    if segmented(ui, t, "Ball axis", &labels, &mut idx, !changing) {
                        next_ball_axis = axes[idx];
                    }
                }

                if row.kind.turns() {
                    ui.add_space(8.0);
                    let shown_deg = match live_applied {
                        Some((DragKind::Turn, d)) => row.angle + d,
                        _ => row.angle,
                    };
                    ui.horizontal(|ui| {
                        let step = |ui: &mut Ui, text: &str, label: &str, w: f32| {
                            let (r, resp) = ui.allocate_exact_size(vec2(w, 26.0), if changing { Sense::hover() } else { Sense::click() });
                            resp.widget_info(|| WidgetInfo::labeled(egui::Role::Button, !changing, label));
                            let fill = if resp.hovered() && !changing { Color32::from_white_alpha(24) } else { Color32::from_white_alpha(14) };
                            ui.painter().rect_filled(r, 6.0, fill);
                            ui.painter().text(r.center(), Align2::CENTER_CENTER, text, FontId::proportional(11.5), if changing { t.text3 } else { t.text1 });
                            resp.clicked() && !changing
                        };
                        if step(ui, "−45°", "Rotate left 45 degrees", 36.0) {
                            act_deg = Some(-45.0);
                        }
                        if step(ui, "−15°", "Rotate left 15 degrees", 38.0) {
                            act_deg = Some(-15.0);
                        }
                        let rem = (ui.available_width() - 82.0).max(48.0);
                        let (r, resp) = ui.allocate_exact_size(vec2(rem, 26.0), Sense::hover());
                        resp.widget_info(|| WidgetInfo::labeled(egui::Role::Label, true, format!("Joint angle {}", degrees(shown_deg))));
                        ui.painter().text(r.center(), Align2::CENTER_CENTER, degrees(shown_deg), FontId::proportional(18.0), t.text1);
                        if step(ui, "+15°", "Rotate right 15 degrees", 38.0) {
                            act_deg = Some(15.0);
                        }
                        if step(ui, "+45°", "Rotate right 45 degrees", 36.0) {
                            act_deg = Some(45.0);
                        }
                    });

                    // Continuous drag slider within live collision limits.
                    if branch_ready && (max_deg - min_deg) > 1.0 {
                        ui.add_space(6.0);
                        let mut val = if app.joints.slider_active { app.joints.slider_applied } else { 0.0 };
                        let sl = ui.add(
                            egui::Slider::new(&mut val, min_deg..=max_deg)
                                .step_by(1.0)
                                .suffix("°")
                                .show_value(false),
                        );
                        sl.widget_info(|| WidgetInfo::labeled(egui::Role::Slider, true, "Joint angle slider"));
                        if sl.drag_started() {
                            app.doc.session().end_gesture();
                            app.joints.slider_active = true;
                            app.joints.slider_applied = 0.0;
                        }
                        if sl.dragged() && app.joints.slider_active {
                            let step = val - app.joints.slider_applied;
                            if step.abs() > 1e-4
                                && let Some(info) = info
                                && all_local(app.doc.session(), &info.pieces)
                            {
                                let cam = app.doc.viewport().map(|vp| vp.camera()).unwrap_or_default();
                                let axis = active_axis(&row, Some(info), next_ball_axis, &cam);
                                let pivot3 = active_pivot(&row, Some(info));
                                let c = app.doc.session().rotate(&info.pieces, axis, step, pivot3, true);
                                if c.refused.is_none() {
                                    app.joints.slider_applied = val;
                                }
                            }
                        }
                        if sl.drag_stopped() && app.joints.slider_active {
                            app.joints.slider_active = false;
                            app.joints.slider_applied = 0.0;
                            app.doc.session().end_gesture();
                            app.joints.info_started = None;
                            app.joints.started = None;
                        }
                        let range_txt = if full_turn {
                            "Drag 3D ring or slider · Free 360°".to_owned()
                        } else {
                            format!("Free range: {} to {}", degrees(min_deg), degrees(max_deg))
                        };
                        ui.label(egui::RichText::new(range_txt).size(10.5).color(t.text3));
                    }
                }

                if can_slide {
                    ui.add_space(6.0);
                    ui.horizontal(|ui| {
                        let sbtn = |ui: &mut Ui, text: &str, label: &str| {
                            let (r, resp) = ui.allocate_exact_size(vec2(52.0, 24.0), if changing { Sense::hover() } else { Sense::click() });
                            resp.widget_info(|| WidgetInfo::labeled(egui::Role::Button, !changing, label));
                            let fill = if resp.hovered() && !changing { Color32::from_white_alpha(24) } else { Color32::from_white_alpha(14) };
                            ui.painter().rect_filled(r, 6.0, fill);
                            ui.painter().text(r.center(), Align2::CENTER_CENTER, text, FontId::proportional(11.0), if changing { t.text3 } else { t.text1 });
                            resp.clicked() && !changing
                        };
                        if sbtn(ui, "−1 stud", "Slide back 1 stud") {
                            act_slide = Some(-bm::STUD);
                        }
                        ui.label(egui::RichText::new("Slide").size(11.0).color(t.text3));
                        if sbtn(ui, "+1 stud", "Slide forward 1 stud") {
                            act_slide = Some(bm::STUD);
                        }
                    });
                }

                if let Some(e) = &error {
                    ui.add_space(6.0);
                    ui.label(egui::RichText::new(e).size(11.0).color(Color32::from_rgb(0xfe, 0xbc, 0x2e)));
                }
                ui.add_space(8.0);
                hairline(ui);
                ui.add_space(8.0);
                ui.horizontal(|ui| {
                    if secondary_button(ui, t, "Select Rigid Body", true).clicked() {
                        body = true;
                    }
                    if branch_ready && secondary_button(ui, t, "Branch", true).clicked() {
                        branch_sel = true;
                    }
                    ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                        if secondary_button(ui, t, "Detach", !changing).clicked() {
                            detach = true;
                        }
                    });
                });
            });
        });

    app.joints.ball_axis = next_ball_axis;
    if let Some(k) = switch_to {
        open(app, k);
    } else if flip {
        flip_side(app);
    } else if detach {
        change(app, 0.0);
    } else if let Some(d) = act_deg {
        change(app, d);
    } else if let Some(s) = act_slide {
        change_ex(app, 0.0, s, bm::Vec3::ZERO);
    } else if body {
        select_body(app);
    } else if branch_sel {
        select_branch(app);
    } else if shut {
        close(app);
    }
}

/// The Joint panel at the top right while a joint is open.
pub fn panel(ui: &mut Ui, app: &mut BrickMotionApp, area: Rect, next_top: &mut f32) {
    let Some(row) = app.joints.row() else { return };
    let subtitle = pair_name(app, row.a, row.b);
    let info = app.joints.open_info(app.doc.session(), app.edit.collision).cloned();
    let siblings = app.joints.sibling_joints();
    let mut pick_joint: Option<(u32, u32)> = None;
    let mut do_flip = false;
    let out = float_panel::show(
        ui,
        app,
        area,
        next_top,
        PanelKind::Joint,
        Head { icon: Icon::Rotate, title: "", subtitle: &subtitle },
        |ui, app| {
            let t = app.theme;
            group_heading(ui, &t, "Joint", "");
            inset_group(ui, |ui| {
                let travel = match &info {
                    Some(i) if i.error.is_some() => "Locked".to_owned(),
                    Some(i) if i.full_turn => "Free 360°".to_owned(),
                    Some(i) if i.can_turn => format!("{} to {}", degrees(i.min_deg), degrees(i.max_deg)),
                    Some(i) if i.can_slide => format!("{:.0} to {:.0} LDU", i.min_slide, i.max_slide),
                    _ => "Inspecting…".to_owned(),
                };
                let branch_n = info.as_ref().map_or(0, |i| i.pieces.len());
                let rows = [
                    ("Type", row.kind.title().to_owned()),
                    ("Angle", degrees(row.angle)),
                    ("Travel", travel),
                    ("Moving branch", if branch_n > 0 { format!("{branch_n} pieces") } else { "—".into() }),
                    ("Mates", row.mate_count.to_string()),
                    ("Clearance", format!("{:.2} mm", row.clearance * 0.4)),
                ];
                for (i, (label, value)) in rows.iter().enumerate() {
                    if i > 0 {
                        hairline(ui);
                    }
                    let (r, _) = ui.allocate_exact_size(vec2(ui.available_width(), 32.0), Sense::hover());
                    ui.painter().text(pos2(r.left() + 12.0, r.center().y), Align2::LEFT_CENTER, *label, FontId::proportional(12.0), t.text1);
                    ui.painter().text(pos2(r.right() - 12.0, r.center().y), Align2::RIGHT_CENTER, value, FontId::monospace(11.5), t.text2);
                }
            });
            if let Some(i) = &info
                && (!i.max_blocker.is_empty() || !i.min_blocker.is_empty())
            {
                let mut notes = Vec::new();
                if !i.min_blocker.is_empty() {
                    notes.push(format!("− stop: {}", i.min_blocker));
                }
                if !i.max_blocker.is_empty() {
                    notes.push(format!("+ stop: {}", i.max_blocker));
                }
                super::widgets::footnote(ui, &t, &notes.join(" · "));
            }
            if let Some(e) = app.joints.error.clone().or_else(|| info.as_ref().and_then(|i| i.error.clone())) {
                super::widgets::footnote(ui, &t, &e);
            }
            if let Some((fixed, moving)) = app.joints.open {
                let fixed_name = part_name(app, fixed);
                let moving_name = part_name(app, moving);
                group_heading(ui, &t, "Articulation", "");
                inset_group(ui, |ui| {
                    let (r1, _) = ui.allocate_exact_size(vec2(ui.available_width(), 30.0), Sense::hover());
                    ui.painter().text(pos2(r1.left() + 12.0, r1.center().y), Align2::LEFT_CENTER, "Fixed", FontId::proportional(11.5), t.text3);
                    ui.painter().text(pos2(r1.right() - 12.0, r1.center().y), Align2::RIGHT_CENTER, &fixed_name, FontId::proportional(11.5), t.text1);
                    hairline(ui);
                    let (r2, _) = ui.allocate_exact_size(vec2(ui.available_width(), 30.0), Sense::hover());
                    ui.painter().text(pos2(r2.left() + 12.0, r2.center().y), Align2::LEFT_CENTER, "Moving", FontId::proportional(11.5), t.text3);
                    ui.painter().text(pos2(r2.right() - 12.0, r2.center().y), Align2::RIGHT_CENTER, &moving_name, FontId::proportional(11.5), t.accent);
                    hairline(ui);
                    egui::Frame::NONE.inner_margin(egui::Margin::symmetric(12, 6)).show(ui, |ui| {
                        if secondary_button(ui, &t, "Swap Fixed & Moving Side", !app.joints.changing).clicked() {
                            do_flip = true;
                        }
                    });
                });
            }
            if siblings.len() > 1 {
                group_heading(ui, &t, "Joints on Piece", &siblings.len().to_string());
                inset_group(ui, |ui| {
                    for (idx, s) in siblings.iter().enumerate() {
                        if idx > 0 {
                            hairline(ui);
                        }
                        let active = same(s, (row.a, row.b));
                        let label = format!("{} · {}", s.kind.title(), pair_name(app, s.a, s.b));
                        let (r, resp) = ui.allocate_exact_size(vec2(ui.available_width(), 30.0), Sense::click());
                        if active {
                            ui.painter().rect_filled(r, CornerRadius::ZERO, t.accent_bg());
                        } else if resp.hovered() {
                            ui.painter().rect_filled(r, CornerRadius::ZERO, t.bg3);
                        }
                        ui.painter().text(pos2(r.left() + 12.0, r.center().y), Align2::LEFT_CENTER, label, FontId::proportional(11.5), if active { t.accent } else { t.text1 });
                        if resp.clicked() && !active {
                            pick_joint = Some((s.a, s.b));
                        }
                    }
                });
            }
            group_heading(ui, &t, "Options", "");
            inset_group(ui, |ui| {
                let mut smart = app.edit.smart_joints;
                if switch_row(ui, &t, "Smart Joints mode", &mut smart, true) {
                    app.edit.smart_joints = smart;
                }
                hairline(ui);
                let mut coll = app.edit.collision;
                if switch_row(ui, &t, "Collision limits", &mut coll, true) {
                    app.edit.collision = coll;
                    app.joints.info_started = None;
                }
                hairline(ui);
                let mut all = app.joints.show;
                if switch_row(ui, &t, "All joints in step", &mut all, true) {
                    app.joints.show = all;
                }
                hairline(ui);
                let mut geo = app.joints.check_geometry;
                if switch_row(ui, &t, "Check geometry", &mut geo, true) {
                    app.joints.check_geometry = geo;
                }
            });
        },
    );
    if do_flip {
        flip_side(app);
    } else if let Some(k) = pick_joint {
        open(app, k);
    }
    if out.close {
        close(app);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn axes_and_labels() {
        assert_eq!(nearest_axis(bm::Vec3::new(0.2, -0.9, 0.1)), bm::Vec3::new(0.0, -1.0, 0.0));
        assert_eq!(nearest_axis(bm::Vec3::new(-0.7, 0.1, 0.5)), bm::Vec3::new(-1.0, 0.0, 0.0));
        assert_eq!(direction_label(bm::Vec3::new(0.0, -1.0, 0.0)), "From Above");
        assert_eq!(direction_label(bm::Vec3::new(0.0, 0.0, 0.0)), "Automatic");
        assert_eq!(direction_label(bm::Vec3::new(0.5, 0.5, 0.0)), "Custom");
        assert_eq!(degrees(-75.2), "−75°");
    }
}
