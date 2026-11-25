//! Interactive move and rotate gizmos drawn over the 3D viewport.
use bm::gizmo::{GizmoShape, Handle};
use bm::{Mat3, PLATE, STUD, Vec2, Vec3};
use egui::{Color32, FontId, Painter, Pos2, Rect, Shape, Stroke, StrokeKind, pos2, vec2};

use crate::edit::EditState;
use crate::theme::Theme;

/// Standard CAD axis hues (the only hues added to the calm dark chrome).
const RED: Color32 = Color32::from_rgb(0xe5, 0x48, 0x4d);
const GREEN: Color32 = Color32::from_rgb(0x30, 0xa4, 0x6c);
const BLUE: Color32 = Color32::from_rgb(0x4f, 0x8c, 0xff);
const VIEW_GREY: Color32 = Color32::from_rgb(0xa4, 0xa9, 0xb1);

/// One active gizmo drag gesture. Pure state machine so increment tracking is unit-tested.
#[derive(Debug, Clone)]
pub struct GizmoDrag {
    pub handle: Handle,
    pub start: Vec2,
    pub origin: Vec3,
    pub axes: Mat3,
    pub pieces: Vec<u32>,
    moved: Vec3,
    turned: f64,
}

impl GizmoDrag {
    pub fn new(handle: Handle, start: Vec2, origin: Vec3, axes: Mat3, pieces: Vec<u32>) -> Self {
        Self {
            handle,
            start,
            origin,
            axes,
            pieces,
            moved: Vec3::ZERO,
            turned: 0.0,
        }
    }

    /// Returns the incremental world delta since the last applied total, or None if unchanged.
    pub fn step_move(&mut self, total: Vec3) -> Option<Vec3> {
        let delta = total - self.moved;
        if delta.x.abs() < 1e-9 && delta.y.abs() < 1e-9 && delta.z.abs() < 1e-9 {
            return None;
        }
        self.moved = total;
        Some(delta)
    }

    /// Returns the incremental rotation in degrees since the last applied angle, or None if unchanged.
    pub fn step_rotate(&mut self, degrees: f64) -> Option<f64> {
        let delta = degrees - self.turned;
        if delta.abs() < 1e-9 {
            return None;
        }
        self.turned = degrees;
        Some(delta)
    }

    pub fn moved(&self) -> Vec3 {
        self.moved
    }

    pub fn turned(&self) -> f64 {
        self.turned
    }
}

/// The basis axes for the gizmo: world identity, or the first selected piece's local axes.
pub fn axes(session: &bm::Session, edit: &EditState) -> Mat3 {
    if !edit.local_axes {
        return Mat3::IDENTITY;
    }
    session.selection().first().copied().map(|p| session.axes_of(p)).unwrap_or(Mat3::IDENTITY)
}

fn handle_color(h: Handle) -> Color32 {
    match h {
        Handle::X | Handle::YZ => RED,
        Handle::Y | Handle::XZ => GREEN,
        Handle::Z | Handle::XY => BLUE,
        Handle::View | Handle::None => VIEW_GREY,
    }
}

fn with_alpha(c: Color32, a: u8) -> Color32 {
    Color32::from_rgba_unmultiplied(c.r(), c.g(), c.b(), a)
}

fn to_screen(rect: Rect, p: Vec2) -> Pos2 {
    pos2(rect.left() + p.x as f32, rect.top() + p.y as f32)
}

/// Paints the gizmo over the viewport texture using egui's painter.
pub fn paint(painter: &Painter, rect: Rect, shape: &GizmoShape, active: Handle, hovered: Handle) {
    let is_move = !shape.lines.is_empty();
    let highlight = if active != Handle::None { active } else { hovered };

    // 1. Rings: Move plane squares (filled 15% + crisp outline) or Rotate rings (1.5-pt stroke).
    for (pts, h) in &shape.rings {
        if pts.len() < 3 {
            continue;
        }
        let hot = *h == highlight;
        let base = handle_color(*h);
        let screen_pts: Vec<Pos2> = pts.iter().map(|p| to_screen(rect, *p)).collect();
        if is_move {
            let fill_a = if hot { 76 } else { 38 }; // ~30% hot, 15% idle
            let stroke_a = if hot { 255 } else { 190 };
            let width = if hot { 2.0 } else { 1.25 };
            painter.add(Shape::convex_polygon(
                screen_pts,
                with_alpha(base, fill_a),
                Stroke::new(width, with_alpha(base, stroke_a)),
            ));
        } else {
            let alpha = if hot { 255 } else { 217 }; // 85% idle, 100% hot
            let width = if hot { 2.75 } else { 1.5 };
            painter.add(Shape::closed_line(screen_pts, Stroke::new(width, with_alpha(base, alpha))));
        }
    }

    // 2. Move axis lines with crisp arrowheads at tips and subtle origin cap.
    let mut origin_pt: Option<Pos2> = None;
    for &(a, b, h) in &shape.lines {
        let hot = h == highlight;
        let base = handle_color(h);
        let alpha = if hot { 255 } else { 217 };
        let color = with_alpha(base, alpha);
        let width = if hot { 3.0 } else { 2.0 };
        let pa = to_screen(rect, a);
        let pb = to_screen(rect, b);
        origin_pt.get_or_insert(pa);
        painter.line_segment([pa, pb], Stroke::new(width, color));

        // Subtle CAD cone arrowhead pointing along the axis.
        let dir = pb - pa;
        let len = dir.length();
        if len > 8.0 {
            let u = dir / len;
            let n = vec2(-u.y, u.x);
            let head_len = if hot { 11.0 } else { 9.5 };
            let head_w = if hot { 4.2 } else { 3.5 };
            let tip = pb + u * 2.0;
            let base_c = pb - u * (head_len - 2.0);
            painter.add(Shape::convex_polygon(
                vec![tip, base_c + n * head_w, base_c - n * head_w],
                color,
                Stroke::NONE,
            ));
        }
    }

    if let Some(o) = origin_pt {
        painter.circle_filled(o, 3.2, Color32::from_rgb(0xe8, 0xea, 0xed));
    }
}

