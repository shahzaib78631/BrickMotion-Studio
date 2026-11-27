//! BrickMotion › Settings… (⌘,): a sidebar of five sections and a page of grouped rows. Every
//! change applies at once and is kept in `preferences.toml`; there is no Apply button.
use egui::{CornerRadius, Id, Key, Modal, Rect, RichText, Sense, Stroke, StrokeKind, Ui, WidgetInfo, pos2, vec2};

use super::{sheet, widgets};
use crate::BrickMotionApp;
use crate::theme::{MATCH_SYSTEM, Theme, catalogue};

pub const SECTIONS: [&str; 5] = ["General", "Appearance", "Building", "Animate", "Files"];

#[derive(Default)]
pub struct SettingsWindow {
    pub open: bool,
    pub section: usize,
    pub search: String,
}

/// One settings row: the section it lives in, its title and a short note under it.
struct Row {
    id: &'static str,
    section: usize,
    title: &'static str,
    note: &'static str,
}

const ROWS: &[Row] = &[
    Row { id: "snap_sounds", section: 0, title: "Snap sounds while building", note: "A click as each part seats." },
    Row { id: "theme", section: 1, title: "Theme", note: "How BrickMotion looks. The model's own render look is set in Look." },
    Row { id: "background", section: 1, title: "Viewport background", note: "Behind the model while you build." },
    Row { id: "click_selects", section: 2, title: "Click selects", note: "Hold ⌥ for the other." },
    Row { id: "collision", section: 2, title: "Collision checks", note: "Stop a part from moving into another." },
    Row { id: "smart_joints", section: 2, title: "Smart Joints", note: "Rotation rings and limits on jointed parts." },
    Row { id: "local_axes", section: 2, title: "Local axes", note: "Move along the part's own axes." },
    Row { id: "auto_plan", section: 3, title: "Plan the build automatically", note: "Re-plan the flights after each edit." },
    Row { id: "logo", section: 3, title: "Video logo", note: "Stamp your logo on exported movies." },
    Row { id: "logo_corner", section: 3, title: "Logo corner", note: "Where the logo sits in the frame." },
    Row { id: "autosave", section: 4, title: "Autosave every", note: "An edited document is saved to a backup." },
    Row { id: "backups", section: 4, title: "Backups kept", note: "Older backups are removed." },
];

fn matches(row: &Row, query: &str) -> bool {
    let q = query.trim().to_lowercase();
    q.is_empty() || row.title.to_lowercase().contains(&q) || row.note.to_lowercase().contains(&q) || SECTIONS[row.section].to_lowercase().contains(&q)
}

pub fn show(ui: &mut Ui, app: &mut BrickMotionApp) {
    if !app.settings.open {
        return;
    }
    let t = app.theme;
    let mut close = false;
    let modal = Modal::new(Id::unique("settings-sheet")).frame(sheet::frame(&t)).backdrop_color(sheet::backdrop(&t)).show(ui.ctx(), |ui| {
        ui.set_width(760.0);
        ui.spacing_mut().item_spacing = vec2(8.0, 0.0);
        let title = if app.settings.search.trim().is_empty() { SECTIONS[app.settings.section] } else { "Search" };
        close = sheet::header(ui, &t, &format!("Settings — {title}"));
        ui.horizontal_top(|ui| {
            ui.spacing_mut().item_spacing = vec2(0.0, 0.0);
            sidebar(ui, app, &t);
            let (line, _) = ui.allocate_exact_size(vec2(1.0, 500.0), Sense::hover());
            ui.painter().vline(line.center().x, line.y_range(), Stroke::new(1.0, t.border));
            ui.vertical(|ui| {
                ui.set_width(579.0);
                egui::ScrollArea::vertical().id_salt("settings-page").max_height(500.0).min_scrolled_height(500.0).auto_shrink([false, false]).show(ui, |ui| {
                    egui::Frame::new().inner_margin(egui::Margin { left: 24, right: 24, top: 18, bottom: 24 }).show(ui, |ui| page(ui, app, &t));
                });
            });
        });
    });
    // Esc first clears a search, then closes.
    let esc = ui.input(|i| i.key_pressed(Key::Escape));
    if esc && !app.settings.search.is_empty() {
        app.settings.search.clear();
    } else if close || modal.should_close() || esc {
        app.settings.open = false;
        app.settings.search.clear();
        ui.ctx().request_repaint();
    }
}

