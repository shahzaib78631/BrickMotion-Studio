//! The Camera panels (m5-rulings.md, `CameraKeyInspector.swift`, `Inspector.swift`):
//! - **Camera Key** floats while a key or move of a Camera track is selected: the key's view and
//!   lens, or the move to the next key with its style tiles.
//! - **Camera** holds the scene cameras, the export camera and the camera track's Auto-Direct.
//!
//! Sliders save live: the first frame of a drag opens an undo step and the rest grow it, so a whole
//! drag is one step.
use bm::camera::{CameraClock, CameraKey, CameraMove, SceneCamera};
use egui::{Align2, Color32, FontId, Frame, Margin, Rect, RichText, Sense, Stroke, Ui, WidgetInfo, pos2, vec2};

use super::camera_lane::{self, AIMS, CameraPick, STYLES};
use super::float_panel::{self, Head, PanelKind, group_heading, link};
use super::widgets::{self, SliderEvent, hairline, inset_group, parse_number, popup_row, segmented, slider_row, switch_row};
use crate::BrickMotionApp;
use crate::icons::Icon;
use crate::theme::Theme;

/// Easing curves: engine id, label (Swift's `CameraMovePanel.curves`).
pub const CURVES: [(&str, &str); 6] = [
    ("easeInOut", "Smooth"),
    ("easeIn", "Starts Slow"),
    ("easeOut", "Lands Soft"),
    ("linear", "Even Speed"),
    ("holdThenMove", "Hold, Then Move"),
    ("snap", "Snap"),
];
const ORBITS: [(&str, &str); 3] = [("shortest", "Shortest Way"), ("cw", "Clockwise"), ("ccw", "Counterclockwise")];
/// What a video records: label, export camera id.
const RECORDS: [(&str, &str); 3] = [("Viewport", "buildView"), ("Camera Track", "track"), ("Scene Camera", "automatic")];

/// The Camera panel's own state: the camera being renamed.
#[derive(Default)]
pub struct CameraPanelState {
    renaming: Option<(String, String)>,
    focus: bool,
}

impl CameraPanelState {
    pub fn reset(&mut self) {
        *self = Self::default();
    }
}

/// Draws the open Camera panels, stacking down the right of `area`.
pub fn show(ui: &mut Ui, app: &mut BrickMotionApp, area: Rect, next_top: &mut f32) {
    if let Some((clock, pick)) = app.camera_selection.clone() {
        let subtitle = subtitle(app, clock, &pick);
        let out = float_panel::show(ui, app, area, next_top, PanelKind::CameraKey, Head { icon: Icon::Cam, title: "", subtitle: &subtitle }, |ui, app| match &pick {
            CameraPick::Key(id) => key_body(ui, app, clock, id),
            CameraPick::Move(from) => move_body(ui, app, clock, from),
        });
        if out.close {
            app.doc.session().end_gesture();
            app.camera_selection = None;
        }
    }
    if app.panels.camera {
        let out = float_panel::show(ui, app, area, next_top, PanelKind::Camera, Head { icon: Icon::Vid, title: "", subtitle: "" }, camera_body);
        if out.close {
            app.panels.camera = false;
            app.panels.camera_focus = None;
        }
    }
}

/// Esc closes the Camera Key panel (its selection) when nothing else took the key.
pub fn escape(app: &mut BrickMotionApp, ctx: &egui::Context) {
    if app.camera_selection.is_some()
        && app.camera_panel.renaming.is_none()
        && !app.text_focus
        && !widgets::slider_active(ctx)
        && ctx.input_mut(|i| i.consume_key(egui::Modifiers::NONE, egui::Key::Escape))
    {
        app.doc.session().end_gesture();
        app.camera_selection = None;
    }
}

