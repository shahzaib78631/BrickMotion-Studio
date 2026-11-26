//! The Build Motion panel (m5-rulings.md; `MotionWorkspace.MotionEditor`): flight timing for the
//! project, one step or chosen parts. A value this scope does not set reads "Inherit · value" in
//! grey with a grey slider fill; touching it sets it, and its reset puts it back to inherited.
//! Every change saves on release as one `set_motion_fields` call (one undo step).
use bm::motion::{MotionFields, MotionScope, effective_motion, flight_phases};
use egui::{Color32, CornerRadius, Rect, Sense, Ui, WidgetInfo, pos2, vec2};

use super::float_panel::{self, Head, PanelKind, group_heading};
use super::widgets::{SliderEvent, SliderLook, hairline, inset_group, parse_number, popup_row, segmented, slider_row_with};
use crate::BrickMotionApp;
use crate::icons::Icon;
use crate::theme::Theme;

/// What the panel edits.
#[derive(Clone, Debug, PartialEq)]
pub struct MotionTarget {
    pub scope: MotionScope,
    /// The step a Step scope edits (and the parts' step).
    pub step: usize,
    /// The parts a Parts scope edits.
    pub pieces: Vec<u32>,
}

#[derive(Default)]
pub struct MotionPanel {
    /// Open while Some.
    pub target: Option<MotionTarget>,
    /// `set_motion_fields` calls made (tests read it).
    pub commits: usize,
}