fn sidebar(ui: &mut Ui, app: &mut BrickMotionApp, t: &Theme) {
    ui.vertical(|ui| {
        ui.set_width(180.0);
        egui::Frame::new().inner_margin(egui::Margin { left: 12, right: 12, top: 14, bottom: 12 }).show(ui, |ui| {
            ui.spacing_mut().item_spacing = vec2(0.0, 2.0);
            let mut fresh = false;
            sheet::text_field(ui, t, "Search", &mut app.settings.search, &mut fresh);
            ui.add_space(12.0);
            let searching = !app.settings.search.trim().is_empty();
            for (i, name) in SECTIONS.iter().enumerate() {
                let on = !searching && app.settings.section == i;
                let (r, resp) = ui.allocate_exact_size(vec2(ui.available_width(), 30.0), Sense::click());
                resp.widget_info(|| WidgetInfo::selected(egui::Role::Tab, true, on, *name));
                let p = ui.painter();
                if on {
                    p.rect_filled(r, CornerRadius::same(7), t.accent_a(46));
                } else if resp.hovered() {
                    p.rect_filled(r, CornerRadius::same(7), t.ink(12));
                }
                p.text(pos2(r.left() + 10.0, r.center().y), egui::Align2::LEFT_CENTER, *name, egui::FontId::proportional(12.5), if on { t.text1 } else { t.text2 });
                if resp.clicked() {
                    app.settings.section = i;
                    app.settings.search.clear();
                }
            }
        });
    });
}

fn page(ui: &mut Ui, app: &mut BrickMotionApp, t: &Theme) {
    let query = app.settings.search.clone();
    let searching = !query.trim().is_empty();
    if !searching {
        let name = SECTIONS[app.settings.section];
        ui.label(RichText::new(name).size(15.0).strong().color(t.text1));
        ui.add_space(16.0);
    }
    let rows: Vec<&Row> = ROWS.iter().filter(|r| if searching { matches(r, &query) } else { r.section == app.settings.section }).collect();
    if rows.is_empty() {
        ui.label(RichText::new(format!("No settings match “{}”.", query.trim())).size(12.5).color(t.text2));
        return;
    }
    let mut last_section = usize::MAX;
    let mut i = 0;
    while i < rows.len() {
        let row = rows[i];
        if searching && row.section != last_section {
            ui.label(RichText::new(SECTIONS[row.section]).size(11.5).strong().color(t.text3));
            ui.add_space(6.0);
            last_section = row.section;
        }
        if row.id == "theme" {
            theme_grid(ui, app, t);
            ui.add_space(20.0);
            i += 1;
            continue;
        }
        // A run of plain rows in one section shares one inset group.
        let start = i;
        while i < rows.len() && rows[i].id != "theme" && rows[i].section == row.section {
            i += 1;
        }
        widgets::inset_group(ui, |ui| {
            for (k, r) in rows[start..i].iter().enumerate() {
                if k > 0 {
                    widgets::hairline(ui);
                }
                setting_row(ui, app, t, r);
            }
        });
        ui.add_space(20.0);
    }
}

/// Title and note on the left, the control on the right, 52 px tall.
fn setting_row(ui: &mut Ui, app: &mut BrickMotionApp, t: &Theme, row: &Row) {
    egui::Frame::new().inner_margin(egui::Margin::symmetric(14, 0)).show(ui, |ui| {
        let w = ui.available_width();
        ui.allocate_ui_with_layout(vec2(w, 52.0), egui::Layout::left_to_right(egui::Align::Center), |ui| {
            ui.set_min_size(vec2(w, 52.0));
            ui.vertical(|ui| {
                ui.spacing_mut().item_spacing.y = 2.0;
                ui.label(RichText::new(row.title).size(12.5).color(t.text1));
                ui.label(RichText::new(row.note).size(11.5).color(t.text2));
            });
            ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| control(ui, app, t, row));
        });
    });
}

fn segment(ui: &mut Ui, t: &Theme, id: &str, width: f32, options: &[&str], selected: &mut usize) -> bool {
    let mut changed = false;
    ui.allocate_ui_with_layout(vec2(width, 24.0), egui::Layout::left_to_right(egui::Align::Center), |ui| {
        changed = widgets::segmented(ui, t, ("settings", id), options, selected, true);
    });
    changed
}

