//! The chosen object's channel lanes (`KeyframeTracks.swift`'s dope sheet). Key shape shows
//! interpolation: rotated square = Smooth, square = Linear, small upright square = Hold; a picked
//! key has an accent ring (m5-rulings.md). Click or ⌘-click picks, a box on empty lane picks, a
//! drag retimes the picks (previewed, committed once on release), ⌫ deletes, and the right-click
//! menu sets interpolation or deletes.
use std::collections::HashSet;

use bm::keys::{Interpolation, KeyChannel, KeyObject, Keyframe};
use egui::{Align2, FontId, Rect, Sense, Shape, Stroke, Ui, WidgetInfo, pos2, vec2};

use super::keys_track::{FrameScale, ObjectId, seek_frame};
use super::timeline::TimelineDrag;
use crate::BrickMotionApp;

pub const LANE_H: f32 = 22.0;

/// Height of the sheet for one object.
pub fn height() -> f32 {
    LANE_H * KeyChannel::ALL.len() as f32
}

/// Draws the channel heads in `heads` and the lanes in `lanes`, both `height()` tall.
pub fn show(ui: &mut Ui, app: &mut BrickMotionApp, heads: Rect, lanes: Rect, object: &KeyObject) {
    let t = app.theme;
    let id = (object.piece, object.submodel);
    let picks_before = app.keys.picks.clone();
    let scale = FrameScale::new(app, lanes);
    let view = app.timeline.view;
    let preview = match &app.timeline.drag {
        Some(TimelineDrag::Keys { picks, offset, .. }) => Some((picks.iter().copied().collect::<HashSet<_>>(), *offset)),
        _ => None,
    };
    let at = |k: &Keyframe| -> f64 {
        match &preview {
            Some((p, off)) if p.contains(&(k.channel, k.frame)) => f64::from(k.frame + off),
            _ => f64::from(k.frame),
        }
    };

    // The box select sits under the keys: a press on empty lane starts it.
    let area = ui.interact(lanes, ui.scope_id().with(("dope-box", id)), Sense::click_and_drag());
    if area.drag_started() {
        app.keys.box_from = ui.input(|i| i.pointer.press_origin());
    }
    if let (Some(from), Some(now)) = (app.keys.box_from, ui.input(|i| i.pointer.latest_pos())) {
        let r = Rect::from_two_pos(from, now);
        ui.painter().rect_filled(r, 2.0, t.accent_a(30));
        ui.painter().rect_stroke(r, 2.0, Stroke::new(1.0, t.accent), egui::StrokeKind::Inside);
        if area.drag_stopped() || !ui.input(|i| i.pointer.primary_down()) {
            let bounds = r.expand(4.0);
            let mut hit = HashSet::new();
            for (i, ch) in KeyChannel::ALL.iter().enumerate() {
                let y = lanes.top() + (i as f32 + 0.5) * LANE_H;
                for k in object.keys.iter().filter(|k| k.channel == *ch) {
                    if bounds.contains(pos2(scale.x(&view, f64::from(k.frame)), y)) {
                        hit.insert((k.channel, k.frame));
                    }
                }
            }
            if ui.input(|i| i.modifiers.command || i.modifiers.shift) {
                app.keys.picks.extend(hit);
            } else {
                app.keys.picks = hit;
            }
            app.keys.box_from = None;
        }
    } else if area.clicked() {
        app.keys.picks.clear();
    }

    let lo = lanes.left() - 18.0;
    let hi = lanes.right() + 18.0;
    let playhead_frame = f64::from(app.transport.key_frame(&app.transport.key_scene));
    let span_band = match (object.markers.first(), object.markers.last()) {
        (Some(a), Some(b)) if b.frame > a.frame => {
            let x0 = scale.x(&view, f64::from(a.frame));
            let x1 = scale.x(&view, f64::from(b.frame));
            Some((x0.min(x1), x0.max(x1)))
        }
        _ => None,
    };
    for (i, ch) in KeyChannel::ALL.iter().enumerate() {
        let hr = Rect::from_min_size(pos2(heads.left(), heads.top() + i as f32 * LANE_H), vec2(heads.width(), LANE_H));
        let lr = Rect::from_min_size(pos2(lanes.left(), hr.top()), vec2(lanes.width(), LANE_H));
        if i % 2 == 0 {
            ui.painter().rect_filled(lr, 0.0, t.ink(4));
        }
        // Soft flight band behind the channel's key span (m6-controls.html).
        if let Some((bx0, bx1)) = span_band {
            let band = Rect::from_min_max(pos2(bx0, lr.top() + 1.0), pos2(bx1, lr.bottom() - 1.0));
            ui.painter_at(lr).rect_filled(band, 4.0, t.accent_a(18));
        }
        let head = ui.interact(hr, ui.scope_id().with(("dope-head", id, i)), Sense::click());
        let current = app.keys.property == *ch;
        head.widget_info(|| WidgetInfo::selected(egui::Role::Button, true, current, format!("{} channel", ch.title())));
        if head.clicked() {
            app.keys.property = *ch;
        }
        let fg = if current { t.text1 } else { t.text3 };
        ui.painter().text(pos2(hr.left() + 46.0, hr.center().y), Align2::LEFT_CENTER, ch.title(), FontId::proportional(11.5), fg);
        // Live channel value at the playhead, right-aligned (m6-controls.html).
        let live_v = app.doc.session().key_value(id.0, *ch, playhead_frame, id.1);
        let val_txt = match ch {
            KeyChannel::RotationX | KeyChannel::RotationY | KeyChannel::RotationZ => format!("{live_v:.0}°"),
            _ => format!("{live_v:.1}"),
        };
        ui.painter().text(pos2(hr.right() - 10.0, hr.center().y), Align2::RIGHT_CENTER, val_txt, FontId::monospace(10.5), t.text2);

        // Connect keys on this channel with a soft accent line behind the markers (m6-controls.html).
        let ch_keys: Vec<&Keyframe> = object.keys.iter().filter(|k| k.channel == *ch).collect();
        if ch_keys.len() >= 2 {
            let x_min = ch_keys.iter().map(|k| scale.x(&view, at(k))).fold(f32::INFINITY, f32::min);
            let x_max = ch_keys.iter().map(|k| scale.x(&view, at(k))).fold(f32::NEG_INFINITY, f32::max);
            if x_max > x_min + 1.0 {
                ui.painter_at(lr).line_segment(
                    [pos2(x_min, lr.center().y), pos2(x_max, lr.center().y)],
                    Stroke::new(1.5, t.accent_a(145)),
                );
            }
        }

        for k in ch_keys {
            let dragged = preview.as_ref().is_some_and(|(p, _)| p.contains(&(k.channel, k.frame)));
            let x = scale.x(&view, at(k));
            if !dragged && (x < lo || x > hi) {
                continue;
            }
            let pick = (k.channel, k.frame);
            let picked = app.keys.picks.contains(&pick);
            let c = pos2(x, lr.center().y);
            let resp = ui.interact(Rect::from_center_size(c, vec2(12.0, LANE_H)), ui.scope_id().with(("dope-key", id, i, k.frame)), Sense::click_and_drag());
            resp.widget_info(|| WidgetInfo::selected(egui::Role::Button, true, picked, format!("{} key at frame {}", ch.title(), k.frame)));
            paint_key(ui, &t, c, k.interpolation, picked);
            if picked {
                ui.painter().circle_stroke(c, 7.0, Stroke::new(1.2, t.accent));
            }
            if resp.clicked() {
                app.keys.property = *ch;
                if ui.input(|i| i.modifiers.command || i.modifiers.shift) {
                    if !app.keys.picks.remove(&pick) {
                        app.keys.picks.insert(pick);
                    }
                } else {
                    app.keys.picks = HashSet::from([pick]);
                }
                seek_frame(app, k.frame);
            }
            if resp.drag_started() {
                if !picked {
                    app.keys.picks = HashSet::from([pick]);
                }
                let start_x = ui.input(|i| i.pointer.press_origin()).map_or(x, |p| p.x);
                let picks: Vec<_> = app.keys.picks.iter().copied().collect();
                app.timeline.drag = Some(TimelineDrag::Keys { picks, start_x, offset: 0 });
            }
            resp.context_menu(|ui| key_menu(ui, app, id, pick));
        }
    }
    // The newest pick takes ⌫: a dope-sheet pick drops the picked path point.
    if !app.keys.picks.is_empty() && app.keys.picks != picks_before {
        app.flights.picked = None;
    }
}

