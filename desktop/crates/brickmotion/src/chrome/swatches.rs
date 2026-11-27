//! Colour swatches popover: recolours the selection or chooses the colour for new parts.
use egui::{
    Align2, Area, Color32, Frame, Id, Key, Margin, Order, Rect, RichText, Sense, Stroke, StrokeKind, Ui, WidgetInfo,
    vec2,
};

use super::{caption, float_frame, icon_button_tip};
use crate::BrickMotionApp;
use crate::icons::{self, Icon};
use crate::theme::Theme;

const WIDTH: f32 = 312.0;
const SWATCH: f32 = 20.0;
const GAP: f32 = 4.0;
const PER_ROW: usize = 12;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Target {
    Selection,
    NewParts,
}

#[derive(Debug, Default)]
pub struct Swatches {
    pub open: Option<Target>,
    query: String,
    fresh: bool,
}

impl Swatches {
    pub fn open(&mut self, target: Target) {
        self.open = Some(target);
        self.query.clear();
        self.fresh = true;
    }

    pub fn close(&mut self) {
        self.open = None;
    }
}

fn matches_query(c: &bm::ColorInfo, query: &str) -> bool {
    let q = query.trim();
    if q.is_empty() {
        return true;
    }
    if c.code.to_string() == q {
        return true;
    }
    let name = c.name.to_lowercase();
    q.split_whitespace().all(|w| name.contains(&w.to_lowercase()))
}

fn group_title(group: i32) -> &'static str {
    match group {
        0 => "Solid",
        1 => "Transparent",
        2 => "Metallic",
        _ => "Other",
    }
}

pub fn show(ui: &mut Ui, app: &mut BrickMotionApp) {
    let Some(target) = app.swatches.open else {
        return;
    };
    let t = app.theme;
    let esc = ui.input_mut(|i| i.consume_key(egui::Modifiers::NONE, Key::Escape));
    if esc {
        app.swatches.close();
        return;
    }

    let colors = app.colors();
    let current_code = match target {
        Target::NewParts => Some(app.edit.colour),
        Target::Selection => {
            let snap = app.snapshot();
            snap.described.first().map(|p| p.color)
        }
    };
    let recent_codes = app.history.colours.clone();

    let mut chosen: Option<i32> = None;
    let mut close = false;
    let title = match target {
        Target::Selection => "Recolour selection",
        Target::NewParts => "Colour for new parts",
    };

    let area = Area::new(Id::unique("colour-swatches"))
        .order(Order::Foreground)
        .anchor(Align2::CENTER_TOP, vec2(0.0, 122.0))
        .show(ui.ctx(), |ui| {
            float_frame(&t).inner_margin(Margin::same(10)).show(ui, |ui| {
                ui.set_width(WIDTH);
                ui.spacing_mut().item_spacing.y = 6.0;

                // Header.
                ui.horizontal(|ui| {
                    ui.label(RichText::new(title).strong().color(t.text1));
                    ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                        if icon_button_tip(ui, &t, Icon::Close, "Close", "Close", true, false, 22.0).clicked() {
                            close = true;
                        }
                    });
                });

                // Search input.
                Frame::NONE
                    .fill(t.bg1)
                    .stroke(Stroke::new(1.0, t.border))
                    .corner_radius(6)
                    .inner_margin(Margin { left: 8, right: 8, top: 0, bottom: 0 })
                    .show(ui, |ui| {
                        ui.set_height(26.0);
                        ui.horizontal_centered(|ui| {
                            icons::icon(ui, Icon::Search, 15.0, t.text3);
                            let field = ui.add(
                                egui::TextEdit::singleline(&mut app.swatches.query)
                                    .hint_text(RichText::new("Search colours").color(t.text3))
                                    .frame(egui::Frame::NONE)
                                    .margin(Margin::ZERO)
                                    .align(Align2::LEFT_CENTER)
                                    .desired_width(f32::INFINITY),
                            );
                            field.widget_info(|| WidgetInfo::labeled(egui::Role::TextInput, true, "Search colours"));
                            if app.swatches.fresh {
                                field.request_focus();
                                app.swatches.fresh = false;
                            }
                        });
                    });

                let query = app.swatches.query.clone();
                let searching = !query.trim().is_empty();

                egui::ScrollArea::vertical().max_height(320.0).show(ui, |ui| {
                    ui.spacing_mut().item_spacing.y = 6.0;

                    if !searching && !recent_codes.is_empty() {
                        let recent: Vec<&bm::ColorInfo> = recent_codes
                            .iter()
                            .filter_map(|code| colors.iter().find(|c| c.code == *code))
                            .collect();
                        if !recent.is_empty() {
                            ui.label(caption("Recent", &t));
                            if let Some(code) = swatch_grid(ui, &t, &recent, current_code) {
                                chosen = Some(code);
                            }
                        }
                    }

                    let mut any = false;
                    for group in 0..=3 {
                        let list: Vec<&bm::ColorInfo> = colors
                            .iter()
                            .filter(|c| c.group == group && matches_query(c, &query))
                            .collect();
                        if list.is_empty() {
                            continue;
                        }
                        any = true;
                        ui.label(caption(group_title(group), &t));
                        if let Some(code) = swatch_grid(ui, &t, &list, current_code) {
                            chosen = Some(code);
                        }
                    }

                    if !any {
                        ui.add_space(4.0);
                        ui.label(RichText::new("No matching colours").color(t.text3));
                    }
                });
            });
        });

    if area.response.clicked_elsewhere() {
        close = true;
    }

    if let Some(code) = chosen {
        match target {
            Target::Selection => {
                crate::edit::selection_edit(app, |s, sel| s.recolor(sel, code));
            }
            Target::NewParts => {
                app.edit.colour = code;
            }
        }
        app.history.record_colour(code);
        let _ = app.history.save(&app.support);
        app.swatches.close();
    } else if close {
        app.swatches.close();
    }
}