fn subtitle(app: &BrickMotionApp, clock: CameraClock, pick: &CameraPick) -> String {
    let keys = app.doc.session().camera_keys(clock);
    let at = |id: &str| keys.iter().position(|k| k.id == id);
    match pick {
        CameraPick::Key(id) => at(id).map_or_else(String::new, |i| seconds(keys[i].seconds)),
        CameraPick::Move(from) => match at(from) {
            Some(i) if i + 1 < keys.len() => format!("{} → {}", seconds(keys[i].seconds), seconds(keys[i + 1].seconds)),
            _ => String::new(),
        },
    }
}

fn seconds(s: f64) -> String {
    format!("{s:.2} s")
}

/// One frame of a live slider: when to send its value, and whether the drag goes on.
#[derive(Clone, Copy, Debug, PartialEq)]
struct Live {
    value: f64,
    /// Grows the drag's open undo step.
    continuing: bool,
    /// The gesture is over: close its undo step.
    end: bool,
}

#[allow(clippy::too_many_arguments)]
fn live(
    ui: &mut Ui,
    t: &Theme,
    id: &str,
    label: &str,
    value: f64,
    range: std::ops::RangeInclusive<f64>,
    step: f64,
    format: impl Fn(f64) -> String,
) -> Option<Live> {
    let sid = ui.make_persistent_id(("live", id));
    let started = ui.data(|d| d.get_temp::<bool>(sid).unwrap_or(false));
    let mut v = value;
    let ev = slider_row(ui, t, ("camera", id), label, &mut v, range, step, format, parse_number, true);
    let out = match ev {
        SliderEvent::Changing => Some(Live { value: v, continuing: started, end: false }),
        SliderEvent::Committed(v) => Some(Live { value: v, continuing: started, end: true }),
        // Esc while dragging puts the first value back.
        SliderEvent::None if started => Some(Live { value: v, continuing: true, end: true }),
        SliderEvent::None => None,
    };
    if let Some(l) = out {
        ui.data_mut(|d| d.insert_temp(sid, !l.end));
    }
    out
}

fn set_key(app: &mut BrickMotionApp, clock: CameraClock, key: &CameraKey, l: Live) {
    let c = app.doc.session().set_camera_key(clock, key, l.continuing);
    app.edited(c);
    if l.end {
        app.doc.session().end_gesture();
    }
}

fn set_move(app: &mut BrickMotionApp, clock: CameraClock, m: &CameraMove, l: Live) {
    let c = app.doc.session().set_camera_move(clock, m, l.continuing);
    app.edited(c);
    if l.end {
        app.doc.session().end_gesture();
    }
}

/// A change made in one go (a switch, a popup): its own undo step.
const ONCE: Live = Live { value: 0.0, continuing: false, end: false };

fn degrees(v: f64) -> String {
    format!("{}°", v.round() as i64)
}

fn percent(v: f64) -> String {
    format!("{}%", (v * 100.0).round() as i64)
}

fn read_row(ui: &mut Ui, t: &Theme, label: &str, value: &str) {
    let (rect, _) = ui.allocate_exact_size(vec2(ui.available_width(), 34.0), Sense::hover());
    let y = rect.center().y;
    ui.painter().text(pos2(rect.left() + 12.0, y), Align2::LEFT_CENTER, label, FontId::proportional(12.5), t.text1);
    ui.painter().text(pos2(rect.right() - 12.0, y), Align2::RIGHT_CENTER, value, FontId::monospace(12.0), t.text2);
}

