//! The 38-px title bar beside the traffic lights: brand, File, undo, document tab, status.
use egui::{Align, Color32, CornerRadius, Frame, Layout, Panel, RichText, Sense, Stroke, Ui, Vec2, ViewportCommand};

use super::{icon_button, icon_button_tip};
use crate::BrickMotionApp;
use crate::commands::{enabled, find, title};
use crate::icons::{self, Icon};

pub fn show(ui: &mut Ui, app: &mut BrickMotionApp) {
    let t = app.theme;
    Panel::top("titlebar")
        .exact_size(38.0)
        .resizable(false)
        .show_separator_line(false)
        .frame(Frame::NONE.fill(t.bg0))
        .show(ui, |ui| {
            let bar = ui.max_rect();
            // The empty bar moves the window.
            let drag = ui.interact(bar, ui.scope_id().with("drag"), Sense::click_and_drag());
            if drag.drag_started() {
                ui.ctx().send_viewport_cmd(ViewportCommand::StartDrag);
            }
            ui.painter().hline(bar.x_range(), bar.bottom() - 0.5, Stroke::new(1.0, t.border));
            ui.horizontal_centered(|ui| {
                ui.spacing_mut().item_spacing.x = 6.0;
                ui.add_space(78.0); // traffic lights
                icons::icon(ui, Icon::Brick, 16.0, t.playhead);
                ui.label(RichText::new("BrickMotion").strong().color(t.text1));
                ui.add_space(6.0);
                if icon_button(ui, &t, Icon::Home, "Open…", true, false, 28.0).clicked() {
                    app.requested.push("file.open");
                }
                ui.menu_button(RichText::new("File").color(t.text2), |ui| file_menu(ui, app));
                let ctx = app.ctx();
                for (icon, id) in [(Icon::Undo, "edit.undo"), (Icon::Redo, "edit.redo")] {
                    let c = find(id).expect("registered");
                    let (name, on) = (title(c, &ctx), enabled(c, &ctx));
                    let tip = if on { name.clone() } else { format!("{} — nothing to {}", c.title, c.title.to_lowercase()) };
                    if icon_button_tip(ui, &t, icon, c.title, &tip, on, false, 28.0).clicked() {
                        app.requested.push(c.id);
                    }
                }
                let edited = app.has_document && app.doc.session().dirty();
                document_tab(ui, &t, &app.title(), edited, bar);
                ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                    ui.spacing_mut().item_spacing.x = 4.0;
                    icon_button(ui, &t, Icon::Help, "Help", false, false, 28.0);
                    icon_button(ui, &t, Icon::Gear, "Preferences", false, false, 28.0);
                    let n = app.piece_count();
                    ui.label(RichText::new(format!("{n} {}", if n == 1 { "piece" } else { "pieces" })).color(t.text3));
                });
            });
        });
}

/// The open document as a tab that joins the ribbon below it.
fn document_tab(ui: &mut Ui, t: &crate::Theme, title: &str, edited: bool, bar: egui::Rect) {
    let galley = ui.painter().layout_no_wrap(title.to_owned(), egui::FontId::proportional(12.5), t.text1);
    let dot = if edited { 14.0 } else { 0.0 };
    let (slot, resp) = ui.allocate_exact_size(Vec2::new(galley.size().x + 24.0 + dot, 30.0), Sense::hover());
    resp.widget_info(|| egui::WidgetInfo::labeled(egui::Role::Label, true, title));
    if edited {
        resp.on_hover_text("Edited");
    }
    let r = egui::Rect::from_min_max(egui::pos2(slot.left(), bar.top() + 8.0), egui::pos2(slot.right(), bar.bottom() + 1.0));
    let p = ui.painter();
    p.rect(r, CornerRadius { nw: 7, ne: 7, sw: 0, se: 0 }, t.bg2, Stroke::new(1.0, t.border), egui::StrokeKind::Inside);
    p.hline(r.x_range().shrink(1.0), bar.bottom() - 0.5, Stroke::new(1.5, t.bg2));
    let x = r.left() + 12.0 + galley.size().x;
    p.galley(egui::pos2(r.left() + 12.0, r.center().y - galley.size().y / 2.0), galley, Color32::WHITE);
    if edited {
        p.circle_filled(egui::pos2(x + 9.0, r.center().y), 3.0, t.text2);
    }
}

/// New, Open, Open Recent, Save and Save As, each with its shortcut and state.
fn file_menu(ui: &mut Ui, app: &mut BrickMotionApp) {
    let ctx = app.ctx();
    let item = |ui: &mut Ui, app: &mut BrickMotionApp, id: &'static str| {
        let c = find(id).expect("registered");
        let b = egui::Button::new(title(c, &ctx)).shortcut_text(c.keys.unwrap_or(""));
        if ui.add_enabled(enabled(c, &ctx), b).clicked() {
            app.requested.push(c.id);
            ui.close();
        }
    };
    item(ui, app, "file.new");
    item(ui, app, "file.open");
    let recent: Vec<std::path::PathBuf> = app.recents.existing().into_iter().map(|p| p.to_path_buf()).collect();
    ui.menu_button("Open Recent", |ui| {
        if recent.is_empty() {
            ui.add_enabled(false, egui::Button::new("No recent files"));
        }
        for p in &recent {
            let name = p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
            if ui.button(name).on_hover_text(p.display().to_string()).clicked() {
                app.open(p.clone());
                ui.close();
            }
        }
        ui.separator();
        if ui.add_enabled(!app.recents.0.is_empty(), egui::Button::new("Clear Menu")).clicked() {
            app.recents.clear();
            let _ = app.recents.save(&app.support);
            ui.close();
        }
    });
    ui.separator();
    item(ui, app, "file.save");
    item(ui, app, "file.save_as");
}
