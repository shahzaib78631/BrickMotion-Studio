//! The Keys panel (m5-rulings.md): floats while one object is chosen on the Keyframes clock.
//! "Key at frame N" lists the object's channels with their values at the playhead (type a value and
//! press Return to key it; "not keyed · Add" keys the value it has now) and the interpolation of the
//! keys there; "Key scene" holds the frames, frame rate and Follow build; Auto Key keys gizmo drags.
use bm::keys::{Interpolation, KeyChannel, KeyObject, KeyScene, Keyframe};
use egui::{Align2, FontId, Rect, RichText, Sense, Ui, WidgetInfo, pos2, vec2};

use super::float_panel::{self, Head, PanelKind, group_heading, link, link_row, links};
use super::keys_track::ObjectId;
use super::widgets::{self, hairline, inset_group, parse_number, segmented, switch_row};
use crate::BrickMotionApp;
use crate::icons::Icon;
use crate::theme::Theme;
use crate::transport::Clock;

/// Draws the Keys panel when one object is chosen on the Keyframes clock.
pub fn show(ui: &mut Ui, app: &mut BrickMotionApp, area: Rect, next_top: &mut f32) {
    if !is_open(app) {
        return;
    }
    let Some(id) = app.keys.target() else { return };
    let Some(object) = app.keys.object(id).cloned() else { return };
    let frame = app.transport.key_frame(&app.transport.key_scene);
    let subtitle = format!("frame {frame}");
    let out = float_panel::show(
        ui,
        app,
        area,
        next_top,
        PanelKind::Keys,
        Head { icon: Icon::Keys, title: &object.name, subtitle: &subtitle },
        |ui, app| body(ui, app, &object, frame),
    );
    if out.close {
        app.keys.active.clear();
        app.keys.picks.clear();
        app.doc.session().select(&[], bm::SelectMode::Replace);
    }
}

pub fn is_open(app: &BrickMotionApp) -> bool {
    app.transport.clock() == Clock::Keyframes && app.keys.target().is_some()
}

fn body(ui: &mut Ui, app: &mut BrickMotionApp, object: &KeyObject, frame: i32) {
    let t = app.theme;
    let id = (object.piece, object.submodel);
    let at_frame: Vec<Keyframe> = object.keys.iter().filter(|k| k.frame == frame).copied().collect();
    let note = match at_frame.len() {
        0 => String::new(),
        1 => "1 channel".into(),
        n => format!("{n} channels"),
    };
    group_heading(ui, &t, &format!("Key at frame {frame}"), &note);
    inset_group(ui, |ui| {
        let mut channels: Vec<KeyChannel> = vec![KeyChannel::PositionX, KeyChannel::PositionY, KeyChannel::PositionZ];
        for ch in KeyChannel::ALL {
            if !channels.contains(&ch) && object.keys.iter().any(|k| k.channel == ch) {
                channels.push(ch);
            }
        }
        for ch in channels {
            channel_row(ui, app, &t, id, object, ch, frame);
            hairline(ui);
        }
        add_channel(ui, app, &t, id, object, frame);
        hairline(ui);
        // The interpolation of the keys at this frame (or of the picked keys).
        let picks: Vec<(KeyChannel, i32)> = if app.keys.picks.is_empty() {
            at_frame.iter().map(|k| (k.channel, k.frame)).collect()
        } else {
            app.keys.picks.iter().copied().collect()
        };
        let current = object
            .keys
            .iter()
            .find(|k| picks.contains(&(k.channel, k.frame)))
            .map_or(Interpolation::Smooth, |k| k.interpolation);
        egui::Frame::NONE.inner_margin(egui::Margin { left: 12, right: 12, top: 8, bottom: 8 }).show(ui, |ui| {
            ui.label(RichText::new("Interpolation").size(12.5).color(if picks.is_empty() { t.text3 } else { t.text1 }));
            ui.add_space(6.0);
            let mut at = Interpolation::ALL.iter().position(|i| *i == current).unwrap_or(0);
            let labels: Vec<&str> = Interpolation::ALL.iter().map(|i| i.title()).collect();
            if segmented(ui, &t, "key_interpolation", &labels, &mut at, !picks.is_empty()) {
                super::dope_sheet::set_interpolation(app, id, &picks, Interpolation::ALL[at]);
            }
        });
    });

    scene_group(ui, app, &t);
    flights_group(ui, app, &t, object);
    check_group(ui, app, &t);

    group_heading(ui, &t, "Recording", "");
    inset_group(ui, |ui| {
        let mut on = app.keys.auto_key;
        if switch_row(ui, &t, "Auto Key", &mut on, true) {
            app.keys.auto_key = on;
        }
    });
    widgets::footnote(ui, &t, "With Auto Key on, moving or turning the chosen object keys it at the playhead.");
}

