//! BrickMotion › Settings… (⌘,): a sidebar of five sections and a page of grouped rows. Every
//! change applies at once and is kept in `preferences.toml`; there is no Apply button.
use egui::{
    Align, Align2, CornerRadius, CursorIcon, FontId, Frame, Id, Key, Layout, Margin, Modal, Rect, RichText, Role,
    Sense, Stroke, StrokeKind, Ui, UiBuilder, WidgetInfo, pos2, vec2,
};

use super::{icon_button_tip, sheet, widgets};
use crate::BrickMotionApp;
use crate::icons::{self, Icon};
use crate::theme::{MATCH_SYSTEM, Theme, catalogue};

pub const SECTIONS: [&str; 5] = ["General", "Appearance", "Building", "Animate", "Files"];

const SECTION_ICONS: [Icon; 5] = [Icon::Sliders, Icon::Paint, Icon::Brick, Icon::Play, Icon::File];

const SECTION_LEADS: [&str; 5] = [
    "Audio feedback and editor basics.",
    "How BrickMotion looks. The model's own render look is set in Look.",
    "Selection, snapping and helper overlays while building.",
    "Automatic build planning and exported video branding.",
    "Autosave cadence, backup retention and local folders.",
];

const SHEET_W: f32 = 788.0;
const SIDEBAR_W: f32 = 200.0;
const BODY_H: f32 = 500.0;

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
    /// Horizontal space reserved on the right for the control.
    control_w: f32,
}

const ROWS: &[Row] = &[
    Row { id: "snap_sounds", section: 0, title: "Snap sounds while building", note: "A click as each part seats.", control_w: 40.0 },
    Row { id: "theme", section: 1, title: "Theme", note: "How BrickMotion looks. The model's own render look is set in Look.", control_w: 0.0 },
    Row { id: "background", section: 1, title: "Viewport background", note: "Behind the model while you build.", control_w: 204.0 },
    Row { id: "click_selects", section: 2, title: "Click selects", note: "Hold ⌥ for the other.", control_w: 188.0 },
    Row { id: "collision", section: 2, title: "Collision checks", note: "Stop a part from moving into another.", control_w: 40.0 },
    Row { id: "smart_joints", section: 2, title: "Smart Joints", note: "Rotation rings and limits on jointed parts.", control_w: 40.0 },
    Row { id: "local_axes", section: 2, title: "Local axes", note: "Move along the part's own axes.", control_w: 40.0 },
    Row { id: "auto_plan", section: 3, title: "Plan the build automatically", note: "Re-plan the flights after each edit.", control_w: 40.0 },
    Row { id: "logo", section: 3, title: "Video logo", note: "Stamp your logo on exported movies.", control_w: 204.0 },
    Row { id: "logo_corner", section: 3, title: "Logo corner", note: "Where the logo sits in the frame.", control_w: 320.0 },
    Row { id: "autosave", section: 4, title: "Autosave every", note: "An edited document is saved to a backup.", control_w: 232.0 },
    Row { id: "backups", section: 4, title: "Backups kept", note: "Older backups are removed.", control_w: 192.0 },
];

fn matches(row: &Row, query: &str) -> bool {
    let q = query.trim().to_lowercase();
    q.is_empty()
        || row.title.to_lowercase().contains(&q)
        || row.note.to_lowercase().contains(&q)
        || SECTIONS[row.section].to_lowercase().contains(&q)
}

