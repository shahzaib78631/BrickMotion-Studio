//! The engine's picture in the central area, and the mapping from pointer gestures to view ops.
use bm::gizmo::{GizmoKind, GizmoShape, Handle};
use egui::{Color32, ColorImage, Modifiers, Pos2, Rect, Sense, TextureHandle, TextureOptions, Ui, Vec2, pos2};

use crate::edit::{EditState, Tool};
use crate::gizmo::{self, GizmoDrag};
use crate::theme::Theme;

/// One thing to do to the view.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum ViewOp {
    Orbit(f64, f64),
    Pan(f64, f64),
    ZoomToward(f64, f64, f64),
    Fit,
    /// Frame the selected pieces.
    FrameSelection,
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
    /// How many ops were ever queued through [`ViewportWidget::queue`] (tests read it).
    pub queued_total: usize,
    /// Background, sRGB 0..1.
    pub background: [f64; 3],
    texture: Option<TextureHandle>,
    frame: bm::Frame,
    last_size: Option<(u32, u32, f64)>,
    /// The view's size last frame, with or without a viewport to draw into.
    view_size: Option<(u32, u32, f64)>,
    /// The document generation the viewport was set up for; a new document needs setting up again.
    generation: Option<u64>,
    /// The last viewport rectangle in egui points.
    pub(crate) last_rect: Option<Rect>,
    /// The active move/rotate gizmo drawn over the viewport, when visible.
    pub(crate) gizmo: Option<GizmoShape>,
    hovered: Handle,
    drag: Option<GizmoDrag>,
    last_auto_plan: Option<bool>,
}

impl ViewportWidget {
    pub fn new(background: Color32) -> Self {
        let c = |v: u8| v as f64 / 255.0;
        ViewportWidget { background: [c(background.r()), c(background.g()), c(background.b())], ..Default::default() }
    }

    /// Asks for an op on the next frame.
    pub fn queue(&mut self, op: ViewOp) {
        self.queued.push(op);
        self.queued_total += 1;
    }

    /// Forget the view's setup: the next frame sets up whatever document it is given.
    pub fn reset(&mut self) {
        self.generation = None;
        self.last_size = None;
        self.gizmo = None;
        self.hovered = Handle::None;
        self.drag = None;
        self.last_auto_plan = None;
    }

    /// The size and background the next document should be drawn at, once known.
    pub fn warm(&self) -> Option<crate::loader::Warm> {
        self.view_size.map(|size| crate::loader::Warm { size, background: self.background })
    }

