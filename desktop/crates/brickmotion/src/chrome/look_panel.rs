//! The Look panel (m6-rulings.md; Swift `LookPanel`): the project's scene, shading, detail and
//! path-tracing samples. Saved with the project and used by every video. Every change is one
//! `set_render_look` call and one undo step; the samples slider commits on release.
use bm::export::{RenderLook, SceneCollection, ScenePreset, Shading, scenes};
use egui::{Align2, Color32, CornerRadius, FontId, Rect, Sense, Stroke, StrokeKind, Ui, WidgetInfo, pos2, vec2};

use super::float_panel::{self, Head, PanelKind, group_heading};
use super::widgets::{SliderEvent, footnote, hairline, inset_group, parse_number, slider_row, switch_row};
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
    /// The scene under the pointer this frame (its name and hint show under the swatches).
    hovered: Option<String>,
}

const SWATCH: f32 = 30.0;

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
    Color32::from_rgb(b(v.x), b(v.y), b(v.z))
}

/// One 30-px scene swatch; `None` is the editor's own backdrop.
fn swatch(ui: &mut Ui, t: &Theme, color: Option<Color32>, selected: bool, title: &str) -> egui::Response {
    let (r, resp) = ui.allocate_exact_size(vec2(SWATCH, SWATCH), Sense::click());
    resp.widget_info(|| WidgetInfo::selected(egui::Role::Button, true, selected, title));
    let p = ui.painter();
    let inner = r.shrink(2.0);
    match color {
        Some(c) => {
            p.rect_filled(inner, CornerRadius::same(6), c);
        }
        None => {
            // Half light, half dark: it follows the appearance.
            p.rect_filled(inner, CornerRadius::same(6), Color32::from_gray(232));
            let half = Rect::from_min_max(pos2(inner.center().x, inner.top()), inner.max);
            p.rect_filled(half, CornerRadius { nw: 0, sw: 0, ne: 6, se: 6 }, Color32::from_gray(38));
        }
    }
    p.rect_stroke(inner, CornerRadius::same(6), Stroke::new(0.5, Color32::from_white_alpha(30)), StrokeKind::Inside);
    if selected {
        p.rect_stroke(r, CornerRadius::same(8), Stroke::new(2.0, t.accent), StrokeKind::Inside);
    } else if resp.hovered() {
        p.rect_stroke(r, CornerRadius::same(8), Stroke::new(1.0, t.text3), StrokeKind::Inside);
    }
    resp.on_hover_cursor(egui::CursorIcon::PointingHand)
}

