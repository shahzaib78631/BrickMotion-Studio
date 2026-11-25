//! The floating Properties panel, right of the viewport: the project when nothing is selected,
//! one piece, or a summary of many.
use std::collections::BTreeMap;

use egui::{Area, CollapsingHeader, Color32, Frame, Id, Margin, Order, Rect, RichText, Sense, Stroke, Ui, vec2};

use super::{float_frame, icon_button, icon_button_tip, panel_header};
use crate::BrickMotionApp;
use crate::icons::Icon;

const INSPECTOR_WIDTH: f32 = 292.0;
pub const SETTINGS_WIDTH: f32 = 344.0;
/// Distinct parts listed for a many-piece selection.
const PART_ROWS: usize = 8;

/// Which page the right-hand Properties panel is currently showing.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub enum Page {
    #[default]
    Inspector,
    BuildSettings,
    Staging,
    SnapSound,
}

impl Page {
    pub fn is_settings(self) -> bool {
        self != Page::Inspector
    }

    pub fn title(self) -> &'static str {
        match self {
            Page::Inspector => "Properties",
            Page::BuildSettings => "Build Settings",
            Page::Staging => "Build Staging",
            Page::SnapSound => "Snap Sound",
        }
    }
}

pub fn show(ui: &mut Ui, app: &mut BrickMotionApp, area: Rect) {
    let t = app.theme;
    let page = app.properties_page;
    let width = if page.is_settings() { SETTINGS_WIDTH } else { INSPECTOR_WIDTH };
    let top = if page.is_settings() { area.top() + 10.0 } else { area.top() + 122.0 };
    let max_h = (area.bottom() - top - 12.0).max(200.0);

    let mut run: Option<&'static str> = None;
    let mut go_back = false;

    Area::new(Id::unique("properties"))
        .order(Order::Middle)
        .fixed_pos(egui::pos2(area.right() - 10.0 - width, top))
        .constrain_to(area)
        .show(ui.ctx(), |ui| {
            let mut frame = float_frame(&t);
            if page.is_settings() {
                frame = frame.fill(Color32::from_rgba_unmultiplied(0x1c, 0x1d, 0x21, 251));
            }
            frame.show(ui, |ui| {
                ui.set_width(width);
                ui.set_max_height(max_h);
                ui.spacing_mut().item_spacing.y = 0.0;

                if page == Page::Inspector {
                    let snap = app.snapshot();
                    panel_header(ui, &t, "Properties", |ui| {
                        icon_button(ui, &t, Icon::Close, "Hide Properties", false, false, 24.0);
                    });
                    Frame::NONE.inner_margin(Margin::symmetric(14, 10)).show(ui, |ui| {
                        ui.spacing_mut().item_spacing.y = 4.0;
                        match snap.selected {
                            0 => project(ui, app, &snap, &mut run),
                            1 if !snap.described.is_empty() => piece(ui, app, &snap.described[0], &mut run),
                            _ => many(ui, app, &snap),
                        }
                    });
                } else {
                    if page_header(ui, &t, page.title()) {
                        go_back = true;
                    }
                    let body_max_h = (max_h - 40.0).max(160.0);
                    match page {
                        Page::Inspector => {}
                        Page::BuildSettings => super::build_settings::show(ui, app, body_max_h),
                        Page::Staging => super::staging::show(ui, app, body_max_h),
                        Page::SnapSound => {
                            egui::ScrollArea::vertical()
                                .id_salt(("properties-page", page))
                                .max_height(body_max_h)
                                .auto_shrink([false, true])
                                .show(ui, |ui| {
                                    ui.add_space(12.0);
                                    ui.label(RichText::new(page.title()).color(t.text2));
                                });
                        }
                    }
                }
            });
        });

    if go_back {
        app.properties_page = Page::Inspector;
    }
    if let Some(id) = run {
        app.requested.push(id);
    }
}

