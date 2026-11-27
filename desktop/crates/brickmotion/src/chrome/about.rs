//! BrickMotion › About BrickMotion: the app, engine and renderer versions, a Copy button for bug
//! reports, and the acknowledgements for the palettes some themes use.
use egui::{Id, Key, Modal, RichText, Ui, vec2};

use super::sheet;
use crate::BrickMotionApp;

/// The lines About shows and Copy puts on the clipboard.
pub fn version_lines() -> Vec<(&'static str, String)> {
    let renderer = if bm::metal_available() { "Metal" } else { "Metal (no device found)" };
    vec![
        ("BrickMotion", env!("CARGO_PKG_VERSION").to_owned()),
        ("Engine", bm::engine_version()),
        ("Renderer", renderer.to_owned()),
        ("Parts library", bm::ldraw_directory().map_or_else(|| "Not found".to_owned(), |p| p.display().to_string())),
    ]
}

/// The palettes credited under Acknowledgements, once each.
pub fn credits() -> Vec<&'static str> {
    let mut out: Vec<&'static str> = Vec::new();
    for c in crate::theme::catalogue().iter().filter_map(|d| d.credit) {
        if !out.contains(&c) {
            out.push(c);
        }
    }
    out
}

pub fn show(ui: &mut Ui, app: &mut BrickMotionApp) {
    if !app.about_open {
        return;
    }
    let t = app.theme;
    let mut close = false;
    let lines = version_lines();
    let modal = Modal::new(Id::unique("about-sheet")).frame(sheet::frame(&t)).backdrop_color(sheet::backdrop(&t)).show(ui.ctx(), |ui| {
        ui.set_width(400.0);
        ui.spacing_mut().item_spacing = vec2(8.0, 0.0);
        close = sheet::header(ui, &t, "About BrickMotion");
        sheet::body(ui, |ui| {
            ui.label(RichText::new("BrickMotion").size(15.0).strong().color(t.text1));
            ui.add_space(4.0);
            ui.label(RichText::new("Build brick models and animate how they go together.").size(12.5).color(t.text2));
            ui.add_space(16.0);
            super::widgets::flush_group(ui, |ui| {
                for (i, (k, v)) in lines.iter().enumerate() {
                    if i > 0 {
                        super::widgets::hairline(ui);
                    }
                    egui::Frame::new().inner_margin(egui::Margin::symmetric(14, 0)).show(ui, |ui| {
                        let w = ui.available_width();
                        ui.allocate_ui_with_layout(vec2(w, 34.0), egui::Layout::left_to_right(egui::Align::Center), |ui| {
                            ui.set_min_size(vec2(w, 34.0));
                            ui.label(RichText::new(*k).size(12.5).color(t.text2));
                            ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                                ui.add(egui::Label::new(RichText::new(v).size(12.5).color(t.text1)).truncate());
                            });
                        });
                    });
                }
            });
            ui.add_space(16.0);
            ui.label(RichText::new("Acknowledgements").size(11.5).strong().color(t.text3));
            ui.add_space(6.0);
            ui.spacing_mut().item_spacing.y = 3.0;
            ui.label(RichText::new("Parts geometry from the LDraw parts library (CC BY 4.0).").size(11.5).color(t.text2));
            for c in credits() {
                ui.label(RichText::new(format!("{c}.")).size(11.5).color(t.text2));
            }
            ui.add_space(20.0);
            ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                if sheet::button(ui, &t, "Done", true, true).clicked() {
                    close = true;
                }
                if sheet::button(ui, &t, "Copy", false, true).clicked() {
                    let text = lines.iter().map(|(k, v)| format!("{k}: {v}")).collect::<Vec<_>>().join("\n");
                    ui.ctx().copy_text(text);
                }
            });
        });
    });
    if close || modal.should_close() || ui.input(|i| i.key_pressed(Key::Escape)) {
        app.about_open = false;
        ui.ctx().request_repaint();
    }
}
