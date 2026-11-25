//! The floating Properties panel, right of the viewport.
use egui::{Area, Frame, Id, Margin, Order, Rect, RichText, Ui};

use super::{float_frame, icon_button, panel_header};
use crate::BrickMotionApp;
use crate::icons::Icon;

const WIDTH: f32 = 292.0;

pub fn show(ui: &mut Ui, app: &mut BrickMotionApp, area: Rect) {
    let t = app.theme;
    let title = app.title();
    let n = app.piece_count();
    let selected = app.doc.session().selection().len();
    Area::new(Id::unique("properties"))
        .order(Order::Middle)
        .fixed_pos(egui::pos2(area.right() - 10.0 - WIDTH, area.top() + 122.0))
        .constrain_to(area)
        .show(ui.ctx(), |ui| {
            float_frame(&t).show(ui, |ui| {
                ui.set_width(WIDTH);
                ui.spacing_mut().item_spacing.y = 0.0;
                panel_header(ui, &t, "Properties", |ui| {
                    icon_button(ui, &t, Icon::Close, "Hide Properties", false, false, 24.0);
                });
                Frame::NONE.inner_margin(Margin::symmetric(14, 12)).show(ui, |ui| {
                    ui.spacing_mut().item_spacing.y = 4.0;
                    ui.label(RichText::new(&title).strong().color(t.text1));
                    ui.label(RichText::new(format!("{n} {}", if n == 1 { "piece" } else { "pieces" })).color(t.text3));
                    ui.add_space(8.0);
                    let status = match selected {
                        0 => "Nothing selected".to_owned(),
                        1 => "1 piece selected".to_owned(),
                        k => format!("{k} pieces selected"),
                    };
                    ui.label(RichText::new(status).color(t.text2));
                });
            });
        });
}