fn paint_key(ui: &Ui, t: &crate::theme::Theme, c: egui::Pos2, interpolation: Interpolation, picked: bool) {
    let p = ui.painter();
    let fill = if picked { t.accent } else { t.key };
    match interpolation {
        Interpolation::Smooth => {
            let r = 4.8;
            let pts = vec![pos2(c.x, c.y - r), pos2(c.x + r, c.y), pos2(c.x, c.y + r), pos2(c.x - r, c.y)];
            if picked {
                p.add(Shape::convex_polygon(pts, t.accent, Stroke::NONE));
            } else {
                p.add(Shape::convex_polygon(pts, t.bg1, Stroke::new(1.5, t.accent)));
            }
        }
        Interpolation::Linear => {
            p.rect_filled(Rect::from_center_size(c, vec2(7.5, 7.5)), 1.5, fill);
        }
        Interpolation::Hold => {
            p.rect_filled(Rect::from_center_size(c, vec2(5.5, 5.5)), 0.5, fill);
        }
    }
}

fn key_menu(ui: &mut Ui, app: &mut BrickMotionApp, id: ObjectId, pick: (KeyChannel, i32)) {
    let picks: Vec<(KeyChannel, i32)> =
        if app.keys.picks.contains(&pick) { app.keys.picks.iter().copied().collect() } else { vec![pick] };
    for it in Interpolation::ALL {
        if ui.button(it.title()).clicked() {
            set_interpolation(app, id, &picks, it);
            ui.close();
        }
    }
    ui.separator();
    if ui.button(if picks.len() == 1 { "Delete Key" } else { "Delete Keys" }).clicked() {
        remove(app, id, &picks);
        ui.close();
    }
}

