//! Live 3D axis navigator in the top-right corner (matching web `NavGizmo.tsx`):
//! rotates live with the viewport camera, clicks snap to any of the six ±X/±Y/±Z views,
//! and dragging anywhere on the orb orbits the camera smoothly.
use egui::{Align2, Area, Color32, CursorIcon, FontId, Id, Order, Pos2, Rect, Sense, Stroke, Ui, pos2, vec2};

use super::icon_button;
use crate::BrickMotionApp;
use crate::icons::Icon;
use crate::viewport::ViewOp;

const SIZE: f32 = 96.0;
const RADIUS: f32 = 31.0;
const DOT_POS: f32 = 9.0;
const DOT_NEG: f32 = 7.5;
const ORBIT_SENSITIVITY: f64 = 1.4;
/// How far below the top of the view the panels in the right column start, clear of the navigator.
pub const CLEARANCE: f32 = 122.0;

#[derive(Clone, Copy, Debug)]
pub struct AxisEnd {
    pub pos: Pos2,
    pub depth: f32,
    pub color: Color32,
    pub label: Option<&'static str>,
    pub neg_label: &'static str,
    pub name: &'static str,
    pub preset: bm::ViewPreset,
}

/// Projects all six world axis directions into navigator space using `OrbitCamera`'s basis
/// (LDraw space: `-y` is up, `-z` is front, `+x` is right), sorted back-to-front by depth.
pub fn project_axes(cam: &bm::Camera, center: Pos2, radius: f32) -> [AxisEnd; 6] {
    let (sa, ca) = cam.yaw.sin_cos();
    let (se, ce) = cam.pitch.sin_cos();
    // Matches `bmr::OrbitCamera::eye()` & `basis()` in `native/render/src/prep/camera.cpp`.
    let eye_dir = [-ce * sa, -se, -ce * ca]; // unit vector from target toward eye
    let right = [ca, 0.0, -sa]; // unit vector to the right on screen
    let up = [sa * se, -ce, ca * se]; // unit vector upward on screen

    let red = Color32::from_rgb(0xe5, 0x48, 0x4d);
    let green = Color32::from_rgb(0x46, 0xa7, 0x58);
    let blue = Color32::from_rgb(0x0e, 0x7f, 0xf1);

    struct AxisSpec {
        dir: [f64; 3],
        color: Color32,
        label: Option<&'static str>,
        neg_label: &'static str,
        name: &'static str,
        preset: bm::ViewPreset,
    }
    let specs = [
        AxisSpec { dir: [1.0, 0.0, 0.0], color: red, label: Some("X"), neg_label: "-X", name: "Right View", preset: bm::ViewPreset::Right },
        AxisSpec { dir: [-1.0, 0.0, 0.0], color: red, label: None, neg_label: "-X", name: "Left View", preset: bm::ViewPreset::Left },
        AxisSpec { dir: [0.0, -1.0, 0.0], color: green, label: Some("Y"), neg_label: "-Y", name: "Top View", preset: bm::ViewPreset::Top },
        AxisSpec { dir: [0.0, 1.0, 0.0], color: green, label: None, neg_label: "-Y", name: "Bottom View", preset: bm::ViewPreset::Bottom },
        AxisSpec { dir: [0.0, 0.0, -1.0], color: blue, label: Some("Z"), neg_label: "-Z", name: "Front View", preset: bm::ViewPreset::Front },
        AxisSpec { dir: [0.0, 0.0, 1.0], color: blue, label: None, neg_label: "-Z", name: "Back View", preset: bm::ViewPreset::Back },
    ];

    let dot = |a: [f64; 3], b: [f64; 3]| a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    let mut ends = specs.map(|s| {
        let sx = dot(s.dir, right) as f32;
        let sy = dot(s.dir, up) as f32;
        let depth = dot(s.dir, eye_dir) as f32;
        AxisEnd {
            pos: pos2(center.x + radius * sx, center.y - radius * sy),
            depth,
            color: s.color,
            label: s.label,
            neg_label: s.neg_label,
            name: s.name,
            preset: s.preset,
        }
    });
    ends.sort_by(|a, b| a.depth.total_cmp(&b.depth));
    ends
}

