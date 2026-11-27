//! Properties › Transform: the selection's exact position, rotation and scale as scrub fields.
//! Drag a number sideways to change it (1 stud, or 1 plate for Y; ⌥ fine, ⇧ coarse) or click it to
//! type. With several pieces, a field that differs shows "—", and an edit moves every piece by the
//! same amount, measured on the first.
use egui::{CornerRadius, CursorIcon, Id, Rect, RichText, Sense, Stroke, StrokeKind, Ui, pos2, vec2};

use crate::BrickMotionApp;
use crate::theme::Theme;

/// One number in the section.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Field {
    /// X, Y or Z in studs (Y in plates, up positive).
    Position(usize),
    /// X, Y or Z angle in degrees (rotation = Ry · Rx · Rz).
    Rotation(usize),
    /// Stretch along the piece's own X, Y or Z.
    Scale(usize),
}

/// What the fields show: `None` where the selected pieces differ.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Readout {
    pub position: [Option<f64>; 3],
    pub rotation: [Option<f64>; 3],
    /// Present when any selected piece is scaled.
    pub scale: Option<[Option<f64>; 3]>,
}

/// The axis and pivot an open scrub turns or stretches about. The engine only joins a gesture
/// whose axis and pivot are unchanged, so they are fixed when the drag starts.
#[derive(Clone, Copy, Debug)]
pub struct Gesture {
    field: Field,
    axis: bm::Vec3,
    axes: bm::Mat3,
    pivot: bm::Vec3,
}

const EPS: f64 = 1e-6;

/// One piece's pose split into display values.
#[derive(Clone, Copy, Debug)]
struct Split {
    position: [f64; 3],
    euler: [f64; 3],
    scale: [f64; 3],
    /// The rotation without scale.
    rotation: bm::Mat3,
}

fn col(m: &bm::Mat3, c: usize) -> [f64; 3] {
    [m.m[c], m.m[3 + c], m.m[6 + c]]
}

fn det(r: &bm::Mat3) -> f64 {
    let m = &r.m;
    m[0] * (m[4] * m[8] - m[5] * m[7]) - m[1] * (m[3] * m[8] - m[5] * m[6]) + m[2] * (m[3] * m[7] - m[4] * m[6])
}

fn split(p: bm::Pose) -> Split {
    let mut scale = [1.0; 3];
    let mut r = p.rotation;
    for (c, s) in scale.iter_mut().enumerate() {
        let v = col(&p.rotation, c);
        let n = (v[0] * v[0] + v[1] * v[1] + v[2] * v[2]).sqrt();
        *s = n;
        if n > EPS {
            for row in 0..3 {
                r.m[row * 3 + c] /= n;
            }
        }
    }
    // A mirrored piece (det < 0): keep the reflection out of the angles by flipping X back.
    if det(&r) < 0.0 {
        for row in 0..3 {
            r.m[row * 3] = -r.m[row * 3];
        }
    }
    Split {
        position: [p.position.x / bm::STUD, -p.position.y / bm::PLATE, p.position.z / bm::STUD],
        euler: euler(&r),
        scale,
        rotation: r,
    }
}

/// X, Y, Z degrees for R = Ry(y) · Rx(x) · Rz(z): Y (up in LDraw) is outermost, so turning a
/// piece about the vertical never meets the gimbal lock; it sits at X = ±90° instead.
fn euler(r: &bm::Mat3) -> [f64; 3] {
    let m = &r.m;
    let x = (-m[5]).clamp(-1.0, 1.0).asin();
    let (y, z) = if m[5].abs() < 1.0 - 1e-9 { (m[2].atan2(m[8]), m[3].atan2(m[4])) } else { ((-m[6]).atan2(m[0]), 0.0) };
    let tidy = |a: f64| {
        let d = a.to_degrees();
        let d = if (d.round() - d).abs() < 1e-7 { d.round() } else { d };
        if d == -0.0 { 0.0 } else { d }
    };
    [tidy(x), tidy(y), tidy(z)]
}

