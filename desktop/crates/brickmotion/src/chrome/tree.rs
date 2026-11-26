//! The Browser's Models tab: the engine's outline as a tree. Rebuilt only when the document's
//! structure changes; only the rows on screen are laid out, so a model with thousands of
//! submodel uses scrolls as fast as a small one.
use std::collections::{HashMap, HashSet};
use std::time::{Duration, Instant};

use egui::{Align2, FontId, Rect, Sense, Ui, pos2, vec2};

use crate::BrickMotionApp;
use crate::icons::{self, Icon};

const ROW_H: f32 = 24.0;
const INDENT: f32 = 16.0;
const MAX_H: f32 = 420.0;

#[derive(Default)]
pub struct Tree {
    rows: Vec<bm::OutlineRow>,
    has_children: Vec<bool>,
    /// (document generation, structure version) the rows were built for.
    built_for: Option<(u64, u64)>,
    /// Open rows, by outline id.
    open: HashSet<String>,
    /// Pieces under each row, fetched when first needed; cleared on rebuild.
    pieces: HashMap<usize, Vec<u32>>,
    /// How many times the rows were rebuilt (tests read it).
    pub rebuilds: usize,
    /// How long the last `show` took.
    pub last_show: Duration,
}

/// What a click on a row does to the selection.
fn mode(m: egui::Modifiers) -> bm::SelectMode {
    if m.command {
        bm::SelectMode::Toggle
    } else if m.shift {
        bm::SelectMode::Add
    } else {
        bm::SelectMode::Replace
    }
}

impl Tree {
    /// Rebuilds from `s` when its document or structure changed. The root starts open.
    pub fn sync(&mut self, s: &bm::Session) {
        let key = (s.generation(), s.structure_version());
        if self.built_for == Some(key) {
            return;
        }
        let new_document = self.built_for.map(|k| k.0) != Some(key.0);
        self.rows = s.outline();
        self.has_children = vec![false; self.rows.len()];
        for r in &self.rows {
            if let Some(p) = r.parent {
                self.has_children[p] = true;
            }
        }
        if new_document {
            self.open.clear();
            self.open.insert("root".into());
        }
        self.pieces.clear();
        self.built_for = Some(key);
        self.rebuilds += 1;
    }

    /// The distinct submodels the outline shows.
    pub fn submodels(&self) -> usize {
        self.rows.iter().filter(|r| !r.def.is_empty()).map(|r| r.def.as_str()).collect::<HashSet<_>>().len()
    }

    pub fn len(&self) -> usize {
        self.rows.len()
    }

    pub fn is_empty(&self) -> bool {
        self.rows.is_empty()
    }

    /// Opens every row (tests, and a future Expand All).
    pub fn open_all(&mut self) {
        self.open = self.rows.iter().map(|r| r.id.clone()).collect();
    }

    fn ancestors_open(&self, mut i: usize) -> bool {
        while let Some(p) = self.rows[i].parent {
            if !self.open.contains(&self.rows[p].id) {
                return false;
            }
            i = p;
        }
        true
    }

    /// The rows to show, in order. With a filter: rows whose name holds it (any case) and their
    /// ancestors, open or not.
    pub fn visible(&self, filter: &str) -> Vec<usize> {
        let f = filter.trim().to_lowercase();
        if f.is_empty() {
            return (0..self.rows.len()).filter(|&i| self.ancestors_open(i)).collect();
        }
        let mut keep = vec![false; self.rows.len()];
        for (i, r) in self.rows.iter().enumerate() {
            if r.name.to_lowercase().contains(&f) {
                let mut j = Some(i);
                while let Some(k) = j {
                    if keep[k] {
                        break;
                    }
                    keep[k] = true;
                    j = self.rows[k].parent;
                }
            }
        }
        (0..self.rows.len()).filter(|&i| keep[i]).collect()
    }

    fn pieces_of(&mut self, s: &bm::Session, i: usize) -> &[u32] {
        let id = &self.rows[i].id;
        self.pieces.entry(i).or_insert_with(|| s.pieces_of_row(id))
    }
}