fn key_body(ui: &mut Ui, app: &mut BrickMotionApp, clock: CameraClock, id: &str) {
    let t = app.theme;
    let keys = app.doc.session().camera_keys(clock);
    let Some(index) = keys.iter().position(|k| k.id == id) else { return };
    let key = keys[index].clone();

    group_heading(ui, &t, "Key", if key.user { "" } else { "Automatic" });
    inset_group(ui, |ui| {
        read_row(ui, &t, "Time", &seconds(key.seconds));
        hairline(ui);
        if let Some(l) = live(ui, &t, "lens", "Lens", key.lens_mm, 12.0..=300.0, 1.0, |v| format!("{v:.0} mm")) {
            set_key(app, clock, &CameraKey { lens_mm: l.value, ..key.clone() }, l);
        }
        hairline(ui);
        let mut aim = AIMS.iter().position(|(a, _)| *a == key.target).unwrap_or(0);
        let labels: Vec<&str> = AIMS.iter().map(|(_, l)| *l).collect();
        if popup_row(ui, &t, ("camera_aim", id), "Look At", AIMS[aim].1, &labels, &mut aim, true) {
            camera_lane::aim_key(app, clock, &key, AIMS[aim].0);
        }
        hairline(ui);
        if let Some(l) = live(ui, &t, "azimuth", "Angle Around", key.azimuth, -360.0..=360.0, 1.0, degrees) {
            set_key(app, clock, &CameraKey { azimuth: l.value, ..key.clone() }, l);
        }
        if let Some(l) = live(ui, &t, "elevation", "Height", key.elevation, -85.0..=89.0, 1.0, degrees) {
            set_key(app, clock, &CameraKey { elevation: l.value, ..key.clone() }, l);
        }
        if let Some(l) = live(ui, &t, "roll", "Dutch Roll", key.roll, -45.0..=45.0, 1.0, degrees) {
            set_key(app, clock, &CameraKey { roll: l.value, ..key.clone() }, l);
        }
        hairline(ui);
        match float_panel::links(ui, &t, &["Set Key from View", "Go to Key"]) {
            Some(0) => camera_lane::update_key_from_view(app, clock, id),
            Some(_) => camera_lane::seek(app, key.seconds),
            None => {}
        }
    });

    group_heading(ui, &t, "Framing", "");
    inset_group(ui, |ui| {
        let mut fitted = key.fitted;
        if switch_row(ui, &t, "Fit Distance to What It Frames", &mut fitted, true) {
            let mut k = CameraKey { fitted, ..key.clone() };
            if fitted {
                k.margin = 1.15;
            } else {
                k.distance = k.distance.max(0.5);
            }
            set_key(app, clock, &k, ONCE);
        }
        hairline(ui);
        if key.fitted {
            if let Some(l) = live(ui, &t, "margin", "Framing Margin", key.margin, 0.6..=3.0, 0.01, |v| format!("{v:.2}×")) {
                set_key(app, clock, &CameraKey { margin: l.value, ..key.clone() }, l);
            }
        } else if let Some(l) = live(ui, &t, "distance", "Distance", key.distance, 0.5..=500.0, 0.5, |v| format!("{v:.1} studs")) {
            set_key(app, clock, &CameraKey { distance: l.value, ..key.clone() }, l);
        }
    });

    group_heading(ui, &t, "Focus", "");
    inset_group(ui, |ui| {
        let mut on = key.focus_target;
        if switch_row(ui, &t, "Focus on What It Looks At", &mut on, true) {
            set_key(app, clock, &CameraKey { focus_target: on, ..key.clone() }, ONCE);
        }
        if !key.focus_target {
            hairline(ui);
            if let Some(l) = live(ui, &t, "focus", "Focus Depth", key.focus, 0.0..=1.0, 0.01, percent) {
                set_key(app, clock, &CameraKey { focus: l.value, ..key.clone() }, l);
            }
        }
        hairline(ui);
        if let Some(l) = live(ui, &t, "blur", "Background Blur", key.blur, 0.0..=1.0, 0.01, percent) {
            set_key(app, clock, &CameraKey { blur: l.value, ..key.clone() }, l);
        }
    });

    super::float_panel::footer(ui, &t, &format!("Key {} of {}", index + 1, keys.len()), "Remove Key", || {
        camera_lane::delete_key(app, clock, id);
    });
}

