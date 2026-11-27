//! The Look panel: the project's scene backdrop, shading mode, detail toggles and path-tracing
//! samples. Saved with the project and used by every video. Every change is one `set_render_look`
//! call and one undo step; the samples slider commits on release. Commits happen at the end of
//! `body()` so the panel never collapses or flashes mid-frame.
use bm::export::{RenderLook, SceneCollection, ScenePreset, Shading, scenes};
use egui::{
    Align, Align2, Color32, CornerRadius, CursorIcon, FontId, Frame, Layout, Margin, Rect, RichText, Role, Sense,
    Stroke, StrokeKind, Ui, UiBuilder, WidgetInfo, pos2, vec2,
};

use super::float_panel::{self, Head, PanelKind, group_heading};
use super::widgets::{SliderEvent, footnote, parse_number, pill_switch, segmented, slider_row, switch_row};
use crate::BrickMotionApp;
use crate::icons::Icon;
use crate::theme::Theme;

#[derive(Default)]
pub struct LookPanel {
    pub open: bool,
    /// `set_render_look` calls made (tests read it).
    pub commits: usize,
    /// The web scenes, read once.
    scenes: Vec<ScenePreset>,
    /// Active scene collection tab (0 = Photo, 1 = Render, 2 = Classic).
    tab: usize,
    /// Last `look.scene` synced to `tab`, so undo or opening a project follows its scene.
    synced_scene: Option<String>,
}

const COLLECTIONS: [SceneCollection; 3] = [SceneCollection::Photo, SceneCollection::Render, SceneCollection::Classic];
const COLLECTION_LABELS: [&str; 3] = ["Photo", "Render", "Classic"];
const EDITOR_HINT: &str = "The editor's own backdrop, which follows Light and Dark appearance";

/// One Detail switch's field of the look.
type Field = fn(&mut RenderLook) -> &mut bool;

pub fn toggle(app: &mut BrickMotionApp) {
    app.look.open = !app.look.open;
    if app.look.open {
        app.panels.unfold(PanelKind::Look);
    }
}

pub fn is_open(app: &BrickMotionApp) -> bool {
    app.look.open
}

pub fn shading_title(s: Shading) -> &'static str {
    match s {
        Shading::Standard => "Standard",
        Shading::Studio => "Studio",
        Shading::Neural => "Neural",
        Shading::HybridRt => "Hybrid Ray Tracing",
        Shading::ScreenSpaceGi => "Screen-Space Bounce",
        Shading::PathTraced => "Path Traced",
        Shading::RealTimePathTraced => "Live Path Traced",
    }
}

pub fn shading_detail(s: Shading) -> &'static str {
    match s {
        Shading::Standard => "Fast raster shading with shadows and occlusion",
        Shading::Studio => "Studio ABS plastic with baked world light, no edge lines",
        Shading::Neural => "Learned shader for soft studio light, in real time",
        Shading::HybridRt => "Hardware ray-traced glass and reflections over raster",
        Shading::ScreenSpaceGi => "Coloured bounce light and glossy reflections",
        Shading::PathTraced => "Final-render quality, refined while the view is still",
        Shading::RealTimePathTraced => "Real-time ReSTIR + SHaRC path tracing with SVGF denoising, always live",
    }
}

fn commit(app: &mut BrickMotionApp, look: &RenderLook) {
    let c = app.doc.session().set_render_look(look);
    app.look.commits += 1;
    app.edited(c);
}

pub fn show(ui: &mut Ui, app: &mut BrickMotionApp, area: Rect, next_top: &mut f32) {
    if !app.look.open {
        return;
    }
    if app.look.scenes.is_empty() {
        app.look.scenes = scenes();
    }
    let out = float_panel::show(
        ui,
        app,
        area,
        next_top,
        PanelKind::Look,
        Head { icon: Icon::Sun, title: "", subtitle: "Project" },
        body,
    );
    if out.close {
        app.look.open = false;
    }
}

fn rgb(v: bm::Vec3) -> Color32 {
    let b = |x: f64| (x.clamp(0.0, 1.0) * 255.0).round() as u8;
    Color32::from_rgb(b(v.x), b(v.y), b(v.z)) // data colour
}

