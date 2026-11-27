//! The engine's picture in the central area, and the mapping from pointer gestures to view ops.
use bm::gizmo::{GizmoKind, GizmoShape, Handle};
use egui::{Color32, ColorImage, Modifiers, Pos2, Rect, Sense, TextureHandle, TextureOptions, Ui, Vec2, pos2};

use crate::edit::{EditState, PickScope, Tool};
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
    /// `(x, y, mode, alt_override)` — holding ⌥ flips whole-submodel vs single-piece picking.
    Pick(f64, f64, bm::SelectMode, bool),
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
    /// Right-drag orbits (⇧ or ⌥ pans), as in the Swift app.
    pub secondary_drag: Vec2,
    /// Middle-drag pans.
    pub middle_drag: Vec2,
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
    if g.secondary_drag != Vec2::ZERO {
        let (dx, dy) = (g.secondary_drag.x as f64, g.secondary_drag.y as f64);
        ops.push(if g.modifiers.shift || g.modifiers.alt { ViewOp::Pan(dx, dy) } else { ViewOp::Orbit(dx, dy) });
    }
    if g.middle_drag != Vec2::ZERO {
        ops.push(ViewOp::Pan(g.middle_drag.x as f64, g.middle_drag.y as f64));
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
        ops.push(ViewOp::Pick(at.x as f64, at.y as f64, mode, m.alt));
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
/// What an Auto Key drag needs from the chrome.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct AutoKey {
    pub frame: i32,
    /// The chosen submodel, when the chosen object is one.
    pub key_submodel: Option<u32>,
}

#[derive(Clone, Copy, Debug)]
struct AutoDrag {
    piece: u32,
    submodel: bool,
    origin: bm::Vec3,
    frame: i32,
}

pub(crate) fn beep() {
    #[cfg(target_os = "macos")]
    {
        #[link(name = "AppKit", kind = "framework")]
        unsafe extern "C" {
            fn NSBeep();
        }
        // SAFETY: NSBeep takes no arguments and only plays the alert sound.
        unsafe { NSBeep() };
    }
}

/// What a right-click in the viewport landed on.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ContextTarget {
    Piece(u32),
    Empty,
}

#[derive(Default)]
pub struct ViewportWidget {
    pub mode: DragMode,
    /// Explicitly chosen camera drag mode in the viewbar (`Orbit` / `Pan` / `Zoom`), or `None`
    /// when unselected (default: drag pieces to move, drag empty space to orbit).
    pub nav_mode: Option<DragMode>,
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
    /// Set for one frame when an overlay owns the primary button (no pick, orbit or gizmo).
    pub block_primary: bool,
    /// True while Smart Joints' 3D rotation ring is open and owns the Rotate gizmo.
    pub suppress_rotate_gizmo: bool,
    /// True while an external drag (e.g. joint angle/slide slider) wants auto-planning paused.
    pub suppress_auto_plan: bool,
    /// The active move/rotate gizmo drawn over the viewport, when visible.
    pub(crate) gizmo: Option<GizmoShape>,
    hovered: Handle,
    drag: Option<GizmoDrag>,
    /// A pointer press on a piece waiting to cross the drag threshold before starting live snap-move.
    pending_piece_drag: Option<(Pos2, u32, Vec<u32>)>,
    /// A Select-tool press on empty space, waiting to cross the drag threshold to become a marquee.
    pending_marquee: Option<Pos2>,
    /// The Scale drag's stalk on screen when it began: centre and the grabbed tip.
    scale_stalk: Option<(bm::Vec2, bm::Vec2)>,
    /// The Scale chip's text while dragging.
    scale_label: Option<String>,
    /// The marquee being dragged: where it started and where the pointer is.
    marquee: Option<(Pos2, Pos2)>,
    /// A pointer press on a waiting piece in Animate mode waiting to cross the drag threshold.
    pending_waiting_drag: Option<(Pos2, u32)>,
    /// Piece double-clicked in the viewport this frame (consumed by chrome to open flight path / submodel).
    pub double_clicked_piece: Option<u32>,
    /// Set by the chrome each frame: on the Keyframes clock with Auto Key on, a gizmo drag keys
    /// the chosen object at this frame instead of moving pieces.
    pub auto_key: Option<AutoKey>,
    /// The Auto Key drag in progress: what it keys and from which values.
    auto_drag: Option<AutoDrag>,
    /// The last total change an Auto Key drag keyed (tests read it).
    pub(crate) last_auto_change: Option<bm::Vec3>,
    waiting_drag: Option<u32>,
    /// What the last right-click hit, for the chrome's context menu.
    pub context_target: Option<ContextTarget>,
    /// This frame's viewport response, for the chrome's context menu.
    pub(crate) response: Option<egui::Response>,
    last_auto_plan: Option<bool>,
    /// The background changed since the engine last drew with it.
    background_dirty: bool,
    last_plan_poll: Option<std::time::Instant>,
}

