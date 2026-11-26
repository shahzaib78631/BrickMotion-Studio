//! The floating view bar at the bottom of the viewport, and the selection chip.
use egui::{Align2, Area, Frame, Id, Margin, Order, Rect, RichText, Sense, Stroke, Ui, vec2};

use super::icon_button;
use crate::BrickMotionApp;
use crate::viewport::DragMode;
use crate::icons::{self, Icon};

pub fn show(ui: &mut Ui, app: &mut BrickMotionApp, area: Rect) {
    let t = app.theme;
    recording_chip(ui, app, area);
    Area::new(Id::unique("viewbar"))
        .order(Order::Middle)
        .anchor(Align2::CENTER_BOTTOM, vec2(0.0, -12.0))
        .constrain_to(area)
        .show(ui.ctx(), |ui| {
            Frame::NONE
                .fill(egui::Color32::from_rgba_unmultiplied(0x1a, 0x1b, 0x1f, 230))
                .stroke(Stroke::new(1.0, t.border))
                .corner_radius(10)
                .inner_margin(Margin::same(4))
                .show(ui, |ui| {
                    ui.horizontal(|ui| {
                        ui.spacing_mut().item_spacing.x = 2.0;
                        let doc_on = app.has_document;
                        for (i, label, tool, cmd) in [
                            (Icon::Cursor, "Select Tool", crate::Tool::Select, "tool.select"),
                            (Icon::Move, "Move Tool", crate::Tool::Move, "model.move"),
                            (Icon::Rotate, "Rotate Tool", crate::Tool::Rotate, "model.rotate_tool"),
                        ] {
                            let tip = if doc_on { label } else { "Open a model to edit" };
                            if super::icon_button_tip(ui, &t, i, label, tip, doc_on, app.edit.tool == tool, 28.0).clicked() {
                                app.requested.push(cmd);
                            }
                        }
                        sep(ui, &t);
                        for (i, label, mode) in [(Icon::Orbit, "Orbit", DragMode::Orbit), (Icon::Pan, "Pan", DragMode::Pan), (Icon::Search, "Zoom", DragMode::Zoom)] {
                            if icon_button(ui, &t, i, label, true, app.viewport.mode == mode, 28.0).clicked() {
                                app.viewport.mode = mode;
                            }
                        }
                        sep(ui, &t);
                        if icon_button(ui, &t, Icon::Fit, "Fit All", true, false, 28.0).clicked() {
                            app.requested.push("view.fit");
                        }
                        icon_button(ui, &t, Icon::LookAt, "Look At Selection", false, false, 28.0);
                        if icon_button(ui, &t, Icon::Home, "Home", true, false, 28.0).clicked() {
                            app.requested.push("view.home");
                        }
                        sep(ui, &t);
                        let pieces = popover_button(ui, &t, Some("Pieces"), Icon::Brick, "Pieces", true);
                        egui::Popup::from_toggle_button_response(&pieces).gap(8.0).show(|ui| {
                            ui.set_min_width(180.0);
                            ui.label(super::caption("Click selects", &t));
                            let _ = ui.add(egui::Button::selectable(true, "Pieces"));
                            for other in ["Submodels", "Whole step", "Connections"] {
                                ui.add_enabled(false, egui::Button::selectable(false, other)).on_disabled_hover_text("Coming soon");
                            }
                        });
                        popover_button(ui, &t, None, Icon::Sliders, "Display", false);
                    });
                });
        });
    if let Some(p) = &app.edit.placement {
        let short = super::library::short_name(&p.part.name);
        let status = p.status_text();
        let status_color = match p.state {
            bm::placement::PlacementState::Snapped => t.accent,
            bm::placement::PlacementState::Blocked | bm::placement::PlacementState::Unavailable => {
                egui::Color32::from_rgb(0xe5, 0x48, 0x4d)
            }
            _ => t.text1,
        };
        Area::new(Id::unique("placement-hud"))
            .order(Order::Middle)
            .anchor(Align2::LEFT_BOTTOM, vec2(12.0, -14.0))
            .constrain_to(area)
            .show(ui.ctx(), |ui| {
                Frame::NONE
                    .fill(t.float_fill())
                    .stroke(Stroke::new(1.0, t.border2))
                    .corner_radius(8)
                    .inner_margin(Margin::symmetric(10, 5))
                    .show(ui, |ui| {
                        ui.horizontal(|ui| {
                            ui.spacing_mut().item_spacing.x = 8.0;
                            ui.label(RichText::new(short).strong().size(11.5).color(t.text1));
                            ui.label(RichText::new(status).strong().size(11.5).color(status_color));
                            ui.label(
                                RichText::new("Click to place · R turn · Tab grip · Esc cancel")
                                    .size(11.0)
                                    .color(t.text3),
                            );
                        });
                    });
            });
    } else {
        let selected = app.doc.session().selection().len();
        if selected > 0 {
            Area::new(Id::unique("selection-chip"))
                .order(Order::Middle)
                .anchor(Align2::LEFT_BOTTOM, vec2(12.0, -14.0))
                .constrain_to(area)
                .show(ui.ctx(), |ui| {
                    Frame::NONE
                        .fill(t.float_fill())
                        .stroke(Stroke::new(1.0, t.border))
                        .corner_radius(8)
                        .inner_margin(Margin::symmetric(10, 5))
                        .show(ui, |ui| {
                            ui.horizontal(|ui| {
                                let word = if selected == 1 { "piece" } else { "pieces" };
                                ui.label(RichText::new(format!("{selected} {word}")).strong().size(11.5).color(t.text1));
                                ui.label(RichText::new("selected").size(11.5).color(t.text2));
                            });
                        });
                });
        }
    }
}

