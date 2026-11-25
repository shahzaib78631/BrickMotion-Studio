//! The window around the viewport: title bar, ribbon, floating panels and the timeline.
pub mod browser;
pub mod callout;
pub mod confirm;
pub mod library;
pub mod navigator;
pub mod notices;
pub mod parts;
pub mod parts_lane;
pub mod properties;
pub mod replace;
pub mod ribbon;
pub mod steps;
pub mod swatches;
pub mod timeline;
pub mod titlebar;
pub mod tree;
pub mod viewbar;
pub mod widgets;

use egui::{
    Align2, Color32, CornerRadius, FontId, Frame, Margin, Rect, Response, Sense, Shadow, Stroke, Ui, Vec2, WidgetInfo,
};

use crate::BrickMotionApp;
use crate::commands::Command;
use crate::icons::{self, Icon};
use crate::theme::{SMALL, Theme};

/// The area between the ribbon and the timeline: viewport plus floating panels.
pub fn central(ui: &mut Ui, app: &mut BrickMotionApp) {
    let t = app.theme;
    egui::CentralPanel::no_frame().show(ui, |ui| {
        let rect = ui.max_rect();
        ui.painter().rect_filled(rect, 0.0, t.bg1);
        let playing = app.transport.state.playing;
        let planning = app.transport.busy() || app.transport.state.waiting_to_play;
        app.viewport.show(ui, &mut app.doc, &mut app.edit, &t, app.prefs.auto_plan, playing, planning);
        browser::show(ui, app, rect);
        properties::show(ui, app, rect);
        navigator::show(ui, app, rect);
        callout::show(ui, app, rect);
        viewbar::show(ui, app, rect);
        notices::show(ui, app, rect);
    });
}

/// A floating panel over the viewport.
pub fn float_frame(t: &Theme) -> Frame {
    Frame::NONE
        .fill(t.float_fill())
        .stroke(Stroke::new(1.0, t.border2))
        .corner_radius(CornerRadius::same(10))
        .shadow(Shadow { offset: [0, 10], blur: 30, spread: 0, color: Color32::from_black_alpha(90) })
}

/// A square icon button. Disabled buttons stay visible, dimmed, and keep their hover text.
pub fn icon_button(ui: &mut Ui, t: &Theme, i: Icon, label: &str, enabled: bool, on: bool, size: f32) -> Response {
    let tip = if enabled { label.to_owned() } else { format!("{label} — coming soon") };
    icon_button_tip(ui, t, i, label, &tip, enabled, on, size)
}

/// An icon button with its own hover text, for buttons that are disabled for a reason other
/// than not being built yet.
#[allow(clippy::too_many_arguments)]
pub fn icon_button_tip(ui: &mut Ui, t: &Theme, i: Icon, label: &str, tip: &str, enabled: bool, on: bool, size: f32) -> Response {
    let (rect, resp) = ui.allocate_exact_size(Vec2::splat(size), if enabled { Sense::click() } else { Sense::hover() });
    resp.widget_info(|| WidgetInfo::selected(egui::Role::Button, enabled, on, label));
    let hovered = enabled && resp.hovered();
    if on {
        ui.painter().rect_filled(rect, t.radius, t.accent_bg());
    } else if hovered {
        ui.painter().rect_filled(rect, t.radius, t.bg3);
    }
    let tint = if on {
        t.accent
    } else if !enabled {
        t.text3
    } else if hovered {
        t.text1
    } else {
        t.text2
    };
    icons::paint(ui, i, rect, 16.0, tint);
    let resp = resp.on_hover_text(tip);
    if enabled { resp } else { resp.on_hover_cursor(egui::CursorIcon::Default) }
}

/// The hover card of a ribbon tool: title, shortcut and what it does.
/// The shortcut to advertise for `c`: none for a command that is not built yet, whose key does nothing.
pub fn card_keys(c: &Command) -> Option<&'static str> {
    if c.when == crate::When::Soon { None } else { c.keys }
}

pub fn hover_card(resp: Response, t: &Theme, c: &Command) -> Response {
    resp.on_hover_ui(|ui| {
        ui.set_max_width(260.0);
        ui.horizontal(|ui| {
            ui.label(egui::RichText::new(c.title).strong().color(t.text1));
            if let Some(k) = card_keys(c) {
                ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| kbd(ui, t, k));
            }
        });
        ui.label(egui::RichText::new(c.tip).color(t.text2));
    })
}

/// A keyboard shortcut in a small outlined box.
pub fn kbd(ui: &mut Ui, t: &Theme, text: &str) -> Response {
    let galley = ui.painter().layout_no_wrap(text.to_owned(), FontId::proportional(11.0), t.text3);
    let (rect, resp) = ui.allocate_exact_size(galley.size() + Vec2::new(10.0, 2.0), Sense::hover());
    ui.painter().rect_stroke(rect, 4.0, Stroke::new(1.0, t.border2), egui::StrokeKind::Inside);
    ui.painter().galley(rect.center() - galley.size() / 2.0, galley, t.text3);
    resp
}

/// Text painted at `pos` without taking layout space.
pub fn text(ui: &Ui, pos: egui::Pos2, anchor: Align2, s: &str, size: f32, color: Color32) -> Rect {
    ui.painter().text(pos, anchor, s, FontId::proportional(size), color)
}

/// A small dimmed caption.
pub fn caption(s: &str, t: &Theme) -> egui::RichText {
    egui::RichText::new(s).size(SMALL).color(t.text3)
}

/// The panel header: grip, title, then actions on the right.
pub fn panel_header(ui: &mut Ui, t: &Theme, title: &str, actions: impl FnOnce(&mut Ui)) {
    Frame::NONE.inner_margin(Margin { left: 10, right: 8, top: 0, bottom: 0 }).show(ui, |ui| {
        ui.set_height(38.0);
        ui.horizontal_centered(|ui| {
            icons::icon(ui, Icon::Grip, 16.0, t.text3);
            ui.label(egui::RichText::new(title).strong().color(t.text1));
            ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                ui.spacing_mut().item_spacing.x = 0.0;
                actions(ui);
            });
        });
    });
    let r = ui.min_rect();
    ui.painter().hline(r.x_range(), ui.cursor().top(), Stroke::new(1.0, t.border));
}

#[cfg(test)]
mod card_tests {
    use super::card_keys;

    #[test]
    fn soon_commands_show_no_keys() {
        let sub = crate::find("model.submodel").unwrap();
        assert_eq!(sub.keys, Some("⌥⌘G"));
        assert_eq!(card_keys(sub), None);
        assert_eq!(card_keys(crate::find("file.open").unwrap()), Some("⌘O"));
    }
}