/// Formats a move delta in studs (x/z) and plates (y), or LDU when free-snapped.
pub fn format_move(delta: Vec3) -> String {
    let mut parts = Vec::new();
    let fmt_axis = |v: f64, unit: f64, singular: &str, plural: &str, axis: &str| -> Option<String> {
        if v.abs() < 1e-3 {
            return None;
        }
        let n = v / unit;
        let sign = if v > 0.0 { "+" } else { "-" };
        let abs_n = n.abs();
        if (abs_n - abs_n.round()).abs() < 0.01 {
            let k = abs_n.round() as i64;
            let word = if k == 1 { singular } else { plural };
            Some(format!("{sign}{k} {word} {axis}"))
        } else {
            Some(format!("{sign}{:.1} {plural} {axis}", abs_n))
        }
    };
    if let Some(s) = fmt_axis(delta.x, STUD, "stud", "studs", "x") {
        parts.push(s);
    }
    // −y is up, so negate y when showing human vertical rise.
    if let Some(s) = fmt_axis(-delta.y, PLATE, "plate", "plates", "y") {
        parts.push(s);
    }
    if let Some(s) = fmt_axis(delta.z, STUD, "stud", "studs", "z") {
        parts.push(s);
    }
    if parts.is_empty() { "0".into() } else { parts.join(", ") }
}

pub fn format_rotate(degrees: f64) -> String {
    if (degrees - degrees.round()).abs() < 0.05 {
        format!("{}°", degrees.round() as i64)
    } else {
        format!("{degrees:.1}°")
    }
}

/// Paints a small floating readout pill near the pointer while dragging.
pub fn paint_readout(painter: &Painter, theme: &Theme, pointer: Pos2, label: &str) {
    let galley = painter.layout_no_wrap(label.to_owned(), FontId::monospace(11.5), theme.text1);
    let pad = vec2(8.0, 4.0);
    let pos = pointer + vec2(14.0, -24.0);
    let bg = Rect::from_min_size(pos, galley.size() + pad * 2.0);
    painter.rect(bg, 6.0, theme.float_fill(), Stroke::new(1.0, theme.border2), StrokeKind::Inside);
    painter.galley(bg.min + pad, galley, theme.text1);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn step_move_returns_increments() {
        let mut d = GizmoDrag::new(Handle::X, Vec2::default(), Vec3::ZERO, Mat3::IDENTITY, vec![0]);
        assert_eq!(d.step_move(Vec3::new(20.0, 0.0, 0.0)), Some(Vec3::new(20.0, 0.0, 0.0)));
        assert_eq!(d.step_move(Vec3::new(40.0, 0.0, 0.0)), Some(Vec3::new(20.0, 0.0, 0.0)));
        assert_eq!(d.step_move(Vec3::new(40.0, 0.0, 0.0)), None);
    }

    #[test]
    fn step_rotate_returns_increments() {
        let mut d = GizmoDrag::new(Handle::Y, Vec2::default(), Vec3::ZERO, Mat3::IDENTITY, vec![0]);
        assert_eq!(d.step_rotate(15.0), Some(15.0));
        assert_eq!(d.step_rotate(30.0), Some(15.0));
        assert_eq!(d.step_rotate(30.0), None);
    }

    #[test]
    fn readout_formatting() {
        assert_eq!(format_move(Vec3::new(40.0, 0.0, 0.0)), "+2 studs x");
        assert_eq!(format_move(Vec3::new(0.0, -8.0, 0.0)), "+1 plate y");
        assert_eq!(format_rotate(90.0), "90°");
    }
}