fn control(ui: &mut Ui, app: &mut BrickMotionApp, t: &Theme, row: &Row) {
    let mut save = false;
    match row.id {
        "snap_sounds" => save = widgets::pill_switch(ui, t, row.title, &mut app.prefs.play_snap_sounds, true),
        "auto_plan" => save = widgets::pill_switch(ui, t, row.title, &mut app.prefs.auto_plan, true),
        "logo" => {
            let has = !app.prefs.video_logo_file.is_empty();
            save = widgets::pill_switch(ui, t, row.title, &mut app.prefs.video_logo_enabled, has);
            if !has {
                ui.label(RichText::new("Choose one in Export Movie").size(11.5).color(t.text3));
            }
        }
        "logo_corner" => {
            const CORNERS: [&str; 4] = ["tl", "tr", "bl", "br"];
            let mut i = CORNERS.iter().position(|c| *c == app.prefs.video_logo_corner).unwrap_or(3);
            if segment(ui, t, row.id, 220.0, &["Top Left", "Top Right", "Bottom Left", "Bottom Right"], &mut i) {
                app.prefs.video_logo_corner = CORNERS[i].to_owned();
                save = true;
            }
        }
        "background" => {
            const IDS: [&str; 3] = ["theme", "studio", "black"];
            let mut i = IDS.iter().position(|c| *c == app.prefs.viewport_background).unwrap_or(0);
            if segment(ui, t, row.id, 200.0, &["Theme", "Studio", "Black"], &mut i) {
                app.prefs.viewport_background = IDS[i].to_owned();
                let bg = app.viewport_background();
                app.viewport.set_background(bg);
                save = true;
            }
        }
        "click_selects" => {
            let mut i = usize::from(app.edit.pick_scope == crate::edit::PickScope::Pieces);
            if segment(ui, t, row.id, 180.0, &["Submodels", "Pieces"], &mut i) {
                app.edit.pick_scope = if i == 1 { crate::edit::PickScope::Pieces } else { crate::edit::PickScope::Submodels };
            }
        }
        "collision" => {
            widgets::pill_switch(ui, t, row.title, &mut app.edit.collision, true);
        }
        "smart_joints" => {
            widgets::pill_switch(ui, t, row.title, &mut app.edit.smart_joints, true);
        }
        "local_axes" => {
            widgets::pill_switch(ui, t, row.title, &mut app.edit.local_axes, true);
        }
        "autosave" => {
            const SECS: [u64; 4] = [15, 30, 60, 120];
            let mut i = SECS.iter().position(|s| *s == app.prefs.autosave_seconds).unwrap_or(1);
            if segment(ui, t, row.id, 240.0, &["15 s", "30 s", "1 min", "2 min"], &mut i) {
                app.prefs.autosave_seconds = SECS[i];
                save = true;
            }
        }
        "backups" => {
            const KEPT: [usize; 4] = [5, 10, 20, 50];
            let mut i = KEPT.iter().position(|s| *s == app.prefs.backups_kept).unwrap_or(1);
            if segment(ui, t, row.id, 200.0, &["5", "10", "20", "50"], &mut i) {
                app.prefs.backups_kept = KEPT[i];
                save = true;
            }
        }
        _ => {}
    }
    if save {
        let _ = app.prefs.save(&app.support);
    }
}

/// Match System, then every theme, as cards with a small preview drawn in the theme's own
/// colours; four to a row.
fn theme_grid(ui: &mut Ui, app: &mut BrickMotionApp, t: &Theme) {
    ui.label(RichText::new("Theme").size(12.5).strong().color(t.text1));
    ui.add_space(2.0);
    ui.label(RichText::new("How BrickMotion looks. The model's own render look is set in Look.").size(11.5).color(t.text2));
    ui.add_space(12.0);
    let mut cards: Vec<(&'static str, &'static str, Option<Theme>)> = vec![(MATCH_SYSTEM, "Match System", None)];
    cards.extend(catalogue().iter().map(|d| (d.id, d.name, Some(d.theme))));
    let cols = 4;
    let gap = 12.0;
    let w = ((ui.available_width() - gap * (cols as f32 - 1.0)) / cols as f32).floor();
    let mut chosen = None;
    for line in cards.chunks(cols) {
        ui.horizontal(|ui| {
            ui.spacing_mut().item_spacing.x = gap;
            for (id, name, theme) in line {
                if theme_card(ui, t, w, name, *theme, app.prefs.theme == *id) {
                    chosen = Some(*id);
                }
            }
        });
        ui.add_space(gap);
    }
    if let Some(id) = chosen {
        app.set_theme(ui.ctx(), id);
    }
}