fn move_body(ui: &mut Ui, app: &mut BrickMotionApp, clock: CameraClock, from: &str) {
    let t = app.theme;
    let keys = app.doc.session().camera_keys(clock);
    let Some(m) = app.doc.session().camera_moves(clock).into_iter().find(|m| m.from == from) else { return };
    let at = |id: &str| keys.iter().find(|k| k.id == id).map_or(0.0, |k| k.seconds);
    let gap = (at(&m.to) - at(&m.from)).max(0.0);

    group_heading(ui, &t, "Move to next key", if m.user { "" } else { "Automatic" });
    tiles(ui, app, clock, &m);

    ui.add_space(6.0);
    inset_group(ui, |ui| {
        let mut cut = m.cut;
        if switch_row(ui, &t, "Hard Cut", &mut cut, true) {
            set_move(app, clock, &CameraMove { cut, ..m.clone() }, ONCE);
        }
        if m.cut {
            return;
        }
        hairline(ui);
        let mut flow = m.flow_through;
        if switch_row(ui, &t, "Flow Through Keys", &mut flow, true) {
            set_move(app, clock, &CameraMove { flow_through: flow, ..m.clone() }, ONCE);
        }
        if !m.flow_through {
            hairline(ui);
            let mut curve = CURVES.iter().position(|(c, _)| *c == m.curve).unwrap_or(0);
            let labels: Vec<&str> = CURVES.iter().map(|(_, l)| *l).collect();
            if popup_row(ui, &t, ("camera_curve", from), "Easing", CURVES[curve].1, &labels, &mut curve, true) {
                set_move(app, clock, &CameraMove { curve: CURVES[curve].0.into(), ..m.clone() }, ONCE);
            }
            if m.curve != "linear" {
                hairline(ui);
                if let Some(l) = live(ui, &t, "strength", "Easing Strength", m.strength, 0.0..=1.0, 0.05, percent) {
                    set_move(app, clock, &CameraMove { strength: l.value, ..m.clone() }, l);
                }
            }
            if gap > 0.05 {
                hairline(ui);
                let fmt = |v: f64| if v > 0.0 { format!("{v:.2} s") } else { "Off".into() };
                if let Some(l) = live(ui, &t, "turn_last", "Turn in the Last", m.turn_last.min(gap), 0.0..=gap, 0.05, fmt) {
                    set_move(app, clock, &CameraMove { turn_last: l.value, ..m.clone() }, l);
                }
            }
        }
        hairline(ui);
        let mut path = usize::from(m.straight);
        if popup_row(ui, &t, ("camera_path", from), "Path", ["Arc Around the Target", "Straight Line"][path], &["Arc Around the Target", "Straight Line"], &mut path, true) {
            set_move(app, clock, &CameraMove { straight: path == 1, ..m.clone() }, ONCE);
        }
        hairline(ui);
        let mut orbit = ORBITS.iter().position(|(o, _)| *o == m.orbit).unwrap_or(0);
        let labels: Vec<&str> = ORBITS.iter().map(|(_, l)| *l).collect();
        if popup_row(ui, &t, ("camera_orbit", from), "Orbit", ORBITS[orbit].1, &labels, &mut orbit, true) {
            set_move(app, clock, &CameraMove { orbit: ORBITS[orbit].0.into(), ..m.clone() }, ONCE);
        }
        if m.orbit != "shortest" {
            hairline(ui);
            if let Some(l) = live(ui, &t, "turns", "Extra Turns", f64::from(m.extra_turns), 0.0..=5.0, 1.0, |v| format!("{v:.0}")) {
                set_move(app, clock, &CameraMove { extra_turns: l.value.round() as i32, ..m.clone() }, l);
            }
        }
        hairline(ui);
        if let Some(l) = live(ui, &t, "overshoot", "Overshoot", m.overshoot, 0.0..=1.0, 0.01, percent) {
            set_move(app, clock, &CameraMove { overshoot: l.value, ..m.clone() }, l);
        }
        hairline(ui);
        if let Some(l) = live(ui, &t, "shake", "Handheld Shake", m.shake, 0.0..=3.0, 0.05, |v| format!("{v:.2}")) {
            set_move(app, clock, &CameraMove { shake: l.value, ..m.clone() }, l);
        }
        if m.shake > 0.0 {
            hairline(ui);
            if let Some(l) = live(ui, &t, "shake_hz", "Shake Speed", m.shake_frequency, 0.1..=4.0, 0.05, |v| format!("{v:.2} Hz")) {
                set_move(app, clock, &CameraMove { shake_frequency: l.value, ..m.clone() }, l);
            }
        }
        hairline(ui);
        if let Some(l) = live(ui, &t, "motion_blur", "Motion Blur", m.motion_blur, 0.0..=1.0, 0.01, percent) {
            set_move(app, clock, &CameraMove { motion_blur: l.value, ..m.clone() }, l);
        }
    });
    let hint = bm::camera::camera_presets().into_iter().find(|p| p.id == m.preset).map(|p| p.hint).unwrap_or_default();
    if !hint.is_empty() {
        widgets::footnote(ui, &t, &hint);
    }
}

