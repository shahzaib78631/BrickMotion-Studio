//! The Browser's Steps tab: virtualised step list, expandable items, step context menu, and
//! debounced single-undo-step editor popover.
use std::collections::{HashMap, HashSet};
use std::time::{Duration, Instant};

use bm::steps::{ItemRow, StepFields, StepRow};
use egui::{
    Align2, Area, Color32, DragValue, FontId, Id, Key, Margin, Order, Rect, RichText, Sense, Stroke, Ui, WidgetInfo,
    pos2, vec2,
};

use super::{caption, float_frame, icon_button_tip};
use crate::BrickMotionApp;
use crate::chrome::library::short_name;
use crate::commands::{enabled, find};
use crate::icons::{self, Icon};

const ROW_H: f32 = 24.0;
const COMMIT_INTERVAL: Duration = Duration::from_millis(300);

#[derive(Debug)]
pub struct StepEditor {
    pub step: usize,
    pub fields: StepFields,
    dirty: bool,
    last_write: Option<Instant>,
    fresh: bool,
}

#[derive(Default)]
pub struct StepsState {
    rows: Vec<StepRow>,
    built_for: Option<(u64, u64)>,
    seen_version: u64,
    open: HashSet<usize>,
    items: HashMap<usize, Vec<ItemRow>>,
    pieces: HashMap<usize, Vec<u32>>,
    pub editor: Option<StepEditor>,
    pub last_show: Duration,
}

enum Line {
    Step(usize),
    Item(usize, usize),
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

impl StepsState {
    /// Rebuilds the step list when the document or its structure/version changed.
    pub fn sync(&mut self, s: &bm::Session) {
        let skey = (s.generation(), s.structure_version());
        let ver = s.version();
        if self.built_for != Some(skey) {
            let new_doc = self.built_for.map(|k| k.0) != Some(skey.0);
            let old_len = self.rows.len();
            self.rows = s.steps();
            self.items.clear();
            self.pieces.clear();
            if new_doc {
                self.open.clear();
                self.editor = None;
            } else if self.rows.len() != old_len && self.editor.take().is_some() {
                // A step was added or removed under the editor: its index may now name another
                // step, so it closes without writing. (A title write also bumps the structure
                // version, so only the count is compared.)
                s.end_gesture();
            }
            self.built_for = Some(skey);
            self.seen_version = ver;
        } else if self.seen_version != ver {
            // Non-structural edit (e.g. step title/notes or undo of one): refresh step metadata only.
            self.rows = s.steps();
            self.seen_version = ver;
        }
    }

    pub fn len(&self) -> usize {
        self.rows.len()
    }

    /// The chosen step, kept inside the current list (None when there are no steps).
    pub fn clamp(&self, step: Option<usize>) -> Option<usize> {
        step.and_then(|i| (!self.rows.is_empty()).then(|| i.min(self.rows.len() - 1)))
    }

    pub fn is_empty(&self) -> bool {
        self.rows.is_empty()
    }

    pub fn row(&self, i: usize) -> Option<&StepRow> {
        self.rows.get(i)
    }

    pub fn open_all(&mut self) {
        self.open = (0..self.rows.len()).collect();
    }

    pub fn collapse_all(&mut self) {
        self.open.clear();
    }

    fn items_of(&mut self, s: &bm::Session, step: usize) -> &[ItemRow] {
        self.items.entry(step).or_insert_with(|| s.step_items(step))
    }

    fn pieces_of(&mut self, s: &bm::Session, step: usize) -> &[u32] {
        self.pieces.entry(step).or_insert_with(|| s.pieces_of_step(step))
    }

    pub fn open_editor(&mut self, step: usize, s: &bm::Session) {
        self.sync(s);
        let Some(row) = self.rows.get(step) else { return };
        s.end_gesture();
        self.editor = Some(StepEditor {
            step,
            fields: StepFields {
                title: row.title.clone(),
                notes: row.notes.clone(),
                pause_after: row.pause_after,
                pin_order: row.pin_order,
            },
            dirty: false,
            last_write: None,
            fresh: true,
        });
    }