pub fn show(ui: &mut Ui, app: &mut BrickMotionApp) {
    let t0 = Instant::now();
    let t = app.theme;
    app.tree.sync(app.doc.session());
    let shown = app.tree.visible(&app.filter);
    let filtering = !app.filter.trim().is_empty();
    let selection: HashSet<u32> = app.doc.session().selection().into_iter().collect();
    let first_unused = shown.iter().position(|&i| app.tree.rows[i].unused);
    // One extra line for the "Not used" header.
    let lines = shown.len() + first_unused.is_some() as usize;
    let mut clicked: Option<(usize, egui::Modifiers)> = None;
    let mut toggled: Option<usize> = None;
    let mut exported: Option<(crate::FileExport, String)> = None;
    let mut video: Option<String> = None;
    egui::ScrollArea::vertical().max_height(MAX_H).auto_shrink([false, true]).show_rows(ui, ROW_H, lines, |ui, range| {
        for line in range {
            let k = match first_unused {
                Some(u) if line == u => {
                    let (r, _) = ui.allocate_exact_size(vec2(ui.available_width(), ROW_H), Sense::hover());
                    ui.painter().text(pos2(r.left() + 10.0, r.center().y), Align2::LEFT_CENTER, "Not used", FontId::proportional(11.0), t.text3);
                    continue;
                }
                Some(u) if line > u => line - 1,
                _ => line,
            };
            let i = shown[k];
            let row = &app.tree.rows[i];
            let (rect, resp) = ui.allocate_exact_size(vec2(ui.available_width(), ROW_H), Sense::click());
            let name = row.name.clone();
            resp.widget_info(|| egui::WidgetInfo::labeled(egui::Role::TreeItem, true, &name));
            let pieces_n = row.pieces;
            let all_selected = pieces_n > 0 && {
                let p = app.tree.pieces_of(app.doc.session(), i);
                !p.is_empty() && p.iter().all(|x| selection.contains(x))
            };
            let row = &app.tree.rows[i];
            if all_selected {
                ui.painter().rect_filled(rect, t.radius, t.accent_bg());
            } else if resp.hovered() {
                ui.painter().rect_filled(rect, t.radius, t.bg3);
            }
            let x = rect.left() + 4.0 + row.depth as f32 * INDENT;
            let y = rect.center().y;
            if app.tree.has_children[i] {
                let open = filtering || app.tree.open.contains(&row.id);
                let dr = Rect::from_center_size(pos2(x + 8.0, y), vec2(16.0, 16.0));
                let d = ui.interact(dr, resp.id.with("disclosure"), Sense::click());
                icons::paint(ui, if open { Icon::Down } else { Icon::Chevron }, dr.shrink(2.0), 12.0, t.text3);
                if d.clicked() && !filtering {
                    toggled = Some(i);
                }
            }
            let dim = row.unused;
            let icon = if row.depth == 0 && !row.unused { Icon::Brick } else { Icon::Layers };
            icons::paint(ui, icon, Rect::from_center_size(pos2(x + 26.0, y), vec2(14.0, 14.0)), 14.0, if row.depth == 0 && !dim { t.playhead } else { t.text3 });
            let mut right = rect.right() - 8.0;
            let count = ui.painter().text(pos2(right, y), Align2::RIGHT_CENTER, row.pieces.to_string(), FontId::proportional(11.5), t.text3);
            right = count.left() - 6.0;
            if row.shared {
                let r = ui.painter().text(pos2(right, y), Align2::RIGHT_CENTER, format!("×{}", row.uses), FontId::proportional(11.0), t.text3);
                right = r.left() - 6.0;
            }
            let text_rect = Rect::from_min_max(pos2(x + 38.0, rect.top()), pos2(right, rect.bottom()));
            let galley = ui.painter().layout(row.name.clone(), FontId::proportional(12.5), if dim { t.text3 } else { t.text1 }, f32::INFINITY);
            ui.painter().with_clip_rect(text_rect).galley(pos2(text_rect.left(), y - galley.size().y / 2.0), galley, t.text1);
            if resp.clicked() {
                clicked = Some((i, ui.input(|inp| inp.modifiers)));
            }
            let def = row.def.clone();
            if !def.is_empty() && row.pieces > 0 {
                resp.context_menu(|ui| {
                    if ui.button("Export Project…").clicked() {
                        exported = Some((crate::FileExport::SubmodelProject, def.clone()));
                        ui.close();
                    }
                    if ui.button("Export LDraw…").clicked() {
                        exported = Some((crate::FileExport::SubmodelLdraw, def.clone()));
                        ui.close();
                    }
                    if ui.button("Export Submodel Video…").clicked() {
                        video = Some(row.id.clone());
                        ui.close();
                    }
                });
            }
        }
    });
    if let Some(i) = toggled {
        let id = app.tree.rows[i].id.clone();
        if !app.tree.open.remove(&id) {
            app.tree.open.insert(id);
        }
    } else if let Some((i, m)) = clicked {
        let pieces = app.tree.pieces_of(app.doc.session(), i).to_vec();
        app.doc.session().select(&pieces, mode(m));
    }
    if let Some(id) = video {
        let targets = bm::export::submodel_video_targets(app.doc.session(), Some(&[id]));
        if !targets.is_empty() {
            super::export_movie::open(app, targets);
        }
    }
    if let Some((kind, def)) = exported {
        app.export_bytes(kind, Some(&def));
    }
    app.tree.last_show = t0.elapsed();
}