/// The move styles as tiles, each with a small line drawing (m5-rulings.md).
fn tiles(ui: &mut Ui, app: &mut BrickMotionApp, clock: CameraClock, m: &CameraMove) {
    let t = app.theme;
    let presets = bm::camera::camera_presets();
    let mut chosen = None;
    Frame::NONE.inner_margin(Margin::symmetric(12, 0)).show(ui, |ui| {
        let cols = 3;
        let gap = 6.0;
        let w = (ui.available_width() - gap * (cols as f32 - 1.0)) / cols as f32;
        for row in presets.chunks(cols) {
            ui.horizontal(|ui| {
                ui.spacing_mut().item_spacing.x = gap;
                for p in row {
                    let (rect, resp) = ui.allocate_exact_size(vec2(w, 46.0), Sense::click());
                    let on = p.id == m.preset;
                    resp.widget_info(|| WidgetInfo::selected(egui::Role::RadioButton, true, on, &p.label));
                    let fill = if on { t.accent_bg() } else if resp.hovered() { Color32::from_white_alpha(14) } else { Color32::from_white_alpha(8) };
                    ui.painter().rect_filled(rect, 7.0, fill);
                    if on {
                        ui.painter().rect_stroke(rect, 7.0, Stroke::new(1.0, t.accent), egui::StrokeKind::Inside);
                    }
                    let fg = if on { t.accent } else { t.text2 };
                    glyph(ui, Rect::from_center_size(pos2(rect.center().x, rect.top() + 15.0), vec2(36.0, 14.0)), &p.id, fg);
                    let label = ui.painter().layout(p.label.clone(), FontId::proportional(10.5), if on { t.text1 } else { t.text2 }, w - 6.0);
                    let lp = pos2(rect.center().x - label.size().x / 2.0, rect.bottom() - 6.0 - label.size().y.min(13.0));
                    ui.painter().with_clip_rect(rect).galley(lp, label, t.text2);
                    if resp.on_hover_text(&p.hint).clicked() && !on {
                        chosen = Some(p.id.clone());
                    }
                }
            });
            ui.add_space(gap);
        }
    });
    if let Some(id) = chosen {
        camera_lane::choose_preset(app, clock, &m.from, &id);
    }
}

