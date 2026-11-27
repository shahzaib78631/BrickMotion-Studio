//! The 38-px title bar beside the traffic lights: brand, File, undo, document tab, status.
use egui::{Align, CornerRadius, Frame, Layout, Panel, RichText, Sense, Stroke, Ui, Vec2, ViewportCommand};

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
                icons::icon(ui, Icon::Brick, 16.0, t.accent);
                ui.label(RichText::new("BrickMotion").strong().color(t.text1));
                ui.add_space(6.0);
                if icon_button(ui, &t, Icon::File, "Open…", true, false, 28.0).clicked() {
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
                    ui.add_space(4.0);
                    plan_status(ui, app);
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
    p.galley(egui::pos2(r.left() + 12.0, r.center().y - galley.size().y / 2.0), galley, t.text1);
    if edited {
        p.circle_filled(egui::pos2(x + 9.0, r.center().y), 3.0, t.text2);
    }
}

/// New, Open, Open Recent, Save and Save As, each with its shortcut and state.
fn file_menu(ui: &mut Ui, app: &mut BrickMotionApp) {
    use super::menu;
    let t = app.theme;
    let ctx = app.ctx();
    menu::prepare(ui);
    let item = |ui: &mut Ui, app: &mut BrickMotionApp, id: &'static str| {
        let c = find(id).expect("registered");
        if menu::item(ui, &t, Some(c.icon), &title(c, &ctx), c.keys, enabled(c, &ctx)) {
            app.requested.push(c.id);
        }
    };
    item(ui, app, "file.new");
    item(ui, app, "file.open");
    let recent: Vec<std::path::PathBuf> = app.recents.existing().into_iter().map(|p| p.to_path_buf()).collect();
    menu::submenu(ui, &t, Some(Icon::File), "Open Recent", |ui| {
        if recent.is_empty() {
            menu::item(ui, &t, None, "No recent files", None, false);
        }
        for p in &recent {
            let name = p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
            if menu::item_tip(ui, &t, Some(Icon::File), &name, &p.display().to_string(), true) {
                app.open(p.clone());
            }
        }
        menu::separator(ui, &t);
        if menu::item(ui, &t, Some(Icon::Close), "Clear Menu", None, !app.recents.0.is_empty()) {
            app.recents.clear();
            let _ = app.recents.save(&app.support);
        }
    });
    menu::separator(ui, &t);
    item(ui, app, "file.save");
    item(ui, app, "file.save_as");
}

/// Plan status right of the title bar (before ⚙ and ?), per `m4-rulings.md`.
fn plan_status(ui: &mut Ui, app: &mut BrickMotionApp) {
    let t = app.theme;
    let n = app.piece_count();
    let pieces = format!("{n} {}", if n == 1 { "piece" } else { "pieces" });
    if app.transport.busy() {
        // Right-to-left: progress line sits to the right of the stage label.
        let (track, _) = ui.allocate_exact_size(Vec2::new(72.0, 14.0), Sense::hover());
        let bar = egui::Rect::from_center_size(track.center(), Vec2::new(72.0, 2.0));
        ui.painter().rect_filled(bar, 1.0, t.bg3);
        let phase = (ui.input(|i| i.time) * 0.9).fract() as f32;
        let seg_w = 26.0;
        let x0 = (bar.left() - seg_w + phase * (bar.width() + seg_w)).max(bar.left());
        let x1 = (bar.left() - seg_w + phase * (bar.width() + seg_w) + seg_w).min(bar.right());
        if x1 > x0 {
            ui.painter().rect_filled(
                egui::Rect::from_min_max(egui::pos2(x0, bar.top()), egui::pos2(x1, bar.bottom())),
                1.0,
                t.accent,
            );
        }
        ui.add_space(6.0);
        ui.label(RichText::new(app.transport.stage_label()).size(12.0).color(t.text2));
        return;
    }
    match app.transport.state.plan {
        bm::playback::PlanState::Failed => {
            let resp = ui
                .add(egui::Button::new(RichText::new("Plan failed").size(12.0).color(t.text2)).frame(false))
                .on_hover_text(if app.transport.failure.is_empty() {
                    "Switch to Animate to see why planning failed"
                } else {
                    app.transport.failure.as_str()
                });
            if resp.clicked() {
                app.set_workspace(crate::Workspace::Animate);
            }
        }
        bm::playback::PlanState::Ready if app.transport.state.stale => {
            let resp = ui
                .add(egui::Button::new(RichText::new("Out of date").size(12.0).color(t.text3)).frame(false))
                .on_hover_text("Model edited since the last plan — click to replan");
            if resp.clicked() {
                app.requested.push("video.plan_build");
            }
        }
        bm::playback::PlanState::Ready => {
            let label = format!("Planned · {pieces}");
            let resp = ui
                .add(egui::Button::new(RichText::new(label).size(12.0).color(t.text3)).frame(false))
                .on_hover_text("Click to refresh the build plan");
            if resp.clicked() {
                app.requested.push("video.plan_build");
            }
        }
        _ => {
            if app.has_document && n > 0 {
                let resp = ui
                    .add(egui::Button::new(RichText::new(pieces).size(12.0).color(t.text3)).frame(false))
                    .on_hover_text("Click to plan the build");
                if resp.clicked() {
                    app.requested.push("video.plan_build");
                }
            } else {
                ui.label(RichText::new(pieces).size(12.0).color(t.text3));
            }
        }
    }
}
