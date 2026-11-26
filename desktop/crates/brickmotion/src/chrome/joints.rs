//! Joints (`AssemblyReview`, `JointCard`, `EditorOverlays`; m5-rulings.md): View › Joint Markers
//! draws a dot at every moving joint; clicking one (or picking a part that has a joint) opens it:
//! its axis (dashed accent line), pivot (accent dot) and turn ring in the view, a small card beside
//! it (type, what it does, −15° / angle / +15°, Select Rigid Body, Detach) and the Joint panel at
//! the top right. Inspections and joint changes run on the `bm-anim` worker; a change lands only on
//! the document it was made from, through `place_moved`.
use std::collections::HashSet;

use bm::motion::{Inspection, JointEdit, JointReport, JointRow, JointType};
use egui::{Align2, Color32, FontId, Pos2, Rect, Sense, Shape, Stroke, Ui, WidgetInfo, pos2, vec2};

use super::float_panel::{self, Head, PanelKind, group_heading};
use super::widgets::{hairline, inset_group, secondary_button, switch_row};
use crate::BrickMotionApp;
use crate::icons::Icon;
use crate::theme::Theme;
use crate::workers::{Job, Stale};

const MARKER_HIT: f32 = 11.0;

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
    /// The open joint's last refusal.
    pub error: Option<String>,
    pub changing: bool,
    /// Markers on screen this frame.
    pub markers: Vec<((u32, u32), Pos2)>,
    inspect: Job<JointKey, JointReport>,
    started: Option<JointKey>,
    change_job: Job<DocKey, (JointEdit, (u32, u32))>,
    /// The selection whose card was closed: picking it does not open the card again.
    dismissed: Option<Vec<u32>>,
    marker_press: bool,
}

impl JointsView {
    pub fn busy(&self) -> bool {
        self.inspect.busy() || self.change_job.busy()
    }

    /// The report is for the document and selection as they stand.
    pub fn current(&self, s: &bm::Session) -> bool {
        self.report.is_some() && self.for_key.as_ref() == Some(&self.key(s))
    }

    fn key(&self, s: &bm::Session) -> JointKey {
        let selection = s.selection();
        let geometry = selection.len() == 1 && self.check_geometry;
        JointKey {
            generation: s.generation(),
            version: s.version(),
            structure: s.structure_version(),
            hidden: s.snapshot().hidden,
            all: self.show || self.open.is_some() || selection.len() == 1,
            selection,
            geometry,
        }
    }

    pub fn reset(&mut self) {
        let show = self.show;
        *self = JointsView { show, ..JointsView::default() };
    }

    fn row(&self) -> Option<JointRow> {
        let k = self.open?;
        self.report.as_ref()?.iter().find(|j| same(j, k)).copied()
    }
}

fn same(j: &JointRow, k: (u32, u32)) -> bool {
    (j.a, j.b) == k || (j.b, j.a) == k
}

/// Opens a joint: (fixed, moving).
pub fn open(app: &mut BrickMotionApp, joint: (u32, u32)) {
    app.joints.open = Some(joint);
    app.joints.error = None;
    app.panels.unfold(PanelKind::Joint);
}

pub fn close(app: &mut BrickMotionApp) {
    app.joints.open = None;
    app.joints.error = None;
    app.joints.dismissed = Some(app.doc.session().selection());
}

pub fn is_open(app: &BrickMotionApp) -> bool {
    app.joints.open.is_some() && app.joints.row().is_some()
}

