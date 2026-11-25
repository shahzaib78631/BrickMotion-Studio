//! The Animate timeline: tools, timecode and transport, Tracks | Curves, and the four tracks.
use egui::{Align2, Color32, FontId, Frame, Panel, Rect, RichText, Sense, Stroke, StrokeKind, Ui, pos2, vec2};

use super::icon_button;
use crate::BrickMotionApp;
use crate::icons::{self, Icon};

const HEIGHT: f32 = 220.0;
const HEAD_W: f32 = 248.0;
const HEADER_H: f32 = 40.0;
const RULER_H: f32 = 26.0;
const ROW_H: f32 = 34.0;
const TRACKS: [(&str, Icon); 4] = [("Camera", Icon::Cam), ("Build", Icon::Layers), ("Keys", Icon::Keys), ("Snaps", Icon::Wave)];
/// Points per second at the default zoom.
const PX_PER_S: f32 = 7.4;

pub fn show(ui: &mut Ui, app: &mut BrickMotionApp) {
    let t = app.theme;
    Panel::bottom("timeline")
        .exact_size(HEIGHT)
        .resizable(false)
        .show_separator_line(false)
        .frame(Frame::NONE.fill(t.bg1))
        .show(ui, |ui| {
            let full = ui.max_rect();
            let line = Stroke::new(1.0, t.border);
            ui.painter().hline(full.x_range(), full.top() + 0.5, line);
            let header = Rect::from_min_size(full.min, vec2(full.width(), HEADER_H));
            ui.painter().hline(full.x_range(), header.bottom() - 0.5, line);
            header_row(ui, app, header);
            let body = Rect::from_min_max(pos2(full.left(), header.bottom()), full.max);
            let heads = Rect::from_min_max(body.min, pos2(body.left() + HEAD_W, body.bottom()));
            ui.painter().vline(heads.right() - 0.5, body.y_range(), line);
            let lanes = Rect::from_min_max(pos2(heads.right(), body.top()), body.max);
            track_heads(ui, &t, heads);
            ruler_and_lanes(ui, &t, lanes);
        });
}

fn header_row(ui: &mut Ui, app: &mut BrickMotionApp, r: Rect) {
    let t = app.theme;
    // Left: editing tools.
    ui.scope_builder(egui::UiBuilder::new().max_rect(Rect::from_min_size(r.min + vec2(10.0, 6.0), vec2(HEAD_W - 10.0, 28.0))), |ui| {
        ui.horizontal(|ui| {
            ui.spacing_mut().item_spacing.x = 6.0;
            icon_button(ui, &t, Icon::Cursor, "Select", false, false, 28.0);
            icon_button(ui, &t, Icon::Razor, "Split", false, false, 28.0);
            icon_button(ui, &t, Icon::Magnet, "Snapping", false, false, 28.0);
            icon_button(ui, &t, Icon::Marker, "Add Marker", false, false, 28.0);
        });
    });
    // Centre: timecode, transport, duration.
    let c = r.center();
    let mono = FontId::monospace(13.0);
    ui.painter().text(pos2(c.x - 70.0, c.y), Align2::RIGHT_CENTER, "00:00:00", mono, t.text1);
    let play = Rect::from_center_size(c, vec2(32.0, 32.0));
    ui.painter().circle_filled(play.center(), 16.0, t.text1);
    icons::paint(ui, Icon::Play, play, 14.0, t.bg0);
    let resp = ui.interact(play, ui.scope_id().with("play"), Sense::hover());
    resp.widget_info(|| egui::WidgetInfo::labeled(egui::Role::Button, false, "Play"));
    for (dx, i, label) in [(-34.0, Icon::Prev, "Previous Step"), (34.0, Icon::Next, "Next Step")] {
        let b = Rect::from_center_size(c + vec2(dx, 0.0), vec2(28.0, 28.0));
        ui.scope_builder(egui::UiBuilder::new().max_rect(b), |ui| icon_button(ui, &t, i, label, false, false, 28.0));
    }
    ui.painter().text(pos2(c.x + 70.0, c.y), Align2::LEFT_CENTER, "00:00:00", FontId::monospace(12.0), t.text3);
    // Right: Tracks | Curves and zoom.
    let seg = Rect::from_min_size(pos2(r.right() - 10.0 - 252.0, c.y - 14.0), vec2(140.0, 28.0));
    ui.painter().rect(seg, 8.0, t.bg2, Stroke::new(1.0, t.border), StrokeKind::Inside);
    for (k, name) in ["Tracks", "Curves"].into_iter().enumerate() {
        let s = Rect::from_min_size(seg.min + vec2(2.0 + k as f32 * 68.0, 2.0), vec2(68.0, 24.0));
        let on = app.curves == (k == 1);
        let resp = ui.interact(s, ui.scope_id().with(("tl-mode", k)), Sense::click());
        resp.widget_info(|| egui::WidgetInfo::selected(egui::Role::Button, true, on, name));
        if on {
            ui.painter().rect_filled(s, 6.0, t.bg3);
        }
        ui.painter().text(s.center(), Align2::CENTER_CENTER, name, FontId::proportional(12.5), if on { t.text1 } else { t.text2 });
        if resp.clicked() {
            app.curves = k == 1;
        }
    }
    let z0 = seg.right() + 12.0;
    icons::paint(ui, Icon::Minus, Rect::from_center_size(pos2(z0 + 8.0, c.y), vec2(16.0, 16.0)), 16.0, t.text3);
    let track = Rect::from_min_size(pos2(z0 + 22.0, c.y - 2.0), vec2(56.0, 4.0));
    ui.painter().rect_filled(track, 2.0, t.bg3);
    ui.painter().circle_filled(pos2(track.left() + 20.0, c.y), 6.0, t.text2);
    icons::paint(ui, Icon::Plus, Rect::from_center_size(pos2(track.right() + 14.0, c.y), vec2(16.0, 16.0)), 16.0, t.text3);
}