/// Slightly shaded floor-band colour derived from a scene's backdrop colour so bright/white
/// studio sweeps read clearly as a studio backdrop with a floor rather than a blank box.
fn floor_band(v: bm::Vec3) -> Color32 {
    let lum = 0.2126 * v.x + 0.7152 * v.y + 0.0722 * v.z;
    let shift = |x: f64| if lum > 0.25 { (x * 0.90).clamp(0.0, 1.0) } else { (x + 0.09).clamp(0.0, 1.0) };
    let b = |x: f64| (shift(x) * 255.0).round() as u8;
    Color32::from_rgb(b(v.x), b(v.y), b(v.z)) // data colour
}

fn paint_editor_chip(p: &egui::Painter, rect: Rect, t: &Theme, radius: u8) {
    p.rect_filled(rect, CornerRadius::same(radius), Color32::from_gray(236)); // data colour: light backdrop
    let half = Rect::from_min_max(pos2(rect.center().x, rect.top()), rect.max);
    p.rect_filled(half, CornerRadius { nw: 0, sw: 0, ne: radius, se: radius }, Color32::from_gray(34)); // data colour: dark backdrop
    p.rect_stroke(rect, CornerRadius::same(radius), Stroke::new(1.0, t.border2), StrokeKind::Inside);
}

fn paint_radio(p: &egui::Painter, center: egui::Pos2, t: &Theme, on: bool) {
    if on {
        p.circle_filled(center, 6.0, t.accent);
        p.circle_filled(center, 2.4, t.on_accent);
    } else {
        p.circle_stroke(center, 5.5, Stroke::new(1.0, t.border2));
    }
}

fn look_card(ui: &mut Ui, t: &Theme, content: impl FnOnce(&mut Ui)) {
    Frame::NONE
        .outer_margin(Margin::symmetric(12, 0))
        .fill(t.bg2)
        .stroke(Stroke::new(1.0, t.border))
        .corner_radius(CornerRadius::same(10))
        .show(ui, |ui| {
            ui.set_width(ui.available_width());
            ui.spacing_mut().item_spacing.y = 0.0;
            content(ui);
        });
}

fn card_hairline(ui: &mut Ui, t: &Theme, inset: f32) {
    let (r, _) = ui.allocate_exact_size(vec2(ui.available_width(), 1.0), Sense::hover());
    ui.painter().hline((r.left() + inset)..=(r.right() - inset), r.center().y, Stroke::new(1.0, t.border));
}

/// One landscape studio-backdrop swatch inside the 5-column scene grid.
fn scene_swatch(ui: &mut Ui, t: &Theme, scene: &ScenePreset, size: egui::Vec2, selected: bool) -> egui::Response {
    let (r, resp) = ui.allocate_exact_size(size, Sense::click());
    resp.widget_info(|| WidgetInfo::selected(Role::Button, true, selected, &scene.label));
    let p = ui.painter();
    let inner = r.shrink(2.5);
    let fill = rgb(scene.background);
    p.rect_filled(inner, CornerRadius::same(5), fill);
    if scene.floor {
        let band = Rect::from_min_max(pos2(inner.left(), inner.bottom() - inner.height() * 0.34), inner.max);
        p.rect_filled(band, CornerRadius { nw: 0, ne: 0, sw: 5, se: 5 }, floor_band(scene.background));
    }
    p.rect_stroke(inner, CornerRadius::same(5), Stroke::new(1.0, t.border2), StrokeKind::Inside);
    if selected {
        p.rect_stroke(r, CornerRadius::same(7), Stroke::new(2.0, t.accent), StrokeKind::Inside);
    } else if resp.hovered() {
        p.rect_stroke(r, CornerRadius::same(7), Stroke::new(1.0, t.text3), StrokeKind::Inside);
    }
    resp.on_hover_text(format!("{}: {}", scene.label, scene.hint)).on_hover_cursor(CursorIcon::PointingHand)
}

/// A two-line switch row (title + muted note vertically centred beside the pill switch).
fn switch_note_row(ui: &mut Ui, t: &Theme, label: &str, note: &str, on: &mut bool, enabled: bool) -> bool {
    let w = ui.available_width();
    let (rect, _) = ui.allocate_exact_size(vec2(w, 46.0), Sense::hover());
    let text_rect = Rect::from_min_max(pos2(rect.left() + 12.0, rect.top() + 6.0), pos2(rect.right() - 50.0, rect.bottom() - 6.0));
    let fg = if enabled { t.text1 } else { t.text3 };
    let p = ui.painter().with_clip_rect(text_rect);
    p.text(pos2(text_rect.left(), rect.center().y - 7.5), Align2::LEFT_CENTER, label, FontId::proportional(12.5), fg);
    p.text(pos2(text_rect.left(), rect.center().y + 8.5), Align2::LEFT_CENTER, note, FontId::proportional(10.5), t.text3);
    let ctrl_rect = Rect::from_min_max(pos2(rect.right() - 46.0, rect.top()), pos2(rect.right() - 12.0, rect.bottom()));
    let mut ctrl_ui = ui.new_child(UiBuilder::new().max_rect(ctrl_rect).layout(Layout::right_to_left(Align::Center)));
    pill_switch(&mut ctrl_ui, t, label, on, enabled)
}