pub fn show(ui: &mut Ui, app: &mut BrickMotionApp) {
    if !app.settings.open {
        return;
    }
    let t = app.theme;
    let mut close = false;
    let modal = Modal::new(Id::unique("settings-sheet"))
        .frame(sheet::frame(&t))
        .backdrop_color(sheet::backdrop(&t))
        .show(ui.ctx(), |ui| {
            ui.set_width(SHEET_W);
            ui.spacing_mut().item_spacing = vec2(0.0, 0.0);
            let title = if app.settings.search.trim().is_empty() {
                SECTIONS[app.settings.section]
            } else {
                "Search"
            };
            close = sheet::header(ui, &t, &format!("Settings — {title}"));
            ui.horizontal_top(|ui| {
                ui.spacing_mut().item_spacing = vec2(0.0, 0.0);
                sidebar(ui, app, &t);
                let (line, _) = ui.allocate_exact_size(vec2(1.0, BODY_H), Sense::hover());
                ui.painter().vline(line.center().x, line.y_range(), Stroke::new(1.0, t.border));
                let page_w = SHEET_W - SIDEBAR_W - 1.0;
                ui.vertical(|ui| {
                    ui.set_width(page_w);
                    egui::ScrollArea::vertical()
                        .id_salt("settings-page")
                        .max_height(BODY_H)
                        .min_scrolled_height(BODY_H)
                        .auto_shrink([false, false])
                        .show(ui, |ui| {
                            Frame::NONE
                                .inner_margin(Margin { left: 26, right: 26, top: 20, bottom: 26 })
                                .show(ui, |ui| page(ui, app, &t));
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
    let (rect, _) = ui.allocate_exact_size(vec2(SIDEBAR_W, BODY_H), Sense::hover());
    ui.painter().rect_filled(rect, CornerRadius { nw: 0, ne: 0, sw: 13, se: 0 }, t.bg0);
    let inner = rect.shrink2(vec2(12.0, 14.0));
    let mut sub = ui.new_child(UiBuilder::new().max_rect(inner).layout(Layout::top_down(Align::LEFT)));
    sub.spacing_mut().item_spacing = vec2(0.0, 3.0);
    search_field(&mut sub, t, &mut app.settings.search);
    sub.add_space(10.0);
    let searching = !app.settings.search.trim().is_empty();
    for (i, name) in SECTIONS.iter().enumerate() {
        let on = !searching && app.settings.section == i;
        let (r, resp) = sub.allocate_exact_size(vec2(sub.available_width(), 32.0), Sense::click());
        resp.widget_info(|| WidgetInfo::selected(Role::Tab, true, on, *name));
        let hovered = resp.hovered();
        let p = sub.painter();
        if on {
            p.rect(r, CornerRadius::same(7), t.accent_bg(), Stroke::new(0.5, t.accent_a(70)), StrokeKind::Inside);
        } else if hovered {
            p.rect_filled(r, CornerRadius::same(7), t.ink(14));
        }
        let icon_tint = if on {
            t.accent
        } else if hovered {
            t.text1
        } else {
            t.text2
        };
        let text_color = if on || hovered { t.text1 } else { t.text2 };
        icons::paint(&sub, SECTION_ICONS[i], Rect::from_center_size(pos2(r.left() + 18.0, r.center().y), vec2(15.0, 15.0)), 15.0, icon_tint);
        sub.painter().text(pos2(r.left() + 34.0, r.center().y), Align2::LEFT_CENTER, *name, FontId::proportional(12.5), text_color);
        if resp.on_hover_cursor(CursorIcon::PointingHand).clicked() {
            app.settings.section = i;
            app.settings.search.clear();
        }
    }
}

fn search_field(ui: &mut Ui, t: &Theme, text: &mut String) {
    let id = ui.make_persistent_id("settings-search");
    let focused = ui.memory(|m| m.has_focus(id));
    let (rect, _) = ui.allocate_exact_size(vec2(ui.available_width(), 30.0), Sense::hover());
    let p = ui.painter();
    if focused {
        p.rect_stroke(rect.expand(1.5), CornerRadius::same(9), Stroke::new(2.5, t.accent.gamma_multiply(0.28)), StrokeKind::Outside);
    }
    let border = if focused { t.accent } else { t.border2 };
    p.rect(rect, CornerRadius::same(8), t.bg2, Stroke::new(1.0, border), StrokeKind::Inside);
    icons::paint(
        ui,
        Icon::Search,
        Rect::from_center_size(pos2(rect.left() + 16.0, rect.center().y), vec2(14.0, 14.0)),
        14.0,
        if focused { t.accent } else { t.text3 },
    );
    let has_text = !text.is_empty();
    let right_pad = if has_text { 26.0 } else { 10.0 };
    let edit_rect = Rect::from_min_max(pos2(rect.left() + 28.0, rect.top()), pos2(rect.right() - right_pad, rect.bottom()));
    let mut edit_ui = ui.new_child(UiBuilder::new().max_rect(edit_rect).layout(Layout::left_to_right(Align::Center)));
    let v = edit_ui.visuals_mut();
    v.selection.bg_fill = t.accent.gamma_multiply(0.38);
    v.selection.stroke = Stroke::new(1.0, t.text1);
    v.text_cursor.stroke = Stroke::new(1.5, t.accent);
    let resp = edit_ui.add(
        egui::TextEdit::singleline(text)
            .id(id)
            .hint_text(RichText::new("Search").size(12.5).color(t.text3))
            .frame(Frame::NONE)
            .margin(Margin::ZERO)
            .font(FontId::proportional(12.5))
            .text_color(t.text1)
            .align(Align2::LEFT_CENTER)
            .desired_width(edit_rect.width()),
    );
    resp.widget_info(|| WidgetInfo::labeled(Role::TextInput, true, "Search"));
    if has_text {
        let clear_rect = Rect::from_center_size(pos2(rect.right() - 14.0, rect.center().y), vec2(18.0, 18.0));
        let mut clear_ui = ui.new_child(UiBuilder::new().max_rect(clear_rect));
        if icon_button_tip(&mut clear_ui, t, Icon::Close, "Clear Search", "Clear search", true, false, 18.0).clicked() {
            text.clear();
        }
    }
}

fn settings_card(ui: &mut Ui, t: &Theme, content: impl FnOnce(&mut Ui)) {
    Frame::NONE
        .fill(t.bg2)
        .stroke(Stroke::new(1.0, t.border))
        .corner_radius(CornerRadius::same(10))
        .show(ui, |ui| {
            ui.set_width(ui.available_width());
            ui.spacing_mut().item_spacing.y = 0.0;
            content(ui);
        });
}

fn card_hairline(ui: &mut Ui, t: &Theme) {
    let (r, _) = ui.allocate_exact_size(vec2(ui.available_width(), 1.0), Sense::hover());
    ui.painter().hline((r.left() + 14.0)..=(r.right() - 14.0), r.center().y, Stroke::new(1.0, t.border));
}

fn group_label(ui: &mut Ui, t: &Theme, title: &str) {
    ui.label(RichText::new(title).size(11.5).strong().color(t.text3));
    ui.add_space(8.0);
}

fn page(ui: &mut Ui, app: &mut BrickMotionApp, t: &Theme) {
    let query = app.settings.search.clone();
    let searching = !query.trim().is_empty();
    if !searching {
        let idx = app.settings.section;
        ui.label(RichText::new(SECTIONS[idx]).size(15.0).strong().color(t.text1));
        ui.add_space(3.0);
        ui.label(RichText::new(SECTION_LEADS[idx]).size(12.0).color(t.text2));
        ui.add_space(18.0);
    }
    let rows: Vec<&Row> = ROWS
        .iter()
        .filter(|r| if searching { matches(r, &query) } else { r.section == app.settings.section })
        .collect();
    if rows.is_empty() {
        settings_card(ui, t, |ui| {
            Frame::NONE.inner_margin(Margin::symmetric(16, 18)).show(ui, |ui| {
                ui.label(RichText::new(format!("No settings match “{}”.", query.trim())).size(12.5).color(t.text2));
            });
        });
        return;
    }
    let mut last_section = usize::MAX;
    let mut i = 0;
    while i < rows.len() {
        let row = rows[i];
        if searching && row.section != last_section {
            group_label(ui, t, SECTIONS[row.section]);
            last_section = row.section;
        }
        if row.id == "theme" {
            theme_grid(ui, app, t);
            ui.add_space(18.0);
            if !searching {
                group_label(ui, t, "Viewport");
            }
            i += 1;
            continue;
        }
        // A run of plain rows in one section shares one card.
        let start = i;
        while i < rows.len() && rows[i].id != "theme" && rows[i].section == row.section {
            i += 1;
        }
        settings_card(ui, t, |ui| {
            for (k, r) in rows[start..i].iter().enumerate() {
                if k > 0 {
                    card_hairline(ui, t);
                }
                setting_row(ui, app, t, r);
            }
        });
        ui.add_space(18.0);
    }
    if !searching && app.settings.section == 4 {
        locations_card(ui, app, t);
    }
}

/// Read-only paths on the Files page: where parts are read from and where backups are written.
fn locations_card(ui: &mut Ui, app: &BrickMotionApp, t: &Theme) {
    group_label(ui, t, "Locations");
    let parts = bm::ldraw_directory().map_or_else(|| "Not found".to_owned(), |p| p.display().to_string());
    let backups = app.support.backups().display().to_string();
    settings_card(ui, t, |ui| {
        info_row(ui, t, "Parts library", &parts);
        card_hairline(ui, t);
        info_row(ui, t, "Backups folder", &backups);
    });
}

fn info_row(ui: &mut Ui, t: &Theme, title: &str, value: &str) {
    let w = ui.available_width();
    let (rect, _) = ui.allocate_exact_size(vec2(w, 42.0), Sense::hover());
    let left_rect = Rect::from_min_max(pos2(rect.left() + 14.0, rect.top()), pos2(rect.left() + 132.0, rect.bottom()));
    let mut left_ui = ui.new_child(UiBuilder::new().max_rect(left_rect).layout(Layout::left_to_right(Align::Center)));
    left_ui.label(RichText::new(title).size(12.5).color(t.text1));
    let right_rect = Rect::from_min_max(pos2(left_rect.right() + 8.0, rect.top()), pos2(rect.right() - 14.0, rect.bottom()));
    let mut right_ui = ui.new_child(UiBuilder::new().max_rect(right_rect).layout(Layout::right_to_left(Align::Center)));
    right_ui.add(egui::Label::new(RichText::new(value).size(11.5).color(t.text2)).truncate()).on_hover_text(value);
}

/// Title and note vertically centred on the left, control vertically centred on the right.
fn setting_row(ui: &mut Ui, app: &mut BrickMotionApp, t: &Theme, row: &Row) {
    let w = ui.available_width();
    let pad_x = 14.0;
    let gap = 14.0;
    let left_w = (w - pad_x * 2.0 - row.control_w - gap).max(150.0);
    let title_g = ui.painter().layout(row.title.to_owned(), FontId::proportional(12.5), t.text1, left_w);
    let note_g = ui.painter().layout(row.note.to_owned(), FontId::proportional(11.5), t.text2, left_w);
    let text_h = title_g.size().y + 2.0 + note_g.size().y;
    let row_h = (text_h + 24.0).max(56.0);
    let (rect, _) = ui.allocate_exact_size(vec2(w, row_h), Sense::hover());

    let text_rect = Rect::from_min_size(pos2(rect.left() + pad_x, rect.center().y - text_h * 0.5), vec2(left_w, text_h + 6.0));
    let mut text_ui = ui.new_child(UiBuilder::new().max_rect(text_rect).layout(Layout::top_down(Align::LEFT)));
    text_ui.spacing_mut().item_spacing.y = 2.0;
    text_ui.label(RichText::new(row.title).size(12.5).color(t.text1));
    text_ui.label(RichText::new(row.note).size(11.5).color(t.text2));

    let ctrl_rect = Rect::from_min_max(pos2(text_rect.right() + gap, rect.top()), pos2(rect.right() - pad_x, rect.bottom()));
    let mut ctrl_ui = ui.new_child(UiBuilder::new().max_rect(ctrl_rect).layout(Layout::right_to_left(Align::Center)));
    control(&mut ctrl_ui, app, t, row);
}

fn segment(ui: &mut Ui, t: &Theme, id: &str, width: f32, options: &[&str], selected: &mut usize) -> bool {
    let mut changed = false;
    ui.allocate_ui_with_layout(vec2(width, 24.0), Layout::left_to_right(Align::Center), |ui| {
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
                ui.add_space(8.0);
                ui.label(RichText::new("Choose one in Export Movie").size(11.5).color(t.text3));
            }
        }
        "logo_corner" => {
            const CORNERS: [&str; 4] = ["tl", "tr", "bl", "br"];
            let mut i = CORNERS.iter().position(|c| *c == app.prefs.video_logo_corner).unwrap_or(3);
            if segment(ui, t, row.id, 316.0, &["Top Left", "Top Right", "Bottom Left", "Bottom Right"], &mut i) {
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
                ui.ctx().request_repaint();
                save = true;
            }
        }
        "click_selects" => {
            let mut i = usize::from(app.edit.pick_scope == crate::edit::PickScope::Pieces);
            if segment(ui, t, row.id, 184.0, &["Submodels", "Pieces"], &mut i) {
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
            if segment(ui, t, row.id, 228.0, &["15 s", "30 s", "1 min", "2 min"], &mut i) {
                app.prefs.autosave_seconds = SECS[i];
                save = true;
            }
        }
        "backups" => {
            const KEPT: [usize; 4] = [5, 10, 20, 50];
            let mut i = KEPT.iter().position(|s| *s == app.prefs.backups_kept).unwrap_or(1);
            if segment(ui, t, row.id, 188.0, &["5", "10", "20", "50"], &mut i) {
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
    group_label(ui, t, "Theme");
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
        ui.ctx().request_repaint();
    }
}

fn theme_card(ui: &mut Ui, t: &Theme, w: f32, name: &str, theme: Option<Theme>, on: bool) -> bool {
    let (r, resp) = ui.allocate_exact_size(vec2(w, 98.0), Sense::click());
    resp.widget_info(|| WidgetInfo::selected(Role::RadioButton, true, on, name));
    let p = ui.painter();
    let preview = Rect::from_min_size(r.min + vec2(2.0, 2.0), vec2(w - 4.0, 66.0));
    if on {
        p.rect_filled(preview.expand(3.0), CornerRadius::same(11), t.accent_bg());
    }
    match theme {
        Some(th) => mini(p, preview, &th),
        None => {
            let (l, rr) = preview.split_left_right_at_fraction(0.5);
            mini(&p.with_clip_rect(l), preview, &Theme::LIGHT);
            mini(&p.with_clip_rect(rr), preview, &Theme::DARK);
        }
    }
    let ring = if on {
        Stroke::new(2.0, t.accent)
    } else if resp.hovered() {
        Stroke::new(1.0, t.text3)
    } else {
        Stroke::new(1.0, t.border2)
    };
    p.rect_stroke(preview, CornerRadius::same(8), ring, StrokeKind::Outside);
    // Radio and name, clipped to the card width so long names never spill onto neighbours.
    let c = pos2(r.left() + 8.0, r.bottom() - 12.0);
    if on {
        p.circle_filled(c, 6.0, t.accent);
        p.circle_filled(c, 2.4, t.on_accent);
    } else {
        p.circle_stroke(c, 5.5, Stroke::new(1.0, t.border2));
    }
    let label_clip = Rect::from_min_max(pos2(c.x + 11.0, preview.bottom() + 2.0), pos2(r.right(), r.bottom()));
    p.with_clip_rect(label_clip).text(
        pos2(c.x + 11.0, c.y),
        Align2::LEFT_CENTER,
        name,
        FontId::proportional(11.5),
        if on { t.text1 } else { t.text2 },
    );
    resp.on_hover_text(name).on_hover_cursor(CursorIcon::PointingHand).clicked()
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