/// A slider row: label, own value, inherited value, range and format.
type Row = (&'static str, f64, f64, std::ops::RangeInclusive<f64>, fn(f64) -> String);

pub const PRESETS: [(&str, MotionFields); 3] = [
    ("Balanced", MotionFields { time: 1.0, landing: 0.25, hover: 0.08, ease: 0 }),
    ("Precise Seating", MotionFields { time: 1.4, landing: 0.45, hover: 0.12, ease: 2 }),
    ("Fast Assembly", MotionFields { time: 0.7, landing: 0.2, hover: 0.0, ease: 1 }),
];

/// Opens the panel on a scope.
pub fn open(app: &mut BrickMotionApp, target: MotionTarget) {
    app.motion.target = Some(target);
    app.panels.unfold(PanelKind::Motion);
}

/// The Motion ribbon command: the selected parts, or else the project.
pub fn open_for_selection(app: &mut BrickMotionApp) {
    let pieces = app.doc.session().selection();
    let step = app.edit.step.unwrap_or(0);
    let scope = if pieces.is_empty() { MotionScope::Project } else { MotionScope::Parts };
    open(app, MotionTarget { scope, step, pieces });
}

pub fn is_open(app: &BrickMotionApp) -> bool {
    app.motion.target.is_some()
}

/// "1.5×", as `MotionEditor.multiplier` shows it (up to two decimals).
pub fn multiplier(v: f64) -> String {
    let s = format!("{:.2}", (v * 100.0).round() / 100.0);
    let s = s.trim_end_matches('0').trim_end_matches('.');
    format!("{s}×")
}

/// "40%", as `MotionEditor.percent` shows it.
pub fn percent(v: f64) -> String {
    format!("{}%", (v * 100.0).round() as i64)
}

fn scope_name(t: &MotionTarget) -> String {
    match t.scope {
        MotionScope::Project => "Project".into(),
        MotionScope::Step => format!("Step {}", t.step + 1),
        MotionScope::Parts if t.pieces.len() == 1 => "1 part".into(),
        MotionScope::Parts => format!("{} parts", t.pieces.len()),
    }
}

/// "Step 12 sets 1 value. The rest come from the project."
fn scope_note(t: &MotionTarget, own: MotionFields) -> String {
    let n = [own.time >= 0.0, own.landing >= 0.0, own.hover >= 0.0, own.ease >= 0].iter().filter(|b| **b).count();
    let who = match t.scope {
        MotionScope::Project => "The project".to_owned(),
        MotionScope::Step => format!("Step {}", t.step + 1),
        MotionScope::Parts if t.pieces.len() == 1 => "This part".into(),
        MotionScope::Parts => "These parts".into(),
    };
    let sets = match n {
        0 => "sets no values".to_owned(),
        1 => "sets 1 value".into(),
        n => format!("sets {n} values"),
    };
    let rest = match (t.scope, n) {
        (_, 4) => String::new(),
        (MotionScope::Project, _) => " The rest are defaults.".into(),
        (MotionScope::Step, _) => " The rest come from the project.".into(),
        (MotionScope::Parts, _) => " The rest come from the step.".into(),
    };
    format!("{who} {sets}.{rest}")
}

fn commit(app: &mut BrickMotionApp, t: &MotionTarget, fields: MotionFields) {
    let c = app.doc.session().set_motion_fields(t.scope, t.step, &t.pieces, fields);
    app.motion.commits += 1;
    app.edited(c);
}

pub fn show(ui: &mut Ui, app: &mut BrickMotionApp, area: Rect, next_top: &mut f32) {
    let Some(target) = app.motion.target.clone() else { return };
    let subtitle = scope_name(&target);
    let out = float_panel::show(
        ui,
        app,
        area,
        next_top,
        PanelKind::Motion,
        Head { icon: Icon::Fly, title: "", subtitle: &subtitle },
        |ui, app| body(ui, app, &target),
    );
    if out.close {
        app.motion.target = None;
    }
}

fn body(ui: &mut Ui, app: &mut BrickMotionApp, target: &MotionTarget) {
    let t = app.theme;
    let session = app.doc.session();
    let own = session.motion_fields(target.scope, target.step, &target.pieces);
    let inherited = effective_motion(session, target.scope, target.step, MotionFields::default());

    // Edit for: Project | This Step | Selected Parts.
    ui.add_space(10.0);
    egui::Frame::NONE.inner_margin(egui::Margin::symmetric(12, 0)).show(ui, |ui| {
        ui.label(egui::RichText::new("Edit for").size(11.5).color(t.text3));
        ui.add_space(4.0);
        let scopes = [MotionScope::Project, MotionScope::Step, MotionScope::Parts];
        let mut at = scopes.iter().position(|s| *s == target.scope).unwrap_or(0);
        if segmented(ui, &t, "motion_scope", &["Project", "This Step", "Selected Parts"], &mut at, true) {
            let mut next = target.clone();
            next.scope = scopes[at];
            if next.scope == MotionScope::Parts && next.pieces.is_empty() {
                next.pieces = app.doc.session().selection();
            }
            // Parts with nothing chosen stay where they are.
            if next.scope != MotionScope::Parts || !next.pieces.is_empty() {
                app.motion.target = Some(next);
            }
        }
    });
    super::widgets::footnote(ui, &t, &scope_note(target, own));

    // The fields as dragged this frame, for the timing bar.
    let mut draft = own;
    group_heading(ui, &t, "Flight", "");
    inset_group(ui, |ui| {
        let rows: [Row; 3] = [
            ("Duration", own.time, inherited.time, 0.25..=4.0, multiplier),
            ("Landing", own.landing, inherited.landing, 0.1..=0.7, percent),
            ("Hover", own.hover, inherited.hover, 0.0..=0.4, percent),
        ];
        for (i, (label, value, from, range, format)) in rows.into_iter().enumerate() {
            let set = value >= 0.0;
            let mut v = if set { value } else { from };
            let look = SliderLook { inherited: !set, reset: set.then(|| format!("Reset {}", label.to_lowercase())) };
            let shown = move |x: f64| if set { format(x) } else { format!("Inherit · {}", format(x)) };
            let percent_row = i > 0;
            let parse = move |s: &str| {
                let n = parse_number(s.trim_start_matches("Inherit · "))?;
                Some(if percent_row { n / 100.0 } else { n })
            };
            let (ev, reset) = slider_row_with(ui, &t, ("motion", label), label, &mut v, range, 0.01, shown, parse, true, &look);
            let with = |f: MotionFields, x: f64| match i {
                0 => MotionFields { time: x, ..f },
                1 => MotionFields { landing: x, ..f },
                _ => MotionFields { hover: x, ..f },
            };
            match ev {
                SliderEvent::Changing => draft = with(draft, v),
                SliderEvent::Committed(x) => commit(app, target, with(own, x)),
                SliderEvent::None => {}
            }
            if reset {
                commit(app, target, with(own, -1.0));
            }
            hairline(ui);
        }
        let names: Vec<String> = std::iter::once(format!("Inherit · {}", MotionFields::ease_name(inherited.ease)))
            .chain((0..4).map(|e| MotionFields::ease_name(e).to_owned()))
            .collect();
        let options: Vec<&str> = names.iter().map(String::as_str).collect();
        let mut at = (own.ease.clamp(-1, 3) + 1) as usize;
        let current = options[at].to_owned();
        if popup_row(ui, &t, "motion_ease", "Easing", &current, &options, &mut at, true) {
            commit(app, target, MotionFields { ease: at as i32 - 1, ..own });
        }
    });

    let effective = effective_motion(app.doc.session(), target.scope, target.step, draft);
    timing_bar(ui, &t, effective);

    group_heading(ui, &t, "Presets", "");
    egui::Frame::NONE.inner_margin(egui::Margin::symmetric(12, 0)).show(ui, |ui| {
        let w = (ui.available_width() - 12.0) / 3.0;
        ui.horizontal(|ui| {
            ui.spacing_mut().item_spacing.x = 6.0;
            for (name, fields) in PRESETS {
                let on = own == fields;
                let (r, resp) = ui.allocate_exact_size(vec2(w, 40.0), Sense::click());
                resp.widget_info(|| WidgetInfo::selected(egui::Role::Button, true, on, name));
                let fill = if on { t.accent_bg() } else if resp.hovered() { Color32::from_white_alpha(18) } else { Color32::from_white_alpha(11) };
                ui.painter().rect_filled(r, CornerRadius::same(8), fill);
                let stroke = if on { egui::Stroke::new(1.0, t.accent) } else { egui::Stroke::new(0.5, Color32::from_white_alpha(15)) };
                ui.painter().rect_stroke(r, CornerRadius::same(8), stroke, egui::StrokeKind::Inside);
                ui.painter().text(r.center(), egui::Align2::CENTER_CENTER, name, egui::FontId::proportional(11.5), if on { t.text1 } else { t.text2 });
                if resp.on_hover_cursor(egui::CursorIcon::PointingHand).clicked() {
                    commit(app, target, fields);
                }
            }
        });
    });

    float_panel::footer(ui, &t, "Saves live · one undo per release", "Reset All", || {
        commit(app, target, MotionFields::default());
    });
}

/// The flight's three phases as one capsule: Travel, Hover, Landing (`MotionWorkspace.FlightTiming`).
fn timing_bar(ui: &mut Ui, t: &Theme, effective: MotionFields) {
    let p = flight_phases(effective);
    let label = format!("Travel {}, hover {}, landing {}", percent(p.travel), percent(p.hover), percent(p.landing));
    egui::Frame::NONE.inner_margin(egui::Margin { left: 16, right: 16, top: 12, bottom: 2 }).show(ui, |ui| {
        let (rect, resp) = ui.allocate_exact_size(vec2(ui.available_width(), 9.0), Sense::hover());
        resp.widget_info(|| {
            let mut info = WidgetInfo::labeled(egui::Role::Group, true, "Flight timing");
            info.current_text_value = Some(label.clone());
            info
        });
        let travel = Color32::from_rgba_unmultiplied(t.accent.r(), t.accent.g(), t.accent.b(), 150);
        let hover = Color32::from_white_alpha(60);
        let mut x = rect.left();
        let painter = ui.painter_at(rect);
        painter.rect_filled(rect, 4.5, Color32::from_white_alpha(18));
        let w = rect.width();
        let parts = [(p.travel, travel), (p.hover, hover), (p.landing, t.accent)];
        for (i, (share, color)) in parts.iter().enumerate() {
            let seg_w = (*share as f32).max(0.0) * w;
            if seg_w <= 0.0 {
                continue;
            }
            let r = Rect::from_min_size(pos2(x, rect.top()), vec2(seg_w, rect.height()));
            let round = CornerRadius {
                nw: if i == 0 || x <= rect.left() + 0.5 { 4 } else { 0 },
                sw: if i == 0 || x <= rect.left() + 0.5 { 4 } else { 0 },
                ne: if x + seg_w >= rect.right() - 0.5 { 4 } else { 0 },
                se: if x + seg_w >= rect.right() - 0.5 { 4 } else { 0 },
            };
            painter.rect_filled(r, round, *color);
            x += seg_w;
        }
        ui.add_space(7.0);
        ui.horizontal(|ui| {
            ui.spacing_mut().item_spacing.x = 14.0;
            for (name, share, color) in [("Travel", p.travel, travel), ("Hover", p.hover, hover), ("Landing", p.landing, t.accent)] {
                ui.horizontal(|ui| {
                    ui.spacing_mut().item_spacing.x = 4.0;
                    let (dot, _) = ui.allocate_exact_size(vec2(5.0, 12.0), Sense::hover());
                    ui.painter().circle_filled(dot.center(), 2.5, color);
                    ui.label(egui::RichText::new(name).size(11.0).color(t.text3));
                    ui.label(egui::RichText::new(percent(share)).size(11.0).color(t.text2));
                });
            }
        });
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats() {
        assert_eq!(multiplier(1.0), "1×");
        assert_eq!(multiplier(1.5), "1.5×");
        assert_eq!(multiplier(1.25), "1.25×");
        assert_eq!(percent(0.4), "40%");
        assert_eq!(percent(0.125), "13%");
    }

    #[test]
    fn notes() {
        let step = MotionTarget { scope: MotionScope::Step, step: 11, pieces: vec![] };
        let one = MotionFields { time: 1.5, ..MotionFields::default() };
        assert_eq!(scope_note(&step, one), "Step 12 sets 1 value. The rest come from the project.");
        let project = MotionTarget { scope: MotionScope::Project, step: 0, pieces: vec![] };
        assert_eq!(scope_note(&project, MotionFields::default()), "The project sets no values. The rest are defaults.");
    }
}
