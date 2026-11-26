//! The floating Properties panel, right of the viewport: the project when nothing is selected,
//! one piece, or a summary of many.
use std::collections::BTreeMap;

use egui::{Area, CollapsingHeader, Color32, CursorIcon, Frame, Id, Margin, Order, Rect, RichText, Sense, Stroke, Ui, Vec2, pos2, vec2};

use super::float_panel::{HeaderSpec, draw_header};
use super::{float_frame, menu};
use crate::BrickMotionApp;
use crate::icons::{self, Icon};

const INSPECTOR_WIDTH: f32 = 292.0;
pub const SETTINGS_WIDTH: f32 = 344.0;
const MIN_WIDTH: f32 = 260.0;
const MAX_WIDTH: f32 = 520.0;
/// Distinct parts listed for a many-piece selection.
const PART_ROWS: usize = 8;

/// Session layout state for the floating Properties panel.
#[derive(Clone, Debug, Default)]
pub struct PropertiesState {
    pub hidden: bool,
    pub collapsed: bool,
    pub offset: Vec2,
    pub width: Option<f32>,
}

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

    pub fn icon(self) -> Icon {
        match self {
            Page::Inspector | Page::BuildSettings => Icon::Sliders,
            Page::Staging => Icon::Stage,
            Page::SnapSound => Icon::Wave,
        }
    }

    pub fn subtitle(self) -> &'static str {
        match self {
            Page::Inspector => "",
            Page::BuildSettings | Page::Staging | Page::SnapSound => "Project",
        }
    }
}