fn sep(ui: &mut Ui, t: &crate::Theme) {
    let (r, _) = ui.allocate_exact_size(vec2(7.0, 28.0), Sense::hover());
    ui.painter().vline(r.center().x, r.y_range().shrink(4.0), Stroke::new(1.0, t.border));
}

/// A text-and-chevron button that will open a popover (not yet in this milestone).
fn popover_button(ui: &mut Ui, t: &crate::Theme, label: Option<&str>, i: Icon, name: &str, enabled: bool) -> egui::Response {
    let text_w = label.map(|l| ui.painter().layout_no_wrap(l.to_owned(), egui::FontId::proportional(12.5), t.text3).size().x + 6.0).unwrap_or(0.0);
    let (r, resp) = ui.allocate_exact_size(vec2(16.0 + 6.0 + text_w + 12.0 + 16.0, 28.0), if enabled { Sense::click() } else { Sense::hover() });
    resp.widget_info(|| egui::WidgetInfo::labeled(egui::Role::Button, enabled, name));
    if enabled && resp.hovered() {
        ui.painter().rect_filled(r, t.radius, t.bg3);
    }
    let tint = if enabled { t.text2 } else { t.text3 };
    let y = r.center().y;
    icons::paint(ui, i, Rect::from_center_size(egui::pos2(r.left() + 16.0, y), vec2(16.0, 16.0)), 16.0, tint);
    if let Some(l) = label {
        ui.painter().text(egui::pos2(r.left() + 30.0, y), Align2::LEFT_CENTER, l, egui::FontId::proportional(12.5), tint);
    }
    icons::paint(ui, Icon::Up, Rect::from_center_size(egui::pos2(r.right() - 12.0, y), vec2(12.0, 12.0)), 12.0, tint);
    if enabled { resp.on_hover_text(name.to_owned()) } else { resp.on_hover_text(format!("{name} — coming soon")) }
}

/// While recording: "● m:ss" and a Stop button, bottom left of the view.
fn recording_chip(ui: &mut Ui, app: &mut BrickMotionApp, area: Rect) {
    let Some(seconds) = app.recording.active.as_ref().map(|r| r.seconds) else { return };
    let t = app.theme;
    let mut stop = false;
    Area::new(Id::unique("recording-chip"))
        .order(Order::Middle)
        .anchor(Align2::LEFT_BOTTOM, vec2(12.0, -12.0))
        .constrain_to(area)
        .show(ui.ctx(), |ui| {
            Frame::NONE
                .fill(t.float_fill())
                .stroke(Stroke::new(1.0, t.border))
                .corner_radius(8)
                .inner_margin(Margin::symmetric(10, 5))
                .show(ui, |ui| {
                    ui.horizontal(|ui| {
                        let (dot, _) = ui.allocate_exact_size(vec2(8.0, 16.0), Sense::hover());
                        ui.painter().circle_filled(dot.center(), 4.0, egui::Color32::from_rgb(255, 69, 58));
                        let clock = crate::recording::clock(seconds);
                        ui.label(RichText::new(&clock).monospace().size(11.5).color(t.text1));
                        let r = ui.add(egui::Button::new(RichText::new("Stop").size(11.5).color(t.text1)).corner_radius(5));
                        r.widget_info(|| egui::WidgetInfo::labeled(egui::Role::Button, true, "Stop recording"));
                        stop = r.on_hover_text("Stop Recording Viewport").clicked();
                    });
                });
        });
    if stop {
        app.requested.push("view.record");
    }
}
