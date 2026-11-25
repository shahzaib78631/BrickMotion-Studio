//! The ribbon: Workspace button, underlined tabs, labelled tool groups, and on the right
//! Search commands over the Build | Animate switch.
use egui::{
    Align2, Color32, CornerRadius, FontId, Frame, Panel, Pos2, Rect, RichText, Sense, Stroke, StrokeKind, Ui, UiBuilder, Vec2,
    WidgetInfo, pos2, vec2,
};

use super::{caption, hover_card, text};
use crate::commands::{Command, enabled, registry, tabs};
use crate::icons::{self, Icon};
use crate::{BrickMotionApp, Theme, Workspace};

const HEIGHT: f32 = 104.0;
const WS_W: f32 = 96.0;
const RIGHT_W: f32 = 250.0;

pub fn show(ui: &mut Ui, app: &mut BrickMotionApp) {
    let t = app.theme;
    Panel::top("ribbon")
        .exact_size(HEIGHT)
        .resizable(false)
        .show_separator_line(false)
        .frame(Frame::NONE.fill(t.bg2))
        .show(ui, |ui| {
            let full = ui.max_rect();
            let line = Stroke::new(1.0, t.border);
            ui.painter().hline(full.x_range(), full.bottom() - 0.5, line);
            let ws = Rect::from_min_size(full.min, vec2(WS_W, full.height()));
            let right = Rect::from_min_max(pos2(full.right() - RIGHT_W, full.top()), full.max);
            let main = Rect::from_min_max(pos2(ws.right() + 1.0, full.top()), pos2(right.left() - 1.0, full.bottom()));
            ui.painter().vline(ws.right() + 0.5, full.y_range(), line);
            ui.painter().vline(right.left() - 0.5, full.y_range(), line);
            workspace_button(ui, app, ws);
            ui.scope_builder(UiBuilder::new().max_rect(main), |ui| main_area(ui, app));
            ui.scope_builder(UiBuilder::new().max_rect(right), |ui| right_column(ui, app, right));
        });
}

/// The big button on the left: shows the workspace and switches to the other one.
fn workspace_button(ui: &mut Ui, app: &mut BrickMotionApp, r: Rect) {
    let t = app.theme;
    let resp = ui.interact(r, ui.scope_id().with("workspace"), Sense::click());
    resp.widget_info(|| WidgetInfo::labeled(egui::Role::Button, true, "Workspace"));
    if resp.hovered() {
        ui.painter().rect_filled(r, 0.0, t.bg3);
    }
    let c = r.center();
    let i = if app.workspace == Workspace::Build { Icon::Brick } else { Icon::Fly };
    icons::paint(ui, i, Rect::from_center_size(c - vec2(0.0, 20.0), Vec2::splat(20.0)), 20.0, t.playhead);
    text(ui, c + vec2(0.0, 2.0), Align2::CENTER_CENTER, app.workspace.name(), 13.0, t.text1);
    let small = text(ui, c + vec2(-6.0, 20.0), Align2::CENTER_CENTER, "Workspace", 10.5, t.text3);
    icons::paint(ui, Icon::Down, Rect::from_center_size(pos2(small.right() + 7.0, small.center().y), Vec2::splat(11.0)), 11.0, t.text3);
    let resp = resp.on_hover_text(format!("Switch to {}", app.workspace.other().name()));
    if resp.clicked() {
        app.set_workspace(app.workspace.other());
    }
}

fn main_area(ui: &mut Ui, app: &mut BrickMotionApp) {
    let t = app.theme;
    ui.add_space(4.0);
    // Tabs, underlined in the accent when on.
    ui.horizontal(|ui| {
        ui.set_height(26.0);
        ui.add_space(8.0);
        ui.spacing_mut().item_spacing.x = 6.0;
        for &tab in tabs(app.workspace) {
            let on = app.ribbon_tab == tab;
            let label = RichText::new(tab).color(if on { t.text1 } else { t.text2 });
            let w = ui.painter().layout_no_wrap(tab.to_owned(), FontId::proportional(12.5), t.text1).size().x;
            let resp = ui.add(egui::Button::new(label).frame(false).min_size(vec2(w + 22.0, 24.0)));
            let resp = resp.on_hover_cursor(egui::CursorIcon::PointingHand);
            if on {
                let r = resp.rect;
                ui.painter().hline(r.x_range(), r.bottom() + 1.0, Stroke::new(2.0, t.accent));
            }
            if resp.clicked() {
                app.ribbon_tab = tab;
            }
        }
    });
    ui.add_space(4.0);
    let ctx = app.ctx();
    let cmds: Vec<&Command> = registry().iter().filter(|c| c.workspace == app.workspace && c.tab == app.ribbon_tab).collect();
    if cmds.is_empty() {
        ui.add_space(20.0);
        ui.horizontal(|ui| {
            ui.add_space(16.0);
            ui.label(caption("Nothing on this tab yet", &t).size(12.0));
        });
        return;
    }
    ui.horizontal_top(|ui| {
        ui.add_space(4.0);
        ui.spacing_mut().item_spacing.x = 0.0;
        let mut groups: Vec<(&str, Vec<&Command>)> = Vec::new();
        for c in cmds {
            match groups.last_mut() {
                Some((g, list)) if *g == c.group => list.push(c),
                _ => groups.push((c.group, vec![c])),
            }
        }
        let n = groups.len();
        for (i, (group, list)) in groups.into_iter().enumerate() {
            ui.vertical(|ui| {
                ui.spacing_mut().item_spacing = vec2(0.0, 0.0);
                let row = ui.horizontal(|ui| {
                    ui.add_space(6.0);
                    for c in &list {
                        let on = enabled(c, &ctx);
                        let resp = tool(ui, &t, c, on);
                        let resp = hover_card(resp, &t, c);
                        if resp.clicked() && on {
                            app.requested.push(c.id);
                        }
                    }
                    ui.add_space(6.0);
                });
                let w = row.response.rect.width();
                ui.allocate_ui_with_layout(vec2(w, 18.0), egui::Layout::top_down(egui::Align::Center), |ui| {
                    ui.add_space(2.0);
                    ui.label(caption(group, &t));
                });
            });
            if i + 1 < n {
                let (r, _) = ui.allocate_exact_size(vec2(1.0, 62.0), Sense::hover());
                ui.painter().vline(r.center().x, r.y_range().shrink(4.0), Stroke::new(1.0, t.border));
            }
        }
    });
}