fn body(ui: &mut Ui, app: &mut BrickMotionApp) {
    let t = app.theme;
    let look = app.doc.session().render_look();
    footnote(ui, &t, "Saved with the project and used by every video.");

    // Scene: the editor's backdrop, then the web scenes by collection.
    let current = app.look.scenes.iter().find(|s| s.id == look.scene).cloned();
    group_heading(ui, &t, "Scene", current.as_ref().map_or("Editor", |s| s.label.as_str()));
    let mut chosen: Option<String> = None;
    let mut hovered: Option<String> = None;
    let editor_hint = "The editor's own backdrop, which follows Light and Dark appearance";
    egui::Frame::NONE.inner_margin(egui::Margin::symmetric(14, 0)).show(ui, |ui| {
        ui.spacing_mut().item_spacing = vec2(4.0, 4.0);
        let groups = [
            (None, "Editor"),
            (Some(SceneCollection::Photo), "Photo"),
            (Some(SceneCollection::Render), "Render"),
            (Some(SceneCollection::Classic), "Classic"),
        ];
        for (collection, name) in groups {
            ui.add_space(4.0);
            ui.label(egui::RichText::new(name).size(10.5).color(t.text3));
            ui.horizontal_wrapped(|ui| match collection {
                None => {
                    let r = swatch(ui, &t, None, look.scene.is_empty(), "Editor");
                    if r.hovered() {
                        hovered = Some(format!("Editor · {editor_hint}"));
                    }
                    if r.on_hover_text(format!("Editor: {editor_hint}")).clicked() {
                        chosen = Some(String::new());
                    }
                }
                Some(c) => {
                    for s in app.look.scenes.iter().filter(|s| s.collection == c) {
                        let r = swatch(ui, &t, Some(rgb(s.background)), s.id == look.scene, &s.label);
                        if r.hovered() {
                            hovered = Some(format!("{} · {}", s.label, s.hint));
                        }
                        if r.on_hover_text(format!("{}: {}", s.label, s.hint)).clicked() {
                            chosen = Some(s.id.clone());
                        }
                    }
                }
            });
        }
    });
    let line = hovered.clone().or_else(|| app.look.hovered.clone()).unwrap_or_else(|| match &current {
        Some(s) => format!("{} · {}", s.label, s.hint),
        None => format!("Editor · {editor_hint}"),
    });
    app.look.hovered = hovered;
    footnote(ui, &t, &line);
    if let Some(scene) = chosen.filter(|s| *s != look.scene) {
        commit(app, &RenderLook { scene, ..look.clone() });
        return;
    }

    // Shading: six rows, the chosen one tinted.
    group_heading(ui, &t, "Shading", shading_title(look.shading));
    let mut shading = None;
    egui::Frame::NONE.inner_margin(egui::Margin::symmetric(12, 0)).show(ui, |ui| {
        ui.spacing_mut().item_spacing.y = 2.0;
        for s in Shading::ALL {
            let on = s == look.shading;
            let (r, resp) = ui.allocate_exact_size(vec2(ui.available_width(), 40.0), Sense::click());
            resp.widget_info(|| WidgetInfo::selected(egui::Role::Button, true, on, shading_title(s)));
            let fill = if on { t.accent_bg() } else if resp.hovered() { Color32::from_white_alpha(10) } else { Color32::TRANSPARENT };
            ui.painter().rect_filled(r, CornerRadius::same(8), fill);
            let title_color = if on { t.text1 } else { t.text2 };
            ui.painter().text(pos2(r.left() + 10.0, r.top() + 13.0), Align2::LEFT_CENTER, shading_title(s), FontId::proportional(12.5), title_color);
            ui.painter().text(pos2(r.left() + 10.0, r.top() + 28.0), Align2::LEFT_CENTER, shading_detail(s), FontId::proportional(10.5), t.text3);
            if resp.on_hover_cursor(egui::CursorIcon::PointingHand).clicked() && !on {
                shading = Some(s);
            }
        }
    });
    if let Some(s) = shading {
        commit(app, &RenderLook { shading: s, ..look.clone() });
        return;
    }
    if look.shading == Shading::Studio {
        inset_group(ui, |ui| {
            let mut on = look.world_gi_occlusion;
            if switch_row(ui, &t, "Baked studio visibility", &mut on, true) {
                commit(app, &RenderLook { world_gi_occlusion: on, ..look.clone() });
            }
        });
    }
    if look.shading == Shading::PathTraced {
        group_heading(ui, &t, "Path tracing", "");
        inset_group(ui, |ui| {
            let mut v = f64::from(look.path_samples);
            let ev = slider_row(ui, &t, ("look", "samples"), "Samples", &mut v, 8.0..=1024.0, 1.0, |x| format!("{}", x.round() as i64), parse_number, true);
            if let SliderEvent::Committed(x) = ev {
                commit(app, &RenderLook { path_samples: x.round() as i32, ..look.clone() });
            }
        });
        footnote(ui, &t, "Samples a pixel: the viewport refines to this many while still; every video frame is drawn with them.");
    }

    // Detail: one inset group of switches.
    group_heading(ui, &t, "Detail", "");
    let mut next = look.clone();
    let mut changed = false;
    inset_group(ui, |ui| {
        let rows: [(&str, Field); 6] = [
            ("Edge lines", |l| &mut l.edges),
            ("Shadows", |l| &mut l.shadows),
            ("Ambient occlusion", |l| &mut l.ambient_occlusion),
            ("Floor", |l| &mut l.floor),
            ("Ray-traced glass", |l| &mut l.raytraced_glass),
            ("Lights follow the camera", |l| &mut l.lights_follow_camera),
        ];
        for (i, (label, field)) in rows.into_iter().enumerate() {
            if i > 0 {
                hairline(ui);
            }
            if switch_row(ui, &t, label, field(&mut next), true) {
                changed = true;
            }
            if label == "Ray-traced glass" {
                egui::Frame::NONE.inner_margin(egui::Margin { left: 12, right: 12, top: 0, bottom: 6 }).show(ui, |ui| {
                    ui.label(egui::RichText::new("Drawn when the view is still").size(10.5).color(t.text3));
                });
            }
        }
    });
    if changed {
        commit(app, &next);
    }
}