fn page_header(ui: &mut Ui, t: &crate::Theme, title: &str) -> bool {
    let mut back = false;
    Frame::NONE
        .inner_margin(Margin { left: 8, right: 10, top: 0, bottom: 0 })
        .show(ui, |ui| {
            ui.set_height(40.0);
            ui.horizontal_centered(|ui| {
                if icon_button_tip(ui, t, Icon::Back, "Back to Properties", "Back to Properties", true, false, 26.0)
                    .clicked()
                {
                    back = true;
                }
                ui.add_space(2.0);
                ui.label(RichText::new(title).size(13.0).strong().color(t.text1));
            });
        });
    let r = ui.min_rect();
    ui.painter().hline(r.x_range(), ui.cursor().top(), Stroke::new(0.5, Color32::from_white_alpha(18)));
    back
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

fn piece(ui: &mut Ui, app: &mut BrickMotionApp, p: &bm::PieceInfo, run: &mut Option<&'static str>) {
    let t = app.theme;
    let colors = app.colors();
    let swatch = colors.iter().find(|c| c.code == p.color).map(|c| Color32::from_rgb(c.rgb[0], c.rgb[1], c.rgb[2]));
    section(ui, "Piece", |ui| {
        ui.label(RichText::new(&p.description).strong().color(t.text1));
        ui.horizontal(|ui| {
            ui.label(RichText::new(&p.part).color(t.text3));
            ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                let btn = egui::Button::new(RichText::new("Replace…").size(11.5).color(t.text1))
                    .fill(t.bg1)
                    .stroke(Stroke::new(1.0, t.border))
                    .min_size(vec2(0.0, 22.0));
                if ui.add(btn).clicked() {
                    *run = Some("model.replace");
                }
            });
        });
        ui.add_space(4.0);
        if colour_button_row(ui, &t, swatch, &p.color_name) {
            app.swatches.open(super::swatches::Target::Selection);
        }
        row(ui, &t, "Step", &(p.step + 1).to_string());
        let place = if p.submodel_path.is_empty() { "Main model".to_owned() } else { p.submodel_path.replace('/', " › ") };
        row(ui, &t, "In", &place);
        if p.in_shared_submodel {
            ui.add_space(4.0);
            ui.label(RichText::new("Shared submodel: edits change every use").color(t.text2).size(11.5));
        }
    });
}

fn colour_button_row(ui: &mut Ui, t: &crate::Theme, swatch: Option<Color32>, name: &str) -> bool {
    let mut clicked = false;
    ui.horizontal(|ui| {
        ui.label(RichText::new("Colour").color(t.text3));
        ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
            let text_galley = ui.painter().layout_no_wrap(name.to_owned(), egui::FontId::proportional(12.5), t.text1);
            let w = text_galley.size().x + 14.0 + 6.0 + 10.0;
            let (r, resp) = ui.allocate_exact_size(vec2(w, 22.0), Sense::click());
            resp.widget_info(|| egui::WidgetInfo::labeled(egui::Role::Button, true, name));
            if resp.hovered() {
                ui.painter().rect_filled(r, 4.0, t.bg3);
            }
            let sw = Rect::from_center_size(egui::pos2(r.left() + 12.0, r.center().y), vec2(14.0, 14.0));
            ui.painter().rect(sw, 3.0, swatch.unwrap_or(t.bg3), Stroke::new(1.0, t.border2), egui::StrokeKind::Inside);
            ui.painter().galley(egui::pos2(sw.right() + 6.0, r.center().y - text_galley.size().y / 2.0), text_galley, t.text1);
            if resp.on_hover_text("Change colour").clicked() {
                clicked = true;
            }
        });
    });
    clicked
}

fn many(ui: &mut Ui, app: &mut BrickMotionApp, snap: &bm::Snapshot) {
    let t = app.theme;
    let colors = app.colors();
    let first_code = snap.described.first().map(|p| p.color);
    let same_color = first_code.filter(|&code| snap.described.iter().all(|p| p.color == code));
    let swatch = same_color.and_then(|code| colors.iter().find(|c| c.code == code)).map(|c| Color32::from_rgb(c.rgb[0], c.rgb[1], c.rgb[2]));
    let color_label = same_color
        .and_then(|_| snap.described.first().map(|p| p.color_name.as_str()))
        .unwrap_or("Mixed");

    let mut parts: BTreeMap<&str, usize> = BTreeMap::new();
    for p in &snap.described {
        *parts.entry(p.description.as_str()).or_default() += 1;
    }
    let mut parts: Vec<(&str, usize)> = parts.into_iter().collect();
    parts.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(b.0)));
    section(ui, &format!("{} pieces", snap.selected), |ui| {
        if colour_button_row(ui, &t, swatch, color_label) {
            app.swatches.open(super::swatches::Target::Selection);
        }
        ui.add_space(2.0);
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
