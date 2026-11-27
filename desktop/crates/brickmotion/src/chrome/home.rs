//! Home: shown while no document is open. Three ways to start, the recent files, and the bundled
//! samples. Opening anything goes straight to Build.
use std::path::{Path, PathBuf};

use egui::{CornerRadius, Rect, RichText, Sense, Stroke, StrokeKind, Ui, WidgetInfo, pos2, vec2};

use crate::BrickMotionApp;
use crate::icons::{self, Icon};
use crate::theme::Theme;

/// A bundled sample: its title and its file under the samples folder.
pub const SAMPLES: [(&str, &str); 5] = [
    ("Helicopter", "helicopter/helicopter.mpd"),
    ("8880 Super Car", "8880-1.mpd"),
    ("5590 Super Truck", "5590_-_whirl_n_wheel_super_truck.mpd"),
    ("42000 Grand Prix", "42000-1.mpd"),
    ("Mechanisms", "mechanisms"),
];

/// The samples folder: `BrickMotion.app/Contents/Resources/Samples`, else `samples/` beside the
/// repo's `desktop/` folder.
pub fn samples_dir() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let bundled = exe.parent()?.join("../Resources/Samples");
    if bundled.is_dir() {
        return Some(bundled);
    }
    let roots = exe.ancestors().map(Path::to_path_buf).chain(std::env::current_dir().ok().into_iter().flat_map(|c| c.ancestors().map(Path::to_path_buf).collect::<Vec<_>>()));
    for anc in roots {
        let candidate = anc.join("samples");
        if candidate.join("helicopter").is_dir() {
            return Some(candidate);
        }
    }
    None
}

/// The samples that exist on this Mac, as (title, file). A folder sample opens its first model.
pub fn samples() -> Vec<(&'static str, PathBuf)> {
    let Some(dir) = samples_dir() else { return Vec::new() };
    SAMPLES
        .iter()
        .filter_map(|(title, rel)| {
            let p = dir.join(rel);
            if p.is_file() {
                return Some((*title, p));
            }
            let mut models: Vec<PathBuf> = std::fs::read_dir(&p)
                .ok()?
                .flatten()
                .map(|e| e.path())
                .filter(|f| f.extension().is_some_and(|x| x == "mpd" || x == "ldr"))
                .collect();
            models.sort();
            models.into_iter().next().map(|f| (*title, f))
        })
        .collect()
}

/// When the file was last changed, the way Finder says it: "Today", "Yesterday", or the date.
fn when(path: &Path) -> String {
    let Ok(modified) = std::fs::metadata(path).and_then(|m| m.modified()) else { return String::new() };
    let age = std::time::SystemTime::now().duration_since(modified).unwrap_or_default().as_secs();
    match age {
        0..=59 => "Just now".to_owned(),
        60..=3599 => format!("{} min ago", age / 60),
        3600..=86_399 => format!("{} h ago", age / 3600),
        86_400..=172_799 => "Yesterday".to_owned(),
        _ => format!("{} days ago", age / 86_400),
    }
}

pub fn show(ui: &mut Ui, app: &mut BrickMotionApp) {
    let t = app.theme;
    egui::CentralPanel::no_frame().show(ui, |ui| {
        let rect = ui.max_rect();
        ui.painter().rect_filled(rect, 0.0, t.bg0);
        let side = Rect::from_min_max(rect.min, pos2(rect.left() + 220.0, rect.bottom()));
        ui.painter().rect_filled(side, 0.0, t.bg1);
        ui.painter().vline(side.right(), side.y_range(), Stroke::new(1.0, t.border));
        ui.scope_builder(egui::UiBuilder::new().max_rect(side.shrink2(vec2(12.0, 16.0))), |ui| sidebar(ui, app, &t));
        let main = Rect::from_min_max(pos2(side.right() + 1.0, rect.top()), rect.max);
        ui.scope_builder(egui::UiBuilder::new().max_rect(main), |ui| {
            egui::ScrollArea::vertical().id_salt("home").auto_shrink([false, false]).show(ui, |ui| {
                let w = ui.available_width().min(880.0);
                let pad = ((ui.available_width() - w) / 2.0).max(32.0);
                egui::Frame::new().inner_margin(egui::Margin { left: pad as i8, right: 32, top: 36, bottom: 40 }).show(ui, |ui| {
                    ui.set_max_width(w);
                    page(ui, app, &t);
                });
            });
        });
    });
}