pub fn show(ui: &mut Ui, app: &mut BrickMotionApp, area: Rect) {
    let t = app.theme;
    let settings_open = app.properties_page.is_settings();
    let right_margin = if settings_open {
        super::properties::SETTINGS_WIDTH + 24.0
    } else {
        14.0
    };
    let origin = pos2(area.right() - right_margin - SIZE, area.top() + 10.0);
    let cam = app.doc.viewport().map(|vp| vp.camera()).unwrap_or(bm::Camera {
        yaw: 0.6,
        pitch: 0.45,
        distance: 400.0,
        target: bm::Vec3::ZERO,
        orthographic: false,
        vertical_fov: 0.6,
    });

    let mut orbit_delta = egui::Vec2::ZERO;
    let mut snap_preset: Option<bm::ViewPreset> = None;

    Area::new(Id::unique("navigator")).order(Order::Middle).fixed_pos(origin).show(ui.ctx(), |ui| {
        let (r, bg_resp) = ui.allocate_exact_size(vec2(SIZE, SIZE), Sense::click_and_drag());
        bg_resp.widget_info(|| egui::WidgetInfo::labeled(egui::Role::Button, true, "Axis Navigator"));
        let center = r.center();
        let ends = project_axes(&cam, center, RADIUS);

        let mut hovered_idx: Option<usize> = None;
        let mut any_dragged = bg_resp.dragged();
        if bg_resp.dragged() {
            orbit_delta += bg_resp.drag_delta();
        }

        // First allocate hit targets for the 6 axis bubbles (front-to-back order for hover priority)
        // so both clicks (accessible labels) and drag-to-orbit starting on any bubble work seamlessly.
        let mut bubble_resps: [Option<egui::Response>; 6] = Default::default();
        for i in (0..6).rev() {
            let e = ends[i];
            let rad = if e.label.is_some() { DOT_POS + 2.5 } else { DOT_NEG + 2.5 };
            let disc = Rect::from_center_size(e.pos, vec2(rad * 2.0, rad * 2.0));
            let resp = ui.interact(disc, ui.scope_id().with(("nav-axis", e.name)), Sense::click_and_drag());
            resp.widget_info(|| egui::WidgetInfo::labeled(egui::Role::Button, true, e.name));
            if resp.dragged() {
                orbit_delta += resp.drag_delta();
                any_dragged = true;
            } else if resp.clicked() {
                snap_preset = Some(e.preset);
            }
            if hovered_idx.is_none() && resp.hovered() {
                hovered_idx = Some(i);
            }
            bubble_resps[i] = Some(resp.on_hover_text(e.name));
        }

        let painter = ui.painter();
        let bg_hovered = bg_resp.hovered() || hovered_idx.is_some() || any_dragged;
        let bg_fill = if bg_hovered {
            Color32::from_white_alpha(20)
        } else {
            Color32::from_white_alpha(10)
        };
        let bg_stroke = if any_dragged { t.accent } else if bg_hovered { t.border2 } else { t.border };
        painter.circle(center, SIZE * 0.46, bg_fill, Stroke::new(1.0, bg_stroke));

        // Draw stems back-to-front so nearer axes overlap farther ones.
        for e in &ends {
            let alpha = if e.depth < 0.0 { 95 } else { 230 };
            let stem_c = Color32::from_rgba_unmultiplied(e.color.r(), e.color.g(), e.color.b(), alpha);
            painter.line_segment([center, e.pos], Stroke::new(1.75, stem_c));
        }

        // Subtle centre hub.
        painter.circle_filled(center, 2.4, Color32::from_black_alpha(130));

        // Draw bubbles back-to-front.
        for (i, e) in ends.iter().enumerate() {
            let hot = hovered_idx == Some(i) && !any_dragged;
            let fade = if e.depth < -0.2 && !hot { 0.72 } else { 1.0 };
            let col = e.color.gamma_multiply(fade);
            if let Some(lbl) = e.label {
                let rad = if hot { DOT_POS + 1.5 } else { DOT_POS };
                painter.circle_filled(e.pos, rad, col);
                if hot {
                    painter.circle_stroke(e.pos, rad, Stroke::new(1.25, Color32::WHITE));
                }
                painter.text(e.pos + vec2(0.0, 0.5), Align2::CENTER_CENTER, lbl, FontId::proportional(10.0), Color32::WHITE);
            } else {
                let rad = if hot { DOT_NEG + 1.5 } else { DOT_NEG };
                let fill = if hot {
                    col
                } else {
                    Color32::from_rgba_unmultiplied(0x1b, 0x1d, 0x21, 225)
                };
                painter.circle(e.pos, rad, fill, Stroke::new(1.75, col));
                if hot {
                    painter.text(e.pos + vec2(0.0, 0.5), Align2::CENTER_CENTER, e.neg_label, FontId::proportional(8.5), Color32::WHITE);
                }
            }
        }

        if any_dragged {
            ui.ctx().set_cursor_icon(CursorIcon::Grabbing);
        } else if hovered_idx.is_some() {
            ui.ctx().set_cursor_icon(CursorIcon::PointingHand);
        } else if bg_resp.hovered() {
            ui.ctx().set_cursor_icon(CursorIcon::Grab);
        }
    });

    if orbit_delta != egui::Vec2::ZERO {
        app.viewport.queue(ViewOp::Orbit(
            f64::from(orbit_delta.x) * ORBIT_SENSITIVITY,
            f64::from(orbit_delta.y) * ORBIT_SENSITIVITY,
        ));
    } else if let Some(preset) = snap_preset {
        app.viewport.queue(ViewOp::Preset(preset));
    }

    Area::new(Id::unique("navigator-home"))
        .order(Order::Middle)
        .fixed_pos(origin + vec2(-24.0, 2.0))
        .show(ui.ctx(), |ui| {
            let r = Rect::from_min_size(ui.cursor().min, vec2(24.0, 24.0));
            ui.painter().circle(r.center(), 12.0, t.bg2, Stroke::new(1.0, t.border2));
            if icon_button(ui, &t, Icon::Home, "Home View", true, false, 24.0).clicked() {
                app.requested.push("view.home");
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn front_camera_projects_y_up_x_right_z_front() {
        let cam = bm::Camera { yaw: 0.0, pitch: 0.0, distance: 400.0, target: bm::Vec3::ZERO, orthographic: false, vertical_fov: 0.6 };
        let c = pos2(48.0, 48.0);
        let ends = project_axes(&cam, c, 30.0);
        let find = |p: bm::ViewPreset| ends.iter().find(|e| e.preset == p).unwrap();
        assert!((find(bm::ViewPreset::Right).pos.x - (c.x + 30.0)).abs() < 1e-3);
        assert!((find(bm::ViewPreset::Top).pos.y - (c.y - 30.0)).abs() < 1e-3);
        assert!(find(bm::ViewPreset::Front).depth > 0.99);
        assert!(find(bm::ViewPreset::Back).depth < -0.99);
        // Sorted back-to-front: Back is first, Front is last.
        assert_eq!(ends[0].preset, bm::ViewPreset::Back);
        assert_eq!(ends[5].preset, bm::ViewPreset::Front);
    }

    #[test]
    fn yaw_rotation_turns_axes_live() {
        let cam = bm::Camera { yaw: -std::f64::consts::FRAC_PI_2, pitch: 0.0, distance: 400.0, target: bm::Vec3::ZERO, orthographic: false, vertical_fov: 0.6 };
        let ends = project_axes(&cam, pos2(48.0, 48.0), 30.0);
        // Looking from +X (Right View): Right is nearest (depth ~ 1), Left is farthest (depth ~ -1).
        assert_eq!(ends[5].preset, bm::ViewPreset::Right);
        assert_eq!(ends[0].preset, bm::ViewPreset::Left);
    }
}
