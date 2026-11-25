//! The axis navigator in the top-right corner, with the home button beside it.
use egui::{Align2, Area, Color32, FontId, Id, Order, Rect, Sense, Stroke, Ui, pos2, vec2};

use super::icon_button;
use crate::BrickMotionApp;
use crate::icons::Icon;

const SIZE: f32 = 96.0;

pub fn show(ui: &mut Ui, app: &mut BrickMotionApp, area: Rect) {
    let t = app.theme;
    let origin = pos2(area.right() - 14.0 - SIZE, area.top() + 10.0);
    Area::new(Id::unique("navigator")).order(Order::Middle).fixed_pos(origin).show(ui.ctx(), |ui| {
        let (r, _) = ui.allocate_exact_size(vec2(SIZE, SIZE), Sense::hover());
        let s = SIZE / 64.0;
        let p = |x: f32, y: f32| r.min + vec2(x * s, y * s);
        let painter = ui.painter();
        painter.circle(p(32.0, 32.0), 30.0 * s, Color32::from_white_alpha(8), Stroke::new(1.0, t.border));
        // Back axes first, dim, then the front axes with labelled ends.
        for (x, y, c) in [(32.0, 50.0, 0x2c4a85), (16.0, 25.0, 0x7a3434), (48.0, 25.0, 0x2a6b47)] {
            let c = Color32::from_hex(&format!("#{c:06x}")).unwrap();
            painter.line_segment([p(32.0, 32.0), p(x, y)], Stroke::new(2.0, c));
            painter.circle(p(x, y + if y > 32.0 { 1.0 } else { -1.0 }), 3.5 * s, Color32::from_rgb(0x1b, 0x1d, 0x21), Stroke::new(1.5, c));
        }
        for (x, y, c, l) in [(32.0, 11.0, 0x5b8cff, "Y"), (51.0, 41.0, 0xff6b6b, "X"), (13.0, 41.0, 0x4fd18b, "Z")] {
            let c = Color32::from_hex(&format!("#{c:06x}")).unwrap();
            painter.line_segment([p(32.0, 32.0), p(x, y)], Stroke::new(2.0, c));
            painter.circle_filled(p(x, y), 7.0 * s, c);
            painter.text(p(x, y), Align2::CENTER_CENTER, l, FontId::proportional(9.0 * s), Color32::WHITE);
        }
    });
    Area::new(Id::unique("navigator-home"))
        .order(Order::Middle)
        .fixed_pos(origin + vec2(-24.0, 2.0))
        .show(ui.ctx(), |ui| {
            let r = Rect::from_min_size(ui.cursor().min, vec2(24.0, 24.0));
            ui.painter().circle(r.center(), 12.0, t.bg2, Stroke::new(1.0, t.border2));
            if icon_button(ui, &t, Icon::Home, "Home View", true, false, 24.0).clicked() {
                app.requested.push("view.home");
            }
        });
}