/// A line drawing of a move style, picked from words in its id.
fn glyph(ui: &Ui, r: Rect, id: &str, color: Color32) {
    let p = ui.painter();
    let s = Stroke::new(1.4, color);
    let (l, rt, top, bot, cy) = (r.left(), r.right(), r.top(), r.bottom(), r.center().y);
    let id = id.to_ascii_lowercase();
    if id.contains("cut") {
        p.line_segment([pos2(l, cy), pos2(rt, cy)], s);
        p.line_segment([pos2(r.center().x, top), pos2(r.center().x, bot)], s);
    } else if id.contains("orbit") || id.contains("arc") || id.contains("circle") || id.contains("turn") {
        let pts: Vec<_> = (0..=16).map(|i| {
            let a = std::f32::consts::PI * (1.0 + i as f32 / 16.0);
            pos2(r.center().x + a.cos() * r.width() / 2.0, bot + a.sin() * r.height())
        }).collect();
        p.add(egui::Shape::line(pts, s));
    } else if id.contains("push") || id.contains("dolly_in") || id.contains("in") && !id.contains("swing") {
        p.line_segment([pos2(l, cy), pos2(rt - 2.0, cy)], s);
        p.line_segment([pos2(rt - 8.0, top + 2.0), pos2(rt - 2.0, cy)], s);
        p.line_segment([pos2(rt - 8.0, bot - 2.0), pos2(rt - 2.0, cy)], s);
    } else if id.contains("pull") || id.contains("out") {
        p.line_segment([pos2(rt, cy), pos2(l + 2.0, cy)], s);
        p.line_segment([pos2(l + 8.0, top + 2.0), pos2(l + 2.0, cy)], s);
        p.line_segment([pos2(l + 8.0, bot - 2.0), pos2(l + 2.0, cy)], s);
    } else if id.contains("crane") || id.contains("rise") || id.contains("up") || id.contains("down") {
        p.line_segment([pos2(l, bot), pos2(r.center().x, top)], s);
        p.line_segment([pos2(r.center().x, top), pos2(rt, bot)], s);
    } else {
        let pts: Vec<_> = (0..=16).map(|i| {
            let f = i as f32 / 16.0;
            let e = f * f * (3.0 - 2.0 * f);
            pos2(l + f * r.width(), bot - e * r.height())
        }).collect();
        p.add(egui::Shape::line(pts, s));
    }
}

fn camera_body(ui: &mut Ui, app: &mut BrickMotionApp) {
    let t = app.theme;
    let scene = app.doc.session().scene_cameras();
    let n = scene.cameras.len();
    group_heading(ui, &t, "Scene cameras", &if n > 0 { n.to_string() } else { String::new() });
    inset_group(ui, |ui| {
        for cam in &scene.cameras {
            camera_row(ui, app, &t, cam, scene.use_for_video && scene.active_id == cam.id);
            hairline(ui);
        }
        if float_panel::links(ui, &t, &["Save View as Camera"]).is_some() {
            save_view(app, &scene.cameras);
        }
    });
    widgets::footnote(ui, &t, &format!("Saves the current view as “{}”. Right-click a camera to rename or remove it.", next_name(&scene.cameras)));

    group_heading(ui, &t, "Export camera", "");
    let export = app.doc.session().export_camera();
    inset_group(ui, |ui| {
        Frame::NONE.inner_margin(Margin { left: 12, right: 12, top: 8, bottom: 8 }).show(ui, |ui| {
            ui.label(RichText::new("Video records").size(12.5).color(t.text1));
            ui.add_space(6.0);
            let mut at = RECORDS.iter().position(|(_, id)| *id == export).unwrap_or(0);
            let labels: Vec<&str> = RECORDS.iter().map(|(l, _)| *l).collect();
            if segmented(ui, &t, "camera_records", &labels, &mut at, true) {
                let c = app.doc.session().set_export_camera(RECORDS[at].1);
                app.edited(c);
            }
        });
        if export == "automatic" {
            hairline(ui);
            let mut names = vec!["Automatic"];
            names.extend(scene.cameras.iter().map(|c| c.name.as_str()));
            let mut at = if scene.use_for_video { scene.cameras.iter().position(|c| c.id == scene.active_id).map_or(0, |i| i + 1) } else { 0 };
            let current = names[at].to_owned();
            if popup_row(ui, &t, "camera_video", "Camera", &current, &names, &mut at, true) {
                let id = if at == 0 { String::new() } else { scene.cameras[at - 1].id.clone() };
                let c = app.doc.session().activate_scene_camera(&id);
                app.edited(c);
            }
        }
    });
    widgets::footnote(ui, &t, "Exports use this camera; the view stays free while you work.");

    let clock = camera_lane::camera_clock(app.transport.clock());
    group_heading(ui, &t, "Camera track", "");
    inset_group(ui, |ui| {
        let style = app.doc.session().camera_director_style(clock);
        let can = camera_lane::can_auto_direct(app, clock);
        let mut at = STYLES.iter().position(|(id, _, _)| *id == style).unwrap_or(usize::MAX);
        let labels: Vec<&str> = STYLES.iter().map(|(_, l, _)| *l).collect();
        let current = if at < STYLES.len() { STYLES[at].1 } else { "None" };
        let changed = ui
            .scope(|ui| popup_row(ui, &t, "camera_style", "Auto-Direct style", current, &labels, &mut at, can))
            .inner;
        if changed && at < STYLES.len() {
            camera_lane::auto_direct(app, clock, STYLES[at].0);
        }
        hairline(ui);
        let mut follow = app.director;
        if switch_row(ui, &t, "Follow Camera", &mut follow, true) {
            camera_lane::set_director(app, follow);
        }
        hairline(ui);
        let any = !app.doc.session().camera_keys(clock).is_empty();
        float_panel::link_row(ui, |ui| {
            let color = if any { Color32::from_rgb(0xe4, 0x6b, 0x6b) } else { t.text3 };
            if link(ui, &t, "Clear Camera Track", color).clicked() && any {
                let c = app.doc.session().clear_camera_track(clock);
                if c.refused.is_none() && app.camera_selection.as_ref().is_some_and(|(k, _)| *k == clock) {
                    app.camera_selection = None;
                }
                app.edited(c);
            }
        });
    });
    if !camera_lane::can_auto_direct(app, clock) {
        widgets::footnote(ui, &t, camera_lane::auto_direct_reason(app, clock));
    }
}