fn rot(axis: usize, deg: f64) -> bm::Mat3 {
    let (s, c) = deg.to_radians().sin_cos();
    bm::Mat3 {
        m: match axis {
            0 => [1.0, 0.0, 0.0, 0.0, c, -s, 0.0, s, c],
            1 => [c, 0.0, s, 0.0, 1.0, 0.0, -s, 0.0, c],
            _ => [c, -s, 0.0, s, c, 0.0, 0.0, 0.0, 1.0],
        },
    }
}

fn mul_v(m: &bm::Mat3, v: [f64; 3]) -> bm::Vec3 {
    let r = |i: usize| m.m[i * 3] * v[0] + m.m[i * 3 + 1] * v[1] + m.m[i * 3 + 2] * v[2];
    bm::Vec3::new(r(0), r(1), r(2))
}

/// The world axis that changes only Euler angle `k` of `e`: Ry·eX, eY or Ry·Rx·eZ.
fn euler_axis(k: usize, e: [f64; 3]) -> bm::Vec3 {
    match k {
        0 => mul_v(&rot(1, e[1]), [1.0, 0.0, 0.0]),
        1 => bm::Vec3::new(0.0, 1.0, 0.0),
        _ => {
            let rx = mul_v(&rot(0, e[0]), [0.0, 0.0, 1.0]);
            mul_v(&rot(1, e[1]), [rx.x, rx.y, rx.z])
        }
    }
}

fn agree(values: impl Iterator<Item = f64>) -> Option<f64> {
    let mut first = None;
    for v in values {
        match first {
            None => first = Some(v),
            Some(f) if (f - v).abs() > 1e-6 => return None,
            _ => {}
        }
    }
    first
}

/// The fields for `pieces` in the open model.
pub fn readout(s: &bm::Session, pieces: &[u32]) -> Readout {
    let all: Vec<Split> = pieces.iter().map(|&p| split(s.pose_of(p))).collect();
    let pick = |f: &dyn Fn(&Split) -> f64| agree(all.iter().map(f));
    let scaled = all.iter().any(|p| p.scale.iter().any(|&k| (k - 1.0).abs() > 1e-6));
    Readout {
        position: [pick(&|p| p.position[0]), pick(&|p| p.position[1]), pick(&|p| p.position[2])],
        rotation: [pick(&|p| p.euler[0]), pick(&|p| p.euler[1]), pick(&|p| p.euler[2])],
        scale: scaled.then(|| [pick(&|p| p.scale[0]), pick(&|p| p.scale[1]), pick(&|p| p.scale[2])]),
    }
}

/// Where rotation and scale act: the piece's own origin, or the middle of several.
fn pivot(s: &bm::Session, pieces: &[u32]) -> bm::Vec3 {
    let n = pieces.len().max(1) as f64;
    pieces.iter().fold(bm::Vec3::ZERO, |acc, &p| acc + s.pose_of(p).position).scale(1.0 / n)
}