#[allow(clippy::too_many_arguments)]
fn channel_row(ui: &mut Ui, app: &mut BrickMotionApp, t: &Theme, id: ObjectId, object: &KeyObject, ch: KeyChannel, frame: i32) {
    let keyed = object.keys.iter().find(|k| k.channel == ch && k.frame == frame).copied();
    let value = app.doc.session().key_value(id.0, ch, f64::from(frame), id.1);
    let (rect, _) = ui.allocate_exact_size(vec2(ui.available_width(), 34.0), Sense::hover());
    let y = rect.center().y;
    let fg = if keyed.is_some() { t.text1 } else { t.text3 };
    ui.painter().text(pos2(rect.left() + 12.0, y), Align2::LEFT_CENTER, ch.title(), FontId::proportional(12.5), fg);
    let field = Rect::from_min_max(pos2(rect.right() - 96.0, rect.top() + 6.0), pos2(rect.right() - 10.0, rect.bottom() - 6.0));
    if let Some(v) = number_field(ui, ("key-value", ch), &format!("{} value", ch.title()), field, &fmt(ch, value)) {
        let interpolation = keyed.map_or_else(|| previous_interpolation(object, ch, frame), |k| k.interpolation);
        let k = Keyframe { channel: ch, frame, value: v, interpolation };
        let c = app.doc.session().set_keys(id.0, &[k], false, id.1);
        app.edited(c);
    }
    if keyed.is_none() {
        let g = ui.painter().layout_no_wrap("not keyed · ".into(), FontId::proportional(11.0), t.text3);
        let add = ui.painter().layout_no_wrap("Add".into(), FontId::proportional(11.0), t.accent);
        let ar = Rect::from_min_size(pos2(field.left() - 8.0 - add.size().x, y - add.size().y / 2.0), add.size());
        ui.painter().galley(pos2(ar.left() - g.size().x, y - g.size().y / 2.0), g, t.text3);
        let resp = ui.interact(ar, ui.make_persistent_id(("key-add", ch)), Sense::click()).on_hover_cursor(egui::CursorIcon::PointingHand);
        resp.widget_info(|| WidgetInfo::labeled(egui::Role::Button, true, format!("Add {} key", ch.title())));
        ui.painter().galley(ar.min, add, t.accent);
        if resp.clicked() {
            let k = Keyframe { channel: ch, frame, value, interpolation: previous_interpolation(object, ch, frame) };
            let c = app.doc.session().set_keys(id.0, &[k], false, id.1);
            app.edited(c);
        }
    }
}

/// A new key takes the interpolation of the channel's key before it (Smooth when none).
fn previous_interpolation(object: &KeyObject, ch: KeyChannel, frame: i32) -> Interpolation {
    object.keys.iter().filter(|k| k.channel == ch && k.frame <= frame).max_by_key(|k| k.frame).map_or(Interpolation::Smooth, |k| k.interpolation)
}

fn fmt(ch: KeyChannel, v: f64) -> String {
    match ch {
        KeyChannel::RotationX | KeyChannel::RotationY | KeyChannel::RotationZ => format!("{v:.1}°"),
        KeyChannel::Visibility => format!("{v:.2}"),
        _ => format!("{v:.2}"),
    }
}

