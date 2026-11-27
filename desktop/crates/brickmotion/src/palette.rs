//! The command palette (⌘K, S, or the Search commands field): every command by name, with its
//! place in the ribbon, its shortcut, and why it is disabled when it is.
use egui::{Align2, Area, Frame, Id, Key, Margin, Order, RichText, Sense, Stroke, Ui, vec2};

use crate::commands::{Command, Ctx, enabled, registry, title, why_disabled};
use crate::icons;
use crate::{BrickMotionApp, Shortcut};

const ROWS: usize = 10;
const ROW_H: f32 = 32.0;
const WIDTH: f32 = 520.0;

#[derive(Debug, Default)]
pub struct Palette {
    pub open: bool,
    query: String,
    cursor: usize,
    /// Opened this frame: the field takes focus and the query starts empty.
    fresh: bool,
}

impl Palette {
    pub fn show_palette(&mut self) {
        if !self.open {
            self.open = true;
            self.fresh = true;
            self.query.clear();
            self.cursor = 0;
        }
    }
}

/// Where in `hay` the letters of `needle` appear in order (case-insensitive): the first letter's
/// index, or None.
fn subsequence(hay: &str, needle: &str) -> Option<usize> {
    let hay: Vec<char> = hay.to_lowercase().chars().collect();
    let mut start = None;
    let mut i = 0;
    for n in needle.to_lowercase().chars().filter(|c| !c.is_whitespace()) {
        while i < hay.len() && hay[i] != n {
            i += 1;
        }
        if i == hay.len() {
            return None;
        }
        start.get_or_insert(i);
        i += 1;
    }
    Some(start.unwrap_or(0))
}

/// Commands matching `query`: title prefixes first, then by where the match starts, then in
/// registry order. An empty query lists every command.
pub fn rank(query: &str, _ctx: &Ctx) -> Vec<&'static Command> {
    let q = query.trim();
    let mut hits: Vec<(bool, usize, usize, &'static Command)> = registry()
        .iter()
        .enumerate()
        .filter_map(|(order, c)| {
            let at = subsequence(c.title, q).or_else(|| subsequence(c.id, q).map(|i| i + 1000))?;
            let prefix = !q.is_empty() && c.title.to_lowercase().starts_with(&q.to_lowercase());
            Some((!prefix, at, order, c))
        })
        .collect();
    hits.sort_by_key(|h| (h.0, h.1, h.2));
    hits.into_iter().map(|h| h.3).collect()
}

/// "<tab> › <group>", or the id for commands not on the ribbon.
fn place(c: &Command) -> String {
    if c.tab.is_empty() { c.id.to_owned() } else { format!("{} › {}", c.tab, c.group) }
}

pub fn show(ui: &mut Ui, app: &mut BrickMotionApp) {
    if !app.palette.open {
        return;
    }
    let t = app.theme;
    let ctx = app.ctx();
    let list = rank(&app.palette.query, &ctx);
    let p = &mut app.palette;
    // Keys the list owns, read before the field sees them.
    let (up, down, enter, esc) = ui.input_mut(|i| {
        (
            i.consume_key(egui::Modifiers::NONE, Key::ArrowUp),
            i.consume_key(egui::Modifiers::NONE, Key::ArrowDown),
            i.consume_key(egui::Modifiers::NONE, Key::Enter),
            i.consume_key(egui::Modifiers::NONE, Key::Escape),
        )
    });
    if down && p.cursor + 1 < list.len() {
        p.cursor += 1;
    }
    if up {
        p.cursor = p.cursor.saturating_sub(1);
    }
    p.cursor = p.cursor.min(list.len().saturating_sub(1));
    let mut chosen: Option<&'static Command> = None;
    let mut close = esc;
    if enter {
        chosen = list.get(p.cursor).copied();
    }
    let area = Area::new(Id::unique("command-palette"))
        .order(Order::Foreground)
        .anchor(Align2::CENTER_TOP, vec2(0.0, 120.0))
        .show(ui.ctx(), |ui| {
            Frame::NONE
                .fill(t.bg2)
                .stroke(Stroke::new(1.0, t.border2))
                .corner_radius(10)
                .inner_margin(Margin::same(8))
                .shadow(egui::epaint::Shadow { offset: [0, 8], blur: 24, spread: 0, color: t.shade(110) })
                .show(ui, |ui| {
                    ui.set_width(WIDTH);
                    let field = ui.add(
                        egui::TextEdit::singleline(&mut p.query)
                            .hint_text(RichText::new("Search commands").color(t.text3))
                            .desired_width(f32::INFINITY)
                            .margin(Margin::symmetric(8, 6)),
                    );
                    field.widget_info(|| egui::WidgetInfo::labeled(egui::Role::TextInput, true, "Command name"));
                    if p.fresh {
                        field.request_focus();
                        p.fresh = false;
                    }
                    if field.changed() {
                        p.cursor = 0;
                    }
                    ui.add_space(6.0);
                    if list.is_empty() {
                        ui.label(RichText::new("No command has that name").color(t.text3));
                    }
                    egui::ScrollArea::vertical().max_height(ROWS as f32 * ROW_H).show(ui, |ui| {
                        for (i, c) in list.iter().enumerate() {
                            if row(ui, &t, c, &ctx, i == p.cursor) {
                                chosen = Some(c);
                            }
                        }
                    });
                });
        });
    // A click outside closes it.
    if area.response.clicked_elsewhere() {
        close = true;
    }
    if let Some(c) = chosen {
        if enabled(c, &ctx) {
            app.palette.open = false;
            app.requested.push(c.id);
        }
    } else if close {
        app.palette.open = false;
    }
}

/// One command row; true when clicked.
fn row(ui: &mut Ui, t: &crate::Theme, c: &Command, ctx: &Ctx, current: bool) -> bool {
    let on = enabled(c, ctx);
    let (rect, resp) = ui.allocate_exact_size(vec2(ui.available_width(), ROW_H), Sense::click());
    resp.widget_info(|| egui::WidgetInfo::labeled(egui::Role::Button, on, title(c, ctx)));
    if current {
        ui.scroll_to_rect(rect, None);
    }
    if current || resp.hovered() {
        ui.painter().rect_filled(rect, t.radius, if current { t.accent_bg() } else { t.bg3 });
    }
    let main = if on { t.text1 } else { t.text3 };
    let y = rect.center().y;
    icons::paint(ui, c.icon, egui::Rect::from_center_size(egui::pos2(rect.left() + 18.0, y), vec2(16.0, 16.0)), 16.0, if on { t.text2 } else { t.text3 });
    ui.painter().text(egui::pos2(rect.left() + 36.0, y), Align2::LEFT_CENTER, title(c, ctx), egui::FontId::proportional(12.5), main);
    let mut right = rect.right() - 10.0;
    if let Some(k) = c.keys.and_then(Shortcut::parse) {
        let r = ui.painter().text(egui::pos2(right, y), Align2::RIGHT_CENTER, k.label(), egui::FontId::proportional(11.0), t.text3);
        right = r.left() - 12.0;
    }
    let detail = why_disabled(c, ctx).map(str::to_owned).unwrap_or_else(|| place(c));
    let r = ui.painter().text(egui::pos2(right, y), Align2::RIGHT_CENTER, &detail, egui::FontId::proportional(11.0), t.text3);
    if let Some(why) = why_disabled(c, ctx) {
        // So the reason can be found by its text.
        ui.interact(r, resp.id.with("why"), Sense::hover()).widget_info(|| egui::WidgetInfo::labeled(egui::Role::Label, true, why));
    }
    resp.clicked() && on
}