fn nav(ui: &mut Ui, t: &Theme, icon: Icon, label: &str, on: bool) -> bool {
    let (r, resp) = ui.allocate_exact_size(vec2(ui.available_width(), 30.0), Sense::click());
    resp.widget_info(|| WidgetInfo::selected(egui::Role::Tab, true, on, label));
    let p = ui.painter();
    if on {
        p.rect_filled(r, CornerRadius::same(7), t.accent_a(46));
    } else if resp.hovered() {
        p.rect_filled(r, CornerRadius::same(7), t.ink(12));
    }
    let fg = if on { t.text1 } else { t.text2 };
    icons::paint(ui, icon, Rect::from_center_size(pos2(r.left() + 18.0, r.center().y), vec2(16.0, 16.0)), 16.0, fg);
    ui.painter().text(pos2(r.left() + 34.0, r.center().y), egui::Align2::LEFT_CENTER, label, egui::FontId::proportional(12.5), fg);
    resp.clicked()
}

fn sidebar(ui: &mut Ui, app: &mut BrickMotionApp, t: &Theme) {
    ui.spacing_mut().item_spacing.y = 2.0;
    nav(ui, t, Icon::Home, "Home", true);
    ui.add_space(16.0);
    if nav(ui, t, Icon::Gear, "Settings", false) {
        app.settings.open = true;
    }
    if nav(ui, t, Icon::Help, "Help", false) {
        crate::help::open_guide(&app.support);
    }
}

fn heading(ui: &mut Ui, t: &Theme, text: &str) {
    ui.label(RichText::new(text).size(13.0).strong().color(t.text1));
    ui.add_space(10.0);
}

fn page(ui: &mut Ui, app: &mut BrickMotionApp, t: &Theme) {
    ui.spacing_mut().item_spacing = vec2(12.0, 0.0);
    heading(ui, t, "Start something");
    let starts: [(Icon, &str, &str, &str); 3] = [
        (Icon::Plus, "New Project", "An empty model · ⌘N", "file.new"),
        (Icon::File, "Open…", "Project or LDraw model · ⌘O", "file.open"),
        (Icon::Inventory, "Import Parts List…", "Rebrickable CSV or Studio bin", "file.import_inventory"),
    ];
    let cw = ((ui.available_width() - 24.0) / 3.0).floor();
    ui.horizontal(|ui| {
        for (icon, title, note, cmd) in starts {
            if start_card(ui, t, cw, icon, title, note) {
                if cmd == "file.import_inventory" {
                    // A parts list fills a new project, so start one first.
                    app.new_document();
                    app.open_inventory_dialog();
                } else {
                    app.requested.push(cmd);
                }
            }
        }
    });
    ui.add_space(32.0);

    heading(ui, t, "Recent");
    let recents: Vec<PathBuf> = app.recents.existing().into_iter().take(6).map(Path::to_path_buf).collect();
    if recents.is_empty() {
        ui.label(RichText::new("Files you open or save appear here.").size(12.5).color(t.text2));
    } else {
        let mut open = None;
        super::widgets::flush_group(ui, |ui| {
            for (i, path) in recents.iter().enumerate() {
                if i > 0 {
                    super::widgets::hairline(ui);
                }
                if recent_row(ui, t, path) {
                    open = Some(path.clone());
                }
            }
        });
        if let Some(p) = open {
            app.open(p);
        }
    }
    ui.add_space(32.0);

    let samples = samples();
    if !samples.is_empty() {
        heading(ui, t, "Samples");
        let cols = 5;
        let sw = ((ui.available_width() - 12.0 * (cols as f32 - 1.0)) / cols as f32).floor();
        let mut open = None;
        let bg = [t.bg2.r(), t.bg2.g(), t.bg2.b()];
        let ctx = ui.ctx().clone();
        ui.horizontal_wrapped(|ui| {
            ui.spacing_mut().item_spacing = vec2(12.0, 12.0);
            for (title, path) in &samples {
                let thumb = match app.thumbnails.get(&ctx, &app.support, path, bg) {
                    crate::thumbnails::Thumb::Ready(tex) => Some(tex),
                    _ => None,
                };
                if sample_card(ui, t, sw, title, thumb.as_ref()) {
                    open = Some(path.clone());
                }
            }
        });
        if let Some(p) = open {
            app.open(p);
        }
    }
}

