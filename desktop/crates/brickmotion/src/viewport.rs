//! The engine's picture in the central area, and the mapping from pointer gestures to view ops.
use egui::{Color32, ColorImage, Modifiers, Pos2, Rect, Sense, TextureHandle, TextureOptions, Ui, Vec2, pos2};

/// One thing to do to the view.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum ViewOp {
    Orbit(f64, f64),
    Pan(f64, f64),
    ZoomToward(f64, f64, f64),
    Fit,
    Preset(bm::ViewPreset),
    Pick(f64, f64, bm::SelectMode),
}

/// What a plain primary drag does; chosen in the view bar.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum DragMode {
    #[default]
    Orbit,
    Pan,
    Zoom,
}

/// The pointer input of one frame over the viewport. Positions are in points from its top left.
#[derive(Clone, Copy, Debug, Default)]
pub struct Gesture {
    pub primary_drag: Vec2,
    pub secondary_or_middle_drag: Vec2,
    pub scroll: Vec2,
    /// Trackpad pinch this frame: 0 for none, 0.1 for 10% closer.
    pub pinch: f32,
    pub click: Option<(Pos2, Modifiers)>,
    pub double_click: bool,
    /// The pointer, for zooming toward it.
    pub origin: Pos2,
    /// Held during the drag.
    pub modifiers: Modifiers,
    pub mode: DragMode,
}

/// Turns one frame of pointer input into view ops. Pure, so the mapping is tested on its own.
pub fn ops_for(g: &Gesture) -> Vec<ViewOp> {
    let mut ops = Vec::new();
    let (ox, oy) = (g.origin.x as f64, g.origin.y as f64);
    if g.primary_drag != Vec2::ZERO {
        let (dx, dy) = (g.primary_drag.x as f64, g.primary_drag.y as f64);
        ops.push(match (g.mode, g.modifiers.alt) {
            (_, true) | (DragMode::Pan, _) => ViewOp::Pan(dx, dy),
            (DragMode::Orbit, false) => ViewOp::Orbit(dx, dy),
            // Dragging up comes closer.
            (DragMode::Zoom, false) => ViewOp::ZoomToward(1.01f64.powf(-dy), ox, oy),
        });
    }
    if g.secondary_or_middle_drag != Vec2::ZERO {
        ops.push(ViewOp::Pan(g.secondary_or_middle_drag.x as f64, g.secondary_or_middle_drag.y as f64));
    }
    if g.scroll.y != 0.0 || g.pinch != 0.0 {
        let factor = 1.0015f64.powf(g.scroll.y as f64) * (1.0 + g.pinch as f64);
        ops.push(ViewOp::ZoomToward(factor, ox, oy));
    }
    if let Some((at, m)) = g.click {
        let mode = if m.shift {
            bm::SelectMode::Add
        } else if m.command || m.mac_cmd {
            bm::SelectMode::Toggle
        } else {
            bm::SelectMode::Replace
        };
        ops.push(ViewOp::Pick(at.x as f64, at.y as f64, mode));
    }
    if g.double_click {
        ops.push(ViewOp::Fit);
    }
    ops
}

/// The engine picture's size in pixels for a view rect, and the scale; None when either side is
/// under one pixel (a collapsed window or panel).
pub fn target_size(rect: Rect, pixels_per_point: f32) -> Option<(u32, u32, f64)> {
    let (w, h) = (rect.width() * pixels_per_point, rect.height() * pixels_per_point);
    if !(w >= 1.0 && h >= 1.0) {
        return None;
    }
    Some((w.round() as u32, h.round() as u32, pixels_per_point as f64))
}

/// Shows the document's viewport and drives it from the pointer.
#[derive(Default)]
pub struct ViewportWidget {
    pub mode: DragMode,
    /// Ops asked for by the chrome (Fit, presets), applied next frame.
    pub queued: Vec<ViewOp>,
    /// Background, sRGB 0..1.
    pub background: [f64; 3],
    texture: Option<TextureHandle>,
    frame: bm::Frame,
    last_size: Option<(u32, u32, f64)>,
    /// The document generation the viewport was set up for; a new document needs setting up again.
    generation: Option<u64>,
}

