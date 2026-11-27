//! "Save changes to <title>?" before an edited document is closed or replaced.
use egui::{Id, Modal, RichText, Ui};

use crate::{Answer, BrickMotionApp};

pub fn show(ui: &mut Ui, app: &mut BrickMotionApp) {
    if app.confirm.is_none() {
        return;
    }
    let t = app.theme;
    let title = app.title();
    let mut answer = None;
    let modal = Modal::new(Id::unique("save-changes")).show(ui.ctx(), |ui| {
        ui.set_width(340.0);
        ui.label(RichText::new(format!("Save changes to {title}?")).strong().size(14.0).color(t.text1));
        ui.add_space(4.0);
        ui.label(RichText::new("Your changes will be lost if you don't save them.").color(t.text2));
        ui.add_space(12.0);
        ui.horizontal(|ui| {
            if ui.button("Don't Save").clicked() {
                answer = Some(Answer::DontSave);
            }
            ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                let save = egui::Button::new(RichText::new("Save").color(t.on_accent)).fill(t.accent);
                if ui.add(save).clicked() {
                    answer = Some(Answer::Save);
                }
                if ui.button("Cancel").clicked() {
                    answer = Some(Answer::Cancel);
                }
            });
        });
    });
    if modal.should_close() && answer.is_none() {
        answer = Some(Answer::Cancel);
    }
    if let Some(a) = answer {
        app.answer_confirm(a);
        ui.ctx().request_repaint();
    }
}