    #[allow(clippy::too_many_arguments)]
    pub fn show(
        &mut self,
        ui: &mut Ui,
        doc: &mut bm::Document,
        edit: &mut EditState,
        theme: &Theme,
        auto_plan: bool,
        playing: bool,
        planning: bool,
    ) {
        let rect = ui.max_rect();
        self.last_rect = Some(rect);
        let resp = ui.interact(rect, ui.scope_id().with("viewport"), Sense::click_and_drag());
        let Some(size) = target_size(rect, ui.ctx().pixels_per_point()) else {
            return;
        };
        self.view_size = Some(size);
        let generation = doc.session().generation();
        let fresh = self.generation != Some(generation);
        let empty = doc.session().piece_count() == 0;
        if doc.viewport().is_none() {
            self.gizmo = None;
            self.drag = None;
            let text = no_view_text(empty, bm::metal_available());
            let hint = egui::Label::new(egui::RichText::new(text).size(13.0).color(Color32::from_gray(0x8a)));
            ui.put(Rect::from_center_size(rect.center(), egui::vec2(rect.width(), 24.0)), hint);
            if empty {
                let k = egui::RichText::new("⌘O").size(11.0).color(Color32::from_gray(0x6c));
                ui.put(Rect::from_center_size(rect.center() + egui::vec2(0.0, 22.0), egui::vec2(60.0, 18.0)), egui::Label::new(k));
            }
            return;
        }
        let mut changed = false;
        {
            let vp = doc.viewport().unwrap();
            if fresh {
                vp.set_background(self.background);
                self.last_size = None;
                self.last_auto_plan = None;
            }
            if self.last_auto_plan != Some(auto_plan) {
                vp.set_preferences(bm::playback::ViewportPreferences { auto_plan, ..Default::default() });
                self.last_auto_plan = Some(auto_plan);
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
        }

        let local = |p: Pos2| pos2(p.x - rect.left(), p.y - rect.top());
        let to_bm = |p: Pos2| bm::Vec2::new((p.x - rect.left()) as f64, (p.y - rect.top()) as f64);
        let view_pt = bm::Vec2::new(rect.width() as f64, rect.height() as f64);

        let placing = edit.placement.is_some();
        let gizmo_kind = if placing {
            None
        } else {
            match edit.tool {
                Tool::Move => Some(GizmoKind::Move),
                Tool::Rotate => Some(GizmoKind::Rotate),
                Tool::Select => None,
            }
        };
        let sel = doc.session().selection();
        let show_gizmo = !playing && gizmo_kind.is_some() && !sel.is_empty();

        // Build the gizmo shape before input so a press on frame 1 hits immediately.
        if show_gizmo {
            let kind = gizmo_kind.unwrap();
            let (cam, origin, axes) = if let Some(d) = &self.drag {
                (doc.viewport().unwrap().camera(), d.origin, d.axes)
            } else {
                let ax = gizmo::axes(doc.session(), edit);
                let vp = doc.viewport().unwrap();
                (vp.camera(), vp.selection_center(), ax)
            };
            self.gizmo = Some(GizmoShape::new(&cam, view_pt, origin, axes, kind));
        } else {
            if self.drag.take().is_some() {
                doc.session().end_gesture();
            }
            self.gizmo = None;
            self.hovered = Handle::None;
        }

        // Read pointer state once outside borrow conflicts.
        let hovered = resp.hovered() || resp.dragged();
        let (primary_pressed, primary_down, latest_pos, hover_pos, modifiers) = ui.input(|i| {
            (
                i.pointer.primary_pressed(),
                i.pointer.primary_down(),
                i.pointer.latest_pos(),
                i.pointer.hover_pos(),
                i.modifiers,
            )
        });

        // Handle live placement pointer moves and primary click to place.
        let mut gizmo_consumed_primary = false;
        if let Some(placement) = edit.placement.as_mut() {
            gizmo_consumed_primary = true;
            if let Some(vp) = doc.viewport() {
                placement.set_colour(vp, edit.colour);
                placement.set_collision(vp, edit.collision);
                if let Some(pos) = hover_pos.filter(|p| rect.contains(*p)) {
                    placement.pointer(vp, to_bm(pos), modifiers.alt);
                }
            }
            if resp.clicked_by(egui::PointerButton::Primary) {
                placement.accept();
            }
        } else if let Some(kind) = gizmo_kind {
            if self.drag.is_some() {
                gizmo_consumed_primary = true;
                if primary_down {
                    if let Some(pos) = latest_pos {
                        let cam = doc.viewport().unwrap().camera();
                        let curr = to_bm(pos);
                        if let Some(d) = self.drag.as_mut() {
                            match kind {
                                GizmoKind::Move => {
                                    let snap = if modifiers.alt {
                                        bm::Vec3::ZERO
                                    } else {
                                        bm::Vec3::new(bm::STUD, bm::PLATE, bm::STUD)
                                    };
                                    let total = bm::gizmo::drag_move(
                                        &cam, view_pt, d.origin, d.axes, d.handle, d.start, curr, snap,
                                    );
                                    if let Some(delta) = d.step_move(total) {
                                        doc.session().translate(&d.pieces, delta, true);
                                        changed = true;
                                    }
                                }
                                GizmoKind::Rotate => {
                                    let deg = bm::gizmo::drag_rotate(
                                        &cam, view_pt, d.origin, d.axes, d.handle, d.start, curr, modifiers.shift,
                                    );
                                    if let Some(step) = d.step_rotate(deg) {
                                        let axis = bm::gizmo::handle_axis(&cam, d.axes, d.handle);
                                        doc.session().rotate(&d.pieces, axis, step, d.origin, true);
                                        changed = true;
                                    }
                                }
                            }
                        }
                    }
                } else {
                    self.drag = None;
                    doc.session().end_gesture();
                }
            } else if primary_pressed
                && let Some(pos) = latest_pos.filter(|p| rect.contains(*p))
                && (resp.hovered() || resp.is_pointer_button_down_on())
                && let Some(shape) = &self.gizmo
            {
                let pt = to_bm(pos);
                let hit = shape.hit(pt, 8.0);
                if hit != Handle::None {
                    let axes = gizmo::axes(doc.session(), edit);
                    let origin = doc.viewport().unwrap().selection_center();
                    doc.session().end_gesture();
                    self.drag = Some(GizmoDrag::new(hit, pt, origin, axes, sel.clone()));
                    gizmo_consumed_primary = true;
                }
            }
        }

        // Read the response first: its methods lock the context, so they cannot run inside ui.input.
        let primary_drag = if !gizmo_consumed_primary && resp.dragged_by(egui::PointerButton::Primary) {
            resp.drag_delta()
        } else {
            Vec2::ZERO
        };
        let other_drag = resp.dragged_by(egui::PointerButton::Secondary) || resp.dragged_by(egui::PointerButton::Middle);
        let secondary_or_middle_drag = if other_drag { resp.drag_delta() } else { Vec2::ZERO };
        let click_at = if !gizmo_consumed_primary && resp.clicked() {
            resp.interact_pointer_pos().map(local)
        } else {
            None
        };
        let double_click = !gizmo_consumed_primary && resp.double_clicked();
        let gesture = ui.input(|i| Gesture {
            primary_drag,
            secondary_or_middle_drag,
            scroll: if hovered { i.smooth_scroll_delta() } else { Vec2::ZERO },
            pinch: if hovered { i.zoom_delta() - 1.0 } else { 0.0 },
            click: click_at.map(|p| (p, i.modifiers)),
            double_click,
            origin: hover_pos.map(local).unwrap_or(rect.size().to_pos2() / 2.0),
            modifiers,
            mode: self.mode,
        });
        let mut ops = std::mem::take(&mut self.queued);
        ops.extend(ops_for(&gesture));

        let mut picks = Vec::new();
        {
            let vp = doc.viewport().unwrap();
            for op in ops {
                changed = true;
                match op {
                    ViewOp::Orbit(dx, dy) => vp.orbit(dx, dy),
                    ViewOp::Pan(dx, dy) => vp.pan(dx, dy),
                    ViewOp::ZoomToward(f, x, y) => vp.zoom_toward(f, x, y),
                    ViewOp::Fit => vp.fit_all(),
                    ViewOp::FrameSelection => vp.frame_selection(),
                    ViewOp::Preset(p) => vp.view(p),
                    ViewOp::Pick(x, y, mode) => picks.push((vp.pick(x, y), mode)),
                }
            }
        }
        for (hit, mode) in picks {
            match hit {
                Some(p) => doc.session().select(&[p], mode),
                // A plain click on empty space clears the selection.
                None if mode == bm::SelectMode::Replace => doc.session().select(&[], mode),
                None => {}
            }
        }

        let Some(vp) = doc.viewport() else { return };
        if changed || playing || planning || vp.needs_draw() || self.texture.is_none() {
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

        // Refresh and paint the gizmo after any camera/selection change this frame.
        let sel_now = doc.session().selection();
        if let Some(kind) = gizmo_kind.filter(|_| !playing && !sel_now.is_empty()) {
            let axes = match &self.drag {
                Some(d) => d.axes,
                None => gizmo::axes(doc.session(), edit),
            };
            let origin = match &self.drag {
                Some(d) => d.origin,
                None => doc.viewport().unwrap().selection_center(),
            };
            let cam = doc.viewport().unwrap().camera();
            let shape = GizmoShape::new(&cam, view_pt, origin, axes, kind);
            self.hovered = hover_pos
                .filter(|p| rect.contains(*p))
                .map(|p| shape.hit(to_bm(p), 8.0))
                .unwrap_or(Handle::None);
            let active = self.drag.as_ref().map(|d| d.handle).unwrap_or(Handle::None);
            gizmo::paint(ui.painter(), rect, &shape, active, self.hovered);
            if let (Some(d), Some(ptr)) = (&self.drag, latest_pos) {
                let label = match kind {
                    GizmoKind::Move => gizmo::format_move(d.moved()),
                    GizmoKind::Rotate => gizmo::format_rotate(d.turned()),
                };
                gizmo::paint_readout(ui.painter(), theme, ptr, &label);
            }
            self.gizmo = Some(shape);
        } else {
            self.gizmo = None;
            self.hovered = Handle::None;
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

/// What the viewport says when the document has no viewport.
/// The engine makes none for an empty document; with pieces, either there is no GPU or it failed.
fn no_view_text(empty: bool, metal: bool) -> &'static str {
    if empty {
        "Open a model to begin"
    } else if !metal {
        "This Mac has no Metal device, so the model cannot be shown."
    } else {
        "The 3D view could not start, so the model cannot be shown."
    }
}

#[cfg(test)]
mod no_view_tests {
    use super::no_view_text;

    #[test]
    fn says_no_metal_only_when_metal_is_missing() {
        assert_eq!(no_view_text(true, true), "Open a model to begin");
        assert!(no_view_text(false, false).contains("no Metal"));
        let t = no_view_text(false, true);
        assert!(!t.contains("Metal") && t.contains("could not start"), "{t}");
    }
}