/// Keeps the report current and takes the workers' results; once a frame.
pub fn sync(app: &mut BrickMotionApp, ctx: &egui::Context) {
    let s = app.doc.session();
    let selection = s.selection();
    let j = &mut app.joints;
    if !j.show && j.open.is_none() && !j.change_job.busy() {
        j.inspect.cancel();
        j.started = None;
        j.report = None;
        j.for_key = None;
        j.dismissed = None;
        return;
    }
    let key = j.key(s);
    match j.inspect.poll(&key) {
        Some(Ok(r)) => {
            j.report = Some(r.joints);
            j.for_key = Some(key.clone());
            j.started = None;
            reconcile(app, &selection);
        }
        Some(Err(Stale)) => app.joints.started = None,
        None => {}
    }
    let j = &mut app.joints;
    if j.for_key.as_ref() != Some(&key)
        && j.started.as_ref() != Some(&key)
        && !j.inspect.busy()
        && let Some(mut inspection) = Inspection::capture(app.doc.session())
    {
        let (sel, all, geometry) = (key.selection.clone(), key.all, key.geometry);
        if j.inspect.start(key.clone(), move || inspection.joints(&sel, all, geometry)) {
            j.started = Some(key.clone());
        }
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

/// The open joint follows the new report; a single picked part opens its joint.
fn reconcile(app: &mut BrickMotionApp, selection: &[u32]) {
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
    // Only while markers show: otherwise picking a part would swap the Inspector for the Joint panel.
    if j.open.is_none()
        && j.show
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
    let Some(k) = app.joints.open else { return };
    if app.joints.changing || app.joints.change_job.busy() {
        return;
    }
    let s = app.doc.session();
    let doc = (s.generation(), s.version());
    let Some(mut inspection) = Inspection::capture(s) else { return };
    let collision = app.edit.collision;
    app.joints.error = None;
    if app.joints.change_job.start(doc, move || (inspection.change_joint(k.0, k.1, degrees, collision), k)) {
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

/// A click on a marker opens its joint; true while the press is the markers'.
pub fn handle_pointer(ui: &Ui, app: &mut BrickMotionApp) -> bool {
    let (pressed, down, pos) = ui.input(|i| (i.pointer.primary_pressed(), i.pointer.primary_down(), i.pointer.latest_pos()));
    if app.joints.marker_press {
        if !down {
            app.joints.marker_press = false;
        }
        return true;
    }
    let (Some(rect), Some(p)) = (app.viewport.last_rect, pos) else { return false };
    if !pressed || !app.joints.show || !rect.contains(p) || ui.ctx().layer_id_at(p) != Some(ui.layer_id()) {
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

/// The part's description; a part inside a submodel goes by the submodel's name (bm names
/// only a step's own items).
fn part_name(s: &bm::Session, piece: u32) -> String {
    let tidy = |d: &str| d.split_whitespace().collect::<Vec<_>>().join(" ");
    let items: Vec<bm::steps::ItemRow> = (0..s.steps().len()).flat_map(|st| s.step_items(st)).filter(|i| i.pieces.contains(&piece)).collect();
    if let Some(i) = items.iter().find(|i| !i.submodel) {
        return tidy(&i.description);
    }
    items.first().map_or_else(|| format!("Part {}", piece + 1), |i| tidy(i.name.trim_end_matches(".ldr").trim_end_matches(".dat")))
}

/// "A ↔ B", or one name when both parts go by the same one.
fn pair_name(s: &bm::Session, a: u32, b: u32) -> String {
    let (a, b) = (part_name(s, a), part_name(s, b));
    if a == b { a } else { format!("{a} ↔ {b}") }
}

fn degrees(v: f64) -> String {
    let n = v.round() as i64;
    if n < 0 { format!("−{}°", -n) } else { format!("{n}°") }
}

/// Markers, the open joint's axis, pivot and ring, and its card; after the viewport.
pub fn show(ui: &mut Ui, app: &mut BrickMotionApp) {
    app.joints.markers.clear();
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
    if app.joints.show
        && let Some(rows) = &app.joints.report
    {
        for j in rows.iter().filter(|j| j.kind != JointType::Fixed) {
            let Some(p) = project(j.point).filter(|p| rect.contains(*p)) else { continue };
            painter.circle(p, 4.0, t.accent, Stroke::new(1.0, Color32::WHITE));
            app.joints.markers.push(((j.a, j.b), p));
        }
    }
    let Some(row) = app.joints.row() else { return };
    let Some(pivot) = project(row.point) else { return };

    // Axis, ring and pivot.
    let len = (row.axis.x * row.axis.x + row.axis.y * row.axis.y + row.axis.z * row.axis.z).sqrt();
    if len > 1e-9 {
        let a = bm::Vec3::new(row.axis.x / len, row.axis.y / len, row.axis.z / len);
        let at = |k: f64| bm::Vec3::new(row.point.x + a.x * k, row.point.y + a.y * k, row.point.z + a.z * k);
        if let (Some(p0), Some(p1)) = (project(at(-60.0)), project(at(60.0))) {
            painter.extend(Shape::dashed_line(&[p0, p1], Stroke::new(1.5, t.accent), 6.0, 4.0));
        }
        if row.kind.turns() {
            // Two directions across the axis span the ring's plane.
            let helper = if a.y.abs() < 0.9 { bm::Vec3::new(0.0, 1.0, 0.0) } else { bm::Vec3::new(1.0, 0.0, 0.0) };
            let u = cross(a, helper);
            let v = cross(a, u);
            let r = 28.0;
            let ring: Vec<Pos2> = (0..=48)
                .filter_map(|i| {
                    let th = f64::from(i) / 48.0 * std::f64::consts::TAU;
                    let (c, s) = (th.cos() * r, th.sin() * r);
                    project(bm::Vec3::new(row.point.x + u.x * c + v.x * s, row.point.y + u.y * c + v.y * s, row.point.z + u.z * c + v.z * s))
                })
                .collect();
            let ring_color = Color32::from_rgba_unmultiplied(t.accent.r(), t.accent.g(), t.accent.b(), 160);
            painter.add(Shape::line(ring, Stroke::new(1.5, ring_color)));
        }
    }
    painter.circle(pivot, 4.5, t.accent, Stroke::new(1.0, Color32::WHITE));
    card(ui, app, &t, rect, pivot, row);
}

fn cross(a: bm::Vec3, b: bm::Vec3) -> bm::Vec3 {
    let c = bm::Vec3::new(a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x);
    let l = (c.x * c.x + c.y * c.y + c.z * c.z).sqrt().max(1e-9);
    bm::Vec3::new(c.x / l, c.y / l, c.z / l)
}

/// The small card beside the pivot.
fn card(ui: &mut Ui, app: &mut BrickMotionApp, t: &Theme, rect: Rect, pivot: Pos2, row: JointRow) {
    const W: f32 = 236.0;
    let names = pair_name(app.doc.session(), row.a, row.b);
    let x = (pivot.x + 14.0).min(rect.right() - W - 8.0).max(rect.left() + 8.0);
    let y = (pivot.y - 60.0).clamp(rect.top() + 8.0, (rect.bottom() - 150.0).max(rect.top() + 8.0));
    let mut act: Option<f64> = None;
    let (mut body, mut shut) = (false, false);
    let changing = app.joints.changing;
    let error = app.joints.error.clone();
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
                    crate::icons::paint(ui, Icon::Rotate, ir, 14.0, t.text2);
                    ui.label(egui::RichText::new(row.kind.title()).strong().size(12.5).color(t.text1));
                    ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                        if super::icon_button(ui, t, Icon::Close, "Close joint", true, false, 18.0).clicked() {
                            shut = true;
                        }
                    });
                });
                ui.add(egui::Label::new(egui::RichText::new(&names).size(11.0).color(t.text3)).truncate());
                ui.label(egui::RichText::new(description(row.kind)).size(11.0).color(t.text3));
                if row.kind.turns() {
                    ui.add_space(8.0);
                    ui.horizontal(|ui| {
                        let step = |ui: &mut Ui, text: &str, label: &str| {
                            let (r, resp) = ui.allocate_exact_size(vec2(44.0, 26.0), if changing { Sense::hover() } else { Sense::click() });
                            resp.widget_info(|| WidgetInfo::labeled(egui::Role::Button, !changing, label));
                            let fill = if resp.hovered() && !changing { Color32::from_white_alpha(24) } else { Color32::from_white_alpha(14) };
                            ui.painter().rect_filled(r, 6.0, fill);
                            ui.painter().text(r.center(), Align2::CENTER_CENTER, text, FontId::proportional(11.5), if changing { t.text3 } else { t.text1 });
                            resp.clicked() && !changing
                        };
                        if step(ui, "−15°", "Rotate left 15 degrees") {
                            act = Some(-15.0);
                        }
                        let (r, resp) = ui.allocate_exact_size(vec2(ui.available_width() - 50.0, 26.0), Sense::hover());
                        resp.widget_info(|| WidgetInfo::labeled(egui::Role::Label, true, format!("Joint angle {}", degrees(row.angle))));
                        ui.painter().text(r.center(), Align2::CENTER_CENTER, degrees(row.angle), FontId::proportional(20.0), t.text1);
                        if step(ui, "+15°", "Rotate right 15 degrees") {
                            act = Some(15.0);
                        }
                    });
                }
                if let Some(e) = &error {
                    ui.add_space(6.0);
                    ui.label(egui::RichText::new(e).size(11.0).color(t.text2));
                }
                ui.add_space(8.0);
                hairline(ui);
                ui.add_space(8.0);
                ui.horizontal(|ui| {
                    if secondary_button(ui, t, "Select Rigid Body", true).clicked() {
                        body = true;
                    }
                    ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                        if secondary_button(ui, t, "Detach", !changing).clicked() {
                            act = Some(0.0);
                        }
                    });
                });
            });
        });
    if let Some(d) = act {
        change(app, d);
    }
    if body {
        select_body(app);
    }
    if shut {
        close(app);
    }
}

