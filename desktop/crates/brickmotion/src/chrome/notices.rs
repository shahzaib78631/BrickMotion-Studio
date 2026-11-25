//! The notice stack, bottom right of the viewport.
use egui::{Align2, Area, Color32, Id, Margin, Order, Rect, RichText, Stroke, Ui, vec2};

use super::{float_frame, icon_button};
use crate::icons::{self, Icon};
use crate::{BrickMotionApp, Notice};

const WIDTH: f32 = 340.0;

pub fn show(ui: &mut Ui, app: &mut BrickMotionApp, area: Rect) {
    if app.notices.is_empty() {
        return;
    }
    let t = app.theme;
    let mut dismiss = None;
    Area::new(Id::unique("notices"))
        .order(Order::Foreground)
        .pivot(Align2::RIGHT_BOTTOM)
        .fixed_pos(area.right_bottom() - vec2(12.0, 12.0))
        .show(ui.ctx(), |ui| {
            ui.set_width(WIDTH);
            ui.spacing_mut().item_spacing.y = 8.0;
            for (k, n) in app.notices.iter().enumerate() {
                let (icon, tint) = match n {
                    Notice::Error { .. } => (Icon::Close, Color32::from_rgb(0xff, 0x6b, 0x6b)),
                    Notice::Warning { .. } => (Icon::Help, Color32::from_rgb(0xfe, 0xbc, 0x2e)),
                };
                float_frame(&t).corner_radius(8).inner_margin(Margin { left: 12, right: 6, top: 10, bottom: 10 }).show(ui, |ui| {
                    ui.set_width(WIDTH - 18.0);
                    ui.horizontal_top(|ui| {
                        let (r, _) = ui.allocate_exact_size(vec2(20.0, 20.0), egui::Sense::hover());
                        ui.painter().circle_stroke(r.center(), 9.0, Stroke::new(1.5, tint));
                        icons::paint(ui, icon, r, 12.0, tint);
                        ui.vertical(|ui| {
                            ui.set_width(WIDTH - 18.0 - 20.0 - 40.0);
                            ui.spacing_mut().item_spacing.y = 3.0;
                            ui.label(RichText::new(n.title()).strong().color(t.text1));
                            ui.add(egui::Label::new(RichText::new(n.detail()).color(t.text2)).wrap());
                        });
                        ui.with_layout(egui::Layout::right_to_left(egui::Align::Min), |ui| {
                            if icon_button(ui, &t, Icon::Close, "Dismiss", true, false, 24.0).clicked() {
                                dismiss = Some(k);
                            }
                        });
                    });
                });
            }
        });
    if let Some(k) = dismiss {
        app.notices.remove(k);
    }
}
