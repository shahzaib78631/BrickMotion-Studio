//! The Browser's Library tab: colour chip, category selector, Recent / Frequent / Common sections,
//! and a virtualised grid of 64-pt square part tiles with background-rendered previews.
use std::time::{Duration, Instant};

use bm::library::{PartMatch, common_parts, library_parts, part_categories};
use egui::{Color32, FontId, Frame, Margin, Pos2, Rect, RichText, Sense, Stroke, StrokeKind, Ui, WidgetInfo, pos2, vec2};

use super::caption;
use crate::BrickMotionApp;
use crate::icons::{self, Icon};
use crate::previews::Preview;

const TILE_W: f32 = 64.0;
const TILE_H: f32 = 82.0;
const GAP: f32 = 6.0;
const COLS: usize = 4;
const MAX_H: f32 = 380.0;
const SEARCH_LIMIT: usize = 200;

/// Drag-and-drop payload when dragging a part tile from the Library onto the Parts lane.
#[derive(Clone, Debug)]
pub struct LibraryDrag(pub PartMatch);

#[derive(Default)]
pub struct LibraryState {
    pub category: String,
    categories: Option<Vec<String>>,
    common: Option<Vec<PartMatch>>,
    query_key: Option<(String, String)>,
    results: Vec<PartMatch>,
    pub last_show: Duration,
}

impl LibraryState {
    fn categories(&mut self) -> &[String] {
        self.categories.get_or_insert_with(part_categories)
    }

    fn common(&mut self) -> &[PartMatch] {
        self.common.get_or_insert_with(common_parts)
    }

    fn sync_results(&mut self, query: &str) {
        let key = (query.trim().to_owned(), self.category.clone());
        if self.query_key.as_ref() == Some(&key) {
            return;
        }
        self.results = if key.0.is_empty() && key.1.is_empty() {
            Vec::new()
        } else {
            library_parts(&key.0, &key.1, SEARCH_LIMIT)
        };
        self.query_key = Some(key);
    }

    /// The parts currently listed for a non-empty filter or category (tests read it).
    #[doc(hidden)]
    pub fn results(&self) -> &[PartMatch] {
        &self.results
    }
}

/// Part filename without the trailing `.dat` extension.
pub fn short_name(name: &str) -> &str {
    name.strip_suffix(".dat").unwrap_or(name)
}

pub fn show(ui: &mut Ui, app: &mut BrickMotionApp) {
    let t0 = Instant::now();
    let t = app.theme;
    let colour = app.edit.colour;
    let colors = app.colors();
    let color_info = colors.iter().find(|c| c.code == colour);
    let swatch = color_info.map(|c| Color32::from_rgb(c.rgb[0], c.rgb[1], c.rgb[2])).unwrap_or(Color32::from_rgb(0xa0, 0xa5, 0xa9));
    let color_name = color_info.map(|c| c.name.as_str()).unwrap_or("Light Bluish Gray");

    // Top controls: new-part colour chip + category selector.
    ui.horizontal(|ui| {
        ui.spacing_mut().item_spacing.x = 6.0;

        // Colour chip button.
        let chip_w = 112.0;
        let (cr, cresp) = ui.allocate_exact_size(vec2(chip_w, 24.0), Sense::click());
        cresp.widget_info(|| WidgetInfo::labeled(egui::Role::Button, true, format!("New part colour: {color_name}")));
        let fill = if cresp.hovered() { t.bg3 } else { t.bg1 };
        ui.painter().rect(cr, 5.0, fill, Stroke::new(1.0, t.border), StrokeKind::Inside);
        let sw = Rect::from_center_size(pos2(cr.left() + 12.0, cr.center().y), vec2(12.0, 12.0));
        ui.painter().rect(sw, 3.0, swatch, Stroke::new(1.0, t.border2), StrokeKind::Inside);
        let galley = ui.painter().layout_no_wrap(color_name.to_owned(), FontId::proportional(11.5), t.text1);
        let text_clip = Rect::from_min_max(pos2(sw.right() + 5.0, cr.top()), pos2(cr.right() - 6.0, cr.bottom()));
        ui.painter()
            .with_clip_rect(text_clip)
            .galley(pos2(text_clip.left(), cr.center().y - galley.size().y / 2.0), galley, t.text1);
        if cresp.on_hover_text(format!("New part colour: {color_name} ({colour})")).clicked() {
            app.swatches.open(super::swatches::Target::NewParts);
        }

        // Category ComboBox.
        let categories: Vec<String> = app.library.categories().to_vec();
        let selected_label = if app.library.category.is_empty() {
            "All parts".to_owned()
        } else {
            app.library.category.clone()
        };
        egui::ComboBox::from_id_salt("library-category")
            .selected_text(RichText::new(selected_label).size(11.5))
            .width(ui.available_width().max(100.0))
            .show_ui(ui, |ui| {
                ui.selectable_value(&mut app.library.category, String::new(), "All parts");
                for cat in &categories {
                    ui.selectable_value(&mut app.library.category, cat.clone(), cat);
                }
            });
    });

    ui.add_space(6.0);

    let query = app.filter.trim().to_owned();
    let category = app.library.category.clone();
    let browsing_default = query.is_empty() && category.is_empty();
    let mut picked: Option<PartMatch> = None;

    if browsing_default {
        // Default landing: Recent, Frequent, Common sections.
        let recent: Vec<PartMatch> = app
            .history
            .recent_parts()
            .into_iter()
            .map(|e| PartMatch { name: e.name.clone(), description: e.description.clone(), category: e.category.clone() })
            .collect();
        let frequent: Vec<PartMatch> = app
            .history
            .frequent_parts()
            .into_iter()
            .map(|e| PartMatch { name: e.name.clone(), description: e.description.clone(), category: e.category.clone() })
            .collect();
        let common: Vec<PartMatch> = app.library.common().to_vec();

        egui::ScrollArea::vertical()
            .id_salt("library-sections")
            .min_scrolled_height(300.0)
            .max_height(MAX_H)
            .auto_shrink([false, true])
            .show(ui, |ui| {
            ui.spacing_mut().item_spacing.y = 6.0;
            for (heading, items) in [("Recent", recent.as_slice()), ("Frequent", frequent.as_slice()), ("Common", common.as_slice())] {
                if items.is_empty() {
                    continue;
                }
                ui.label(caption(heading, &t));
                for chunk in items.chunks(COLS) {
                    if let Some(p) = tile_row(ui, app, chunk, colour) {
                        picked = Some(p);
                    }
                }
                ui.add_space(2.0);
            }
        });
    } else {
        app.library.sync_results(&query);
        let results: Vec<PartMatch> = app.library.results.clone();
        if results.is_empty() {
            ui.add_space(8.0);
            ui.horizontal(|ui| {
                ui.add_space(8.0);
                ui.label(caption("No matching parts", &t).size(12.0));
            });
        } else {
            let row_count = results.len().div_ceil(COLS);
            egui::ScrollArea::vertical()
                .id_salt("library-grid")
                .min_scrolled_height(300.0)
                .max_height(MAX_H)
                .auto_shrink([false, true])
                .show_rows(ui, TILE_H + GAP, row_count, |ui, range| {
                    ui.spacing_mut().item_spacing.y = GAP;
                    for row_idx in range {
                        let start = row_idx * COLS;
                        let end = (start + COLS).min(results.len());
                        if let Some(p) = tile_row(ui, app, &results[start..end], colour) {
                            picked = Some(p);
                        }
                    }
                });
        }
    }

    if let Some(part) = picked {
        app.begin_placement(part);
    }
    app.library.last_show = t0.elapsed();
}

