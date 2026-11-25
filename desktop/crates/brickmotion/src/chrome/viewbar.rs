//! The floating view bar at the bottom of the viewport, and the selection chip.
use egui::{Align2, Area, Frame, Id, Margin, Order, Rect, RichText, Sense, Stroke, Ui, vec2};

use super::icon_button;
use crate::BrickMotionApp;
use crate::icons::{self, Icon};

pub fn show(ui: &mut Ui, app: &mut BrickMotionApp, area: Rect) {
    let t = app.theme;
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
                        icon_button(ui, &t, Icon::Orbit, "Orbit", false, false, 28.0);
                        icon_button(ui, &t, Icon::Pan, "Pan", false, false, 28.0);
                        icon_button(ui, &t, Icon::Search, "Zoom", false, false, 28.0);
                        sep(ui, &t);
                        if icon_button(ui, &t, Icon::Fit, "Fit All", true, false, 28.0).clicked() {
                            app.requested.push("view.fit");
                        }
                        icon_button(ui, &t, Icon::LookAt, "Look At Selection", false, false, 28.0);
                        if icon_button(ui, &t, Icon::Home, "Home", true, false, 28.0).clicked() {
                            app.requested.push("view.home");
                        }
                        sep(ui, &t);
                        popover_button(ui, &t, Some("Pieces"), Icon::Brick, "Pieces");
                        popover_button(ui, &t, None, Icon::Sliders, "Display");
                    });
                });
        });
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

fn sep(ui: &mut Ui, t: &crate::Theme) {
    let (r, _) = ui.allocate_exact_size(vec2(7.0, 28.0), Sense::hover());
    ui.painter().vline(r.center().x, r.y_range().shrink(4.0), Stroke::new(1.0, t.border));
}

/// A text-and-chevron button that will open a popover (not yet in this milestone).
fn popover_button(ui: &mut Ui, t: &crate::Theme, label: Option<&str>, i: Icon, name: &str) {
    let text_w = label.map(|l| ui.painter().layout_no_wrap(l.to_owned(), egui::FontId::proportional(12.5), t.text3).size().x + 6.0).unwrap_or(0.0);
    let (r, resp) = ui.allocate_exact_size(vec2(16.0 + 6.0 + text_w + 12.0 + 16.0, 28.0), Sense::hover());
    resp.widget_info(|| egui::WidgetInfo::labeled(egui::Role::Button, false, name));
    let y = r.center().y;
    icons::paint(ui, i, Rect::from_center_size(egui::pos2(r.left() + 16.0, y), vec2(16.0, 16.0)), 16.0, t.text3);
    if let Some(l) = label {
        ui.painter().text(egui::pos2(r.left() + 30.0, y), Align2::LEFT_CENTER, l, egui::FontId::proportional(12.5), t.text3);
    }
    icons::paint(ui, Icon::Up, Rect::from_center_size(egui::pos2(r.right() - 12.0, y), vec2(12.0, 12.0)), 12.0, t.text3);
    resp.on_hover_text(format!("{name} — coming soon"));
}
