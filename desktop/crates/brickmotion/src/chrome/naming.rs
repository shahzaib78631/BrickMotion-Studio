//! The small naming sheet behind Make Submodel, New Submodel and Group…: the next free name is
//! filled in and selected, Return confirms and Esc cancels. Also the Help › Keyboard Shortcuts sheet.
use egui::{Id, Key, Modal, RichText, Ui};

use crate::BrickMotionApp;
use crate::chrome::sheet;
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
    let modal = Modal::new(Id::unique("naming-sheet")).frame(sheet::frame(&t)).backdrop_color(sheet::backdrop(&t)).show(ui.ctx(), |ui| {
        ui.set_width(360.0);
        ui.spacing_mut().item_spacing = egui::vec2(8.0, 0.0);
        if sheet::header(ui, &t, title) {
            answer = Some(false);
        }
        sheet::body(ui, |ui| {
            ui.label(RichText::new(note).size(12.5).color(t.text2));
            ui.add_space(16.0);
            sheet::text_field(ui, &t, "Name", &mut naming.text, &mut naming.fresh);
            if ui.input(|i| i.key_pressed(Key::Enter)) {
                answer = Some(true);
            }
            ui.add_space(20.0);
            let ok = !naming.text.trim().is_empty();
            ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                if sheet::button(ui, &t, title, true, ok).clicked() {
                    answer = Some(true);
                }
                if sheet::button(ui, &t, "Cancel", false, true).clicked() {
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

/// The Keyboard Shortcuts groups, in pill order.
pub const SHORTCUT_GROUPS: [&str; 4] = ["General", "Edit", "View", "Playback"];

/// Which group a command's shortcut is listed under.
fn shortcut_group(id: &str) -> usize {
    match id.split('.').next().unwrap_or_default() {
        "edit" | "model" | "tool" => 1,
        "view" => 2,
        "transport" | "step" | "video" => 3,
        _ => 0,
    }
}

/// "⌥⌘G" as caps: each modifier on its own, then the key.
pub fn split_keys(label: &str) -> Vec<String> {
    let mut caps = Vec::new();
    let mut rest = label;
    while let Some(c) = rest.chars().next().filter(|c| "⌃⌥⇧⌘".contains(*c)) {
        caps.push(c.to_string());
        rest = &rest[c.len_utf8()..];
    }
    if !rest.is_empty() {
        caps.push(rest.to_owned());
    }
    caps
}

/// Help › Keyboard Shortcuts: every command with a key, from the registry, grouped under pills.
fn shortcuts(ui: &mut Ui, app: &mut BrickMotionApp) {
    if !app.shortcuts_open {
        return;
    }
    let t = app.theme;
    let mut close = false;
    let mut tab = app.shortcuts_tab.min(SHORTCUT_GROUPS.len() - 1);
    let modal = Modal::new(Id::unique("shortcuts-sheet")).frame(sheet::frame(&t)).backdrop_color(sheet::backdrop(&t)).show(ui.ctx(), |ui| {
        ui.set_width(440.0);
        ui.spacing_mut().item_spacing = egui::vec2(8.0, 0.0);
        close = sheet::header(ui, &t, "Keyboard Shortcuts");
        sheet::body(ui, |ui| {
            ui.horizontal(|ui| {
                ui.spacing_mut().button_padding = egui::vec2(14.0, 0.0);
                for (i, g) in SHORTCUT_GROUPS.iter().enumerate() {
                    if sheet::pill(ui, &t, g, i == tab).clicked() {
                        tab = i;
                    }
                }
            });
            ui.add_space(16.0);
            let mut rows: Vec<_> = registry()
                .iter()
                .filter(|c| shortcut_group(c.id) == tab)
                .filter_map(|c| Some((c.title.trim_end_matches('…'), c.icon, split_keys(&Shortcut::parse(c.keys?)?.label()))))
                .collect();
            rows.sort_by(|a, b| a.0.cmp(b.0));
            rows.dedup_by(|a, b| a.0 == b.0);
            // An inset well holding the group's name and a raised card of rows.
            egui::Frame::new()
                .fill(t.bg0)
                .stroke(egui::Stroke::new(1.0, t.border))
                .corner_radius(egui::CornerRadius::same(12))
                .inner_margin(egui::Margin { left: 4, right: 4, top: 0, bottom: 4 })
                .show(ui, |ui| {
                    egui::Frame::new().inner_margin(egui::Margin { left: 14, right: 14, top: 12, bottom: 10 }).show(ui, |ui| {
                        ui.label(RichText::new(SHORTCUT_GROUPS[tab]).size(13.0).strong().color(t.text1));
                    });
                    egui::Frame::new()
                        .fill(t.bg2)
                        .stroke(egui::Stroke::new(1.0, t.border2))
                        .corner_radius(egui::CornerRadius::same(10))
                        .inner_margin(egui::Margin::symmetric(14, 6))
                        .show(ui, |ui| {
                            egui::ScrollArea::vertical().min_scrolled_height(352.0).max_height(352.0).auto_shrink([false, true]).show(ui, |ui| {
                                for (title, icon, keys) in rows {
                                    ui.allocate_ui_with_layout(
                                        egui::vec2(ui.available_width(), 44.0),
                                        egui::Layout::left_to_right(egui::Align::Center),
                                        |ui| {
                                            ui.set_min_height(44.0);
                                            crate::icons::icon(ui, icon, 16.0, t.text2);
                                            ui.add_space(4.0);
                                            ui.label(RichText::new(title).size(13.0).color(t.text1));
                                            ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                                                sheet::keycaps(ui, &t, &keys);
                                            });
                                        },
                                    );
                                }
                            });
                        });
                });
        });
    });
    app.shortcuts_tab = tab;
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

    #[test]
    fn keys_split_into_caps() {
        assert_eq!(split_keys("⌥⌘G"), ["⌥", "⌘", "G"]);
        assert_eq!(split_keys("⇧⌘Z"), ["⇧", "⌘", "Z"]);
        assert_eq!(split_keys("Space"), ["Space"]);
        assert_eq!(split_keys("⇧←"), ["⇧", "←"]);
    }
}