/// The Joint panel at the top right while a joint is open.
pub fn panel(ui: &mut Ui, app: &mut BrickMotionApp, area: Rect, next_top: &mut f32) {
    let Some(row) = app.joints.row() else { return };
    let s = app.doc.session();
    let subtitle = pair_name(s, row.a, row.b);
    let out = float_panel::show(ui, app, area, next_top, PanelKind::Joint, Head { icon: Icon::Rotate, title: "", subtitle: &subtitle }, |ui, app| {
        let t = app.theme;
        group_heading(ui, &t, "Joint", "");
        inset_group(ui, |ui| {
            let rows = [
                ("Type", row.kind.title().to_owned()),
                ("Angle", degrees(row.angle)),
                ("Mates", row.mate_count.to_string()),
                ("Clearance", format!("{:.2} mm", row.clearance * 0.4)),
            ];
            for (i, (label, value)) in rows.iter().enumerate() {
                if i > 0 {
                    hairline(ui);
                }
                let (r, _) = ui.allocate_exact_size(vec2(ui.available_width(), 34.0), Sense::hover());
                ui.painter().text(pos2(r.left() + 12.0, r.center().y), Align2::LEFT_CENTER, *label, FontId::proportional(12.5), t.text1);
                ui.painter().text(pos2(r.right() - 12.0, r.center().y), Align2::RIGHT_CENTER, value, FontId::proportional(12.0), t.text2);
            }
        });
        group_heading(ui, &t, "Show", "");
        inset_group(ui, |ui| {
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
    });
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