/// One ribbon tool: a 22-px icon over its name.
fn tool(ui: &mut Ui, t: &Theme, c: &Command, on: bool) -> egui::Response {
    let color = if on { t.text1 } else { t.text2 };
    let galley = ui.painter().layout_no_wrap(c.title.to_owned(), FontId::proportional(11.5), color);
    let w = (galley.size().x + 10.0).max(56.0);
    let (rect, resp) = ui.allocate_exact_size(vec2(w, 46.0), Sense::click());
    resp.widget_info(|| WidgetInfo::labeled(egui::Role::Button, on, c.title));
    if resp.hovered() {
        ui.painter().rect_filled(rect, t.radius, t.bg3);
    }
    let icon_tint = if on { Color32::from_rgb(0xc9, 0xce, 0xd6) } else { t.text3 };
    let ir = Rect::from_center_size(pos2(rect.center().x, rect.top() + 6.0 + 11.0), Vec2::splat(22.0));
    icons::paint(ui, c.icon, ir, 22.0, icon_tint);
    let tp = Pos2::new(rect.center().x - galley.size().x / 2.0, ir.bottom() + 4.0);
    ui.painter().galley(tp, galley, color);
    resp
}

/// Search commands, and under it the Build | Animate switch.
fn right_column(ui: &mut Ui, app: &mut BrickMotionApp, r: Rect) {
    let t = app.theme;
    let inner = r.shrink2(vec2(12.0, 0.0));
    // Search commands (the palette itself comes later).
    let sr = Rect::from_min_size(pos2(inner.left(), r.top() + 8.0), vec2(inner.width(), 28.0));
    let resp = ui.interact(sr, ui.scope_id().with("search"), Sense::click());
    resp.widget_info(|| WidgetInfo::labeled(egui::Role::TextInput, true, "Search commands"));
    let p = ui.painter();
    p.rect(sr, t.radius, t.bg1, Stroke::new(1.0, if resp.hovered() { t.border2 } else { t.border }), StrokeKind::Inside);
    icons::paint(ui, Icon::Search, Rect::from_center_size(pos2(sr.left() + 18.0, sr.center().y), Vec2::splat(16.0)), 16.0, t.text3);
    text(ui, pos2(sr.left() + 34.0, sr.center().y), Align2::LEFT_CENTER, "Search commands", 12.5, t.text3);
    let k = text(ui, pos2(sr.right() - 10.0, sr.center().y), Align2::RIGHT_CENTER, "⌘K", 11.0, t.text3);
    ui.painter().rect_stroke(k.expand2(vec2(4.0, 1.0)), 4.0, Stroke::new(1.0, t.border2), StrokeKind::Inside);
    resp.on_hover_text("Find any command by name — coming soon");

    // The switch.
    let wr = Rect::from_min_max(pos2(inner.left(), r.bottom() - 10.0 - 38.0), pos2(inner.right(), r.bottom() - 10.0));
    ui.painter().rect(wr, 8.0, t.bg1, Stroke::new(1.0, t.border), StrokeKind::Inside);
    let half = (wr.width() - 9.0) / 2.0;
    for (k, w) in [Workspace::Build, Workspace::Animate].into_iter().enumerate() {
        let seg = Rect::from_min_size(pos2(wr.left() + 3.0 + k as f32 * (half + 3.0), wr.top() + 4.0), vec2(half, 30.0));
        let on = app.workspace == w;
        let resp = ui.interact(seg, ui.scope_id().with(("ws-switch", k)), Sense::click());
        resp.widget_info(|| WidgetInfo::selected(egui::Role::Button, true, on, w.name()));
        if on {
            ui.painter().rect(seg, CornerRadius::same(6), t.bg3, Stroke::new(1.0, t.border2), StrokeKind::Inside);
        } else if resp.hovered() {
            ui.painter().rect_filled(seg, 6.0, t.bg2);
        }
        let color = if on || resp.hovered() { t.text1 } else { t.text2 };
        let label = ui.painter().layout_no_wrap(w.name().to_owned(), FontId::proportional(12.5), color);
        let total = 16.0 + 7.0 + label.size().x;
        let x0 = seg.center().x - total / 2.0;
        let i = if w == Workspace::Build { Icon::Brick } else { Icon::Fly };
        icons::paint(ui, i, Rect::from_center_size(pos2(x0 + 8.0, seg.center().y), Vec2::splat(16.0)), 16.0, if on { t.playhead } else { t.text2 });
        ui.painter().galley(pos2(x0 + 23.0, seg.center().y - label.size().y / 2.0), label, color);
        if resp.clicked() {
            app.set_workspace(w);
        }
    }
}