fn swatch_grid(ui: &mut Ui, t: &Theme, list: &[&bm::ColorInfo], active: Option<i32>) -> Option<i32> {
    let mut picked = None;
    for chunk in list.chunks(PER_ROW) {
        ui.horizontal(|ui| {
            ui.spacing_mut().item_spacing.x = GAP;
            for c in chunk {
                if swatch_tile(ui, t, c, active == Some(c.code)) {
                    picked = Some(c.code);
                }
            }
        });
    }
    picked
}

fn swatch_tile(ui: &mut Ui, t: &Theme, c: &bm::ColorInfo, selected: bool) -> bool {
    let (rect, resp) = ui.allocate_exact_size(vec2(SWATCH, SWATCH), Sense::click());
    let label = format!("{} ({})", c.name, c.code);
    resp.widget_info(|| WidgetInfo::selected(egui::Role::Button, true, selected, &label));

    let fill = Color32::from_rgb(c.rgb[0], c.rgb[1], c.rgb[2]); // data colour
    let p = ui.painter();
    if c.alpha < 0.99 {
        // Subtle two-tone backdrop for transparent colours so translucency reads cleanly.
        p.rect_filled(rect, 4.0, t.bg1);
        let half = Rect::from_min_max(rect.center(), rect.max);
        p.rect_filled(half, 2.0, t.bg3);
        let a = (c.alpha.clamp(0.25, 0.95) * 255.0).round() as u8;
        p.rect_filled(rect, 4.0, Color32::from_rgba_unmultiplied(c.rgb[0], c.rgb[1], c.rgb[2], a)); // data colour
    } else {
        p.rect_filled(rect, 4.0, fill);
    }

    let stroke = if selected {
        Stroke::new(2.0, t.accent)
    } else if resp.hovered() {
        Stroke::new(1.5, t.text1)
    } else {
        Stroke::new(1.0, t.ink(35))
    };
    p.rect_stroke(rect, 4.0, stroke, StrokeKind::Inside);

    resp.on_hover_text(label).clicked()
}
