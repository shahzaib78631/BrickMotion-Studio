//! Replace Part modal sheet: search the library, preview in the selection's colour, and swap
//! the selected pieces' part as one undo step.
use bm::library::{PartMatch, common_parts, library_parts};
use egui::{
    Align2, Area, Color32, FontId, Frame, Id, Key, Margin, Order, Pos2, Rect, RichText, Sense, Stroke, StrokeKind, Ui,
    WidgetInfo, pos2, vec2,
};

use super::{caption, float_frame, icon_button_tip};
use crate::BrickMotionApp;
use crate::chrome::library::short_name;
use crate::icons::{self, Icon};
use crate::previews::Preview;

const WIDTH: f32 = 420.0;
const TILE_W: f32 = 64.0;
const TILE_H: f32 = 82.0;
const GAP: f32 = 8.0;
const COLS: usize = 5;
const GRID_H: f32 = 270.0;

#[derive(Default)]
pub struct ReplaceSheet {
    pub open: bool,
    query: String,
    query_key: Option<String>,
    results: Vec<PartMatch>,
    chosen: Option<usize>,
    error: Option<String>,
    fresh: bool,
}

impl ReplaceSheet {
    pub fn show_sheet(&mut self) {
        self.open = true;
        self.query.clear();
        self.query_key = None;
        self.results.clear();
        self.chosen = None;
        self.error = None;
        self.fresh = true;
    }

    pub fn close(&mut self) {
        self.open = false;
        self.error = None;
    }

    fn sync_results(&mut self) {
        let q = self.query.trim().to_owned();
        if self.query_key.as_ref() == Some(&q) {
            return;
        }
        self.results = if q.is_empty() {
            common_parts()
        } else {
            library_parts(&q, "", 100)
        };
        self.chosen = (!self.results.is_empty()).then_some(0);
        self.query_key = Some(q);
    }
}