impl ViewportWidget {
    /// The Scale chip's text while a scale drag is under way.
    pub fn scale_readout(&self) -> Option<String> {
        self.scale_label.clone()
    }

    /// The last frame the viewport drew (empty before the first).
    pub fn last_frame(&self) -> &bm::Frame {
        &self.frame
    }

    /// Changes what the viewport draws behind the model, from the next frame on.
    pub fn set_background(&mut self, background: Color32) {
        let c = |v: u8| f64::from(v) / 255.0;
        self.background = [c(background.r()), c(background.g()), c(background.b())];
        self.background_dirty = true;
    }

    pub fn new(background: Color32) -> Self {
        let c = |v: u8| v as f64 / 255.0;
        ViewportWidget { background: [c(background.r()), c(background.g()), c(background.b())], ..Default::default() }
    }

    /// Asks for an op on the next frame.
    pub fn queue(&mut self, op: ViewOp) {
        self.queued.push(op);
        self.queued_total += 1;
    }

    pub fn last_rect(&self) -> Option<Rect> {
        self.last_rect
    }

    /// Forget the view's setup: the next frame sets up whatever document it is given.
    pub fn reset(&mut self) {
        self.generation = None;
        self.last_size = None;
        self.gizmo = None;
        self.hovered = Handle::None;
        self.drag = None;
        self.pending_piece_drag = None;
        self.pending_waiting_drag = None;
        self.double_clicked_piece = None;
        self.auto_drag = None;
        self.waiting_drag = None;
        self.context_target = None;
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
            let hint = egui::Label::new(egui::RichText::new(text).size(13.0).color(theme.text2));
            ui.put(Rect::from_center_size(rect.center(), egui::vec2(rect.width(), 24.0)), hint);
            if empty {
                let k = egui::RichText::new("⌘O").size(11.0).color(theme.text3);
                ui.put(Rect::from_center_size(rect.center() + egui::vec2(0.0, 22.0), egui::vec2(60.0, 18.0)), egui::Label::new(k));
            }
            return;
        }
        let mut changed = false;
        let is_dragging = self.drag.is_some()
            || self.waiting_drag.is_some()
            || self.pending_piece_drag.is_some()
            || edit.placement.as_ref().is_some_and(|p| p.is_moving())
            || self.block_primary
            || self.suppress_auto_plan;
        let effective_auto_plan = auto_plan && !is_dragging;
        {
            let vp = doc.viewport().unwrap();
            if fresh || self.background_dirty {
                vp.set_background(self.background);
                self.background_dirty = false;
                self.last_size = None;
                self.last_auto_plan = None;
            }
            if self.last_auto_plan != Some(effective_auto_plan) {
                vp.set_preferences(bm::playback::ViewportPreferences {
                    auto_plan: effective_auto_plan,
                    ..Default::default()
                });
                self.last_auto_plan = Some(effective_auto_plan);
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
                // When Smart Joints has an active joint ring open, it replaces the generic Rotate gizmo.
                Tool::Rotate if !self.suppress_rotate_gizmo => Some(GizmoKind::Rotate),
                Tool::Rotate => None,
                Tool::Scale => Some(GizmoKind::Scale),
                Tool::Select => None,
            }
        };
        let sel = doc.session().selection();
        let show_gizmo = !playing && gizmo_kind.is_some() && !sel.is_empty();