/// The channels not shown yet: pick one to key its value at the playhead.
fn add_channel(ui: &mut Ui, app: &mut BrickMotionApp, t: &Theme, id: ObjectId, object: &KeyObject, frame: i32) {
    let shown = |ch: KeyChannel| matches!(ch, KeyChannel::PositionX | KeyChannel::PositionY | KeyChannel::PositionZ) || object.keys.iter().any(|k| k.channel == ch);
    let rest: Vec<KeyChannel> = KeyChannel::ALL.into_iter().filter(|c| !shown(*c)).collect();
    if rest.is_empty() {
        return;
    }
    let mut labels: Vec<&str> = vec!["Add a property…"];
    labels.extend(rest.iter().map(|c| c.title()));
    // usize::MAX so nothing starts checked and picking index 0 (the first remaining property) works.
    let mut at = usize::MAX;
    if widgets::popup_row(ui, t, "key_add_channel", "Property", "Add…", &labels[1..], &mut at, true) && at < rest.len() {
        let ch = rest[at];
        let value = app.doc.session().key_value(id.0, ch, f64::from(frame), id.1);
        let c = app.doc.session().set_keys(id.0, &[Keyframe::new(ch, frame, value)], false, id.1);
        app.keys.property = ch;
        app.edited(c);
    }
}

fn scene_group(ui: &mut Ui, app: &mut BrickMotionApp, t: &Theme) {
    let scene = app.doc.session().key_scene();
    group_heading(ui, t, "Key scene", "");
    inset_group(ui, |ui| {
        let mut next: Option<KeyScene> = None;
        let rows: [(&str, String); 3] =
            [("First frame", scene.first.to_string()), ("Last frame", scene.last.to_string()), ("Frame rate", format!("{} fps", scene.fps))];
        for (i, (label, text)) in rows.iter().enumerate() {
            let (rect, _) = ui.allocate_exact_size(vec2(ui.available_width(), 34.0), Sense::hover());
            ui.painter().text(pos2(rect.left() + 12.0, rect.center().y), Align2::LEFT_CENTER, *label, FontId::proportional(12.5), t.text1);
            let field = Rect::from_min_max(pos2(rect.right() - 96.0, rect.top() + 6.0), pos2(rect.right() - 10.0, rect.bottom() - 6.0));
            if let Some(v) = number_field(ui, ("key-scene", i), label, field, text) {
                let v = v.round() as i32;
                let mut s = scene;
                match i {
                    0 => s.first = v.max(0).min(s.last - 1),
                    1 => s.last = v.max(s.first + 1),
                    _ => s.fps = v.clamp(1, 240),
                }
                next = Some(s);
            }
            hairline(ui);
        }
        let (rect, _) = ui.allocate_exact_size(vec2(ui.available_width(), 34.0), Sense::hover());
        ui.painter().text(pos2(rect.left() + 12.0, rect.center().y), Align2::LEFT_CENTER, "Length", FontId::proportional(12.5), t.text1);
        ui.painter().text(pos2(rect.right() - 12.0, rect.center().y), Align2::RIGHT_CENTER, format!("{:.2} s", scene.length()), FontId::proportional(12.0), t.text2);
        hairline(ui);
        let mut linked = scene.build_linked;
        if switch_row(ui, t, "Follow build", &mut linked, true) {
            next = Some(bm::keys::linked_key_scene(scene, linked, app.transport.build_duration()));
        }
        if scene.build_linked {
            hairline(ui);
            let (rect, _) = ui.allocate_exact_size(vec2(ui.available_width(), 34.0), Sense::hover());
            ui.painter().text(pos2(rect.left() + 12.0, rect.center().y), Align2::LEFT_CENTER, "Build start", FontId::proportional(12.5), t.text1);
            let field = Rect::from_min_max(pos2(rect.right() - 96.0, rect.top() + 6.0), pos2(rect.right() - 10.0, rect.bottom() - 6.0));
            if let Some(v) = number_field(ui, "key-build-start", "Build start", field, &scene.build_start.to_string()) {
                next = Some(KeyScene { build_start: v.round() as i32, ..scene });
            }
            hairline(ui);
            let (rect, _) = ui.allocate_exact_size(vec2(ui.available_width(), 34.0), Sense::hover());
            ui.painter().text(pos2(rect.left() + 12.0, rect.center().y), Align2::LEFT_CENTER, "Build speed", FontId::proportional(12.5), t.text1);
            let field = Rect::from_min_max(pos2(rect.right() - 96.0, rect.top() + 6.0), pos2(rect.right() - 10.0, rect.bottom() - 6.0));
            if let Some(v) = number_field(ui, "key-build-speed", "Build speed", field, &format!("{:.2}×", scene.build_speed)) {
                next = Some(KeyScene { build_speed: v.clamp(0.05, 20.0), ..scene });
            }
        }
        if let Some(s) = next
            && s != scene
        {
            let c = app.doc.session().set_key_scene(s);
            app.edited(c);
        }
    });
}