/// Adds `amount` (display units) to `field` for the selection; `continuing` joins the open drag.
pub fn nudge(app: &mut BrickMotionApp, field: Field, amount: f64, continuing: bool) {
    let sel = app.doc.session().selection();
    let Some(&first) = sel.first() else { return };
    if amount == 0.0 {
        return;
    }
    let s = app.doc.session();
    let reference = split(s.pose_of(first));
    let open = app.transform_gesture.filter(|g| continuing && g.field == field);
    let changed = match field {
        Field::Position(k) => {
            let mut d = [0.0; 3];
            d[k] = match k {
                1 => -amount * bm::PLATE,
                _ => amount * bm::STUD,
            };
            app.transform_gesture = continuing.then_some(Gesture { field, axis: bm::Vec3::ZERO, axes: bm::Mat3::IDENTITY, pivot: bm::Vec3::ZERO });
            s.translate(&sel, bm::Vec3::new(d[0], d[1], d[2]), continuing)
        }
        Field::Rotation(k) => {
            let g = open.unwrap_or(Gesture { field, axis: euler_axis(k, reference.euler), axes: bm::Mat3::IDENTITY, pivot: pivot(s, &sel) });
            app.transform_gesture = continuing.then_some(g);
            s.rotate(&sel, g.axis, amount, g.pivot, continuing)
        }
        Field::Scale(k) => {
            let now = reference.scale[k];
            let next = (now + amount).clamp(0.05, 20.0);
            if now <= EPS || (next - now).abs() < 1e-12 {
                return;
            }
            let g = open.unwrap_or(Gesture { field, axis: bm::Vec3::ZERO, axes: reference.rotation, pivot: pivot(s, &sel) });
            app.transform_gesture = continuing.then_some(g);
            let mut f = [1.0; 3];
            f[k] = next / now;
            s.scale(&sel, bm::Vec3::new(f[0], f[1], f[2]), g.axes, g.pivot, continuing)
        }
    };
    app.edited(changed);
}

/// Sets `field` to `value` on the first selected piece and moves the rest by the same amount.
pub fn set(app: &mut BrickMotionApp, field: Field, value: f64) {
    let sel = app.doc.session().selection();
    let Some(&first) = sel.first() else { return };
    let now = split(app.doc.session().pose_of(first));
    let current = match field {
        Field::Position(k) => now.position[k],
        Field::Rotation(k) => now.euler[k],
        Field::Scale(k) => now.scale[k],
    };
    app.transform_gesture = None;
    nudge(app, field, value - current, false);
}

/// True when some selected piece is turned or scaled.
pub fn can_reset(s: &bm::Session, pieces: &[u32]) -> bool {
    pieces.iter().any(|&p| {
        let k = split(s.pose_of(p));
        k.euler.iter().any(|a| a.abs() > 1e-6) || k.scale.iter().any(|v| (v - 1.0).abs() > 1e-6)
    })
}

/// Puts each selected piece back to no turn and no stretch, about its own origin, as one undo
/// step ("Reset Transform"). A mirrored piece stays mirrored.
pub fn reset(app: &mut BrickMotionApp) {
    app.transform_gesture = None;
    let s = app.doc.session();
    let moves: Vec<(u32, bm::Pose)> = s
        .selection()
        .into_iter()
        .filter(|&p| can_reset(s, &[p]))
        .map(|p| {
            let pose = s.pose_of(p);
            let mut rotation = bm::Mat3::default();
            if det(&pose.rotation) < 0.0 {
                rotation.m[0] = -1.0;
            }
            (p, bm::Pose { rotation, position: pose.position })
        })
        .collect();
    if moves.is_empty() {
        return;
    }
    let c = s.reset_poses(&moves, s.generation(), s.version());
    app.edited(c);
}

/// "4", "1.25", "−3": up to two places, a true minus sign.
fn number(v: f64) -> String {
    let r = (v * 100.0).round() / 100.0;
    let s = format!("{r:.2}");
    let s = s.trim_end_matches('0').trim_end_matches('.');
    let s = if s == "-0" { "0" } else { s };
    s.replacen('-', "−", 1)
}

fn shown(field: Field, v: Option<f64>) -> String {
    match v {
        None => "—".to_owned(),
        Some(v) => match field {
            Field::Position(_) => number(v),
            Field::Rotation(_) => format!("{}°", number(v)),
            Field::Scale(_) => format!("{}×", number(v)),
        },
    }
}

fn parse(text: &str) -> Option<f64> {
    let t: String = text.chars().filter(|c| !matches!(c, '°' | '×' | 'x' | ' ')).collect();
    t.replace('−', "-").replace(',', ".").parse::<f64>().ok().filter(|v| v.is_finite())
}