        // Build the gizmo shape before input so a press on frame 1 hits immediately.
        if show_gizmo {
            let kind = gizmo_kind.unwrap();
            let (cam, origin, axes) = if let Some(d) = &self.drag {
                let o = if kind == GizmoKind::Move { d.origin + d.moved() } else { d.origin };
                (doc.viewport().unwrap().camera(), o, d.axes)
            } else {
                let ax = gizmo::axes(doc.session(), edit);
                let vp = doc.viewport().unwrap();
                (vp.camera(), vp.selection_center(), ax)
            };
            self.gizmo = Some(GizmoShape::new(&cam, view_pt, origin, axes, kind));
        } else {
            if self.drag.take().is_some() {
                self.auto_drag = None;
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

        // Handle live placement (new library part or mouse-dragged existing piece).
        // The flight path / joint overlay took the press when `block_primary` was set.
        let mut gizmo_consumed_primary = std::mem::take(&mut self.block_primary);
        let mut cancel_move_placement = false;
        if let Some(placement) = edit.placement.as_mut() {
            gizmo_consumed_primary = true;
            if let Some(vp) = doc.viewport() {
                if !placement.is_moving() {
                    placement.set_colour(vp, edit.colour);
                }
                placement.set_collision(vp, edit.collision);
                if placement.is_moving() {
                    if primary_down {
                        if let Some(pos) = latest_pos.filter(|p| rect.contains(*p)) {
                            placement.pointer(vp, to_bm(pos), modifiers.alt);
                        }
                    } else if !placement.awaiting() {
                        if let Some(pos) = latest_pos.filter(|p| rect.contains(*p)) {
                            placement.pointer(vp, to_bm(pos), modifiers.alt);
                            placement.accept();
                        } else {
                            cancel_move_placement = true;
                        }
                    }
                } else {
                    if let Some(pos) = hover_pos.filter(|p| rect.contains(*p)) {
                        placement.pointer(vp, to_bm(pos), modifiers.alt);
                    }
                    if resp.clicked_by(egui::PointerButton::Primary) {
                        placement.accept();
                    }
                }
            }
        }
        if cancel_move_placement {
            edit.placement = None;
            if let Some(vp) = doc.viewport() {
                vp.clear_placement_preview();
            }
        } else if edit.placement.is_none()
            && let Some(kind) = gizmo_kind
        {
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
                                        if let Some(a) = self.auto_drag {
                                            let keys = bm::keys::auto_key_values(bm::keys::GizmoTool::Move, a.origin, total, a.frame);
                                            doc.session().set_keys(a.piece, &keys, true, a.submodel);
                                            self.last_auto_change = Some(total);
                                        } else {
                                            doc.session().translate(&d.pieces, delta, true);
                                        }
                                        changed = true;
                                    }
                                }
                                GizmoKind::Rotate => {
                                    let deg = bm::gizmo::drag_rotate(
                                        &cam, view_pt, d.origin, d.axes, d.handle, d.start, curr, modifiers.shift,
                                    );
                                    if let Some(step) = d.step_rotate(deg) {
                                        let axis = bm::gizmo::handle_axis(&cam, d.axes, d.handle);
                                        if let Some(a) = self.auto_drag {
                                            let total = bm::Vec3::new(axis.x * deg, axis.y * deg, axis.z * deg);
                                            let keys = bm::keys::auto_key_values(bm::keys::GizmoTool::Rotate, a.origin, total, a.frame);
                                            doc.session().set_keys(a.piece, &keys, true, a.submodel);
                                            self.last_auto_change = Some(total);
                                        } else {
                                            doc.session().rotate(&d.pieces, axis, step, d.origin, true);
                                        }
                                        changed = true;
                                    }
                                }
                                GizmoKind::Scale => {
                                    let (o, tip) = self.scale_stalk.unwrap_or_default();
                                    let f = gizmo::scale_factor(o, tip, d.handle, d.start, curr, modifiers.shift);
                                    if let Some(ratio) = d.step_scale(f) {
                                        let k = |h| if d.handle == Handle::View || d.handle == h { ratio } else { 1.0 };
                                        let factor = bm::Vec3::new(k(Handle::X), k(Handle::Y), k(Handle::Z));
                                        doc.session().scale(&d.pieces, factor, d.axes, d.origin, true);
                                        changed = true;
                                    }
                                    self.scale_label = Some(gizmo::format_scale(d.handle, d.scaled()));
                                }
                            }
                        }
                    }
                } else {
                    self.drag = None;
                    self.auto_drag = None;
                    self.scale_label = None;
                    doc.session().end_gesture();
                }
            } else if primary_pressed && !gizmo_consumed_primary
                && let Some(pos) = latest_pos.filter(|p| rect.contains(*p))
                && (resp.hovered() || resp.is_pointer_button_down_on())
                && let Some(shape) = &self.gizmo
            {
                let pt = to_bm(pos);
                let hit = if kind == GizmoKind::Scale { gizmo::scale_hit(shape, pt) } else { shape.hit(pt, 8.0) };
                if hit != Handle::None {
                    gizmo_consumed_primary = true;
                    if kind == GizmoKind::Scale {
                        let o = shape.lines.first().map(|l| l.0).unwrap_or_default();
                        let tip = shape.lines.iter().find(|l| l.2 == hit).map_or(o, |l| l.1);
                        self.scale_stalk = Some((o, tip));
                    }
                    // Auto Key: key the chosen object instead; a selection it cannot key does nothing.
                    // Scaling is not keyed: with Auto Key on it does nothing.
                    let auto = match self.auto_key {
                        Some(_) if kind == GizmoKind::Scale => None,
                        Some(ak) => bm::keys::auto_key_target(doc.session(), &sel, true, ak.key_submodel)
                            .map(|(piece, submodel)| Some((piece, submodel, ak.frame))),
                        None => Some(None),
                    };
                    if let Some(auto) = auto {
                        let axes = gizmo::axes(doc.session(), edit);
                        let origin = doc.viewport().unwrap().selection_center();
                        doc.session().end_gesture();
                        // Suppress auto-plan immediately before the first drag step mutates the session.
                        if self.last_auto_plan != Some(false) {
                            doc.viewport().unwrap().set_preferences(bm::playback::ViewportPreferences {
                                auto_plan: false,
                                ..Default::default()
                            });
                            self.last_auto_plan = Some(false);
                        }
                        self.auto_drag = auto.map(|(piece, submodel, frame)| {
                            use bm::keys::KeyChannel as C;
                            let chans = if kind == GizmoKind::Move { [C::PositionX, C::PositionY, C::PositionZ] } else { [C::RotationX, C::RotationY, C::RotationZ] };
                            let v = |c| doc.session().key_value(piece, c, f64::from(frame), submodel);
                            AutoDrag { piece, submodel, origin: bm::Vec3::new(v(chans[0]), v(chans[1]), v(chans[2])), frame }
                        });
                        self.drag = Some(GizmoDrag::new(hit, pt, origin, axes, sel.clone()));
                    } else {
                        beep();
                    }
                }
            }
        }

        if playing || placing {
            if self.waiting_drag.take().is_some()
                && let Some(vp) = doc.viewport()
            {
                let _ = vp.end_waiting_drag();
            }
            self.pending_waiting_drag = None;
            self.context_target = None;
        }

        // Handle waiting-part floor drag when paused mid-build (and not dragging a gizmo).
        // Only begin dragging after crossing 3.5 px so plain clicks still select waiting pieces!
        if !gizmo_consumed_primary && !placing && !playing && self.nav_mode.is_none() {
            if let Some(piece) = self.waiting_drag {
                gizmo_consumed_primary = true;
                if primary_down {
                    if let Some(pos) = latest_pos
                        && let Some(vp) = doc.viewport()
                    {
                        let pt = to_bm(pos);
                        vp.drag_waiting_part(pt.x, pt.y);
                        changed = true;
                    }
                } else {
                    self.waiting_drag = None;
                    let delta = doc.viewport().map_or(bm::Vec3::ZERO, |vp| vp.end_waiting_drag());
                    if delta.x.abs() > 1e-6 || delta.y.abs() > 1e-6 || delta.z.abs() > 1e-6 {
                        doc.session().shift_waiting_part(piece, delta);
                        changed = true;
                    }
                }
            } else if let Some((start_pos, piece)) = self.pending_waiting_drag {
                if primary_down {
                    gizmo_consumed_primary = true;
                    if let Some(curr) = latest_pos
                        && curr.distance(start_pos) > 3.5
                        && let Some(vp) = doc.viewport()
                    {
                        self.pending_waiting_drag = None;
                        let st = to_bm(start_pos);
                        let cur = to_bm(curr);
                        if vp.begin_waiting_drag(piece, st.x, st.y) {
                            vp.drag_waiting_part(cur.x, cur.y);
                            self.waiting_drag = Some(piece);
                            if doc.session().selection() != [piece] {
                                doc.session().select(&[piece], bm::SelectMode::Replace);
                            }
                            changed = true;
                        }
                    }
                } else {
                    // Released without dragging: let normal click selection pick this piece.
                    self.pending_waiting_drag = None;
                }
            } else if primary_pressed
                && let Some(pos) = latest_pos.filter(|p| rect.contains(*p))
                && (resp.hovered() || resp.is_pointer_button_down_on())
                && let Some(vp) = doc.viewport()
            {
                let pt = to_bm(pos);
                if let Some(piece) = vp.pick(pt.x, pt.y)
                    && vp.can_move_waiting_part(piece)
                {
                    self.pending_waiting_drag = Some((pos, piece));
                }
            }
        }

        // Direct mouse piece dragging (web & Swift parity):
        // - Move tool: drag any clicked piece to slide & snap onto studs/connectors under the pointer.
        // - Select tool: drag an already-selected piece to slide & snap it.
        // Suppressed when an explicit camera drag mode (Orbit/Pan/Zoom) is active in the viewbar.
        if playing || edit.placement.is_some() || self.waiting_drag.is_some() || self.drag.is_some() || self.nav_mode.is_some() || self.auto_key.is_some() {
            self.pending_piece_drag = None;
        } else if !gizmo_consumed_primary && matches!(edit.tool, Tool::Select | Tool::Move) {
            if let Some((start_pos, anchor, pieces)) = self.pending_piece_drag.clone() {
                if primary_down {
                    // Hold camera orbit off while deciding whether this press on a piece becomes a drag.
                    gizmo_consumed_primary = true;
                    if let Some(curr) = latest_pos
                        && curr.distance(start_pos) > 3.5
                    {
                        self.pending_piece_drag = None;
                        if doc.session().selection() != pieces {
                            doc.session().select(&pieces, bm::SelectMode::Replace);
                        }
                        let (session, vp) = doc.parts();
                        if let Some(vp) = vp
                            && let Some(p) = crate::placement::Placement::begin_move(
                                anchor,
                                pieces,
                                to_bm(start_pos),
                                to_bm(curr),
                                modifiers.alt,
                                edit.collision,
                                session,
                                vp,
                            )
                        {
                            edit.placement = Some(p);
                            changed = true;
                        }
                    }
                } else {
                    // Released before drag threshold: let normal click selection handle it.
                    self.pending_piece_drag = None;
                }
            } else if primary_pressed
                && !modifiers.shift
                && !modifiers.alt
                && !modifiers.command
                && !modifiers.mac_cmd
                && let Some(pos) = latest_pos.filter(|p| rect.contains(*p))
                && (resp.hovered() || resp.is_pointer_button_down_on())
                && let Some(vp) = doc.viewport()
            {
                let pt = to_bm(pos);
                if let Some(piece) = vp.pick(pt.x, pt.y) {
                    let allow = match edit.tool {
                        Tool::Move => true,
                        Tool::Select => sel.contains(&piece),
                        Tool::Rotate | Tool::Scale => false,
                    };
                    if allow {
                        let pieces = if sel.contains(&piece) {
                            sel.clone()
                        } else {
                            pick_targets(doc.session(), piece, edit.pick_scope, modifiers.alt)
                        };
                        self.pending_piece_drag = Some((pos, piece, pieces));
                    }
                }
            }
        }

        // Marquee: with the Select tool, a drag that starts on empty space draws a box and selects
        // the pieces wholly inside it (⇧ adds). A press that never moves stays a click.
        let marquee_allowed = !playing
            && !placing
            && self.waiting_drag.is_none()
            && self.drag.is_none()
            && self.nav_mode.is_none()
            && self.auto_key.is_none()
            && edit.tool == Tool::Select
            && !gizmo_consumed_primary;
        if !marquee_allowed {
            self.pending_marquee = None;
            self.marquee = None;
        } else if let Some(start) = self.pending_marquee {
            if primary_down {
                gizmo_consumed_primary = true;
                if let Some(curr) = latest_pos
                    && (self.marquee.is_some() || curr.distance(start) > 3.5)
                {
                    self.marquee = Some((start, curr));
                    changed = true;
                }
            } else {
                self.pending_marquee = None;
                if let Some((a, _)) = self.marquee.take() {
                    gizmo_consumed_primary = true;
                    let b = latest_pos.unwrap_or(a);
                    let found = doc.viewport().map(|vp| vp.marquee(to_bm(a), to_bm(b), false)).unwrap_or_default();
                    let mut pieces: Vec<u32> = Vec::new();
                    let mut seen = std::collections::HashSet::new();
                    for p in found {
                        for q in pick_targets(doc.session(), p, edit.pick_scope, false) {
                            if seen.insert(q) {
                                pieces.push(q);
                            }
                        }
                    }
                    // The release carries the modifiers held as the box was let go.
                    let shift = ui.input(|i| {
                        i.events.iter().rev().find_map(|ev| match ev {
                            egui::Event::PointerButton { button: egui::PointerButton::Primary, pressed: false, modifiers, .. } => Some(modifiers.shift),
                            _ => None,
                        })
                    });
                    let mode = if shift.unwrap_or(modifiers.shift) { bm::SelectMode::Add } else { bm::SelectMode::Replace };
                    doc.session().select(&pieces, mode);
                    changed = true;
                }
            }
        } else if primary_pressed
            && !modifiers.alt
            && !modifiers.command
            && !modifiers.mac_cmd
            && let Some(pos) = latest_pos.filter(|p| rect.contains(*p))
            && (resp.hovered() || resp.is_pointer_button_down_on())
            && let Some(vp) = doc.viewport()
            && vp.pick(to_bm(pos).x, to_bm(pos).y).is_none()
        {
            self.pending_marquee = Some(pos);
        }

        // Right-click: remember what was under the pointer; the chrome draws the menu for it. A
        // piece outside the selection becomes the selection, as a left click would make it.
        if resp.secondary_clicked() && !playing && !placing {
            let hit = resp.interact_pointer_pos().and_then(|pos| {
                let pt = to_bm(pos);
                doc.viewport()?.pick(pt.x, pt.y)
            });
            self.context_target = Some(match hit {
                Some(piece) => {
                    let waiting = doc.viewport().is_some_and(|vp| vp.can_turn_waiting_part(piece));
                    let sel = doc.session().selection();
                    if !waiting && !sel.contains(&piece) {
                        let pieces = pick_targets(doc.session(), piece, edit.pick_scope, false);
                        doc.session().select(&pieces, bm::SelectMode::Replace);
                        changed = true;
                    }
                    ContextTarget::Piece(piece)
                }
                None => ContextTarget::Empty,
            });
        }
        self.response = Some(resp.clone());

        // Read the response first: its methods lock the context, so they cannot run inside ui.input.
        let primary_drag = if !gizmo_consumed_primary && resp.dragged_by(egui::PointerButton::Primary) {
            resp.drag_delta()
        } else {
            Vec2::ZERO
        };
        let secondary_drag = if resp.dragged_by(egui::PointerButton::Secondary) { resp.drag_delta() } else { Vec2::ZERO };
        let middle_drag = if resp.dragged_by(egui::PointerButton::Middle) { resp.drag_delta() } else { Vec2::ZERO };
        let click_at = if !gizmo_consumed_primary && resp.clicked() {
            resp.interact_pointer_pos().map(local)
        } else {
            None
        };
        self.double_clicked_piece = None;
        let mut double_click = false;
        if !gizmo_consumed_primary && resp.double_clicked() {
            let hit = resp
                .interact_pointer_pos()
                .and_then(|pos| doc.viewport().and_then(|vp| vp.pick((pos.x - rect.left()) as f64, (pos.y - rect.top()) as f64)));
            if let Some(piece) = hit {
                self.double_clicked_piece = Some(piece);
            } else {
                double_click = true;
            }
        }
        let gesture = ui.input(|i| {
            let click_mods = i
                .events
                .iter()
                .rev()
                .find_map(|ev| match ev {
                    egui::Event::PointerButton { button: egui::PointerButton::Primary, pressed: false, modifiers, .. } => {
                        Some(*modifiers)
                    }
                    _ => None,
                })
                .unwrap_or(i.modifiers);
            Gesture {
                primary_drag,
                secondary_drag,
                middle_drag,
                scroll: if hovered { i.smooth_scroll_delta() } else { Vec2::ZERO },
                pinch: if hovered { i.zoom_delta() - 1.0 } else { 0.0 },
                click: click_at.map(|p| (p, click_mods)),
                double_click,
                origin: hover_pos.map(local).unwrap_or(rect.size().to_pos2() / 2.0),
                modifiers,
                mode: self.nav_mode.unwrap_or(self.mode),
            }
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
                    ViewOp::Pick(x, y, mode, alt) => picks.push((vp.pick(x, y), mode, alt)),
                }
            }
        }
        for (hit, mode, alt) in picks {
            match hit {
                Some(p) => {
                    let targets = pick_targets(doc.session(), p, edit.pick_scope, alt);
                    doc.session().select(&targets, mode);
                }
                // A plain click on empty space clears the selection.
                None if mode == bm::SelectMode::Replace => doc.session().select(&[], mode),
                None => {}
            }
        }

        let Some(vp) = doc.viewport() else { return };
        let only_planning_poll = planning && !playing && !changed && self.texture.is_some();
        let poll_due = !only_planning_poll
            || self.last_plan_poll.is_none_or(|t| t.elapsed() >= std::time::Duration::from_millis(120));
        if poll_due && (changed || playing || planning || vp.needs_draw() || self.texture.is_none()) {
            let want_more = vp.draw();
            if only_planning_poll {
                self.last_plan_poll = Some(std::time::Instant::now());
            } else {
                self.last_plan_poll = None;
            }
            if want_more && !only_planning_poll {
                ui.ctx().request_repaint();
            }
            // Skip 20 MB readback + upload while still planning an unchanged frame.
            let still_planning = only_planning_poll && vp.playback_state().plan == bm::playback::PlanState::Planning;
            if !still_planning {
                vp.read_frame(&mut self.frame);
                if self.frame.width > 0 && self.frame.height > 0 {
                    let image = ColorImage::from_rgba_unmultiplied([self.frame.width as usize, self.frame.height as usize], &self.frame.rgba);
                    match &mut self.texture {
                        Some(t) => t.set(image, TextureOptions::LINEAR),
                        None => self.texture = Some(ui.ctx().load_texture("viewport", image, TextureOptions::LINEAR)),
                    }
                }
            }
        }
        if let Some(t) = &self.texture {
            let uv = Rect::from_min_max(Pos2::ZERO, pos2(1.0, 1.0));
            ui.painter().image(t.id(), rect, uv, crate::theme::NO_TINT);
        }

        if let Some((a, b)) = self.marquee {
            let r = Rect::from_two_pos(a, b).intersect(rect);
            ui.painter().rect(r, 0.0, theme.accent_a(30), egui::Stroke::new(1.0, theme.accent), egui::StrokeKind::Inside);
        }

        // Refresh and paint the gizmo after any camera/selection change this frame.
        let sel_now = doc.session().selection();
        if let Some(kind) = gizmo_kind.filter(|_| !playing && !sel_now.is_empty()) {
            let axes = match &self.drag {
                Some(d) => d.axes,
                None => gizmo::axes(doc.session(), edit),
            };
            let origin = match &self.drag {
                Some(d) if kind == GizmoKind::Move => d.origin + d.moved(),
                Some(d) => d.origin,
                None => doc.viewport().unwrap().selection_center(),
            };
            let cam = doc.viewport().unwrap().camera();
            let shape = GizmoShape::new(&cam, view_pt, origin, axes, kind);
            self.hovered = hover_pos
                .filter(|p| rect.contains(*p))
                .map(|p| if kind == GizmoKind::Scale { gizmo::scale_hit(&shape, to_bm(p)) } else { shape.hit(to_bm(p), 8.0) })
                .unwrap_or(Handle::None);
            let active = self.drag.as_ref().map(|d| d.handle).unwrap_or(Handle::None);
            if kind == GizmoKind::Scale {
                gizmo::paint_scale(ui.painter(), theme, rect, &shape, active, self.hovered);
            } else {
                gizmo::paint(ui.painter(), theme, rect, &shape, active, self.hovered);
            }
            if let (Some(d), Some(ptr)) = (&self.drag, latest_pos) {
                match kind {
                    GizmoKind::Move => gizmo::paint_readout(ui.painter(), theme, ptr, &gizmo::format_move(d.moved())),
                    GizmoKind::Rotate => gizmo::paint_readout(ui.painter(), theme, ptr, &gizmo::format_rotate(d.turned())),
                    GizmoKind::Scale => gizmo::paint_chip(ui.painter(), theme, rect, &gizmo::format_scale(d.handle, d.scaled())),
                }
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
        let d = Gesture { secondary_drag: vec2(3.0, 2.0), ..g() };
        assert_eq!(ops_for(&d), vec![ViewOp::Orbit(3.0, 2.0)], "right-drag orbits");
        let d = Gesture { modifiers: Modifiers::SHIFT, ..d };
        assert_eq!(ops_for(&d), vec![ViewOp::Pan(3.0, 2.0)], "⇧ right-drag pans");
        let d = Gesture { middle_drag: vec2(3.0, 2.0), ..g() };
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
        assert_eq!(ops_for(&c(Modifiers::NONE)), vec![ViewOp::Pick(7.0, 8.0, bm::SelectMode::Replace, false)]);
        assert_eq!(ops_for(&c(Modifiers::SHIFT)), vec![ViewOp::Pick(7.0, 8.0, bm::SelectMode::Add, false)]);
        assert_eq!(ops_for(&c(Modifiers::MAC_CMD)), vec![ViewOp::Pick(7.0, 8.0, bm::SelectMode::Toggle, false)]);
        assert_eq!(ops_for(&c(Modifiers::ALT)), vec![ViewOp::Pick(7.0, 8.0, bm::SelectMode::Replace, true)]);
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

/// Expands a clicked piece to its whole submodel instance when picking submodels in a parent model,
/// or keeps the single piece when inside the submodel itself or when holding ⌥ Option (web parity).
fn pick_targets(session: &bm::Session, piece: u32, scope: PickScope, alt_override: bool) -> Vec<u32> {
    let whole_submodel = (scope == PickScope::Submodels) ^ alt_override;
    if whole_submodel {
        let group = session.use_pieces(piece);
        if !group.is_empty() {
            return group;
        }
    }
    vec![piece]
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