    /// Commits any pending field change and closes the editor's undo gesture.
    pub fn close_editor(&mut self, s: &bm::Session) {
        if let Some(ed) = self.editor.take() {
            if ed.dirty {
                let _ = s.set_step_fields(ed.step, &ed.fields, true);
                self.rows = s.steps();
                self.seen_version = s.version();
            }
            s.end_gesture();
        }
    }
}

pub fn show(ui: &mut Ui, app: &mut BrickMotionApp, body_h: f32, pinned_h: bool) {
    let t0 = Instant::now();
    let t = app.theme;
    app.steps.sync(app.doc.session());
    if app.steps.rows.is_empty() {
        ui.add_space(6.0);
        ui.horizontal(|ui| {
            ui.add_space(8.0);
            ui.label(caption("No steps yet", &t).size(12.0));
        });
        app.steps.last_show = t0.elapsed();
        return;
    }

    let filter = app.filter.trim().to_lowercase();
    let filtering = !filter.is_empty();

    // Build flat list of visible lines (steps + expanded items).
    let mut lines: Vec<Line> = Vec::with_capacity(app.steps.rows.len());
    let step_count = app.steps.rows.len();
    for i in 0..step_count {
        if filtering {
            let title_match = app.steps.rows[i].title.to_lowercase().contains(&filter)
                || format!("step {}", i + 1).contains(&filter);
            let items = app.steps.items_of(app.doc.session(), i);
            let matching_items: Vec<usize> = items
                .iter()
                .enumerate()
                .filter(|(_, it)| {
                    it.name.to_lowercase().contains(&filter) || it.description.to_lowercase().contains(&filter)
                })
                .map(|(k, _)| k)
                .collect();
            if title_match || !matching_items.is_empty() {
                lines.push(Line::Step(i));
                for k in matching_items {
                    lines.push(Line::Item(i, k));
                }
            }
        } else {
            lines.push(Line::Step(i));
            if app.steps.open.contains(&i) {
                let n_items = app.steps.items_of(app.doc.session(), i).len();
                for k in 0..n_items {
                    lines.push(Line::Item(i, k));
                }
            }
        }
    }

    let colors = app.colors();
    let mut toggled_step: Option<usize> = None;
    let mut clicked_step: Option<(usize, egui::Modifiers)> = None;
    let mut double_clicked_step: Option<usize> = None;
    let mut clicked_item: Option<(Vec<u32>, egui::Modifiers)> = None;
    let mut menu_cmd: Option<(usize, &'static str)> = None;

    let content_h = (lines.len() as f32 * ROW_H).max(ROW_H);
    let scroll_h = if pinned_h { body_h } else { content_h.min(body_h) };
    egui::ScrollArea::vertical()
        .id_salt("steps-list")
        .min_scrolled_height(scroll_h)
        .max_height(body_h)
        .auto_shrink([false, !pinned_h])
        .show_rows(ui, ROW_H, lines.len(), |ui, range| {
            for idx in range {
                match lines[idx] {
                    Line::Step(i) => {
                        let row = &app.steps.rows[i];
                        let chosen = app.edit.step == Some(i);
                        let (rect, resp) = ui.allocate_exact_size(vec2(ui.available_width(), ROW_H), Sense::click());
                        let step_label = format!("Step {}", i + 1);
                        resp.widget_info(|| WidgetInfo::selected(egui::Role::TreeItem, true, chosen, &step_label));
                        if chosen {
                            ui.painter().rect_filled(rect, t.radius, t.accent_bg());
                        } else if resp.hovered() {
                            ui.painter().rect_filled(rect, t.radius, t.bg3);
                        }
                        let y = rect.center().y;
                        let open = filtering || app.steps.open.contains(&i);
                        if row.items > 0 {
                            let dr = Rect::from_center_size(pos2(rect.left() + 12.0, y), vec2(16.0, 16.0));
                            let d = ui.interact(dr, resp.id.with(("step-disc", i)), Sense::click());
                            icons::paint(ui, if open { Icon::Down } else { Icon::Chevron }, dr.shrink(2.0), 12.0, t.text3);
                            if d.clicked() && !filtering {
                                toggled_step = Some(i);
                            }
                        }

                        let right = rect.right() - 8.0;
                        let count_r = ui.painter().text(
                            pos2(right, y),
                            Align2::RIGHT_CENTER,
                            row.pieces.to_string(),
                            FontId::proportional(11.5),
                            t.text3,
                        );
                        let text_right = count_r.left() - 6.0;
                        let text_left = rect.left() + 24.0;
                        let step_g = ui.painter().layout_no_wrap(step_label, FontId::proportional(12.5), t.text1);
                        let title_x = text_left + step_g.size().x + 6.0;
                        let clip = Rect::from_min_max(pos2(text_left, rect.top()), pos2(text_right, rect.bottom()));
                        ui.painter().with_clip_rect(clip).galley(pos2(text_left, y - step_g.size().y / 2.0), step_g, t.text1);

                        if !row.title.is_empty() && title_x < text_right {
                            let tg = ui.painter().layout_no_wrap(row.title.clone(), FontId::proportional(12.0), t.text2);
                            let tclip = Rect::from_min_max(pos2(title_x, rect.top()), pos2(text_right, rect.bottom()));
                            ui.painter().with_clip_rect(tclip).galley(pos2(title_x, y - tg.size().y / 2.0), tg, t.text2);
                        }

                        if resp.double_clicked() {
                            double_clicked_step = Some(i);
                        } else if resp.clicked() {
                            clicked_step = Some((i, ui.input(|inp| inp.modifiers)));
                        }

                        let mut ctx_for_step = app.ctx();
                        ctx_for_step.step = Some(i);
                        resp.context_menu(|ui| {
                            use super::menu;
                            menu::prepare(ui);
                            let play_entries: &[(&str, Icon, &str)] = &[
                                ("step.play", Icon::Play, "Play Step"),
                                ("step.play_to_end", Icon::Next, "Play to End"),
                            ];
                            for &(cmd_id, ic, label) in play_entries {
                                let on = find(cmd_id).is_some_and(|c| enabled(c, &ctx_for_step));
                                if menu::item(ui, &t, Some(ic), label, None, on) {
                                    menu_cmd = Some((i, cmd_id));
                                }
                            }
                            menu::submenu(ui, &t, Some(Icon::Eye), "Step Appearance", |ui| {
                                let modes: &[(&str, &str)] = &[
                                    ("step.appearance_assembled", "Assembled through This Step"),
                                    ("step.appearance_separated", "Separated from Earlier Steps"),
                                    ("step.appearance_laid_out", "Lay Out These Parts"),
                                    ("step.appearance_exploded", "Explode This Step"),
                                ];
                                for &(cmd_id, label) in modes {
                                    let on = find(cmd_id).is_some_and(|c| enabled(c, &ctx_for_step));
                                    if menu::item(ui, &t, None, label, None, on) {
                                        menu_cmd = Some((i, cmd_id));
                                    }
                                }
                                menu::separator(ui, &t);
                                if menu::item(ui, &t, Some(Icon::Eye), "Show All Steps", None, true) {
                                    menu_cmd = Some((i, "step.show_all"));
                                }
                            });
                            menu::separator(ui, &t);
                            let entries: &[(&str, Icon, &str, bool)] = &[
                                ("step.edit", Icon::Sliders, "Edit Step…", false),
                                ("step.insert_before", Icon::Plus, "Insert Step Before", false),
                                ("step.insert_after", Icon::Plus, "Insert Step After", false),
                                ("step.split", Icon::Razor, "Split at Selection", false),
                                ("step.merge", Icon::Group, "Merge with Next", false),
                                ("model.to_step", Icon::Step, "Gather Selection Here", false),
                                ("step.move_up", Icon::Up, "Move Step Up", false),
                                ("step.move_down", Icon::Down, "Move Step Down", false),
                                ("step.delete", Icon::Close, "Delete Step", true),
                            ];
                            for (k, &(cmd_id, ic, label, destructive)) in entries.iter().enumerate() {
                                if matches!(k, 1 | 3 | 6 | 8) {
                                    menu::separator(ui, &t);
                                }
                                let on = find(cmd_id).is_some_and(|c| enabled(c, &ctx_for_step));
                                let clicked = if destructive {
                                    menu::item_destructive(ui, &t, Some(ic), label, on)
                                } else {
                                    menu::item(ui, &t, Some(ic), label, None, on)
                                };
                                if clicked {
                                    menu_cmd = Some((i, cmd_id));
                                }
                            }
                        });
                    }
                    Line::Item(step_i, item_k) => {
                        let item = &app.steps.items_of(app.doc.session(), step_i)[item_k];
                        let name = if item.submodel {
                            item.name.clone()
                        } else {
                            short_name(&item.name).to_owned()
                        };
                        let pieces_len = item.pieces.len();
                        let submodel = item.submodel;
                        let color_code = item.color;
                        let pieces_vec = item.pieces.clone();

                        let (rect, resp) = ui.allocate_exact_size(vec2(ui.available_width(), ROW_H), Sense::click());
                        resp.widget_info(|| WidgetInfo::labeled(egui::Role::TreeItem, true, &name));
                        if resp.hovered() {
                            ui.painter().rect_filled(rect, t.radius, t.bg3);
                        }
                        let y = rect.center().y;
                        let x = rect.left() + 26.0;
                        if submodel {
                            icons::paint(ui, Icon::Layers, Rect::from_center_size(pos2(x + 6.0, y), vec2(13.0, 13.0)), 13.0, t.accent);
                        } else {
                            let sw = colors
                                .iter()
                                .find(|c| c.code == color_code)
                                .map(|c| Color32::from_rgb(c.rgb[0], c.rgb[1], c.rgb[2]))
                                .unwrap_or(t.text3);
                            ui.painter().circle(pos2(x + 6.0, y), 4.5, sw, Stroke::new(1.0, t.border2));
                        }

                        let mut right = rect.right() - 8.0;
                        let cnt = ui.painter().text(
                            pos2(right, y),
                            Align2::RIGHT_CENTER,
                            pieces_len.to_string(),
                            FontId::proportional(11.0),
                            t.text3,
                        );
                        right = cnt.left() - 6.0;
                        if submodel {
                            let tag = ui.painter().text(pos2(right, y), Align2::RIGHT_CENTER, "submodel", FontId::proportional(10.5), t.text3);
                            right = tag.left() - 6.0;
                        }
                        let clip = Rect::from_min_max(pos2(x + 18.0, rect.top()), pos2(right, rect.bottom()));
                        let g = ui.painter().layout_no_wrap(name, FontId::proportional(12.0), t.text2);
                        ui.painter().with_clip_rect(clip).galley(pos2(clip.left(), y - g.size().y / 2.0), g, t.text2);

                        if resp.clicked() {
                            clicked_item = Some((pieces_vec, ui.input(|inp| inp.modifiers)));
                        }
                    }
                }
            }
        });

    if let Some(i) = toggled_step {
        if !app.steps.open.remove(&i) {
            app.steps.open.insert(i);
        }
    } else if let Some(i) = double_clicked_step {
        app.edit.step = Some(i);
        app.transport.focused_step = Some(i);
        app.steps.open_editor(i, app.doc.session());
    } else if let Some((i, m)) = clicked_step {
        app.edit.step = Some(i);
        app.transport.focused_step = Some(i);
        let pieces = app.steps.pieces_of(app.doc.session(), i).to_vec();
        app.doc.session().select(&pieces, select_mode(m));
    } else if let Some((pieces, m)) = clicked_item {
        app.doc.session().select(&pieces, select_mode(m));
    } else if let Some((i, cmd_id)) = menu_cmd {
        app.edit.step = Some(i);
        app.transport.focused_step = Some(i);
        app.requested.push(cmd_id);
    }

    app.steps.last_show = t0.elapsed();
}

/// Floating Step editor popover (`step.edit` or double-clicking a step row).
pub fn show_editor(ui: &mut Ui, app: &mut BrickMotionApp) {
    let Some(step_idx) = app.steps.editor.as_ref().map(|e| e.step) else {
        return;
    };
    let t = app.theme;

    if ui.input_mut(|i| i.consume_key(egui::Modifiers::NONE, Key::Escape)) {
        app.steps.close_editor(app.doc.session());
        return;
    }

    let mut close = false;
    let mut changed = false;

    let area = Area::new(Id::unique("step-editor"))
        .order(Order::Foreground)
        .anchor(Align2::LEFT_TOP, vec2(322.0, 152.0))
        .show(ui.ctx(), |ui| {
            float_frame(&t).inner_margin(Margin::same(12)).show(ui, |ui| {
                ui.set_width(280.0);
                ui.spacing_mut().item_spacing.y = 8.0;
                let Some(ed) = app.steps.editor.as_mut() else { return };

                ui.horizontal(|ui| {
                    ui.label(RichText::new(format!("Edit Step {}", step_idx + 1)).strong().color(t.text1));
                    ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                        if icon_button_tip(ui, &t, Icon::Close, "Close", "Close", true, false, 22.0).clicked() {
                            close = true;
                        }
                    });
                });

                ui.label(caption("Title", &t));
                let title_field = ui.add(
                    egui::TextEdit::singleline(&mut ed.fields.title)
                        .char_limit(80)
                        .hint_text("Step title")
                        .desired_width(f32::INFINITY),
                );
                title_field.widget_info(|| WidgetInfo::labeled(egui::Role::TextInput, true, "Step title"));
                if ed.fresh {
                    title_field.request_focus();
                    ed.fresh = false;
                }
                if title_field.changed() {
                    changed = true;
                }

                ui.label(caption("Notes", &t));
                let notes_field = ui.add(
                    egui::TextEdit::multiline(&mut ed.fields.notes)
                        .char_limit(1000)
                        .desired_rows(3)
                        .hint_text("Notes for this step")
                        .desired_width(f32::INFINITY),
                );
                notes_field.widget_info(|| WidgetInfo::labeled(egui::Role::TextInput, true, "Step notes"));
                if notes_field.changed() {
                    changed = true;
                }

                ui.horizontal(|ui| {
                    ui.label(RichText::new("Pause after").color(t.text2));
                    ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                        egui::Frame::NONE
                            .fill(t.bg1)
                            .stroke(Stroke::new(1.0, t.border))
                            .corner_radius(5)
                            .inner_margin(Margin::symmetric(6, 2))
                            .show(ui, |ui| {
                                let dv = ui.add(
                                    DragValue::new(&mut ed.fields.pause_after)
                                        .range(0.0..=10.0)
                                        .speed(0.1)
                                        .fixed_decimals(1)
                                        .suffix(" s"),
                                );
                                if dv.changed() {
                                    ed.fields.pause_after = (ed.fields.pause_after * 10.0).round() / 10.0;
                                    changed = true;
                                }
                            });
                    });
                });

                ui.scope(|ui| {
                    let w = &mut ui.visuals_mut().widgets;
                    w.inactive.bg_fill = t.bg1;
                    w.inactive.bg_stroke = Stroke::new(1.0, t.border2);
                    w.hovered.bg_stroke = Stroke::new(1.0, t.accent);
                    if ui.checkbox(&mut ed.fields.pin_order, "Pin build order").changed() {
                        changed = true;
                    }
                });

                ui.horizontal(|ui| {
                    ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                        let done = egui::Button::new(RichText::new("Done").color(Color32::WHITE))
                            .fill(t.accent)
                            .stroke(Stroke::NONE);
                        if ui.add(done).clicked() {
                            close = true;
                        }
                    });
                });
            });
        });

    if area.response.clicked_elsewhere() {
        close = true;
    }

    if changed && let Some(ed) = app.steps.editor.as_mut() {
        ed.dirty = true;
    }

    if close {
        app.steps.close_editor(app.doc.session());
        return;
    }

    // Debounced commit while typing (every 300 ms, continuing = true so all edits join one undo step).
    let now = Instant::now();
    if let Some(ed) = app.steps.editor.as_mut()
        && ed.dirty
    {
        let due = ed.last_write.is_none_or(|w| now.duration_since(w) >= COMMIT_INTERVAL);
        if due {
            let c = app.doc.session().set_step_fields(ed.step, &ed.fields, true);
            ed.dirty = false;
            ed.last_write = Some(now);
            app.edited(c);
            app.steps.rows = app.doc.session().steps();
            app.steps.seen_version = app.doc.session().version();
        } else {
            ui.ctx().request_repaint_after(COMMIT_INTERVAL);
        }
    }
}