fn theme_card(ui: &mut Ui, t: &Theme, w: f32, name: &str, theme: Option<Theme>, on: bool) -> bool {
    let (r, resp) = ui.allocate_exact_size(vec2(w, 96.0), Sense::click());
    resp.widget_info(|| WidgetInfo::selected(egui::Role::RadioButton, true, on, name));
    let p = ui.painter();
    let preview = Rect::from_min_size(r.min, vec2(w, 66.0));
    match theme {
        Some(th) => mini(p, preview, &th),
        None => {
            let (l, rr) = preview.split_left_right_at_fraction(0.5);
            mini(&p.with_clip_rect(l), preview, &Theme::LIGHT);
            mini(&p.with_clip_rect(rr), preview, &Theme::DARK);
        }
    }
    let ring = if on { Stroke::new(2.0, t.accent) } else if resp.hovered() { Stroke::new(1.0, t.text3) } else { Stroke::new(1.0, t.border2) };
    p.rect_stroke(preview, CornerRadius::same(8), ring, StrokeKind::Outside);
    // Radio and name.
    let c = pos2(r.left() + 7.0, r.bottom() - 13.0);
    if on {
        p.circle_filled(c, 6.0, t.accent);
        p.circle_filled(c, 2.4, t.on_accent);
    } else {
        p.circle_stroke(c, 5.5, Stroke::new(1.0, t.border2));
    }
    p.text(pos2(c.x + 12.0, c.y), egui::Align2::LEFT_CENTER, name, egui::FontId::proportional(11.5), if on { t.text1 } else { t.text2 });
    resp.on_hover_cursor(egui::CursorIcon::PointingHand).clicked()
}

/// A tiny window in the theme's colours: a sidebar, a selected row in the accent, text lines,
/// and the playhead.
fn mini(p: &egui::Painter, r: Rect, th: &Theme) {
    let rad = CornerRadius::same(8);
    p.rect_filled(r, rad, th.bg0);
    let side = Rect::from_min_max(r.min, pos2(r.left() + r.width() * 0.3, r.bottom()));
    p.rect_filled(side, CornerRadius { nw: 8, sw: 8, ne: 0, se: 0 }, th.bg1);
    p.vline(side.right(), side.y_range(), Stroke::new(1.0, th.border));
    let row = |y: f32, len: f32, c| p.rect_filled(Rect::from_min_size(pos2(side.left() + 6.0, y), vec2(side.width() * len, 3.0)), 1.5, c);
    row(r.top() + 10.0, 0.55, th.text2);
    p.rect_filled(Rect::from_min_size(pos2(side.left() + 4.0, r.top() + 18.0), vec2(side.width() - 8.0, 9.0)), 2.5, Theme::alpha(th.accent, 90));
    row(r.top() + 21.0, 0.45, th.text1);
    row(r.top() + 32.0, 0.6, th.text3);
    row(r.top() + 42.0, 0.4, th.text3);
    let card = Rect::from_min_max(pos2(side.right() + 7.0, r.top() + 8.0), pos2(r.right() - 7.0, r.bottom() - 18.0));
    p.rect(card, CornerRadius::same(4), th.bg2, Stroke::new(1.0, th.border), StrokeKind::Inside);
    p.rect_filled(Rect::from_min_size(card.min + vec2(6.0, 6.0), vec2(card.width() * 0.5, 3.0)), 1.5, th.text1);
    p.rect_filled(Rect::from_min_size(card.min + vec2(6.0, 13.0), vec2(card.width() * 0.32, 3.0)), 1.5, th.text2);
    p.rect_filled(Rect::from_min_size(pos2(card.right() - 26.0, card.bottom() - 11.0), vec2(20.0, 6.0)), 3.0, th.accent);
    let lane = pos2(side.right() + 7.0, r.bottom() - 10.0);
    p.hline(lane.x..=r.right() - 7.0, lane.y, Stroke::new(2.0, th.bg3));
    p.vline(lane.x + (r.right() - lane.x) * 0.45, (lane.y - 5.0)..=(lane.y + 4.0), Stroke::new(1.5, th.playhead));
}