pub fn show(ui: &mut Ui, app: &mut BrickMotionApp) {
    if !app.replace.open {
        return;
    }
    let t = app.theme;
    let esc = ui.input_mut(|i| i.consume_key(egui::Modifiers::NONE, Key::Escape));
    if esc {
        app.replace.close();
        return;
    }
    let enter = ui.input_mut(|i| i.consume_key(egui::Modifiers::NONE, Key::Enter));

    let snap = app.snapshot();
    let count = snap.selected;
    if count == 0 {
        app.replace.close();
        return;
    }
    let colour = snap.described.first().map(|p| p.color).unwrap_or(app.edit.colour);
    app.replace.sync_results();

    // Subtle modal scrim over the viewport.
    let screen = ui.ctx().content_rect();
    Area::new(Id::unique("replace-scrim"))
        .order(Order::Middle)
        .fixed_pos(screen.min)
        .show(ui.ctx(), |ui| {
            let (r, _) = ui.allocate_exact_size(screen.size(), Sense::click());
            ui.painter().rect_filled(r, 0.0, Color32::from_black_alpha(110));
        });

    let heading = if count == 1 {
        "Replace 1 piece".to_owned()
    } else {
        format!("Replace {count} pieces")
    };

    let mut commit = enter;
    let mut cancel = false;

    Area::new(Id::unique("replace-sheet"))
        .order(Order::Foreground)
        .anchor(Align2::CENTER_CENTER, vec2(0.0, -20.0))
        .show(ui.ctx(), |ui| {
            float_frame(&t).inner_margin(Margin::same(14)).show(ui, |ui| {
                ui.set_width(WIDTH);
                ui.spacing_mut().item_spacing.y = 8.0;

                // Header.
                ui.horizontal(|ui| {
                    ui.label(RichText::new(&heading).strong().size(14.0).color(t.text1));
                    ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                        if icon_button_tip(ui, &t, Icon::Close, "Close", "Close", true, false, 22.0).clicked() {
                            cancel = true;
                        }
                    });
                });

                // Search field.
                Frame::NONE
                    .fill(t.bg1)
                    .stroke(Stroke::new(1.0, t.border))
                    .corner_radius(6)
                    .inner_margin(Margin { left: 9, right: 9, top: 0, bottom: 0 })
                    .show(ui, |ui| {
                        ui.set_height(28.0);
                        ui.horizontal_centered(|ui| {
                            icons::icon(ui, Icon::Search, 16.0, t.text3);
                            let field = ui.add(
                                egui::TextEdit::singleline(&mut app.replace.query)
                                    .hint_text(RichText::new("Search replacement part").color(t.text3))
                                    .frame(egui::Frame::NONE)
                                    .margin(Margin::ZERO)
                                    .align(Align2::LEFT_CENTER)
                                    .desired_width(f32::INFINITY),
                            );
                            field.widget_info(|| WidgetInfo::labeled(egui::Role::TextInput, true, "Replace part search"));
                            if app.replace.fresh {
                                field.request_focus();
                                app.replace.fresh = false;
                            }
                        });
                    });

                if let Some(err) = &app.replace.error {
                    ui.label(RichText::new(err).size(11.5).color(Color32::from_rgb(0xe5, 0x48, 0x4d)));
                }

                app.replace.sync_results();
                let results = app.replace.results.clone();
                let chosen_idx = app.replace.chosen;

                if results.is_empty() {
                    ui.add_space(12.0);
                    ui.label(caption("No matching parts", &t).size(12.0));
                    ui.add_space(12.0);
                } else {
                    let rows = results.len().div_ceil(COLS);
                    let mut newly_chosen = chosen_idx;
                    let mut dbl_clicked = false;
                    egui::ScrollArea::vertical()
                        .id_salt("replace-grid")
                        .max_height(GRID_H)
                        .auto_shrink([false, false])
                        .show_rows(ui, TILE_H + GAP, rows, |ui, range| {
                            ui.spacing_mut().item_spacing.y = GAP;
                            for row_i in range {
                                let start = row_i * COLS;
                                let end = (start + COLS).min(results.len());
                                ui.horizontal(|ui| {
                                    ui.spacing_mut().item_spacing.x = GAP;
                                    for (offset, part) in results[start..end].iter().enumerate() {
                                        let idx = start + offset;
                                        let selected = newly_chosen == Some(idx);
                                        let resp = replace_tile(ui, app, part, colour, selected);
                                        if resp.double_clicked() {
                                            newly_chosen = Some(idx);
                                            dbl_clicked = true;
                                        } else if resp.clicked() {
                                            newly_chosen = Some(idx);
                                        }
                                    }
                                });
                            }
                        });
                    app.replace.chosen = newly_chosen;
                    if dbl_clicked {
                        commit = true;
                    }
                }

                // Selected part description preview line.
                if let Some(p) = app.replace.chosen.and_then(|i| app.replace.results.get(i)) {
                    ui.label(RichText::new(format!("{} — {}", p.name, p.description)).size(11.5).color(t.text2));
                }

                // Footer buttons.
                ui.horizontal(|ui| {
                    ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                        let can_replace = app.replace.chosen.is_some_and(|i| i < app.replace.results.len());
                        let replace_btn = egui::Button::new(RichText::new("Replace").color(Color32::WHITE))
                            .fill(if can_replace { t.accent } else { t.bg3 })
                            .stroke(Stroke::NONE);
                        if ui.add_enabled(can_replace, replace_btn).clicked() {
                            commit = true;
                        }
                        if ui.button("Cancel").clicked() {
                            cancel = true;
                        }
                    });
                });
            });
        });

    if cancel {
        app.replace.close();
        return;
    }

    if commit
        && let Some(part) = app.replace.chosen.and_then(|i| app.replace.results.get(i)).cloned()
    {
        let sel = app.doc.session().selection();
        let c = app.doc.session().replace_part(&sel, &part.name);
        match c.refused {
            None => {
                app.history.record_part(&part.name, &part.description, &part.category);
                let _ = app.history.save(&app.support);
                app.replace.close();
            }
            Some(why) => {
                app.replace.error = Some(why);
            }
        }
    }
}

fn replace_tile(ui: &mut Ui, app: &mut BrickMotionApp, part: &PartMatch, colour: i32, selected: bool) -> egui::Response {
    let t = app.theme;
    let short = short_name(&part.name);
    let (rect, resp) = ui.allocate_exact_size(vec2(TILE_W, TILE_H), Sense::click());
    resp.widget_info(|| WidgetInfo::selected(egui::Role::Button, true, selected, short));

    let img_rect = Rect::from_min_size(rect.min, vec2(TILE_W, TILE_W));
    let bg = if selected { t.accent_bg() } else if resp.hovered() { t.bg3 } else { t.bg1 };
    let border = if selected {
        Stroke::new(2.0, t.accent)
    } else if resp.hovered() {
        Stroke::new(1.0, t.border2)
    } else {
        Stroke::new(1.0, t.border)
    };
    ui.painter().rect(img_rect, 6.0, bg, border, StrokeKind::Inside);

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
    let color = if selected || resp.hovered() { t.text1 } else { t.text2 };
    let galley = ui.painter().layout_no_wrap(short.to_owned(), FontId::proportional(11.0), color);
    let lx = (label_rect.center().x - galley.size().x / 2.0).max(label_rect.left());
    ui.painter()
        .with_clip_rect(label_rect)
        .galley(pos2(lx, label_rect.center().y - galley.size().y / 2.0), galley, color);

    resp.on_hover_text(&part.description)
}