fn tile_row(ui: &mut Ui, app: &mut BrickMotionApp, items: &[PartMatch], colour: i32) -> Option<PartMatch> {
    let mut picked = None;
    ui.horizontal(|ui| {
        ui.spacing_mut().item_spacing.x = GAP;
        for part in items {
            if part_tile(ui, app, part, colour) {
                picked = Some(part.clone());
            }
        }
    });
    picked
}

/// One 64-pt square part tile with its short name underneath, hover card, and DnD payload.
pub fn part_tile(ui: &mut Ui, app: &mut BrickMotionApp, part: &PartMatch, colour: i32) -> bool {
    let t = app.theme;
    let short = short_name(&part.name);
    let (rect, resp) = ui.allocate_exact_size(vec2(TILE_W, TILE_H), Sense::click_and_drag());
    resp.widget_info(|| WidgetInfo::labeled(egui::Role::Button, true, short));
    if resp.drag_started() {
        egui::DragAndDrop::set_payload(ui.ctx(), LibraryDrag(part.clone()));
    }
    if resp.dragged()
        && let Some(pos) = ui.input(|i| i.pointer.latest_pos())
    {
        egui::Area::new(egui::Id::unique("lib-drag-pill"))
            .order(egui::Order::Tooltip)
            .interactable(false)
            .fixed_pos(pos + vec2(12.0, 12.0))
            .show(ui.ctx(), |ui| {
                Frame::NONE
                    .fill(t.bg2)
                    .stroke(Stroke::new(1.0, t.accent))
                    .corner_radius(6)
                    .inner_margin(Margin::symmetric(8, 4))
                    .show(ui, |ui| {
                        ui.label(RichText::new(short).size(11.5).color(t.text1));
                    });
            });
    }

    let img_rect = Rect::from_min_size(rect.min, vec2(TILE_W, TILE_W));
    let bg = if resp.hovered() { t.bg3 } else { t.bg1 };
    let border = if resp.hovered() { t.accent } else { t.border };
    ui.painter().rect(img_rect, 6.0, bg, Stroke::new(1.0, border), StrokeKind::Inside);

    match app.previews.get(ui.ctx(), &part.name, colour) {
        Preview::Ready(tex) => {
            let uv = Rect::from_min_max(Pos2::ZERO, pos2(1.0, 1.0));
            ui.painter().image(tex.id(), img_rect.shrink(3.0), uv, Color32::WHITE);
        }
        Preview::Pending => {
            icons::paint(ui, Icon::Brick, img_rect.shrink(20.0), 20.0, t.text3);
        }
        Preview::Missing => {
            icons::paint(ui, Icon::Brick, img_rect.shrink(20.0), 20.0, t.border2);
        }
    }

    let label_rect = Rect::from_min_max(pos2(rect.left(), img_rect.bottom() + 2.0), rect.max);
    let galley = ui.painter().layout_no_wrap(short.to_owned(), FontId::proportional(11.0), if resp.hovered() { t.text1 } else { t.text2 });
    let lx = (label_rect.center().x - galley.size().x / 2.0).max(label_rect.left());
    ui.painter()
        .with_clip_rect(label_rect)
        .galley(pos2(lx, label_rect.center().y - galley.size().y / 2.0), galley, t.text2);

    let resp = resp.on_hover_ui(|ui| {
        Frame::NONE.inner_margin(Margin::same(2)).show(ui, |ui| {
            ui.set_max_width(240.0);
            ui.label(RichText::new(&part.description).strong().color(t.text1));
            ui.horizontal(|ui| {
                ui.label(RichText::new(&part.name).size(11.0).color(t.text3));
                if !part.category.is_empty() {
                    ui.label(RichText::new(format!("· {}", part.category)).size(11.0).color(t.text3));
                }
            });
        });
    });

    resp.clicked()
}
