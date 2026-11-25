//! The floating Properties panel, right of the viewport: the project when nothing is selected,
//! one piece, or a summary of many.
use std::collections::BTreeMap;

use egui::{Area, CollapsingHeader, Color32, Frame, Id, Margin, Order, Rect, RichText, Sense, Stroke, Ui, vec2};

use super::{float_frame, icon_button, panel_header};
use crate::BrickMotionApp;
use crate::icons::Icon;

const WIDTH: f32 = 292.0;
/// Distinct parts listed for a many-piece selection.
const PART_ROWS: usize = 8;

pub fn show(ui: &mut Ui, app: &mut BrickMotionApp, area: Rect) {
    let t = app.theme;
    let snap = app.snapshot();
    let mut run: Option<&'static str> = None;
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
                Frame::NONE.inner_margin(Margin::symmetric(14, 10)).show(ui, |ui| {
                    ui.spacing_mut().item_spacing.y = 4.0;
                    match snap.selected {
                        0 => project(ui, app, &snap, &mut run),
                        1 if !snap.described.is_empty() => piece(ui, app, &snap.described[0]),
                        _ => many(ui, &t, &snap),
                    }
                });
            });
        });
    if let Some(id) = run {
        app.requested.push(id);
    }
}

fn section(ui: &mut Ui, title: &str, body: impl FnOnce(&mut Ui)) {
    CollapsingHeader::new(RichText::new(title).strong()).id_salt(("properties", title)).default_open(true).show(ui, body);
}

/// A label on the left and its value on the right.
fn row(ui: &mut Ui, t: &crate::Theme, key: &str, value: &str) {
    ui.horizontal(|ui| {
        ui.label(RichText::new(key).color(t.text3));
        ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
            ui.add(egui::Label::new(RichText::new(value).color(t.text1)).truncate());
        });
    });
}

fn project(ui: &mut Ui, app: &mut BrickMotionApp, snap: &bm::Snapshot, run: &mut Option<&'static str>) {
    let t = app.theme;
    let title = app.title();
    let file = match app.state.save_path() {
        Some(p) => p.display().to_string(),
        None => "Not saved".into(),
    };
    let imported = app.state.imported.then(|| app.state.path.as_ref().and_then(|p| p.file_name())).flatten().map(|n| n.to_string_lossy().into_owned());
    app.tree.sync(app.doc.session());
    let submodels = app.tree.submodels();
    // Read live: saving changes neither the version nor the selection the snapshot is cached on.
    let edited = app.has_document && app.doc.session().dirty();
    section(ui, "Project", |ui| {
        row(ui, &t, "Title", &title);
        row(ui, &t, "File", &file);
        if let Some(src) = &imported {
            row(ui, &t, "Imported from", src);
        }
        row(ui, &t, "Pieces", &snap.pieces.to_string());
        row(ui, &t, "Submodels", &submodels.to_string());
        if snap.hidden > 0 {
            ui.horizontal(|ui| {
                ui.label(RichText::new("Hidden").color(t.text3));
                ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                    if ui.link("Show All").clicked() {
                        *run = Some("edit.show_all");
                    }
                    ui.label(RichText::new(snap.hidden.to_string()).color(t.text1));
                });
            });
        }
        if app.has_document {
            row(ui, &t, "State", if edited { "Edited" } else { "Saved" });
        }
    });
}

fn piece(ui: &mut Ui, app: &mut BrickMotionApp, p: &bm::PieceInfo) {
    let t = app.theme;
    let colors = app.colors();
    let swatch = colors.iter().find(|c| c.code == p.color).map(|c| Color32::from_rgb(c.rgb[0], c.rgb[1], c.rgb[2]));
    section(ui, "Piece", |ui| {
        ui.label(RichText::new(&p.description).strong().color(t.text1));
        ui.label(RichText::new(&p.part).color(t.text3));
        ui.add_space(4.0);
        ui.horizontal(|ui| {
            ui.label(RichText::new("Colour").color(t.text3));
            ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                ui.label(RichText::new(&p.color_name).color(t.text1));
                let (r, _) = ui.allocate_exact_size(vec2(14.0, 14.0), Sense::hover());
                ui.painter().rect(r, 3.0, swatch.unwrap_or(t.bg3), Stroke::new(1.0, t.border2), egui::StrokeKind::Inside);
            });
        });
        row(ui, &t, "Step", &(p.step + 1).to_string());
        let place = if p.submodel_path.is_empty() { "Main model".to_owned() } else { p.submodel_path.replace('/', " › ") };
        row(ui, &t, "In", &place);
        if p.in_shared_submodel {
            ui.add_space(4.0);
            ui.label(RichText::new("Shared submodel: edits change every use").color(t.text2).size(11.5));
        }
    });
}

fn many(ui: &mut Ui, t: &crate::Theme, snap: &bm::Snapshot) {
    let mut parts: BTreeMap<&str, usize> = BTreeMap::new();
    for p in &snap.described {
        *parts.entry(p.description.as_str()).or_default() += 1;
    }
    let mut parts: Vec<(&str, usize)> = parts.into_iter().collect();
    parts.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(b.0)));
    section(ui, &format!("{} pieces", snap.selected), |ui| {
        for (desc, n) in parts.iter().take(PART_ROWS) {
            ui.add(egui::Label::new(RichText::new(format!("{n} × {desc}")).color(t.text1)).truncate());
        }
        if parts.len() > PART_ROWS {
            ui.label(RichText::new(format!("and {} more", parts.len() - PART_ROWS)).color(t.text3));
        }
        if snap.selected > snap.described.len() {
            ui.add_space(4.0);
            ui.label(RichText::new(format!("Showing the first {}", snap.described.len())).color(t.text3).size(11.5));
        }
    });
}