/// One drag step in display units: (normal, fine with ⌥, coarse with ⇧).
fn steps(field: Field) -> (f64, f64, f64) {
    match field {
        Field::Position(1) => (1.0, 0.125, 3.0),
        Field::Position(_) => (1.0, 0.05, 4.0),
        Field::Rotation(_) => (15.0, 1.0, 90.0),
        Field::Scale(_) => (0.05, 0.01, 0.25),
    }
}

/// Pixels of sideways drag per step.
const PX_PER_STEP: f32 = 8.0;

/// The field being typed into, if any: it owns the keyboard, Esc included (egui drops focus on
/// Esc before the shortcuts run, so the shortcut handler asks here).
fn typing_id() -> Id {
    Id::unique("transform-typing")
}

/// True while a Transform field is being typed into.
pub fn editing(ctx: &egui::Context) -> bool {
    ctx.data(|d| d.get_temp::<Id>(typing_id())).is_some()
}

#[derive(Clone, Default)]
struct ScrubState {
    editing: Option<String>,
    /// Set when typing starts, so the first frame selects the whole number.
    fresh: bool,
    carried: f32,
}

enum Scrub {
    Idle,
    Step(f64),
    Released,
    Typed(f64),
}

fn scrub(ui: &mut Ui, t: &Theme, id: Id, field: Field, axis: usize, value: Option<f64>, w: f32) -> Scrub {
    let names = ["X", "Y", "Z"];
    let label = match field {
        Field::Position(_) => format!("Position {}", names[axis]),
        Field::Rotation(_) => format!("Rotation {}", names[axis]),
        Field::Scale(_) => format!("Scale {}", names[axis]),
    };
    let text = shown(field, value);
    let mut state: ScrubState = ui.data(|d| d.get_temp(id)).unwrap_or_default();
    let mut out = Scrub::Idle;
    let (r, resp) = ui.allocate_exact_size(vec2(w, 22.0), Sense::click_and_drag());
    let p = ui.painter();
    let active = resp.dragged() || state.editing.is_some();
    let fill = if active || resp.hovered() { t.bg3 } else { t.bg2 };
    let ring = if active { t.accent } else { t.border };
    p.rect(r, CornerRadius::same(5), fill, Stroke::new(1.0, ring), StrokeKind::Inside);
    p.text(pos2(r.left() + 8.0, r.center().y), egui::Align2::LEFT_CENTER, names[axis], egui::FontId::proportional(10.5), t.axis[axis]);

    if let Some(edit) = state.editing.as_mut() {
        let inner = Rect::from_min_max(pos2(r.left() + 18.0, r.top() + 2.0), pos2(r.right() - 4.0, r.bottom() - 2.0));
        let te = egui::TextEdit::singleline(edit)
            .id(id.with("text"))
            .frame(egui::Frame::NONE)
            .font(egui::FontId::proportional(12.0))
            .align(egui::Align2::RIGHT_CENTER)
            .desired_width(inner.width());
        let te_resp = ui.put(inner, te);
        if state.fresh {
            state.fresh = false;
            te_resp.request_focus();
            if let Some(mut ts) = egui::TextEdit::load_state(ui.ctx(), te_resp.id) {
                let all = egui::text::CCursorRange::two(egui::text::CCursor::new(0), egui::text::CCursor::new(edit.chars().count()));
                ts.cursor.set_char_range(Some(all));
                ts.store(ui.ctx(), te_resp.id);
            }
        }
        let esc = ui.input(|i| i.key_pressed(egui::Key::Escape));
        if esc {
            state.editing = None;
        } else if te_resp.lost_focus() {
            if let Some(v) = parse(edit) {
                out = Scrub::Typed(v);
            }
            state.editing = None;
        }
    } else {
        let fg = if value.is_some() { t.text1 } else { t.text3 };
        ui.painter().text(pos2(r.right() - 8.0, r.center().y), egui::Align2::RIGHT_CENTER, &text, egui::FontId::proportional(12.0), fg);
        if resp.drag_started() {
            state.carried = 0.0;
        }
        if resp.dragged() {
            state.carried += resp.drag_delta().x;
            let n = (state.carried / PX_PER_STEP).trunc();
            if n != 0.0 {
                state.carried -= n * PX_PER_STEP;
                let (normal, fine, coarse) = steps(field);
                let m = ui.input(|i| i.modifiers);
                let step = if m.alt { fine } else if m.shift { coarse } else { normal };
                out = Scrub::Step(f64::from(n) * step);
            }
        }
        if resp.drag_stopped() {
            out = Scrub::Released;
        }
        if resp.clicked() {
            state.editing = Some(value.map(|v| number(v).replace('−', "-")).unwrap_or_default());
            state.fresh = true;
        }
    }
    ui.data_mut(|d| {
        let owner = d.get_temp::<Id>(typing_id());
        if state.editing.is_some() {
            d.insert_temp(typing_id(), id);
        } else if owner == Some(id) {
            d.remove::<Id>(typing_id());
        }
    });
    resp.widget_info(|| {
        let mut info = egui::WidgetInfo::labeled(egui::Role::SpinButton, true, &label);
        info.value = value;
        info.current_text_value = Some(text.clone());
        info
    });
    let _ = resp.on_hover_cursor(CursorIcon::ResizeHorizontal);
    ui.data_mut(|d| d.insert_temp(id, state));
    out
}