/// Flights: bake the chosen object's planned flight into keys (asks first when keys go), and send
/// an edited flight back to Build or to the planner.
fn flights_group(ui: &mut Ui, app: &mut BrickMotionApp, t: &Theme, object: &KeyObject) {
    let note = match object.keys.len() {
        0 => String::new(),
        1 => "replaces 1 key".into(),
        n => format!("replaces {n} keys"),
    };
    let can_bake = app.transport.ready();
    group_heading(ui, t, "Flights", &note);
    inset_group(ui, |ui| {
        if app.bake.busy() {
            link_row(ui, |ui| {
                ui.label(RichText::new("Baking flights…").size(12.5).color(t.text3));
            });
        } else {
            let color = if can_bake { t.accent } else { t.text3 };
            link_row(ui, |ui| {
                let r = link(ui, t, "Bake Flights to Keys", color);
                let r = if can_bake { r } else { r.on_hover_text("Plan the build before baking flights.").on_hover_cursor(egui::CursorIcon::Default) };
                if can_bake && r.clicked() {
                    crate::flights::bake(app, false);
                }
            });
            hairline(ui);
            link_row(ui, |ui| {
                let r = link(ui, t, "Bake All and Detach Build", color);
                let r = if can_bake { r } else { r.on_hover_text("Plan the build before baking flights.").on_hover_cursor(egui::CursorIcon::Default) };
                if can_bake && r.clicked() {
                    crate::flights::bake(app, true);
                }
            });
        }
        if object.baked && !object.submodel {
            hairline(ui);
            let local = crate::flights::is_local(app, object.piece);
            let labels: &[&str] = if local { &["Use in Build", "Return to Planner"] } else { &["Return to Planner"] };
            match links(ui, t, labels).map(|i| labels[i]) {
                Some("Use in Build") => crate::flights::use_edited_flight(app, object.piece),
                Some(_) => crate::flights::return_to_planner(app, object.piece),
                None => {}
            }
        }
    });
    if let Some(note) = app.flights.note.clone() {
        widgets::footnote(ui, t, &note);
    }
}