fn next_name(cameras: &[SceneCamera]) -> String {
    let n = (1..=cameras.len() + 1).find(|i| !cameras.iter().any(|c| c.name == format!("Camera {i}"))).unwrap_or(cameras.len() + 1);
    format!("Camera {n}")
}

fn save_view(app: &mut BrickMotionApp, cameras: &[SceneCamera]) {
    let Some(vp) = app.doc.viewport() else { return };
    let mut cam = vp.capture_scene_camera();
    cam.id = new_id();
    cam.name = next_name(cameras);
    let c = app.doc.session().save_scene_camera(&cam);
    app.edited(c);
}

/// A fresh camera id, unique for the process.
fn new_id() -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static N: AtomicU64 = AtomicU64::new(0);
    let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_nanos());
    format!("cam-{nanos:x}-{}", N.fetch_add(1, Ordering::Relaxed))
}

fn camera_row(ui: &mut Ui, app: &mut BrickMotionApp, t: &Theme, cam: &SceneCamera, active: bool) {
    let renaming = app.camera_panel.renaming.as_ref().is_some_and(|(id, _)| *id == cam.id);
    let (rect, resp) = ui.allocate_exact_size(vec2(ui.available_width(), 34.0), Sense::click());
    let y = rect.center().y;
    if active {
        ui.painter().circle_filled(pos2(rect.left() + 15.0, y), 3.5, t.accent);
    }
    if renaming {
        let mut child = ui.new_child(egui::UiBuilder::new().max_rect(Rect::from_min_max(pos2(rect.left() + 26.0, rect.top() + 5.0), pos2(rect.right() - 12.0, rect.bottom() - 5.0))));
        let Some((_, draft)) = app.camera_panel.renaming.as_mut() else { return };
        let edit_id = child.make_persistent_id(("camera_name", &cam.id));
        let edit = child.add(egui::TextEdit::singleline(draft).id(edit_id).desired_width(f32::INFINITY));
        edit.widget_info(|| WidgetInfo::labeled(egui::Role::TextInput, true, "Camera name"));
        if app.camera_panel.focus {
            // The old name starts selected, so typing replaces it.
            edit.request_focus();
            if let Some(mut st) = egui::TextEdit::load_state(child.ctx(), edit_id) {
                let all = egui::text::CCursorRange::two(egui::text::CCursor::new(0), egui::text::CCursor::new(draft.chars().count()));
                st.cursor.set_char_range(Some(all));
                st.store(child.ctx(), edit_id);
            }
            app.camera_panel.focus = false;
        }
        let (enter, esc) = child.input_mut(|i| {
            (i.consume_key(egui::Modifiers::NONE, egui::Key::Enter), i.consume_key(egui::Modifiers::NONE, egui::Key::Escape))
        });
        if esc {
            app.camera_panel.renaming = None;
        } else if enter || edit.lost_focus() {
            let name = draft.trim().to_owned();
            app.camera_panel.renaming = None;
            if !name.is_empty() && name != cam.name {
                let c = app.doc.session().save_scene_camera(&SceneCamera { name, ..cam.clone() });
                app.edited(c);
            }
        }
        return;
    }
    resp.widget_info(|| WidgetInfo::labeled(egui::Role::Button, true, &cam.name));
    if resp.hovered() {
        ui.painter().rect_filled(rect, 0.0, Color32::from_white_alpha(8));
    }
    ui.painter().text(pos2(rect.left() + 26.0, y), Align2::LEFT_CENTER, &cam.name, FontId::proportional(12.5), t.text1);
    // Look Through on the right; the active camera also carries its badge.
    let look = format!("Look Through {}", cam.name);
    let g = ui.painter().layout_no_wrap("Look Through".into(), FontId::proportional(12.0), t.accent);
    let lr = Rect::from_min_size(pos2(rect.right() - 12.0 - g.size().x, y - g.size().y / 2.0), g.size());
    let lresp = ui.interact(lr, ui.make_persistent_id(("look", &cam.id)), Sense::click()).on_hover_cursor(egui::CursorIcon::PointingHand);
    lresp.widget_info(|| WidgetInfo::labeled(egui::Role::Button, true, &look));
    ui.painter().galley(lr.min, g, t.accent);
    if active {
        let b = ui.painter().layout_no_wrap("Active".into(), FontId::proportional(10.5), t.accent);
        let br = Rect::from_min_size(pos2(lr.left() - 12.0 - b.size().x - 10.0, y - 9.0), vec2(b.size().x + 10.0, 18.0));
        ui.painter().rect_filled(br, 9.0, t.accent_bg());
        ui.painter().galley(pos2(br.left() + 5.0, y - b.size().y / 2.0), b, t.accent);
    }
    if lresp.clicked() {
        look_through(app, &cam.id);
    }
    resp.context_menu(|ui| {
        if ui.button("Rename…").clicked() {
            app.camera_panel.renaming = Some((cam.id.clone(), cam.name.clone()));
            app.camera_panel.focus = true;
            ui.close();
        }
        if ui.button("Update from View").clicked() {
            if let Some(vp) = app.doc.viewport() {
                let view = vp.capture_scene_camera();
                let c = app.doc.session().save_scene_camera(&SceneCamera { id: cam.id.clone(), name: cam.name.clone(), ..view });
                app.edited(c);
            }
            ui.close();
        }
        if active {
            if ui.button("Use Automatic Camera for Video").clicked() {
                let c = app.doc.session().activate_scene_camera("");
                app.edited(c);
                ui.close();
            }
        } else if ui.button("Make Default for Video").clicked() {
            let c = app.doc.session().activate_scene_camera(&cam.id);
            app.edited(c);
            ui.close();
        }
        ui.separator();
        if ui.button("Remove Camera").clicked() {
            let c = app.doc.session().remove_scene_camera(&cam.id);
            app.edited(c);
            ui.close();
        }
    });
}

/// Puts the viewport at a saved camera; Follow Camera stops so the view stays there.
fn look_through(app: &mut BrickMotionApp, id: &str) {
    let ok = app.doc.viewport().is_some_and(|vp| vp.recall_scene_camera(id));
    if ok {
        camera_lane::set_director(app, false);
    }
}