fn body(ui: &mut Ui, app: &mut BrickMotionApp) {
    let t = app.theme;
    let look = app.doc.session().render_look();
    if app.look.synced_scene.as_deref() != Some(look.scene.as_str()) {
        if let Some(preset) = app.look.scenes.iter().find(|s| s.id == look.scene) {
            app.look.tab = match preset.collection {
                SceneCollection::Photo => 0,
                SceneCollection::Render => 1,
                SceneCollection::Classic => 2,
            };
        }
        app.look.synced_scene = Some(look.scene.clone());
    }
    let mut pending: Option<RenderLook> = None;

    Frame::NONE.inner_margin(Margin { left: 16, right: 16, top: 8, bottom: 2 }).show(ui, |ui| {
        ui.label(RichText::new("Saved with the project and used by every video.").size(11.0).color(t.text3));
    });

    // ---- Scene ----
    let current = app.look.scenes.iter().find(|s| s.id == look.scene).cloned();
    group_heading(ui, &t, "Scene", current.as_ref().map_or("Editor", |s| s.label.as_str()));

    let mut hovered_scene: Option<Option<ScenePreset>> = None;
    let mut tab = app.look.tab.min(COLLECTIONS.len() - 1);
    let mut chosen_scene: Option<String> = None;

    look_card(ui, &t, |ui| {
        // Editor backdrop row: always one click away regardless of which collection tab is open.
        let editor_on = look.scene.is_empty();
        let (er, eresp) = ui.allocate_exact_size(vec2(ui.available_width(), 42.0), Sense::click());
        eresp.widget_info(|| WidgetInfo::selected(Role::Button, true, editor_on, "Editor"));
        let p = ui.painter();
        let top_rad = CornerRadius { nw: 9, ne: 9, sw: 0, se: 0 };
        if editor_on {
            p.rect_filled(er.shrink(1.0), top_rad, t.accent_bg());
        } else if eresp.hovered() {
            p.rect_filled(er.shrink(1.0), top_rad, t.ink(10));
        }
        let chip = Rect::from_center_size(pos2(er.left() + 26.0, er.center().y), vec2(28.0, 20.0));
        paint_editor_chip(p, chip, &t, 5);
        p.text(
            pos2(chip.right() + 10.0, er.center().y - 7.0),
            Align2::LEFT_CENTER,
            "Editor",
            FontId::proportional(12.5),
            if editor_on { t.text1 } else { t.text2 },
        );
        p.text(
            pos2(chip.right() + 10.0, er.center().y + 8.0),
            Align2::LEFT_CENTER,
            "Follows Light and Dark appearance",
            FontId::proportional(10.5),
            t.text3,
        );
        paint_radio(p, pos2(er.right() - 18.0, er.center().y), &t, editor_on);
        if eresp.hovered() {
            hovered_scene = Some(None);
        }
        if eresp.on_hover_text(format!("Editor: {EDITOR_HINT}")).on_hover_cursor(CursorIcon::PointingHand).clicked() && !editor_on {
            chosen_scene = Some(String::new());
        }

        card_hairline(ui, &t, 0.0);

        // Collection tabs + 5-column studio backdrop swatches.
        Frame::NONE.inner_margin(Margin { left: 10, right: 10, top: 8, bottom: 8 }).show(ui, |ui| {
            segmented(ui, &t, "look-scene-collection", &COLLECTION_LABELS, &mut tab, true);
            ui.add_space(8.0);
            let active_collection = COLLECTIONS[tab];
            let items: Vec<&ScenePreset> = app.look.scenes.iter().filter(|s| s.collection == active_collection).collect();
            let cols = 5;
            let gap = 6.0;
            let sw = ((ui.available_width() - gap * (cols as f32 - 1.0)) / cols as f32).floor().max(32.0);
            let sh = 28.0;
            ui.spacing_mut().item_spacing = vec2(gap, gap);
            for (row_idx, chunk) in items.chunks(cols).enumerate() {
                if row_idx > 0 {
                    ui.add_space(gap);
                }
                ui.horizontal(|ui| {
                    ui.spacing_mut().item_spacing.x = gap;
                    for s in chunk {
                        let resp = scene_swatch(ui, &t, s, vec2(sw, sh), s.id == look.scene);
                        if resp.hovered() {
                            hovered_scene = Some(Some((*s).clone()));
                        }
                        if resp.clicked() && s.id != look.scene {
                            chosen_scene = Some(s.id.clone());
                        }
                    }
                });
            }
        });

        card_hairline(ui, &t, 0.0);

        // Stable-height recessed footer strip: previews the hovered swatch live, or shows the active scene.
        let shown_scene: Option<&ScenePreset> = match &hovered_scene {
            Some(opt) => opt.as_ref(),
            None => current.as_ref(),
        };
        let (preview_r, _) = ui.allocate_exact_size(vec2(ui.available_width(), 44.0), Sense::hover());
        let p = ui.painter();
        let foot_bg = Rect::from_min_max(pos2(preview_r.left() + 1.0, preview_r.top()), pos2(preview_r.right() - 1.0, preview_r.bottom() - 1.0));
        p.rect_filled(foot_bg, CornerRadius { nw: 0, ne: 0, sw: 9, se: 9 }, t.bg0);
        if shown_scene.is_none() && hovered_scene.is_none() {
            // Editor is already highlighted at the top of the card; avoid repeating it.
            p.text(
                pos2(preview_r.left() + 12.0, preview_r.center().y),
                Align2::LEFT_CENTER,
                "Hover a backdrop to preview its name and mood.",
                FontId::proportional(10.5),
                t.text3,
            );
        } else {
            let chip_r = Rect::from_center_size(pos2(preview_r.left() + 21.0, preview_r.center().y), vec2(20.0, 20.0));
            match shown_scene {
                Some(s) => {
                    p.rect_filled(chip_r, CornerRadius::same(4), rgb(s.background));
                    if s.floor {
                        let band = Rect::from_min_max(pos2(chip_r.left(), chip_r.bottom() - 7.0), chip_r.max);
                        p.rect_filled(band, CornerRadius { nw: 0, ne: 0, sw: 4, se: 4 }, floor_band(s.background));
                    }
                    p.rect_stroke(chip_r, CornerRadius::same(4), Stroke::new(1.0, t.border2), StrokeKind::Inside);
                }
                None => paint_editor_chip(p, chip_r, &t, 4),
            }
            let text_left = chip_r.right() + 9.0;
            let text_w = (preview_r.right() - 12.0 - text_left).max(80.0);
            let (title_text, hint_text) = match shown_scene {
                Some(s) => (s.label.as_str(), s.hint.as_str()),
                None => ("Editor", EDITOR_HINT),
            };
            let title_g = ui.painter().layout_no_wrap(title_text.to_owned(), FontId::proportional(11.5), t.text1);
            let hint_g = ui.painter().layout(hint_text.to_owned(), FontId::proportional(10.0), t.text3, text_w);
            let total_h = (title_g.size().y + 1.0 + hint_g.size().y).min(preview_r.height() - 6.0);
            let text_top = (preview_r.center().y - total_h * 0.5).max(preview_r.top() + 3.0);
            let clip_r = Rect::from_min_max(pos2(text_left, preview_r.top() + 2.0), pos2(preview_r.right() - 10.0, preview_r.bottom() - 2.0));
            let cp = p.with_clip_rect(clip_r);
            cp.galley(pos2(text_left, text_top), title_g, t.text1);
            cp.galley(pos2(text_left, text_top + 14.0), hint_g, t.text3);
        }
    });
    app.look.tab = tab;
    if let Some(scene) = chosen_scene {
        pending = Some(RenderLook { scene, ..look.clone() });
    }

    // ---- Shading ----
    group_heading(ui, &t, "Shading", shading_title(look.shading));
    let mut chosen_shading = None;
    look_card(ui, &t, |ui| {
        let total = Shading::ALL.len();
        for (idx, s) in Shading::ALL.into_iter().enumerate() {
            if idx > 0 {
                card_hairline(ui, &t, 12.0);
            }
            let on = s == look.shading;
            let row_w = ui.available_width();
            let text_w = (row_w - 42.0).max(120.0);
            let title_g = ui.painter().layout_no_wrap(shading_title(s).to_owned(), FontId::proportional(12.5), t.text1);
            let detail_g = ui.painter().layout(shading_detail(s).to_owned(), FontId::proportional(10.5), t.text3, text_w);
            let content_h = title_g.size().y + 2.0 + detail_g.size().y;
            let row_h = (content_h + 14.0).max(44.0);
            let (r, resp) = ui.allocate_exact_size(vec2(row_w, row_h), Sense::click());
            resp.widget_info(|| WidgetInfo::selected(Role::Button, true, on, shading_title(s)));
            let rad = CornerRadius {
                nw: if idx == 0 { 9 } else { 0 },
                ne: if idx == 0 { 9 } else { 0 },
                sw: if idx + 1 == total { 9 } else { 0 },
                se: if idx + 1 == total { 9 } else { 0 },
            };
            let fill = if on {
                t.accent_bg()
            } else if resp.hovered() {
                t.ink(10)
            } else {
                Color32::TRANSPARENT
            };
            let p = ui.painter();
            if fill != Color32::TRANSPARENT {
                p.rect_filled(r.shrink(1.0), rad, fill);
            }
            paint_radio(p, pos2(r.left() + 17.0, r.center().y), &t, on);
            let text_left = r.left() + 32.0;
            let text_top = r.center().y - content_h * 0.5;
            let title_color = if on || resp.hovered() { t.text1 } else { t.text2 };
            let title_g = p.layout_no_wrap(shading_title(s).to_owned(), FontId::proportional(12.5), title_color);
            p.galley(pos2(text_left, text_top), title_g, title_color);
            p.galley(pos2(text_left, text_top + 16.0), detail_g, t.text3);
            if resp.on_hover_cursor(CursorIcon::PointingHand).clicked() && !on {
                chosen_shading = Some(s);
            }
        }
    });
    if let Some(s) = chosen_shading {
        pending = Some(RenderLook { shading: s, ..look.clone() });
    }

    if look.shading == Shading::Studio {
        ui.add_space(8.0);
        look_card(ui, &t, |ui| {
            let mut on = look.world_gi_occlusion;
            if switch_row(ui, &t, "Baked studio visibility", &mut on, true) {
                pending = Some(RenderLook { world_gi_occlusion: on, ..look.clone() });
            }
        });
    }
    if matches!(look.shading, Shading::PathTraced | Shading::RealTimePathTraced) {
        group_heading(ui, &t, "Path tracing", &format!("{} spp", look.path_samples));
        look_card(ui, &t, |ui| {
            let mut v = f64::from(look.path_samples);
            let ev = slider_row(
                ui,
                &t,
                ("look", "samples"),
                "Samples",
                &mut v,
                8.0..=1024.0,
                1.0,
                |x| format!("{}", x.round() as i64),
                parse_number,
                true,
            );
            if let SliderEvent::Committed(x) = ev {
                pending = Some(RenderLook { path_samples: x.round() as i32, ..look.clone() });
            }
        });
        footnote(ui, &t, "Samples a pixel: the viewport refines to this many while still; every video frame is drawn with them.");
    }

    // ---- Detail ----
    group_heading(ui, &t, "Detail", "");
    let mut next = look.clone();
    let mut detail_changed = false;
    look_card(ui, &t, |ui| {
        let rows: [(&str, Option<&str>, Field); 6] = [
            ("Edge lines", None, |l| &mut l.edges),
            ("Shadows", None, |l| &mut l.shadows),
            ("Ambient occlusion", None, |l| &mut l.ambient_occlusion),
            ("Floor", None, |l| &mut l.floor),
            ("Ray-traced glass", Some("Drawn when the view is still"), |l| &mut l.raytraced_glass),
            ("Lights follow the camera", None, |l| &mut l.lights_follow_camera),
        ];
        for (i, (label, note, field)) in rows.into_iter().enumerate() {
            if i > 0 {
                card_hairline(ui, &t, 12.0);
            }
            let toggled = match note {
                Some(n) => switch_note_row(ui, &t, label, n, field(&mut next), true),
                None => switch_row(ui, &t, label, field(&mut next), true),
            };
            if toggled {
                detail_changed = true;
            }
        }
    });
    if detail_changed {
        pending = Some(next);
    }

    // ---- Bricks ----
    if let Some(rounded) = super::rounding::section(ui, &t, &look) {
        pending = Some(rounded);
    }

    // Commit once at the end of the frame so the panel never collapses or drops sections mid-frame.
    if let Some(committed) = pending {
        commit(app, &committed);
        ui.ctx().request_repaint();
    }
}