fn start_card(ui: &mut Ui, t: &Theme, w: f32, icon: Icon, title: &str, note: &str) -> bool {
    let (r, resp) = ui.allocate_exact_size(vec2(w, 76.0), Sense::click());
    resp.widget_info(|| WidgetInfo::labeled(egui::Role::Button, true, title));
    let p = ui.painter();
    let fill = if resp.hovered() { t.bg3 } else { t.bg2 };
    p.rect(r, CornerRadius::same(10), fill, Stroke::new(1.0, t.border), StrokeKind::Inside);
    let chip = Rect::from_center_size(pos2(r.left() + 34.0, r.center().y), vec2(36.0, 36.0));
    p.rect_filled(chip, CornerRadius::same(9), t.accent_a(36));
    icons::paint(ui, icon, Rect::from_center_size(chip.center(), vec2(18.0, 18.0)), 18.0, t.accent);
    let x = chip.right() + 14.0;
    ui.painter().text(pos2(x, r.center().y - 9.0), egui::Align2::LEFT_CENTER, title, egui::FontId::proportional(13.0), t.text1);
    ui.painter().text(pos2(x, r.center().y + 10.0), egui::Align2::LEFT_CENTER, note, egui::FontId::proportional(11.5), t.text2);
    resp.on_hover_cursor(egui::CursorIcon::PointingHand).clicked()
}

fn recent_row(ui: &mut Ui, t: &Theme, path: &Path) -> bool {
    let name = path.file_name().map_or_else(String::new, |n| n.to_string_lossy().into_owned());
    let folder = path.parent().and_then(|p| p.file_name()).map_or_else(String::new, |n| n.to_string_lossy().into_owned());
    let (r, resp) = ui.allocate_exact_size(vec2(ui.available_width(), 48.0), Sense::click());
    resp.widget_info(|| WidgetInfo::labeled(egui::Role::Button, true, &name));
    if resp.hovered() {
        ui.painter().rect_filled(r, CornerRadius::same(8), t.ink(8));
    }
    icons::paint(ui, Icon::File, Rect::from_center_size(pos2(r.left() + 26.0, r.center().y), vec2(18.0, 18.0)), 18.0, t.text2);
    let p = ui.painter();
    p.text(pos2(r.left() + 48.0, r.center().y - 8.0), egui::Align2::LEFT_CENTER, &name, egui::FontId::proportional(12.5), t.text1);
    let meta = [when(path), folder].into_iter().filter(|s| !s.is_empty()).collect::<Vec<_>>().join(" · ");
    p.text(pos2(r.left() + 48.0, r.center().y + 9.0), egui::Align2::LEFT_CENTER, meta, egui::FontId::proportional(11.5), t.text2);
    resp.on_hover_cursor(egui::CursorIcon::PointingHand).clicked()
}

/// A sample: its picture (the brick icon until it is drawn) and its title under it.
fn sample_card(ui: &mut Ui, t: &Theme, w: f32, title: &str, thumb: Option<&egui::TextureHandle>) -> bool {
    let (r, resp) = ui.allocate_exact_size(vec2(w, 112.0), Sense::click());
    resp.widget_info(|| WidgetInfo::labeled(egui::Role::Button, true, title));
    let art = Rect::from_min_size(r.min, vec2(w, 80.0));
    let ring = if resp.hovered() { t.text3 } else { t.border };
    ui.painter().rect_filled(art, CornerRadius::same(10), t.bg2);
    match thumb {
        Some(tex) => {
            // Fill the card, cropping the picture's sides or top to keep its shape.
            let ts = tex.size_vec2();
            let (aw, ah) = (art.width() / ts.x, art.height() / ts.y);
            let s = aw.max(ah);
            let (u, v) = ((1.0 - aw / s) / 2.0, (1.0 - ah / s) / 2.0);
            egui::Image::from_texture(tex)
                .uv(Rect::from_min_max(pos2(u, v), pos2(1.0 - u, 1.0 - v)))
                .corner_radius(10)
                .paint_at(ui, art);
        }
        None => icons::paint(ui, Icon::Brick, Rect::from_center_size(art.center(), vec2(28.0, 28.0)), 28.0, t.text3),
    }
    let p = ui.painter();
    p.rect_stroke(art, CornerRadius::same(10), Stroke::new(1.0, ring), StrokeKind::Inside);
    ui.painter().text(pos2(r.left() + 2.0, art.bottom() + 16.0), egui::Align2::LEFT_CENTER, title, egui::FontId::proportional(12.5), t.text1);
    resp.on_hover_cursor(egui::CursorIcon::PointingHand).clicked()
}