fn track_heads(ui: &mut Ui, t: &crate::Theme, r: Rect) {
    ui.scope_builder(egui::UiBuilder::new().max_rect(r), |ui| {
        ui.spacing_mut().item_spacing.y = 0.0;
        ui.add_space(RULER_H);
        for (name, i) in TRACKS {
            let (row, _) = ui.allocate_exact_size(vec2(r.width(), ROW_H), Sense::hover());
            ui.painter().hline(row.x_range(), row.bottom() - 0.5, Stroke::new(1.0, Color32::from_rgb(0x20, 0x22, 0x28)));
            let y = row.center().y;
            icons::paint(ui, Icon::Chevron, Rect::from_center_size(pos2(row.left() + 16.0, y), vec2(12.0, 12.0)), 12.0, t.text3);
            icons::paint(ui, i, Rect::from_center_size(pos2(row.left() + 36.0, y), vec2(16.0, 16.0)), 16.0, t.text3);
            let lr = Rect::from_min_max(pos2(row.left() + 52.0, row.top()), row.max);
            ui.scope_builder(egui::UiBuilder::new().max_rect(lr).layout(egui::Layout::left_to_right(egui::Align::Center)), |ui| {
                ui.label(RichText::new(name).color(t.text1));
            });
        }
    });
}

fn ruler_and_lanes(ui: &mut Ui, t: &crate::Theme, r: Rect) {
    let p = ui.painter_at(r);
    let ruler = Rect::from_min_size(r.min, vec2(r.width(), RULER_H));
    p.hline(ruler.x_range(), ruler.bottom() - 0.5, Stroke::new(1.0, t.border));
    let mut s = 0;
    loop {
        let x = r.left() + s as f32 * PX_PER_S;
        if x > r.right() {
            break;
        }
        let big = s % 10 == 0;
        p.vline(x, (ruler.bottom() - if big { 9.0 } else { 5.0 })..=ruler.bottom(), Stroke::new(1.0, if big { t.text3 } else { t.border2 }));
        if big {
            let label = format!("{:02}:{:02}", s / 60, s % 60);
            p.text(pos2(x + 4.0, ruler.top() + 5.0), Align2::LEFT_TOP, label, FontId::monospace(10.5), t.text3);
        }
        s += 2;
    }
    for k in 0..TRACKS.len() {
        let y = ruler.bottom() + (k as f32 + 1.0) * ROW_H;
        p.hline(r.x_range(), y - 0.5, Stroke::new(1.0, Color32::from_rgb(0x20, 0x22, 0x28)));
    }
    // Playhead at the start.
    let x = r.left() + 1.0;
    p.vline(x, r.y_range(), Stroke::new(1.5, t.playhead));
    p.rect_filled(Rect::from_min_size(pos2(x - 5.0, r.top()), vec2(11.0, 11.0)), egui::CornerRadius { nw: 2, ne: 2, sw: 6, se: 6 }, t.playhead);
}