/// Check Motion: where the chosen piece's keyed motion crosses other parts. A contact seeks to its
/// first frame and selects and frames both parts.
fn check_group(ui: &mut Ui, app: &mut BrickMotionApp, t: &Theme) {
    group_heading(ui, t, "Check Motion", "");
    inset_group(ui, |ui| {
        if app.audit.busy() {
            link_row(ui, |ui| {
                ui.label(RichText::new("Checking motion…").size(12.5).color(t.text3));
            });
        } else {
            let label = if app.flights.check.is_some() { "Check Motion Again" } else { "Check Motion" };
            link_row(ui, |ui| {
                if link(ui, t, label, t.accent).clicked() {
                    crate::flights::check_motion(app);
                }
            });
        }
        let Some(check) = app.flights.check.clone() else { return };
        hairline(ui);
        egui::Frame::NONE.inner_margin(egui::Margin::symmetric(12, 8)).show(ui, |ui| {
            ui.set_width(ui.available_width());
            ui.label(RichText::new(&check.text).size(12.0).color(if check.warning { t.text1 } else { t.text2 }));
        });
        for contact in &check.contacts {
            hairline(ui);
            let title = format!("{} crosses {}", contact.part, contact.blocker);
            let when = if contact.first_frame == contact.last_frame {
                format!("Frame {}", contact.first_frame)
            } else {
                format!("Frames {}–{}", contact.first_frame, contact.last_frame)
            };
            let (rect, resp) = ui.allocate_exact_size(vec2(ui.available_width(), 42.0), Sense::click());
            resp.widget_info(|| WidgetInfo::labeled(egui::Role::Button, true, format!("{title}, {when}")));
            if resp.hovered() {
                ui.painter().rect_filled(rect, 0.0, egui::Color32::from_white_alpha(8));
            }
            let p = ui.painter_at(rect.shrink2(vec2(12.0, 0.0)));
            p.text(pos2(rect.left() + 12.0, rect.top() + 14.0), Align2::LEFT_CENTER, &title, FontId::proportional(12.5), t.text1);
            p.text(pos2(rect.left() + 12.0, rect.top() + 30.0), Align2::LEFT_CENTER, &when, FontId::proportional(11.0), t.text3);
            if resp.on_hover_cursor(egui::CursorIcon::PointingHand).clicked() {
                crate::flights::show_contact(app, contact);
            }
        }
    });
}

/// A number typed in `rect`, committed on Return; shows `shown` while not being edited. Focusing
/// it selects the text, so typing replaces it.
fn number_field(ui: &mut Ui, salt: impl std::hash::Hash + std::fmt::Debug, label: &str, rect: Rect, shown: &str) -> Option<f64> {
    let id = ui.make_persistent_id(salt);
    let draft_id = id.with("draft");
    let focused = ui.memory(|m| m.has_focus(id));
    let mut text = if focused { ui.data(|d| d.get_temp::<String>(draft_id)).unwrap_or_else(|| shown.to_owned()) } else { shown.to_owned() };
    let mut child = ui.new_child(egui::UiBuilder::new().max_rect(rect));
    let resp = child.add(
        egui::TextEdit::singleline(&mut text).id(id).desired_width(rect.width()).align(egui::Align2::RIGHT_CENTER).font(FontId::monospace(11.5)),
    );
    resp.widget_info(|| WidgetInfo::labeled(egui::Role::TextInput, true, label));
    if resp.gained_focus()
        && let Some(mut st) = egui::TextEdit::load_state(ui.ctx(), id)
    {
        let all = egui::text::CCursorRange::two(egui::text::CCursor::new(0), egui::text::CCursor::new(text.chars().count()));
        st.cursor.set_char_range(Some(all));
        st.store(ui.ctx(), id);
    }
    // Read focus first: has_focus locks memory, which must not happen inside input_mut.
    let focused = resp.has_focus() || resp.lost_focus();
    let (enter, esc) = ui.input_mut(|i| {
        if focused {
            (i.key_pressed(egui::Key::Enter), i.consume_key(egui::Modifiers::NONE, egui::Key::Escape))
        } else {
            (false, false)
        }
    });
    if esc {
        ui.data_mut(|d| d.remove::<String>(draft_id));
        resp.surrender_focus();
        None
    } else if resp.has_focus() {
        ui.data_mut(|d| d.insert_temp(draft_id, text.clone()));
        None
    } else if resp.lost_focus() {
        ui.data_mut(|d| d.remove::<String>(draft_id));
        if enter { parse_number(&text) } else { None }
    } else {
        None
    }
}

/// Insert Key: keys the chosen object's property at the playhead with the value it has there.
pub fn insert_key(app: &mut BrickMotionApp) {
    let Some(id) = app.keys.target() else { return };
    let frame = app.transport.key_frame(&app.transport.key_scene);
    let ch = app.keys.property;
    let value = app.doc.session().key_value(id.0, ch, f64::from(frame), id.1);
    let interpolation = app.keys.object(id).map_or(Interpolation::Smooth, |o| previous_interpolation(o, ch, frame));
    let c = app.doc.session().set_keys(id.0, &[Keyframe { channel: ch, frame, value, interpolation }], false, id.1);
    app.edited(c);
}
