//! The look every small sheet shares: a rounded panel with a titled header, a close button and a
//! hairline under it, a padded body, and calm buttons and keycaps. Spacing sits on the 8-px grid.
use egui::{Button, Color32, CornerRadius, Frame, Margin, RichText, Stroke, Ui, Role, WidgetInfo, vec2};

use crate::icons::{self, Icon};
use crate::theme::Theme;

/// Padding inside the sheet, left and right.
pub const PAD: i8 = 20;

/// The sheet's own panel: no inner margin, so the header hairline can run edge to edge.
pub fn frame(t: &Theme) -> Frame {
    Frame::new()
        .fill(t.bg1)
        .stroke(Stroke::new(1.0, t.border2))
        .corner_radius(CornerRadius::same(14))
        .shadow(egui::epaint::Shadow { offset: [0, 12], blur: 32, spread: 0, color: t.shade(110) })
}

/// The dimmed backdrop behind a sheet.
pub fn backdrop(t: &Theme) -> Color32 {
    t.shade(110)
}

/// Title and close button, then a hairline. True when the close button was clicked.
pub fn header(ui: &mut Ui, t: &Theme, title: &str) -> bool {
    let mut close = false;
    Frame::new().inner_margin(Margin { left: PAD, right: 14, top: 16, bottom: 14 }).show(ui, |ui| {
        ui.horizontal(|ui| {
            ui.label(RichText::new(title).size(15.0).strong().color(t.text1));
            ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                let b = Button::image(icons::image(Icon::Close, 14.0, t.text2)).frame(false).min_size(vec2(28.0, 28.0));
                let resp = ui.add(b).on_hover_text("Close");
                resp.widget_info(|| WidgetInfo::labeled(Role::Button, true, "Close"));
                close = resp.clicked();
            });
        });
    });
    hairline(ui, t);
    close
}

/// A full-width hairline.
pub fn hairline(ui: &mut Ui, t: &Theme) {
    let (r, _) = ui.allocate_exact_size(vec2(ui.available_width(), 1.0), egui::Sense::hover());
    ui.painter().hline(r.x_range(), r.center().y, Stroke::new(1.0, t.border));
}

/// The padded body of a sheet.
pub fn body<R>(ui: &mut Ui, add: impl FnOnce(&mut Ui) -> R) -> R {
    Frame::new().inner_margin(Margin { left: PAD, right: PAD, top: 16, bottom: PAD }).show(ui, add).inner
}

/// A 30-px button: the accent fill for the primary action, a quiet one otherwise.
pub fn button(ui: &mut Ui, t: &Theme, label: &str, primary: bool, enabled: bool) -> egui::Response {
    let (fill, stroke, text) = if primary {
        (t.accent, Stroke::new(1.0, t.accent), t.on_accent)
    } else {
        (t.bg3, Stroke::new(1.0, t.border2), t.text1)
    };
    let b = Button::new(RichText::new(label).size(12.5).color(text))
        .fill(fill)
        .stroke(stroke)
        .corner_radius(CornerRadius::same(8))
        .min_size(vec2(76.0, 30.0));
    ui.add_enabled(enabled, b)
}

/// A rounded pill, outlined in the accent while chosen.
pub fn pill(ui: &mut Ui, t: &Theme, label: &str, on: bool) -> egui::Response {
    let (stroke, text) = if on { (Stroke::new(1.0, t.accent), t.text1) } else { (Stroke::new(1.0, t.border2), t.text2) };
    let b = Button::new(RichText::new(label).size(12.5).color(text))
        .fill(if on { t.bg2 } else { Color32::TRANSPARENT })
        .stroke(stroke)
        .corner_radius(CornerRadius::same(15))
        .min_size(vec2(0.0, 30.0));
    ui.add(b)
}

/// The caps of a shortcut such as "⌥⌘G": one 28-px cap per key, joined by "+". Call it in a
/// right-to-left layout; the caps then end at the right edge.
pub fn keycaps(ui: &mut Ui, t: &Theme, keys: &[String]) {
    for (i, k) in keys.iter().rev().enumerate() {
        if i > 0 {
            ui.label(RichText::new("+").size(12.0).color(t.text3));
        }
        let galley = ui.painter().layout_no_wrap(k.clone(), egui::FontId::proportional(12.5), t.text1);
        let w = (galley.size().x + 20.0).max(28.0);
        let (r, resp) = ui.allocate_exact_size(vec2(w, 28.0), egui::Sense::hover());
        resp.widget_info(|| WidgetInfo::labeled(Role::Label, true, k));
        let p = ui.painter();
        p.rect(r, CornerRadius::same(7), t.bg3, Stroke::new(1.0, t.border2), egui::StrokeKind::Inside);
        p.galley(r.center() - galley.size() / 2.0, galley, t.text1);
    }
}

/// A labelled single-line field: 34 px tall, a quiet border at rest, an accent border and soft
/// ring while focused, and a translucent selection the text stays readable through.
/// With `select_all`, it takes focus and selects its text once (the flag is then cleared).
pub fn text_field(ui: &mut Ui, t: &Theme, label: &str, text: &mut String, select_all: &mut bool) -> egui::text_edit::TextEditOutput {
    ui.label(RichText::new(label).size(11.5).color(t.text2));
    ui.add_space(6.0);
    let id = ui.make_persistent_id(("sheet-field", label));
    let focused = ui.memory(|m| m.has_focus(id));
    let (rect, _) = ui.allocate_exact_size(vec2(ui.available_width(), 34.0), egui::Sense::hover());
    let p = ui.painter();
    if focused {
        p.rect_stroke(rect.expand(1.5), CornerRadius::same(10), Stroke::new(3.0, t.accent.gamma_multiply(0.28)), egui::StrokeKind::Outside);
    }
    let border = if focused { t.accent } else { t.border2 };
    p.rect(rect, CornerRadius::same(8), t.bg0, Stroke::new(1.0, border), egui::StrokeKind::Inside);
    let inner = rect.shrink2(vec2(11.0, 0.0));
    let out = ui
        .scope_builder(egui::UiBuilder::new().max_rect(inner).layout(egui::Layout::left_to_right(egui::Align::Center)), |ui| {
            let v = ui.visuals_mut();
            v.selection.bg_fill = t.accent.gamma_multiply(0.38);
            v.selection.stroke = Stroke::new(1.0, t.text1);
            v.text_cursor.stroke = Stroke::new(1.5, t.accent);
            egui::TextEdit::singleline(text)
                .id(id)
                .frame(Frame::NONE)
                .margin(Margin::ZERO)
                .font(egui::FontId::proportional(13.0))
                .text_color(t.text1)
                .align(egui::Align2::LEFT_CENTER)
                .desired_width(inner.width())
                .show(ui)
        })
        .inner;
    if *select_all {
        out.response.request_focus();
        let all = egui::text::CCursorRange::two(egui::text::CCursor::new(0), egui::text::CCursor::new(text.chars().count()));
        let mut state = out.state.clone();
        state.cursor.set_char_range(Some(all));
        state.store(ui.ctx(), out.response.id);
        *select_all = false;
    }
    out
}