fn keys_of(app: &BrickMotionApp, id: ObjectId, picks: &[(KeyChannel, i32)]) -> Vec<Keyframe> {
    app.keys.object(id).map_or_else(Vec::new, |o| o.keys.iter().filter(|k| picks.contains(&(k.channel, k.frame))).copied().collect())
}

pub fn set_interpolation(app: &mut BrickMotionApp, id: ObjectId, picks: &[(KeyChannel, i32)], it: Interpolation) {
    let keys: Vec<Keyframe> = keys_of(app, id, picks).into_iter().map(|k| Keyframe { interpolation: it, ..k }).collect();
    if keys.is_empty() {
        return;
    }
    let c = app.doc.session().set_keys(id.0, &keys, false, id.1);
    app.edited(c);
}

fn remove(app: &mut BrickMotionApp, id: ObjectId, picks: &[(KeyChannel, i32)]) {
    let keys = keys_of(app, id, picks);
    let c = app.doc.session().remove_keys(id.0, &keys, id.1);
    if c.refused.is_none() {
        for p in picks {
            app.keys.picks.remove(p);
        }
    }
    app.edited(c);
}

/// ⌫ on picked keys.
pub fn delete_picks(app: &mut BrickMotionApp) {
    let Some(id) = app.keys.target() else { return };
    let picks: Vec<_> = app.keys.picks.iter().copied().collect();
    remove(app, id, &picks);
}

/// How far picked keys may move and stay in the scene.
pub fn limits(app: &BrickMotionApp, picks: &[(KeyChannel, i32)]) -> (i32, i32) {
    let (Some(lo), Some(hi)) = (picks.iter().map(|p| p.1).min(), picks.iter().map(|p| p.1).max()) else { return (0, 0) };
    bm::keys::key_offset_limits(app.transport.key_scene, lo, hi)
}

/// Retimes the picks by `offset` frames (clamped to the scene) in one `move_keys` call; the picks
/// follow the keys.
pub fn commit(app: &mut BrickMotionApp, picks: &[(KeyChannel, i32)], offset: i32) {
    let Some(id) = app.keys.target() else { return };
    let offset = bm::keys::clamp_offset(limits(app, picks), offset);
    if offset == 0 {
        return;
    }
    let keys = keys_of(app, id, picks);
    let c = app.doc.session().move_keys(id.0, &keys, offset, id.1);
    let ok = c.refused.is_none();
    app.edited(c);
    if ok {
        app.keys.picks = picks.iter().map(|&(ch, f)| (ch, f + offset)).collect();
        if let Some(anchor) = picks.iter().map(|p| p.1).min() {
            seek_frame(app, anchor + offset);
        }
    }
}