pub fn show(ui: &mut Ui, app: &mut BrickMotionApp, area: Rect) {
    let t = app.theme;
    let page = app.properties_page;

    // When hidden on the Inspector page, show a compact reopen pill tucked neatly on the right edge.
    if app.properties.hidden && !page.is_settings() {
        let pill_top = area.top() + super::navigator::CLEARANCE;
        let mut reopen = false;
        Area::new(Id::unique("properties-reopen"))
            .order(Order::Middle)
            .fixed_pos(pos2(area.right() - 10.0 - 108.0, pill_top))
            .constrain_to(area)
            .show(ui.ctx(), |ui| {
                float_frame(&t).corner_radius(8).inner_margin(Margin::symmetric(10, 6)).show(ui, |ui| {
                    let (r, resp) = ui.allocate_exact_size(vec2(88.0, 20.0), Sense::click());
                    resp.widget_info(|| egui::WidgetInfo::labeled(egui::Role::Button, true, "Show Properties"));
                    if resp.hovered() {
                        ui.painter().rect_filled(r.expand2(vec2(4.0, 2.0)), 6.0, t.bg3);
                    }
                    icons::paint(ui, Icon::Sliders, Rect::from_center_size(pos2(r.left() + 8.0, r.center().y), vec2(14.0, 14.0)), 14.0, t.text2);
                    ui.painter().text(
                        pos2(r.left() + 22.0, r.center().y),
                        egui::Align2::LEFT_CENTER,
                        "Properties",
                        egui::FontId::proportional(12.0),
                        if resp.hovered() { t.text1 } else { t.text2 },
                    );
                    if resp.on_hover_text("Show Properties panel").on_hover_cursor(CursorIcon::PointingHand).clicked() {
                        reopen = true;
                    }
                });
            });
        if reopen {
            app.properties.hidden = false;
        }
        return;
    }

    let max_w = (area.width() - 360.0).clamp(MIN_WIDTH, MAX_WIDTH);
    let default_w = if page.is_settings() { SETTINGS_WIDTH } else { INSPECTOR_WIDTH };
    let width = app.properties.width.unwrap_or(default_w).clamp(MIN_WIDTH, max_w);
    // Always align right-hand panels cleanly below the fixed Axis Navigator.
    let top = area.top() + super::navigator::CLEARANCE;
    let anchor = pos2(area.right() - 10.0 - width, top);
    let pos = pos2(
        (anchor.x + app.properties.offset.x).clamp(area.left() + 4.0, (area.right() - width - 4.0).max(area.left() + 4.0)),
        (anchor.y + app.properties.offset.y).clamp(area.top() + 4.0, (area.bottom() - 46.0).max(area.top() + 4.0)),
    );
    let max_h = (area.bottom() - pos.y - 12.0).max(200.0);

    let mut run: Option<&'static str> = None;
    let mut go_back = false;
    let mut hide = false;
    let mut toggle_collapse = false;
    let mut moved = Vec2::ZERO;
    let mut resize_dx = 0.0f32;

    Area::new(Id::unique("properties"))
        .order(Order::Middle)
        .fixed_pos(pos)
        .constrain_to(area)
        .show(ui.ctx(), |ui| {
            let collapsed = app.properties.collapsed;
            let frame_resp = float_frame(&t).show(ui, |ui| {
                ui.set_width(width);
                ui.set_max_height(max_h);
                ui.spacing_mut().item_spacing.y = 0.0;

                let fold_label = if collapsed { "Expand Properties" } else { "Collapse Properties" };
                let (back_lbl, close_lbl) = if page == Page::Inspector {
                    (None, Some("Hide Properties"))
                } else {
                    (Some("Back to Properties"), Some("Close"))
                };
                let head = draw_header(
                    ui,
                    &t,
                    width,
                    &HeaderSpec {
                        id_salt: if page == Page::Inspector { "properties" } else { page.title() },
                        icon: page.icon(),
                        title: page.title(),
                        subtitle: page.subtitle(),
                        folded: collapsed,
                        back_label: back_lbl,
                        fold_label: Some(fold_label),
                        close_label: close_lbl,
                        extra_actions_w: 0.0,
                    },
                    |_| {},
                );
                moved = head.moved;
                toggle_collapse = head.toggle_fold;
                if page == Page::Inspector {
                    hide = head.close;
                } else if head.back || head.close {
                    go_back = true;
                }

                if !collapsed {
                    if page == Page::Inspector {
                        let snap = app.snapshot();
                        Frame::NONE.inner_margin(Margin::symmetric(14, 10)).show(ui, |ui| {
                            ui.spacing_mut().item_spacing.y = 4.0;
                            match snap.selected {
                                0 => project(ui, app, &snap, &mut run),
                                1 if !snap.described.is_empty() => piece(ui, app, &snap.described[0], &mut run),
                                _ => many(ui, app, &snap),
                            }
                        });
                    } else {
                        let body_max_h = (max_h - super::float_panel::HEADER_H).max(160.0);
                        match page {
                            Page::Inspector => {}
                            Page::BuildSettings => super::build_settings::show(ui, app, body_max_h),
                            Page::Staging => super::staging::show(ui, app, body_max_h),
                            Page::SnapSound => super::sound::show(ui, app, body_max_h),
                        }
                    }
                }
            });

            if !collapsed {
                let r = frame_resp.response.rect;
                let left_r = Rect::from_min_max(pos2(r.left() - 3.0, r.top() + 38.0), pos2(r.left() + 5.0, r.bottom() - 4.0));
                let left_resp = ui
                    .interact(left_r, Id::unique("properties-resize-w"), Sense::drag())
                    .on_hover_cursor(CursorIcon::ResizeHorizontal);
                if left_resp.dragged() {
                    resize_dx -= left_resp.drag_delta().x;
                }
            }
        });

    if moved != Vec2::ZERO {
        let next = pos + moved - anchor;
        app.properties.offset = vec2(
            next.x.clamp(area.left() + 4.0 - anchor.x, (area.right() - width - 4.0 - anchor.x).max(0.0)),
            next.y.clamp(area.top() + 4.0 - anchor.y, (area.bottom() - 46.0 - anchor.y).max(0.0)),
        );
    }
    if resize_dx != 0.0 {
        app.properties.width = Some((width + resize_dx).clamp(MIN_WIDTH, max_w));
    }
    if hide {
        app.properties.hidden = true;
    }
    if toggle_collapse {
        app.properties.collapsed = !app.properties.collapsed;
    }
    if go_back {
        app.properties_page = Page::Inspector;
    }
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
        arrives_row(ui, app, &t);
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
        arrives_row(ui, app, &t);
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

/// "Arrives": the selected parts' insertion direction (`ArrivalDirection.swift`).
fn arrives_row(ui: &mut Ui, app: &mut BrickMotionApp, t: &crate::Theme) {
    use super::joints;
    let s = app.doc.session();
    let pieces = s.selection();
    let dirs: Vec<bm::Vec3> = pieces.iter().map(|&p| s.insertion_direction(p)).collect();
    let label = match dirs.first() {
        Some(d) if dirs.iter().all(|e| e == d) => joints::direction_label(*d),
        Some(_) => "Mixed",
        None => return,
    };
    let mut pick: Option<Option<bm::Vec3>> = None;
    ui.horizontal(|ui| {
        ui.label(RichText::new("Arrives").color(t.text3));
        ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
            let r = ui.menu_button(RichText::new(label).color(t.text1), |ui| {
                menu::prepare(ui);
                if menu::item_check(ui, t, "Automatic", label == "Automatic", true) {
                    pick = Some(Some(bm::Vec3::new(0.0, 0.0, 0.0)));
                }
                menu::separator(ui, t);
                for (name, a) in joints::AXES {
                    if menu::item_check(ui, t, name, label == name, true) {
                        pick = Some(Some(bm::Vec3::new(a[0], a[1], a[2])));
                    }
                }
                menu::separator(ui, t);
                if menu::item(ui, t, Some(Icon::Cam), "From Current View", None, true) {
                    pick = Some(None);
                }
            });
            r.response.widget_info(|| egui::WidgetInfo::labeled(egui::Role::Button, true, format!("Insertion direction, {label}")));
        });
    });
    match pick {
        Some(Some(d)) => joints::set_direction(app, d),
        Some(None) => joints::direction_from_view(app),
        None => {}
    }
}