impl ViewportWidget {
    pub fn new(background: Color32) -> Self {
        let c = |v: u8| v as f64 / 255.0;
        ViewportWidget { background: [c(background.r()), c(background.g()), c(background.b())], ..Default::default() }
    }

    pub fn show(&mut self, ui: &mut Ui, doc: &mut bm::Document) {
        let rect = ui.max_rect();
        let resp = ui.interact(rect, ui.scope_id().with("viewport"), Sense::click_and_drag());
        let Some(size) = target_size(rect, ui.ctx().pixels_per_point()) else {
            return;
        };
        let generation = doc.session().generation();
        let fresh = self.generation != Some(generation);
        let Some(vp) = doc.viewport() else {
            ui.painter().text(rect.center(), egui::Align2::CENTER_CENTER, "This Mac has no Metal device, so the model cannot be shown.", egui::FontId::proportional(13.0), Color32::GRAY);
            return;
        };
        let mut changed = false;
        if fresh {
            vp.set_background(self.background);
            self.last_size = None;
        }
        if self.last_size != Some(size) {
            vp.resize(size.0, size.1, size.2);
            self.last_size = Some(size);
            changed = true;
        }
        if fresh {
            vp.fit_all();
            self.generation = Some(generation);
            changed = true;
        }

        // Read the response first: its methods lock the context, so they cannot run inside ui.input.
        let hovered = resp.hovered() || resp.dragged();
        let local = |p: Pos2| pos2(p.x - rect.left(), p.y - rect.top());
        let primary_drag = if resp.dragged_by(egui::PointerButton::Primary) { resp.drag_delta() } else { Vec2::ZERO };
        let other_drag = resp.dragged_by(egui::PointerButton::Secondary) || resp.dragged_by(egui::PointerButton::Middle);
        let secondary_or_middle_drag = if other_drag { resp.drag_delta() } else { Vec2::ZERO };
        let click_at = if resp.clicked() { resp.interact_pointer_pos().map(local) } else { None };
        let double_click = resp.double_clicked();
        let gesture = ui.input(|i| Gesture {
            primary_drag,
            secondary_or_middle_drag,
            scroll: if hovered { i.smooth_scroll_delta() } else { Vec2::ZERO },
            pinch: if hovered { i.zoom_delta() - 1.0 } else { 0.0 },
            click: click_at.map(|p| (p, i.modifiers)),
            double_click,
            origin: i.pointer.hover_pos().map(local).unwrap_or(rect.size().to_pos2() / 2.0),
            modifiers: i.modifiers,
            mode: self.mode,
        });
        let mut ops = std::mem::take(&mut self.queued);
        ops.extend(ops_for(&gesture));

        let mut picks = Vec::new();
        for op in ops {
            changed = true;
            match op {
                ViewOp::Orbit(dx, dy) => vp.orbit(dx, dy),
                ViewOp::Pan(dx, dy) => vp.pan(dx, dy),
                ViewOp::ZoomToward(f, x, y) => vp.zoom_toward(f, x, y),
                ViewOp::Fit => vp.fit_all(),
                ViewOp::Preset(p) => vp.view(p),
                ViewOp::Pick(x, y, mode) => picks.push((vp.pick(x, y), mode)),
            }
        }
        for (hit, mode) in picks {
            match hit {
                Some(p) => doc.session_mut().select(&[p], mode),
                // A plain click on empty space clears the selection.
                None if mode == bm::SelectMode::Replace => doc.session_mut().select(&[], mode),
                None => {}
            }
        }

        let Some(vp) = doc.viewport() else { return };
        if changed || vp.needs_draw() || self.texture.is_none() {
            if vp.draw() {
                ui.ctx().request_repaint();
            }
            vp.read_frame(&mut self.frame);
            if self.frame.width > 0 && self.frame.height > 0 {
                let image = ColorImage::from_rgba_unmultiplied([self.frame.width as usize, self.frame.height as usize], &self.frame.rgba);
                match &mut self.texture {
                    Some(t) => t.set(image, TextureOptions::LINEAR),
                    None => self.texture = Some(ui.ctx().load_texture("viewport", image, TextureOptions::LINEAR)),
                }
            }
        }
        if let Some(t) = &self.texture {
            let uv = Rect::from_min_max(Pos2::ZERO, pos2(1.0, 1.0));
            ui.painter().image(t.id(), rect, uv, Color32::WHITE);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use egui::{Modifiers, Pos2, Rect, vec2};

    fn g() -> Gesture {
        Gesture::default()
    }

    #[test]
    fn drag_orbits_and_option_drag_pans() {
        let d = Gesture { primary_drag: vec2(10.0, -4.0), ..g() };
        assert_eq!(ops_for(&d), vec![ViewOp::Orbit(10.0, -4.0)]);
        let d = Gesture { modifiers: Modifiers::ALT, ..d };
        assert_eq!(ops_for(&d), vec![ViewOp::Pan(10.0, -4.0)]);
        let d = Gesture { secondary_or_middle_drag: vec2(3.0, 2.0), ..g() };
        assert_eq!(ops_for(&d), vec![ViewOp::Pan(3.0, 2.0)]);
    }

    #[test]
    fn view_bar_mode_changes_primary_drag() {
        let d = Gesture { primary_drag: vec2(10.0, -4.0), mode: DragMode::Pan, ..g() };
        assert_eq!(ops_for(&d), vec![ViewOp::Pan(10.0, -4.0)]);
        let d = Gesture { primary_drag: vec2(0.0, -10.0), mode: DragMode::Zoom, origin: Pos2::new(5.0, 6.0), ..g() };
        assert_eq!(ops_for(&d), vec![ViewOp::ZoomToward(1.01f64.powf(10.0), 5.0, 6.0)]);
    }

    #[test]
    fn scroll_zooms_toward_pointer() {
        let s = Gesture { scroll: vec2(0.0, 100.0), origin: Pos2::new(50.0, 60.0), ..g() };
        assert_eq!(ops_for(&s), vec![ViewOp::ZoomToward(1.0015f64.powf(100.0), 50.0, 60.0)]);
        let p = Gesture { pinch: 0.25, origin: Pos2::new(50.0, 60.0), ..g() };
        assert_eq!(ops_for(&p), vec![ViewOp::ZoomToward(1.25, 50.0, 60.0)]);
    }

    #[test]
    fn click_picks_with_modifiers() {
        let at = Pos2::new(7.0, 8.0);
        let c = |m| Gesture { click: Some((at, m)), ..g() };
        assert_eq!(ops_for(&c(Modifiers::NONE)), vec![ViewOp::Pick(7.0, 8.0, bm::SelectMode::Replace)]);
        assert_eq!(ops_for(&c(Modifiers::SHIFT)), vec![ViewOp::Pick(7.0, 8.0, bm::SelectMode::Add)]);
        assert_eq!(ops_for(&c(Modifiers::MAC_CMD)), vec![ViewOp::Pick(7.0, 8.0, bm::SelectMode::Toggle)]);
    }

    #[test]
    fn double_click_fits() {
        assert_eq!(ops_for(&Gesture { double_click: true, ..g() }), vec![ViewOp::Fit]);
    }

    #[test]
    fn idle_gesture_does_nothing() {
        assert!(ops_for(&g()).is_empty());
    }

    #[test]
    fn zero_size_viewport_skips_draw() {
        assert_eq!(target_size(Rect::from_min_size(Pos2::ZERO, vec2(800.0, 0.0)), 2.0), None);
        assert_eq!(target_size(Rect::from_min_size(Pos2::ZERO, vec2(0.3, 300.0)), 2.0), None);
    }

    #[test]
    fn resize_tracks_pixels_per_point() {
        assert_eq!(target_size(Rect::from_min_size(Pos2::ZERO, vec2(400.0, 300.0)), 2.0), Some((800, 600, 2.0)));
        assert_eq!(target_size(Rect::from_min_size(Pos2::ZERO, vec2(400.0, 300.0)), 1.0), Some((400, 300, 1.0)));
    }
}
