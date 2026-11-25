//! The Browser's Parts tab: every (part, colour) and submodel used in the current model,
//! rebuilt only when `structure_version` changes and virtualised with `ScrollArea::show_rows`.
use std::collections::HashMap;
use std::time::{Duration, Instant};

use egui::{Align2, Color32, FontId, Rect, Sense, Stroke, Ui, WidgetInfo, pos2, vec2};

use super::caption;
use crate::BrickMotionApp;
use crate::chrome::library::short_name;
use crate::icons::{self, Icon};

const ROW_H: f32 = 28.0;
const MAX_H: f32 = 420.0;

#[derive(Clone, Debug)]
pub struct PartUsageRow {
    pub name: String,
    pub description: String,
    pub color: i32,
    pub color_name: String,
    pub submodel: bool,
    pub pieces: Vec<u32>,
}

#[derive(Default)]
pub struct PartsState {
    rows: Vec<PartUsageRow>,
    built_for: Option<(u64, u64)>,
    pub last_show: Duration,
}

fn select_mode(m: egui::Modifiers) -> bm::SelectMode {
    if m.command {
        bm::SelectMode::Toggle
    } else if m.shift {
        bm::SelectMode::Add
    } else {
        bm::SelectMode::Replace
    }
}

impl PartsState {
    /// Rebuilds the model's part summary when the document or its structure changed.
    pub fn sync(&mut self, s: &bm::Session) {
        let key = (s.generation(), s.structure_version());
        if self.built_for == Some(key) {
            return;
        }
        let step_count = s.steps().len();
        let mut by_part: HashMap<(String, i32), PartUsageRow> = HashMap::new();
        let mut by_sub: HashMap<String, PartUsageRow> = HashMap::new();

        for step in 0..step_count {
            for item in s.step_items(step) {
                if item.submodel {
                    let entry = by_sub.entry(item.name.clone()).or_insert_with(|| PartUsageRow {
                        name: item.name.clone(),
                        description: item.description.clone(),
                        color: item.color,
                        color_name: String::new(),
                        submodel: true,
                        pieces: Vec::new(),
                    });
                    entry.pieces.extend_from_slice(&item.pieces);
                } else {
                    let entry = by_part.entry((item.name.clone(), item.color)).or_insert_with(|| PartUsageRow {
                        name: item.name.clone(),
                        description: item.description.clone(),
                        color: item.color,
                        color_name: item.color_name.clone(),
                        submodel: false,
                        pieces: Vec::new(),
                    });
                    entry.pieces.extend_from_slice(&item.pieces);
                }
            }
        }

        let mut rows: Vec<PartUsageRow> = by_part.into_values().chain(by_sub.into_values()).collect();
        rows.sort_by(|a, b| b.pieces.len().cmp(&a.pieces.len()).then_with(|| a.name.cmp(&b.name)));
        self.rows = rows;
        self.built_for = Some(key);
    }

    pub fn rows(&self) -> &[PartUsageRow] {
        &self.rows
    }
}

pub fn show(ui: &mut Ui, app: &mut BrickMotionApp) {
    let t0 = Instant::now();
    let t = app.theme;
    app.parts.sync(app.doc.session());

    if app.parts.rows.is_empty() {
        ui.add_space(6.0);
        ui.horizontal(|ui| {
            ui.add_space(8.0);
            ui.label(caption("No parts in this model", &t).size(12.0));
        });
        app.parts.last_show = t0.elapsed();
        return;
    }

    let filter = app.filter.trim().to_lowercase();
    let shown: Vec<usize> = if filter.is_empty() {
        (0..app.parts.rows.len()).collect()
    } else {
        app.parts
            .rows
            .iter()
            .enumerate()
            .filter(|(_, r)| {
                r.name.to_lowercase().contains(&filter)
                    || r.description.to_lowercase().contains(&filter)
                    || r.color_name.to_lowercase().contains(&filter)
            })
            .map(|(i, _)| i)
            .collect()
    };

    let colors = app.colors();
    let mut clicked: Option<(usize, egui::Modifiers)> = None;

    egui::ScrollArea::vertical()
        .id_salt("parts-list")
        .max_height(MAX_H)
        .auto_shrink([false, true])
        .show_rows(ui, ROW_H, shown.len(), |ui, range| {
            for k in range {
                let i = shown[k];
                let row = &app.parts.rows[i];
                let display_name = if row.submodel {
                    row.name.clone()
                } else {
                    short_name(&row.name).to_owned()
                };
                let (rect, resp) = ui.allocate_exact_size(vec2(ui.available_width(), ROW_H), Sense::click());
                let a11y = format!("{} ({})", display_name, row.pieces.len());
                resp.widget_info(|| WidgetInfo::labeled(egui::Role::Button, true, &a11y));
                if resp.hovered() {
                    ui.painter().rect_filled(rect, t.radius, t.bg3);
                }

                let y = rect.center().y;
                let left = rect.left() + 8.0;
                if row.submodel {
                    icons::paint(ui, Icon::Layers, Rect::from_center_size(pos2(left + 6.0, y), vec2(14.0, 14.0)), 14.0, t.accent);
                } else {
                    let sw = colors
                        .iter()
                        .find(|c| c.code == row.color)
                        .map(|c| Color32::from_rgb(c.rgb[0], c.rgb[1], c.rgb[2]))
                        .unwrap_or(t.text3);
                    ui.painter().circle(pos2(left + 6.0, y), 5.0, sw, Stroke::new(1.0, t.border2));
                }

                let mut right = rect.right() - 8.0;
                let count_r = ui.painter().text(
                    pos2(right, y),
                    Align2::RIGHT_CENTER,
                    row.pieces.len().to_string(),
                    FontId::proportional(11.5),
                    t.text3,
                );
                right = count_r.left() - 6.0;
                if row.submodel {
                    let tag = ui.painter().text(pos2(right, y), Align2::RIGHT_CENTER, "submodel", FontId::proportional(10.5), t.text3);
                    right = tag.left() - 6.0;
                }

                let text_x = left + 18.0;
                let clip = Rect::from_min_max(pos2(text_x, rect.top()), pos2(right, rect.bottom()));
                let ng = ui.painter().layout_no_wrap(display_name, FontId::proportional(12.0), t.text1);
                let desc_x = text_x + ng.size().x + 6.0;
                ui.painter().with_clip_rect(clip).galley(pos2(text_x, y - ng.size().y / 2.0), ng, t.text1);

                if !row.description.is_empty() && desc_x < right {
                    let dg = ui.painter().layout_no_wrap(row.description.clone(), FontId::proportional(11.0), t.text3);
                    let dclip = Rect::from_min_max(pos2(desc_x, rect.top()), pos2(right, rect.bottom()));
                    ui.painter().with_clip_rect(dclip).galley(pos2(desc_x, y - dg.size().y / 2.0), dg, t.text3);
                }

                if resp.clicked() {
                    clicked = Some((i, ui.input(|inp| inp.modifiers)));
                }
            }
        });

    if let Some((i, m)) = clicked {
        let pieces = app.parts.rows[i].pieces.clone();
        app.doc.session().select(&pieces, select_mode(m));
    }

    app.parts.last_show = t0.elapsed();
}
