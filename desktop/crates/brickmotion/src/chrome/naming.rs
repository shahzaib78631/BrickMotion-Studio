//! The small naming sheet behind Make Submodel, New Submodel and Group…: the next free name is
//! filled in and selected, Return confirms and Esc cancels. Also the Help › Keyboard Shortcuts sheet.
use egui::{Id, Key, Modal, RichText, Ui};

use crate::BrickMotionApp;
use crate::commands::{Shortcut, registry};

/// What the name is for.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NameFor {
    MakeSubmodel,
    NewSubmodel,
    Group,
}

/// An open naming sheet.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Naming {
    pub kind: NameFor,
    pub text: String,
    /// The pieces it acts on (Make Submodel and Group), as selected when the sheet opened.
    pub pieces: Vec<u32>,
    /// True until the field has been focused and its text selected once.
    pub(crate) fresh: bool,
}

impl Naming {
    pub fn new(kind: NameFor, text: String, pieces: Vec<u32>) -> Naming {
        Naming { kind, text, pieces, fresh: true }
    }

    fn title(&self) -> &'static str {
        match self.kind {
            NameFor::MakeSubmodel => "Make Submodel",
            NameFor::NewSubmodel => "New Submodel",
            NameFor::Group => "Group",
        }
    }

    fn note(&self) -> String {
        let n = self.pieces.len();
        let pieces = if n == 1 { "1 piece".to_owned() } else { format!("{n} pieces") };
        match self.kind {
            NameFor::MakeSubmodel => format!("{pieces} become one submodel, used here once."),
            NameFor::NewSubmodel => "An empty submodel you can open and build in.".to_owned(),
            NameFor::Group => format!("Name a group for the {pieces} selected."),
        }
    }
}

/// "Group", or "Group N" with the first N not yet taken.
pub fn free_group_name(taken: &[String]) -> String {
    let free = |n: &str| !taken.iter().any(|t| t == n);
    if free("Group") {
        return "Group".to_owned();
    }
    (2..).map(|i| format!("Group {i}")).find(|n| free(n)).unwrap_or_default()
}

pub fn show(ui: &mut Ui, app: &mut BrickMotionApp) {
    shortcuts(ui, app);
    let Some(naming) = app.naming.as_mut() else { return };
    let t = app.theme;
    let mut answer = None;
    let title = naming.title();
    let note = naming.note();
    let modal = Modal::new(Id::unique("naming-sheet")).show(ui.ctx(), |ui| {
        ui.set_width(340.0);
        ui.label(RichText::new(title).strong().size(13.0).color(t.text1));
        ui.add_space(2.0);
        ui.label(RichText::new(note).size(12.0).color(t.text2));
        ui.add_space(10.0);
        let field = egui::TextEdit::singleline(&mut naming.text).desired_width(f32::INFINITY);
        let out = field.show(ui);
        if naming.fresh {
            out.response.request_focus();
            let all = egui::text::CCursorRange::two(
                egui::text::CCursor::new(0),
                egui::text::CCursor::new(naming.text.chars().count()),
            );
            let mut state = out.state.clone();
            state.cursor.set_char_range(Some(all));
            state.store(ui.ctx(), out.response.id);
            naming.fresh = false;
        }
        if ui.input(|i| i.key_pressed(Key::Enter)) {
            answer = Some(true);
        }
        ui.add_space(12.0);
        let ok = !naming.text.trim().is_empty();
        ui.horizontal(|ui| {
            ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                let confirm = egui::Button::new(RichText::new(title).color(egui::Color32::WHITE)).fill(t.accent);
                if ui.add_enabled(ok, confirm).clicked() {
                    answer = Some(true);
                }
                if ui.button("Cancel").clicked() {
                    answer = Some(false);
                }
            });
        });
    });
    if (modal.should_close() || ui.input(|i| i.key_pressed(Key::Escape))) && answer.is_none() {
        answer = Some(false);
    }
    if let Some(a) = answer {
        app.finish_naming(a);
        ui.ctx().request_repaint();
    }
}

/// Help › Keyboard Shortcuts: every command with a key, from the registry.
fn shortcuts(ui: &mut Ui, app: &mut BrickMotionApp) {
    if !app.shortcuts_open {
        return;
    }
    let t = app.theme;
    let mut close = false;
    let modal = Modal::new(Id::unique("shortcuts-sheet")).show(ui.ctx(), |ui| {
        ui.set_width(420.0);
        ui.label(RichText::new("Keyboard Shortcuts").strong().size(13.0).color(t.text1));
        ui.add_space(8.0);
        egui::ScrollArea::vertical().max_height(460.0).show(ui, |ui| {
            egui::Grid::new("shortcuts-grid").num_columns(2).spacing([24.0, 6.0]).show(ui, |ui| {
                let mut rows: Vec<_> = registry().iter().filter_map(|c| Some((c.title, Shortcut::parse(c.keys?)?.label()))).collect();
                rows.sort_by(|a, b| a.0.cmp(b.0));
                rows.dedup();
                for (title, keys) in rows {
                    ui.label(RichText::new(title).color(t.text1));
                    ui.label(RichText::new(keys).color(t.text2));
                    ui.end_row();
                }
            });
        });
        ui.add_space(10.0);
        ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
            if ui.button("Done").clicked() {
                close = true;
            }
        });
    });
    if close || modal.should_close() || ui.input(|i| i.key_pressed(Key::Escape)) {
        app.shortcuts_open = false;
        ui.ctx().request_repaint();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn free_group_names() {
        assert_eq!(free_group_name(&[]), "Group");
        assert_eq!(free_group_name(&["Group".into()]), "Group 2");
        assert_eq!(free_group_name(&["Group".into(), "Group 2".into()]), "Group 3");
    }
}