/// A labelled row of three scrub fields.
fn triple(ui: &mut Ui, app: &mut BrickMotionApp, t: &Theme, key: &str, make: fn(usize) -> Field, values: [Option<f64>; 3]) {
    let mut events = Vec::new();
    ui.horizontal(|ui| {
        ui.spacing_mut().item_spacing.x = 4.0;
        ui.add_sized([58.0, 22.0], egui::Label::new(RichText::new(key).color(t.text3)).halign(egui::Align::LEFT));
        let w = ((ui.available_width() - 8.0) / 3.0).floor().max(40.0);
        for (k, v) in values.into_iter().enumerate() {
            let field = make(k);
            let id = Id::unique(("transform-scrub", key, k));
            events.push((field, scrub(ui, t, id, field, k, v, w)));
        }
    });
    for (field, e) in events {
        match e {
            Scrub::Idle => {}
            Scrub::Step(a) => nudge(app, field, a, true),
            Scrub::Released => {
                app.doc.session().end_gesture();
                app.transform_gesture = None;
            }
            Scrub::Typed(v) => set(app, field, v),
        }
    }
}

/// The Transform section for the current selection.
pub fn section(ui: &mut Ui, app: &mut BrickMotionApp) {
    let t = app.theme;
    let sel = app.doc.session().selection();
    if sel.is_empty() {
        return;
    }
    let r = readout(app.doc.session(), &sel);
    let resettable = can_reset(app.doc.session(), &sel);
    egui::CollapsingHeader::new(RichText::new("Transform").strong())
        .id_salt(("properties", "Transform"))
        .default_open(true)
        .show(ui, |ui| {
            ui.spacing_mut().item_spacing.y = 6.0;
            triple(ui, app, &t, "Position", Field::Position, r.position);
            triple(ui, app, &t, "Rotation", Field::Rotation, r.rotation);
            if let Some(s) = r.scale {
                triple(ui, app, &t, "Scale", Field::Scale, s);
            }
            ui.horizontal(|ui| {
                ui.label(RichText::new("Position in studs · Y in plates").size(11.0).color(t.text3));
                ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                    let b = egui::Button::new(RichText::new("Reset").size(11.0).color(if resettable { t.text1 } else { t.text3 })).frame(false);
                    if ui.add_enabled(resettable, b).on_hover_text("Clear turns and stretches").clicked() {
                        reset(app);
                    }
                });
            });
        });
}
